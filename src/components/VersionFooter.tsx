import { useState } from 'react';
import { isDesktop, openUrl } from '../lib/desktop';

const RELEASES_URL = 'https://github.com/sparkly-quasar/inbox-sweep/releases';

/**
 * Shows which version is running, with a way to reach the releases page.
 *
 * There is deliberately no auto-updater. Tauri's updater requires signed
 * artifacts served from a URL the app can read without credentials, and this
 * repository is private — its release assets need authentication, which would
 * mean shipping a token inside the app. Showing the version and linking out is
 * the honest version of the same job: you can see at a glance whether you're
 * behind, and updating is downloading the newer `.dmg`.
 */
export function VersionFooter() {
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setError(null);
    try {
      // Routed through Rust on the desktop build, where window.open is inert.
      await openUrl(RELEASES_URL);
    } catch {
      setError('Could not open the releases page.');
    }
  };

  return (
    <footer className="version-footer">
      <span data-testid="app-version">
        Inbox Sweep v{__APP_VERSION__}
        {isDesktop() ? ' · desktop' : null}
      </span>
      <button className="linkish" onClick={open} data-testid="check-updates">
        Releases
      </button>
      {error ? <span className="version-error">{error}</span> : null}
    </footer>
  );
}
