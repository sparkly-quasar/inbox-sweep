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
  /** Mailboxes already signed in. */
  accounts?: string[];
  /** Selected mailbox; null or omitted means the combined view. */
  active?: string | null;
  /** Make `refresh_session` fail, as a revoked refresh token would. */
  refreshFails?: boolean;
  /** Make `sign_in` fail, as a cancelled consent would. */
  signInError?: string;
  /** Address the next `sign_in` resolves to. */
  nextSignIn?: string;
}

/**
 * Install a fake Tauri backend implementing the same commands as
 * `src-tauri/src/lib.rs`, and record every call for assertions.
 */
async function stubTauri(page: Page, initial: BackendState = {}) {
  await page.addInitScript((state: BackendState) => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    let configured = state.configured ?? false;
    let accounts: string[] = [...(state.accounts ?? [])];
    let active: string | null = state.active ?? (accounts.length === 1 ? accounts[0] : null);

    (window as unknown as { __tauriCalls: typeof calls }).__tauriCalls = calls;

    const session = (email: string) => ({
      email,
      accessToken: `token-for-${email}`,
      expiresIn: 3600,
    });

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke(cmd: string, args: Record<string, unknown> = {}) {
        calls.push({ cmd, args });
        switch (cmd) {
          case 'auth_status':
            return Promise.resolve({ configured, accounts, active });
          case 'save_client':
            configured = true;
            return Promise.resolve();
          case 'sign_in': {
            if (state.signInError) return Promise.reject(new Error(state.signInError));
            const email = state.nextSignIn ?? 'first@example.com';
            if (!accounts.includes(email)) accounts = [...accounts, email].sort();
            active = email;
            return Promise.resolve(session(email));
          }
          case 'refresh_session': {
            const email = args.email as string;
            if (state.refreshFails || !accounts.includes(email)) {
              accounts = accounts.filter((a) => a !== email);
              return Promise.reject(new Error('Google rejected the token request: invalid_grant'));
            }
            return Promise.resolve(session(email));
          }
          case 'set_active':
            active = (args.email as string | null) ?? null;
            return Promise.resolve();
          case 'sign_out':
            accounts = accounts.filter((a) => a !== args.email);
            if (active === args.email) active = accounts.length === 1 ? accounts[0] : null;
            return Promise.resolve();
          case 'forget_all':
            configured = false;
            accounts = [];
            active = null;
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
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
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
  await stubTauri(page, { configured: true, accounts: ['me@example.com'], refreshFails: true });
  await stubGmailApi(page);
  await page.goto('/');

  await expect(page.getByTestId('sign-in')).toBeVisible();
  // The user can act on this screen, so no raw invalid_grant should surface.
  await expect(page.getByText(/invalid_grant/)).toHaveCount(0);
});

test('signing in explains that it opens the real browser', async ({ page }) => {
  await stubTauri(page, { configured: true });
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
    signInError: 'Google refused the sign-in: access_denied',
  });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sign-in').click();
  await expect(page.getByText(/access_denied/)).toBeVisible();
  await expect(page.getByTestId('sign-in')).toBeVisible();
});

test('signing out drops the refresh token and returns to sign-in', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('account-switcher').click();
  await page.getByTestId('switcher-sign-out').click();

  await expect(page.getByTestId('sign-in')).toBeVisible();
  expect(await commandsCalled(page)).toContain('sign_out');
  // Credentials are kept, so the user isn't made to re-enter them.
  await expect(page.getByTestId('client-id-input')).toHaveCount(0);
});

test('changing the OAuth client forgets everything', async ({ page }) => {
  await stubTauri(page, { configured: true });
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
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });

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
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
  await stubGmailApi(page);

  // The desktop build learns its address from Rust, so the scan's message
  // listing is the first Gmail call that can be refused.
  await page.route('**/gmail/v1/users/me/messages?*', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          errors: [
            { reason: 'insufficientPermissions', domain: 'global', message: 'Insufficient Permission' },
          ],
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
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
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

/* ---------------------------------------------------------------------- */
/* Multiple mailboxes                                                      */
/* ---------------------------------------------------------------------- */

const TWO = ['work@example.com', 'personal@example.com'];

test('the switcher lists every mailbox plus a combined view', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: TWO, active: TWO[0] });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('account-switcher').click();

  await expect(page.getByTestId('select-account')).toHaveCount(2);
  // The combined option only earns its place once there are two mailboxes.
  await expect(page.getByTestId('select-combined')).toBeVisible();
});

test('a single mailbox gets no combined option', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: ['only@example.com'] });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('account-switcher').click();
  await expect(page.getByTestId('select-combined')).toHaveCount(0);
});

test('switching mailbox tells Rust, so the choice survives a restart', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: TWO, active: TWO[0] });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('account-switcher').click();
  await page.getByTestId('select-account').nth(1).click();

  const calls = await page.evaluate(
    () => (window as unknown as { __tauriCalls: { cmd: string; args: { email?: string } }[] }).__tauriCalls,
  );
  expect(calls.some((c) => c.cmd === 'set_active')).toBe(true);
});

test('the combined view scans every mailbox and merges the senders', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: TWO, active: null });
  await stubGmailApi(page);
  await page.goto('/');

  await expect(page.getByTestId('combined-note')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sender-row').first().waitFor();

  // Both mailboxes return the same fixture, so every sender appears twice and
  // the counts must add up rather than one mailbox overwriting the other.
  const acme = page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' });
  await expect(acme).toHaveCount(1);
  await expect(acme).toContainText('6');
  await expect(acme.getByText('both')).toBeVisible();
});

test('a bulk action in the combined view hits each mailbox separately', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: TWO, active: null });
  const calls = await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' }).click({ timeout: 15_000 });
  await page.getByTestId('action-trash').click();
  await expect(page.getByText(/across .* and /)).toBeVisible();
  await page.getByTestId('confirm-action').click();

  await expect(page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' })).toHaveCount(0);

  // Two mailboxes, two tokens, therefore two calls — not one merged call that
  // would fail against whichever account did not own the ids.
  expect(calls.batchModify).toHaveLength(2);
  expect(calls.batchModify.every((c) => c.addLabelIds?.includes('TRASH'))).toBe(true);
});

test('signing out of one mailbox leaves the other working', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: TWO, active: null });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('account-switcher').click();
  await page.getByTestId('switcher-sign-out').first().click();

  // Still signed in elsewhere, so the app stays usable rather than bouncing
  // back to the sign-in screen.
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  // The menu closes itself when a row is removed, so reopen it to inspect.
  await page.getByTestId('account-switcher').click();
  await expect(page.getByTestId('select-account')).toHaveCount(1);
});

/* ---------------------------------------------------------------------- */
/* Reviewing messages before acting                                        */
/* ---------------------------------------------------------------------- */

test('a sender can be opened to see the actual messages', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' }).click({ timeout: 15_000 });
  await expect(page.getByTestId('message-list')).toHaveCount(0);

  await page.getByTestId('toggle-review').click();
  const list = page.getByTestId('message-list');
  await expect(list).toBeVisible();
  // Subjects come from the scan's cached metadata, at no extra API cost.
  await expect(list).toContainText('Subject');
  await expect(list.locator('.msg')).toHaveCount(3);
});

test('acting on a selection touches only the chosen messages', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
  const calls = await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' }).click({ timeout: 15_000 });
  await page.getByTestId('toggle-review').click();

  // Pick one of the three.
  await page.locator('.msg-pick input').first().check();
  await expect(page.getByText('1 of 3 selected')).toBeVisible();

  await page.getByTestId('action-trash').click();
  await expect(page.getByText(/Only the 1 message you selected/)).toBeVisible();
  await page.getByTestId('confirm-action').click();

  expect(calls.batchModify).toHaveLength(1);
  expect(calls.batchModify[0].ids).toHaveLength(1);
  // The sender survives, because two of its messages were left alone.
  await expect(page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' })).toBeVisible();
});

test('select-all then clear returns to acting on the whole sender', async ({ page }) => {
  await stubTauri(page, { configured: true, accounts: ['me@example.com'] });
  await stubGmailApi(page);
  await page.goto('/');

  await page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' }).click({ timeout: 15_000 });
  await page.getByTestId('toggle-review').click();

  await page.getByTestId('toggle-select-all').click();
  await expect(page.getByText('3 of 3 selected')).toBeVisible();
  await expect(page.getByTestId('action-trash')).toContainText('3 selected');

  await page.getByTestId('toggle-select-all').click();
  await expect(page.getByTestId('action-trash')).toContainText('all 3');
});
