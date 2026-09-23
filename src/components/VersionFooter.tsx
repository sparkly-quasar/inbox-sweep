import { useEffect, useState } from 'react';
import { isDesktop, openUrl } from '../lib/desktop';
import { checkForUpdate, type AvailableUpdate } from '../lib/updater';

const RELEASES_URL = 'https://github.com/sparkly-quasar/inbox-sweep/releases';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'installing'; version: string; percent: number | null }
  | { kind: 'uptodate' }
  | { kind: 'failed'; message: string };

/**
 * Shows which version is running, and offers an update when one exists.
 *
 * The desktop build checks once at startup, quietly — a failed check is not
 * worth interrupting anyone over — and the user can re-check on demand.
 * Installing verifies the release's signature before replacing anything, then
 * relaunches.
 */
export function VersionFooter() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const desktop = isDesktop();

  // One quiet check on launch. Nothing is downloaded until the user asks.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;

    checkForUpdate()
      .then((update) => {
        if (!cancelled && update) setState({ kind: 'available', update });
      })
      .catch(() => {
        /* silent: the app works fine without an update check */
      });

    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const recheck = async () => {
    setState({ kind: 'checking' });
    try {
      const update = await checkForUpdate();
      setState(update ? { kind: 'available', update } : { kind: 'uptodate' });
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const install = async (update: AvailableUpdate) => {
    setState({ kind: 'installing', version: update.version, percent: 0 });
    try {
      await update.install((percent) =>
        setState((s) => (s.kind === 'installing' ? { ...s, percent } : s)),
      );
      // Not normally reached: the app relaunches into the new version.
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <footer className="version-footer">
      <span data-testid="app-version">
        Inbox Sweep v{__APP_VERSION__}
        {desktop ? ' · desktop' : null}
      </span>

      {state.kind === 'available' ? (
        <button
          className="btn btn-sm btn-primary"
          onClick={() => void install(state.update)}
          data-testid="install-update"
        >
          Update to v{state.update.version}
        </button>
      ) : null}

      {state.kind === 'installing' ? (
        <span data-testid="update-progress">
          <span className="spinner" /> Installing v{state.version}
          {state.percent === null ? '…' : ` — ${Math.round(state.percent)}%`}
        </span>
      ) : null}

      {desktop && state.kind !== 'available' && state.kind !== 'installing' ? (
        <button className="linkish" onClick={() => void recheck()} data-testid="check-updates">
          {state.kind === 'checking'
            ? 'Checking…'
            : state.kind === 'uptodate'
              ? 'Up to date'
              : 'Check for updates'}
        </button>
      ) : null}

      {!desktop ? (
        <button
          className="linkish"
          onClick={() => void openUrl(RELEASES_URL).catch(() => undefined)}
          data-testid="check-updates"
        >
          Releases
        </button>
      ) : null}

      {state.kind === 'failed' ? (
        <span className="version-error" data-testid="update-error">
          Update failed: {state.message}
        </span>
      ) : null}
    </footer>
  );
}
