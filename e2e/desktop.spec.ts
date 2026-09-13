/**
 * Desktop-build tests.
 *
 * The Rust half is covered by `cargo test`. What these cover is the half that
 * Rust can't see: whether the React app picks the right screen, calls the right
 * commands, and recovers when the stored credentials stop working.
 *
 * Tauri v2's `invoke` dispatches through `window.__TAURI_INTERNALS__`, so
 * replacing that object runs the real `src/lib/desktop.ts` against a fake
 * backend — the production code path, not a reimplementation of it.
 *
 * What remains unverified here, and can only be checked on a Mac: the IPC
 * wiring between this frontend and the Rust commands, and the live Google
 * round-trip.
 */
import { expect, test, type Page } from '@playwright/test';
import { stubGmailApi } from './fixtures';

test.use({ viewport: { width: 1000, height: 800 }, isMobile: false, hasTouch: false });

interface BackendState {
  configured?: boolean;
  signedIn?: boolean;
  /** Make `refresh_session` fail, as a revoked refresh token would. */
  refreshFails?: boolean;
  /** Make `sign_in` fail, as a cancelled consent would. */
  signInError?: string;
}

/**
 * Install a fake Tauri backend implementing the same six commands as
 * `src-tauri/src/lib.rs`, and record every call for assertions.
 */
async function stubTauri(page: Page, initial: BackendState = {}) {
  await page.addInitScript((state: BackendState) => {
    const calls: { cmd: string; args: unknown }[] = [];
    let configured = state.configured ?? false;
    let signedIn = state.signedIn ?? false;

    (window as unknown as { __tauriCalls: typeof calls }).__tauriCalls = calls;

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke(cmd: string, args: unknown) {
        calls.push({ cmd, args });
        switch (cmd) {
          case 'auth_status':
            return Promise.resolve({ configured, signedIn });
          case 'save_client':
            configured = true;
            return Promise.resolve();
          case 'sign_in':
            if (state.signInError) return Promise.reject(new Error(state.signInError));
            signedIn = true;
            return Promise.resolve({ accessToken: 'desktop-token', expiresIn: 3600 });
          case 'refresh_session':
            if (state.refreshFails || !signedIn) {
              signedIn = false;
              return Promise.reject(new Error('Google rejected the token request: invalid_grant'));
            }
            return Promise.resolve({ accessToken: 'desktop-token', expiresIn: 3600 });
          case 'sign_out':
            signedIn = false;
            return Promise.resolve();
          case 'forget_all':
            configured = false;
            signedIn = false;
            return Promise.resolve();
          case 'open_external':
            return Promise.resolve();
          default:
            return Promise.reject(new Error(`unexpected command: ${cmd}`));
        }
      },
    };
  }, initial);
}

const commandsCalled = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tauriCalls: { cmd: string }[] }).__tauriCalls.map((c) => c.cmd));

test('asks for a client secret, which the browser build never needs', async ({ page }) => {
  await stubTauri(page);
  await stubGmailApi(page);
  await page.goto('/');

  await expect(page.getByTestId('client-id-input')).toBeVisible();
  // The desktop flow needs a Desktop app client, which issues a secret.
  await expect(page.getByTestId('client-secret-input')).toBeVisible();
  await expect(page.getByText('Desktop app')).toBeVisible();
  // The browser-only instruction to whitelist an origin must not appear.
  await expect(page.getByText('Authorised JavaScript origins')).toHaveCount(0);
});

test('saving credentials advances to sign-in and stores them in Rust', async ({ page }) => {
  await stubTauri(page);
  await stubGmailApi(page);
  await page.goto('/');

  // Both fields are required before the button enables.
  await page.getByTestId('client-id-input').fill('abc.apps.googleusercontent.com');
  await expect(page.getByTestId('save-client-id')).toBeDisabled();
  await page.getByTestId('client-secret-input').fill('GOCSPX-secret');
  await page.getByTestId('save-client-id').click();

  await expect(page.getByTestId('sign-in')).toBeVisible();
  expect(await commandsCalled(page)).toContain('save_client');
});

test('a stored refresh token signs in silently on launch', async ({ page }) => {
  await stubTauri(page, { configured: true, signedIn: true });
  await stubGmailApi(page);
  await page.goto('/');

  // The whole point of the desktop build: straight in, no sign-in screen.
  await expect(page.getByTestId('sender-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sign-in')).toHaveCount(0);

  const calls = await commandsCalled(page);
  expect(calls).toContain('auth_status');
  expect(calls).toContain('refresh_session');
});

test('a revoked refresh token falls back to sign-in without an error dump', async ({ page }) => {
  await stubTauri(page, { configured: true, signedIn: true, refreshFails: true });
  await stubGmailApi(page);
  await page.goto('/');

  await expect(page.getByTestId('sign-in')).toBeVisible();
  // The user can act on this screen, so no raw invalid_grant should surface.
  await expect(page.getByText(/invalid_grant/)).toHaveCount(0);
});

test('signing in explains that it opens the real browser', async ({ page }) => {
  await stubTauri(page, { configured: true, signedIn: false });
  await stubGmailApi(page);
  await page.goto('/');

  // Google rejects OAuth in embedded webviews, so the handoff is expected
  // behaviour and worth stating rather than surprising the user.
  await expect(page.getByText(/opens your browser/i)).toBeVisible();

  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('sender-row').first()).toBeVisible({ timeout: 15_000 });
  expect(await commandsCalled(page)).toContain('sign_in');
});

test('a cancelled sign-in surfaces the reason and stays put', async ({ page }) => {
  await stubTauri(page, {
    configured: true,
    signedIn: false,
    signInError: 'Google refused the sign-in: access_denied',
  });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sign-in').click();
  await expect(page.getByText(/access_denied/)).toBeVisible();
  await expect(page.getByTestId('sign-in')).toBeVisible();
});

test('signing out drops the refresh token and returns to sign-in', async ({ page }) => {
  await stubTauri(page, { configured: true, signedIn: true });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByTestId('sign-in')).toBeVisible();
  expect(await commandsCalled(page)).toContain('sign_out');
  // Credentials are kept, so the user isn't made to re-enter them.
  await expect(page.getByTestId('client-id-input')).toHaveCount(0);
});

test('changing the OAuth client forgets everything', async ({ page }) => {
  await stubTauri(page, { configured: true, signedIn: false });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Change OAuth client' }).click();

  await expect(page.getByTestId('client-id-input')).toBeVisible();
  expect(await commandsCalled(page)).toContain('forget_all');
});

test('a 403 does not become an infinite re-authentication loop', async ({ page }) => {
  // The bug this covers: the app treated 403 as "token problem", cleared the
  // session, and the desktop build silently refreshed from its stored refresh
  // token — producing a fresh token that Google refused identically, forever.
  await stubTauri(page, { configured: true, signedIn: true });

  let listCalls = 0;
  await page.route('**/gmail/v1/users/me/profile*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ emailAddress: 'tester@example.com', messagesTotal: 1, threadsTotal: 1 }),
    }),
  );
  await page.route('**/gmail/v1/users/me/messages?*', (route) => {
    listCalls++;
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 403,
          message: 'Gmail API has not been used in project 123 before or it is disabled.',
          errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits', message: 'Access Not Configured.' }],
          status: 'PERMISSION_DENIED',
        },
      }),
    });
  });

  await page.goto('/');

  // The message must name the actual fix rather than a generic refusal.
  await expect(page.getByText(/Gmail API is not enabled/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Signing in again will not help/i)).toBeVisible();

  const afterFirst = listCalls;
  await page.waitForTimeout(3000);

  // A loop would keep re-signing-in and re-listing; a handled error stops.
  expect(listCalls).toBeLessThanOrEqual(afterFirst + 1);
  expect(listCalls).toBeLessThan(5);

  const signIns = (await commandsCalled(page)).filter((c) => c === 'sign_in' || c === 'refresh_session');
  expect(signIns.length).toBeLessThan(4);
});

test('insufficient scopes tells the user to re-grant permissions', async ({ page }) => {
  await stubTauri(page, { configured: true, signedIn: true });
  await page.route('**/gmail/v1/users/me/profile*', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          errors: [{ reason: 'insufficientPermissions', domain: 'global', message: 'Insufficient Permission' }],
          status: 'PERMISSION_DENIED',
        },
      }),
    }),
  );

  await page.goto('/');
  await expect(page.getByText(/did not grant the permissions/i)).toBeVisible({ timeout: 15_000 });
});

test('shows the running version and opens Releases through Rust', async ({ page }) => {
  // There is no auto-updater (the repo is private, so release assets need
  // credentials the app must not carry). Showing the version and linking out
  // is the substitute, so it needs to actually work.
  await stubTauri(page, { configured: true, signedIn: true });
  await stubGmailApi(page);
  await page.goto('/');

  const version = page.getByTestId('app-version');
  await expect(version).toContainText(/^Inbox Sweep v\d+\.\d+\.\d+/);
  await expect(version).toContainText('desktop');

  await page.getByTestId('check-updates').click();

  const calls = await page.evaluate(
    () => (window as unknown as { __tauriCalls: { cmd: string; args: { url?: string } }[] }).__tauriCalls,
  );
  const opened = calls.find((c) => c.cmd === 'open_external');
  expect(opened, 'the link must go through Rust, since window.open is inert in a webview').toBeTruthy();
  expect(opened!.args.url).toContain('/releases');
});
