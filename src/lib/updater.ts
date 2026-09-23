/**
 * Desktop auto-update.
 *
 * Tauri's updater fetches a small JSON manifest from the latest GitHub
 * release, compares versions, and downloads the new bundle. Every update is
 * verified against a minisign public key compiled into the app — signature
 * checking cannot be turned off — so a tampered or substituted release cannot
 * be installed even if someone managed to serve one.
 *
 * This only works because the repository is public: the manifest and the
 * bundle must be fetchable without credentials, and embedding a token in a
 * distributed binary would hand it to anyone who downloaded the app.
 *
 * Everything here no-ops in the browser build, which updates by reloading.
 */

import { isDesktop } from './desktop';

export interface AvailableUpdate {
  version: string;
  notes?: string;
  /** Applies the update and relaunches. Never resolves on success. */
  install: (onProgress?: (percent: number | null) => void) => Promise<void>;
}

/**
 * Look for a newer release.
 *
 * Returns null when up to date, when running in the browser, or when the
 * check fails — a failed check is not worth interrupting anyone over, since
 * the app works regardless.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isDesktop()) return null;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;

    return {
      version: update.version,
      notes: update.body,
      install: async (onProgress) => {
        let downloaded = 0;
        let total: number | null = null;

        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              total = event.data.contentLength ?? null;
              onProgress?.(0);
              break;
            case 'Progress':
              downloaded += event.data.chunkLength;
              // contentLength is absent often enough that the UI has to cope
              // with an indeterminate bar rather than a wrong one.
              onProgress?.(total ? Math.min(100, (downloaded / total) * 100) : null);
              break;
            case 'Finished':
              onProgress?.(100);
              break;
          }
        });

        // The new binary only takes effect on restart.
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
    };
  } catch (err) {
    console.warn('Update check failed', err);
    return null;
  }
}
