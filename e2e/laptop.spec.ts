/**
 * Not assertions — produces reviewable screenshots of the app at laptop width,
 * to confirm the mobile-first layout holds up on a desktop browser.
 */
import { test, expect } from '@playwright/test';
import { seedClientId, stubGmailApi, stubGoogleAuth } from './fixtures';

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
});

test('laptop: setup screen names the local origin', async ({ page }) => {
  await stubGoogleAuth(page);
  await stubGmailApi(page);
  await page.goto('/');

  // The exact string the user must paste into Google's console.
  await expect(page.getByText('http://127.0.0.1:5173')).toBeVisible();
  await page.screenshot({ path: 'screenshots/laptop-01-setup.png', fullPage: true });
});

test('laptop: sender list and sheet', async ({ page }) => {
  await stubGoogleAuth(page);
  await seedClientId(page);
  await stubGmailApi(page);

  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.getByTestId('sender-row').first().waitFor({ timeout: 15_000 });
  await page.screenshot({ path: 'screenshots/laptop-02-senders.png' });

  await page.getByTestId('sender-row').filter({ hasText: 'Acme Weekly' }).click();
  await page.screenshot({ path: 'screenshots/laptop-03-sheet.png', animations: 'disabled' });
});
