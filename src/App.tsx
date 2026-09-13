import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GmailClient, GmailError } from './lib/gmail';
import { clearSession, ensureToken, requestToken, revoke, type Session } from './lib/auth';
import { scanMailbox, type ScanProgress } from './lib/scan';
import { filterGroups, groupMessages, sortGroups, totals, type GroupBy, type SortBy } from './lib/group';
import { formatSize, type MessageMeta } from './lib/parse';
import {
  applyBulkAction,
  createFilterFromPlan,
  unsubscribe as runUnsubscribe,
  type BulkAction,
  type FilterPlan,
} from './lib/actions';
import { clearAccount } from './lib/cache';
import * as desktopAuth from './lib/desktop';
import { isDesktop, type DesktopStatus } from './lib/desktop';
import { SenderRow } from './components/SenderRow';
import { SenderSheet } from './components/SenderSheet';
import { SetupScreen } from './components/SetupScreen';

const CLIENT_ID_KEY = 'inbox-sweep.clientId';
const BUILD_TIME_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

/** Preset mailbox scopes, as Gmail search queries. */
const SCOPES_QUERY: { id: string; label: string; query: string }[] = [
  { id: 'inbox', label: 'Inbox', query: 'in:inbox' },
  { id: 'all', label: 'All mail', query: '' },
  { id: 'unread', label: 'Unread', query: 'is:unread' },
  { id: 'old', label: 'Over 1y old', query: 'older_than:1y' },
  { id: 'big', label: 'Large', query: 'larger:1m' },
  { id: 'lists', label: 'Newsletters', query: 'category:promotions OR category:updates OR category:forums' },
];

const SORTS: { id: SortBy; label: string }[] = [
  { id: 'count', label: 'Most mail' },
  { id: 'size', label: 'Biggest' },
  { id: 'unread', label: 'Unread' },
  { id: 'recent', label: 'Recent' },
];

export default function App() {
  // Which build we're running in. Fixed for the lifetime of the process, so
  // it's resolved once rather than re-checked on every render.
  const [desktop] = useState(() => isDesktop());
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null);

  const [clientId, setClientId] = useState<string>(
    () => BUILD_TIME_CLIENT_ID || localStorage.getItem(CLIENT_ID_KEY) || '',
  );
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<string>('');
  const [messages, setMessages] = useState<MessageMeta[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [scopeId, setScopeId] = useState('inbox');
  const [groupBy, setGroupBy] = useState<GroupBy>('sender');
  const [sortBy, setSortBy] = useState<SortBy>('count');
  const [query, setQuery] = useState('');

  const abort = useRef<AbortController | null>(null);
  // Guards against an automatic re-authentication cycling forever.
  const reauthed = useRef(false);
  const client = useMemo(() => (session ? new GmailClient(session.token) : null), [session]);

  /* ---------- auth ---------- */

  // Desktop: ask Rust what it has stored, then use the refresh token to get
  // straight into the app. This is the payoff of the native flow — a returning
  // user never sees a sign-in screen until they revoke access.
  useEffect(() => {
    if (!desktop || session) return;
    let cancelled = false;

    desktopAuth
      .status()
      .then(async (status) => {
        if (cancelled) return;
        setDesktopStatus(status);
        if (!status.signedIn) return;

        try {
          const refreshed = await desktopAuth.refreshSession();
          if (!cancelled) setSession(refreshed);
        } catch {
          // A revoked refresh token is dropped by Rust; fall back to the
          // sign-in screen rather than surfacing an error the user can't act on.
          if (!cancelled) setDesktopStatus({ ...status, signedIn: false });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(explain(err));
      });

    return () => {
      cancelled = true;
    };
  }, [desktop, session]);

  // Browser: try a silent sign-in on load so a returning user lands straight
  // in the app.
  useEffect(() => {
    if (desktop || !clientId || session) return;
    let cancelled = false;
    ensureToken(clientId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        /* expected on first visit — the user taps sign in */
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, clientId, session]);

  // Resolve which mailbox we're looking at; the cache is keyed on it.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getProfile()
      .then((p) => {
        if (!cancelled) setAccount(p.emailAddress);
      })
      .catch((err) => {
        if (!cancelled) setError(explain(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const signIn = async () => {
    setError(null);
    try {
      // Desktop sign-in hands off to the user's real browser and resolves when
      // they come back, so it can sit pending for a while.
      setSession(desktop ? await desktopAuth.signIn() : await requestToken(clientId, true));
    } catch (err) {
      setError(explain(err));
    }
  };

  const signOut = () => {
    if (desktop) {
      void desktopAuth.signOut().catch(() => {
        /* the in-memory session is cleared regardless */
      });
      setDesktopStatus((s) => (s ? { ...s, signedIn: false } : s));
    } else {
      if (session) revoke(session.token);
      clearSession();
    }
    setSession(null);
    setMessages([]);
    setAccount('');
    setProgress(null);
  };

  /* ---------- scanning ---------- */

  const scan = useCallback(
    async (force = false) => {
      if (!client || !account) return;
      setError(null);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      const scopeQuery = SCOPES_QUERY.find((s) => s.id === scopeId)?.query ?? '';

      try {
        const result = await scanMailbox(client, account, {
          query: scopeQuery,
          force,
          signal: controller.signal,
          onProgress: (p) => {
            // Ignore progress from a scan that has since been superseded.
            if (abort.current === controller) setProgress(p);
          },
        });

        // Only the newest scan may publish results. A superseded scan — from
        // StrictMode's double-invoked effect, a scope change, or a rapid
        // rescan — still resolves with whatever it had, and applying that
        // would clobber newer state (including messages the user just
        // trashed). Pressing Stop leaves this scan current, so its partial
        // results are still applied, which is what the button should do.
        if (abort.current !== controller) return;
        setMessages(result);
      } catch (err) {
        if (abort.current !== controller) return;
        setError(explain(err));
        setProgress((p) => (p ? { ...p, phase: 'error' } : null));

        // Only an expired token is worth re-authenticating for, and only once.
        //
        // A 403 must never land here: signing in again produces a fresh token
        // that is refused in exactly the same way, and on desktop — where the
        // refresh token makes re-auth silent — that becomes an invisible
        // infinite loop. The reauth guard covers the same risk for a 401 that
        // somehow survives a refresh.
        if (err instanceof GmailError && err.isExpired && !reauthed.current) {
          reauthed.current = true;
          clearSession();
          setSession(null);
        }
      }
    },
    [client, account, scopeId],
  );

  // Kick off a scan whenever the mailbox or the chosen scope changes.
  useEffect(() => {
    if (client && account) void scan(false);
    return () => abort.current?.abort();
  }, [client, account, scopeId, scan]);

  /* ---------- derived data ---------- */

  const groups = useMemo(() => groupMessages(messages, groupBy), [messages, groupBy]);
  const visible = useMemo(
    () => sortGroups(filterGroups(groups, query), sortBy),
    [groups, query, sortBy],
  );
  const summary = useMemo(() => totals(groups), [groups]);
  const selected = useMemo(
    () => visible.find((g) => g.key === selectedKey) ?? groups.find((g) => g.key === selectedKey) ?? null,
    [visible, groups, selectedKey],
  );

  /* ---------- actions ---------- */

  const handleBulk = async (action: BulkAction) => {
    if (!client || !selected) return;
    setBusy(true);
    try {
      const ids = new Set(selected.messageIds);
      await applyBulkAction(client, account, selected.messageIds, action);

      // Update the local view rather than re-scanning: instant, and a re-scan
      // of a big mailbox costs thousands of calls.
      setMessages((prev) =>
        action === 'trash'
          ? prev.filter((m) => !ids.has(m.id))
          : prev.map((m) =>
              ids.has(m.id)
                ? {
                    ...m,
                    inInbox: action === 'archive' ? false : m.inInbox,
                    unread: action === 'markRead' ? false : m.unread,
                  }
                : m,
            ),
      );
      setSelectedKey(null);
    } finally {
      setBusy(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!selected) return { kind: 'unavailable' as const };
    return runUnsubscribe(selected.unsubscribe);
  };

  const handleCreateFilter = async (plan: FilterPlan) => {
    if (!client) throw new Error('Not signed in.');
    setBusy(true);
    try {
      await createFilterFromPlan(client, plan);
    } finally {
      setBusy(false);
    }
  };

  const resetCache = async () => {
    if (!account) return;
    await clearAccount(account);
    setMessages([]);
    void scan(true);
  };

  /* ---------- render ---------- */

  // Desktop waits for Rust to report what it has stored before choosing a
  // screen, so the user never sees setup flash before their saved session.
  if (desktop && !session && !desktopStatus) {
    return (
      <Shell>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="spinner" />
          <span>Starting…</span>
        </div>
      </Shell>
    );
  }

  const needsSetup = desktop ? !desktopStatus?.configured : !clientId;

  if (needsSetup) {
    return (
      <Shell>
        <SetupScreen
          mode={desktop ? 'desktop' : 'browser'}
          origin={window.location.origin}
          error={error}
          onSave={async (id, secret) => {
            setError(null);
            if (desktop) {
              try {
                await desktopAuth.saveClient(id, secret ?? '');
                setDesktopStatus(await desktopAuth.status());
              } catch (err) {
                setError(explain(err));
              }
            } else {
              localStorage.setItem(CLIENT_ID_KEY, id);
              setClientId(id);
            }
          }}
        />
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Sign in to Gmail</h2>
          <p className="note" style={{ marginTop: 0 }}>
            {desktop
              ? 'This opens your browser to approve access — Google requires that rather than an in-app window. Your mail is read on this device and sent nowhere else.'
              : 'Your mail is read on this device and sent nowhere else. There is no server.'}
          </p>
          {error ? <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div> : null}
          <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={signIn} data-testid="sign-in">
            Sign in with Google
          </button>
          <button
            className="btn btn-block"
            style={{ marginTop: 8 }}
            onClick={async () => {
              if (desktop) {
                await desktopAuth.forgetAll().catch(() => undefined);
                setDesktopStatus({ configured: false, signedIn: false });
              } else {
                localStorage.removeItem(CLIENT_ID_KEY);
                setClientId('');
              }
            }}
          >
            Change OAuth client
          </button>
        </div>
      </Shell>
    );
  }

  const scanning = progress?.phase === 'listing' || progress?.phase === 'fetching';
  const pct =
    progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <Shell
      account={account}
      onSignOut={signOut}
      onRescan={() => void scan(false)}
      scanning={scanning}
    >
      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="segmented" role="group" aria-label="Mailbox scope">
        {SCOPES_QUERY.map((s) => (
          <button
            key={s.id}
            className="seg"
            aria-pressed={scopeId === s.id}
            onClick={() => setScopeId(s.id)}
            disabled={scanning}
          >
            {s.label}
          </button>
        ))}
      </div>

      {scanning ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="spinner" />
            <span>{progress?.message ?? 'Scanning…'}</span>
          </div>
          {progress && progress.total > 0 ? (
            <div className="progress">
              <i style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {progress && progress.fromCache > 0 ? (
            <p className="note">{progress.fromCache.toLocaleString()} reused from this device's cache.</p>
          ) : null}
          <button
            className="btn btn-block"
            style={{ marginTop: 10 }}
            onClick={() => abort.current?.abort()}
          >
            Stop
          </button>
        </div>
      ) : null}

      <div className="stats" style={{ marginTop: 12 }}>
        <div className="stat">
          <b>{summary.senders.toLocaleString()}</b>
          <span>Senders</span>
        </div>
        <div className="stat">
          <b>{summary.messages.toLocaleString()}</b>
          <span>Mail</span>
        </div>
        <div className="stat">
          <b>{formatSize(summary.size)}</b>
          <span>Size</span>
        </div>
        <div className="stat">
          <b>{summary.unsubscribable.toLocaleString()}</b>
          <span>Unsub</span>
        </div>
      </div>

      <input
        className="field"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter senders"
        aria-label="Filter senders"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        type="search"
      />

      <div className="segmented" style={{ marginTop: 10 }} role="group" aria-label="Sort and group">
        {SORTS.map((s) => (
          <button key={s.id} className="seg" aria-pressed={sortBy === s.id} onClick={() => setSortBy(s.id)}>
            {s.label}
          </button>
        ))}
        <button
          className="seg"
          aria-pressed={groupBy === 'domain'}
          onClick={() => setGroupBy((g) => (g === 'domain' ? 'sender' : 'domain'))}
        >
          By domain
        </button>
      </div>

      {visible.length > 0 ? (
        <ul className="sender-list">
          {visible.slice(0, 300).map((g) => (
            <SenderRow key={g.key} group={g} onSelect={() => setSelectedKey(g.key)} />
          ))}
        </ul>
      ) : !scanning ? (
        <div className="empty">
          <p>{messages.length ? 'No senders match that filter.' : 'Nothing scanned yet.'}</p>
          {!messages.length ? (
            <button className="btn btn-primary" onClick={() => void scan(false)}>
              Scan mailbox
            </button>
          ) : null}
        </div>
      ) : null}

      {visible.length > 300 ? (
        <p className="note">Showing the top 300 of {visible.length.toLocaleString()} senders.</p>
      ) : null}

      {!scanning && messages.length > 0 ? (
        <button className="btn btn-sm" style={{ marginTop: 14 }} onClick={() => void resetCache()}>
          Clear cache and rescan
        </button>
      ) : null}

      {selected ? (
        <SenderSheet
          group={selected}
          busy={busy}
          onClose={() => setSelectedKey(null)}
          onBulk={handleBulk}
          onUnsubscribe={handleUnsubscribe}
          onCreateFilter={handleCreateFilter}
        />
      ) : null}
    </Shell>
  );
}

function Shell({
  account,
  onSignOut,
  onRescan,
  scanning,
  children,
}: {
  account?: string;
  onSignOut?: () => void;
  onRescan?: () => void;
  scanning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <h1 className="brand">
            Inbox Sweep
            {account ? <small>{account}</small> : null}
          </h1>
          {onRescan ? (
            <button className="btn btn-sm" onClick={onRescan} disabled={scanning}>
              Rescan
            </button>
          ) : null}
          {onSignOut ? (
            <button className="btn btn-sm" onClick={onSignOut}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

/**
 * Turn an exception into something worth showing a human.
 *
 * A 403 has two quite different causes that the generic wording used to
 * conflate, leaving the user to guess. Google labels them, so say which.
 */
function explain(err: unknown): string {
  if (!(err instanceof GmailError)) {
    return err instanceof Error ? err.message : String(err);
  }

  if (err.isExpired) return 'Your Google session expired. Sign in again.';

  if (err.isForbidden) {
    switch (err.reason) {
      case 'accessNotConfigured':
        return (
          'The Gmail API is not enabled on your Google Cloud project. Open the project in ' +
          'console.cloud.google.com, search for "Gmail API", and click Enable — then retry. ' +
          'Signing in again will not help.'
        );
      case 'insufficientPermissions':
      case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
        return (
          'Your sign-in did not grant the permissions this app needs. Sign out, then sign in ' +
          'again and leave every permission checkbox ticked on the Google consent screen. ' +
          'If it still fails, add the gmail.modify and gmail.settings.basic scopes to your ' +
          'OAuth consent screen.'
        );
      default:
        // Google's own message is usually specific and often carries a link.
        return `Google refused the request: ${err.message.replace(/^Gmail API \d+: /, '')}`;
    }
  }

  if (err.status === 429) return 'Gmail is rate-limiting this account. Wait a minute and retry.';
  return err.message;
}
