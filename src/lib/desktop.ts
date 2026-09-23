/**
 * Bridge to the Tauri desktop build.
 *
 * The same React app serves both targets. Only authentication differs: the
 * browser gets a one-hour implicit token via Google Identity Services, while
 * the desktop app delegates to Rust, which runs the native-app flow (system
 * browser + PKCE + loopback redirect) and holds a refresh token.
 *
 * Every export here is safe to call from the browser build — `isDesktop()`
 * returns false and nothing else runs, so the web path is untouched.
 */

import type { Session } from './auth';

interface TauriGlobals {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

/**
 * True when running inside the Tauri shell.
 *
 * Checked at call time rather than module load: the globals are injected
 * before the app's scripts run, but reading them lazily keeps this testable
 * and avoids depending on script ordering.
 */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as TauriGlobals;
  return w.__TAURI_INTERNALS__ !== undefined || w.__TAURI__ !== undefined;
}

/**
 * Call a Tauri command.
 *
 * `@tauri-apps/api` is imported dynamically so the browser bundle never pulls
 * it in — it is dead weight there, and importing it eagerly would run its
 * initialisation outside Tauri.
 */
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

export interface DesktopStatus {
  /** A client ID and secret have been saved. */
  configured: boolean;
  /** Every signed-in mailbox, in a stable order. */
  accounts: string[];
  /** The mailbox last selected; null means the combined view. */
  active: string | null;
}

/** A token plus the mailbox it belongs to. */
export interface AccountSession extends Session {
  email: string;
}

interface RawSession {
  email: string;
  accessToken: string;
  expiresIn: number;
}

function toSession(raw: RawSession): AccountSession {
  return {
    email: raw.email,
    token: raw.accessToken,
    expiresAt: Date.now() + raw.expiresIn * 1000,
  };
}

/** What's stored, so the app can pick the right screen on launch. */
export function status(): Promise<DesktopStatus> {
  return invoke<DesktopStatus>('auth_status');
}

/** Persist the Google "Desktop app" client credentials. */
export function saveClient(clientId: string, clientSecret: string): Promise<void> {
  return invoke('save_client', { clientId, clientSecret });
}

/**
 * Run the interactive sign-in and add whichever mailbox the user picks.
 *
 * This opens the user's real browser — Google rejects OAuth inside an embedded
 * webview — and resolves once they finish. Signing in with an address that is
 * already present replaces its token rather than adding a duplicate.
 */
export async function signIn(): Promise<AccountSession> {
  return toSession(await invoke<RawSession>('sign_in'));
}

/** Mint a fresh access token for one mailbox, silently. */
export async function refreshSession(email: string): Promise<AccountSession> {
  return toSession(await invoke<RawSession>('refresh_session', { email }));
}

/** Remember the selected mailbox, or the combined view when null. */
export function setActive(email: string | null): Promise<void> {
  return invoke('set_active', { email });
}

/** Forget one mailbox, keeping the others and the client credentials. */
export function signOut(email: string): Promise<void> {
  return invoke('sign_out', { email });
}

/** Drop everything, including the client credentials. */
export function forgetAll(): Promise<void> {
  return invoke('forget_all');
}

/**
 * Open a link outside the app — an unsubscribe page, or a mail composer.
 *
 * In the browser this is just `window.open`. In the desktop app it has to go
 * through Rust: `window.open` does nothing useful inside a Tauri webview, and
 * a third-party unsubscribe page has no business rendering in-app regardless.
 */
export async function openUrl(url: string): Promise<void> {
  if (isDesktop()) {
    await invoke('open_external', { url });
    return;
  }

  if (url.startsWith('mailto:')) {
    window.location.href = url;
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
