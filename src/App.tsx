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
  type Clients,
  type FilterPlan,
} from './lib/actions';
import { clearAccount } from './lib/cache';
import * as desktopAuth from './lib/desktop';
import { isDesktop } from './lib/desktop';
import { SenderRow } from './components/SenderRow';
import { SenderSheet } from './components/SenderSheet';
import { SetupScreen } from './components/SetupScreen';
import { VersionFooter } from './components/VersionFooter';
import { AccountSwitcher, type Selection } from './components/AccountSwitcher';

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
  const [ready, setReady] = useState(!isDesktop());
  const [configured, setConfigured] = useState(false);

  const [clientId, setClientId] = useState<string>(
    () => BUILD_TIME_CLIENT_ID || localStorage.getItem(CLIENT_ID_KEY) || '',
  );

  /** Live access tokens, keyed by mailbox. */
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  /** Every signed-in mailbox, in a stable order. */
  const [accounts, setAccounts] = useState<string[]>([]);
  /** Selected mailbox, or null for the combined view. */
  const [selection, setSelection] = useState<Selection>(null);

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

  /** One API client per signed-in mailbox. */
  const clients = useMemo<Clients>(() => {
    const out: Clients = {};
    for (const [email, session] of Object.entries(sessions)) {
      out[email] = new GmailClient(session.token);
    }
    return out;
  }, [sessions]);

  /** The mailboxes the current view covers. */
  const viewing = useMemo(
    () => (selection === null ? accounts : [selection]).filter((a) => a in clients),
    [selection, accounts, clients],
  );
  const combined = selection === null && accounts.length > 1;

  /* ---------- auth ---------- */

  // Desktop: ask Rust what it has, then refresh every mailbox in parallel so
  // the combined view is usable immediately rather than one account at a time.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;

    desktopAuth
      .status()
      .then(async (status) => {
        if (cancelled) return;
        setConfigured(status.configured);
        setAccounts(status.accounts);
        setSelection(status.active ?? (status.accounts.length === 1 ? status.accounts[0] : null));

        const results = await Promise.allSettled(
          status.accounts.map((email) => desktopAuth.refreshSession(email)),
        );
        if (cancelled) return;

        const live: Record<string, Session> = {};
        const dead: string[] = [];
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') live[r.value.email] = r.value;
          else dead.push(status.accounts[i]);
        });

        setSessions(live);
        // Rust has dropped revoked accounts; mirror that rather than showing
        // mailboxes that cannot be used.
        if (dead.length) setAccounts((prev) => prev.filter((a) => !dead.includes(a)));
      })
      .catch((err) => {
        if (!cancelled) setError(explain(err));
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [desktop]);

  // Browser: one mailbox only. Tokens last an hour with no silent refresh, so
  // juggling several accounts here would mean near-constant re-authentication.
  useEffect(() => {
    if (desktop || !clientId || accounts.length) return;
    let cancelled = false;

    ensureToken(clientId)
      .then(async (session) => {
        if (cancelled) return;
        const profile = await new GmailClient(session.token).getProfile();
        if (cancelled) return;
        setSessions({ [profile.emailAddress]: session });
        setAccounts([profile.emailAddress]);
        setSelection(profile.emailAddress);
      })
      .catch(() => {
        /* expected on first visit — the user taps sign in */
      });

    return () => {
      cancelled = true;
    };
  }, [desktop, clientId, accounts.length]);

  const signIn = async () => {
    setError(null);
    try {
      if (desktop) {
        const added = await desktopAuth.signIn();
        setSessions((prev) => ({ ...prev, [added.email]: added }));
        setAccounts((prev) => (prev.includes(added.email) ? prev : [...prev, added.email].sort()));
        setSelection(added.email);
      } else {
        const session = await requestToken(clientId, true);
        const profile = await new GmailClient(session.token).getProfile();
        setSessions({ [profile.emailAddress]: session });
        setAccounts([profile.emailAddress]);
        setSelection(profile.emailAddress);
      }
    } catch (err) {
      setError(explain(err));
    }
  };

  const signOutOf = async (email: string) => {
    if (desktop) {
      await desktopAuth.signOut(email).catch(() => undefined);
    } else {
      const session = sessions[email];
      if (session) revoke(session.token);
      clearSession();
    }

    const remaining = accounts.filter((a) => a !== email);
    setAccounts(remaining);
    setSessions((prev) => {
      const next = { ...prev };
      delete next[email];
      return next;
    });
    // Drop that mailbox's mail from the working set without disturbing the rest.
    setMessages((prev) => prev.filter((m) => m.account !== email));
    setSelection((current) =>
      current === email ? (remaining.length === 1 ? remaining[0] : null) : current,
    );
    setSelectedKey(null);
  };

  const chooseSelection = (next: Selection) => {
    setSelection(next);
    setSelectedKey(null);
    if (desktop) void desktopAuth.setActive(next).catch(() => undefined);
  };

  /* ---------- scanning ---------- */

  const scan = useCallback(
    async (force = false) => {
      if (!viewing.length) return;
      setError(null);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      const scopeQuery = SCOPES_QUERY.find((s) => s.id === scopeId)?.query ?? '';

      try {
        // Sequential across mailboxes: Gmail's quota is per user, and racing
        // two full scans mostly earns 429s.
        const collected: MessageMeta[] = [];
        for (const email of viewing) {
          if (controller.signal.aborted) break;
          const result = await scanMailbox(clients[email], email, {
            query: scopeQuery,
            force,
            signal: controller.signal,
            onProgress: (p) => {
              if (abort.current === controller) {
                setProgress(viewing.length > 1 ? { ...p, message: `${email}: ${p.message ?? ''}` } : p);
              }
            },
          });
          collected.push(...result);
        }

        // Only the newest scan may publish results. A superseded scan — from
        // StrictMode's double-invoked effect, a scope change, or a rapid
        // rescan — still resolves with whatever it had, and applying that
        // would clobber newer state (including messages the user just
        // trashed). Pressing Stop leaves this scan current, so its partial
        // results are still applied, which is what the button should do.
        if (abort.current !== controller) return;
        setMessages(collected);
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
          if (!desktop) {
            clearSession();
            setSessions({});
            setAccounts([]);
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clients, scopeId, viewing.join('|'), desktop],
  );

  // Rescan whenever the mailbox selection or the chosen scope changes.
  useEffect(() => {
    if (viewing.length) void scan(false);
    return () => abort.current?.abort();
  }, [scan, viewing.length]);

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
  /** The messages behind the open sender, for review. */
  const selectedMessages = useMemo(() => {
    if (!selected) return [];
    const ids = new Set(selected.messageIds);
    return messages.filter((m) => ids.has(m.id));
  }, [selected, messages]);

  /* ---------- actions ---------- */

  const handleBulk = async (action: BulkAction, messagesByAccount: Record<string, string[]>) => {
    setBusy(true);
    try {
      await applyBulkAction(clients, messagesByAccount, action);

      const touched = new Set(
        Object.entries(messagesByAccount).flatMap(([account, ids]) =>
          ids.map((id) => `${account}:${id}`),
        ),
      );

      // Update the local view rather than re-scanning: instant, and a re-scan
      // of a big mailbox costs thousands of calls.
      setMessages((prev) =>
        action === 'trash'
          ? prev.filter((m) => !touched.has(`${m.account}:${m.id}`))
          : prev.map((m) =>
              touched.has(`${m.account}:${m.id}`)
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
    if (!selected) throw new Error('Nothing selected.');
    setBusy(true);
    try {
      // Filters live inside a mailbox, so a sender spanning two inboxes needs
      // one filter in each.
      for (const account of selected.accounts) {
        const client = clients[account];
        if (client) await createFilterFromPlan(client, plan);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Previews for rows on screen, routed to whichever mailbox owns them. */
  const loadSnippets = useCallback(
    async (ids: string[]): Promise<Record<string, string>> => {
      const wanted = new Set(ids);
      const byAccount: Record<string, string[]> = {};
      for (const m of messages) {
        if (wanted.has(m.id)) (byAccount[m.account] ??= []).push(m.id);
      }

      const out: Record<string, string> = {};
      for (const [account, accountIds] of Object.entries(byAccount)) {
        const client = clients[account];
        if (!client) continue;
        Object.assign(out, await client.getSnippets(accountIds));
      }
      return out;
    },
    [messages, clients],
  );

  const resetCache = async () => {
    for (const email of viewing) await clearAccount(email);
    setMessages([]);
    void scan(true);
  };

  /* ---------- render ---------- */

  const shellProps = {
    accounts,
    selection,
    onSelect: chooseSelection,
    onAddAccount: signIn,
    onSignOutOf: (email: string) => void signOutOf(email),
    canAddAccount: desktop,
  };

  // Desktop waits for Rust to report what it has stored before choosing a
  // screen, so the user never sees setup flash before their saved session.
  if (!ready) {
    return (
      <Shell {...shellProps} accounts={[]}>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="spinner" />
          <span>Starting…</span>
        </div>
      </Shell>
    );
  }

  const needsSetup = desktop ? !configured : !clientId;

  if (needsSetup) {
    return (
      <Shell {...shellProps} accounts={[]}>
        <SetupScreen
          mode={desktop ? 'desktop' : 'browser'}
          origin={window.location.origin}
          error={error}
          onSave={async (id, secret) => {
            setError(null);
            if (desktop) {
              try {
                await desktopAuth.saveClient(id, secret ?? '');
                setConfigured(true);
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

  if (!accounts.length) {
    return (
      <Shell {...shellProps} accounts={[]}>
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
                setConfigured(false);
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
    <Shell {...shellProps} onRescan={() => void scan(false)} scanning={scanning}>
      {error ? <div className="alert alert-error">{error}</div> : null}

      {combined ? (
        <p className="note combined-note" data-testid="combined-note">
          Showing {accounts.length} mailboxes together. Actions apply to each sender's mail in
          whichever inbox it came from.
        </p>
      ) : null}

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
            <SenderRow key={g.key} group={g} combined={combined} onSelect={() => setSelectedKey(g.key)} />
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
          messages={selectedMessages}
          combined={combined}
          busy={busy}
          onClose={() => setSelectedKey(null)}
          onBulk={handleBulk}
          onUnsubscribe={handleUnsubscribe}
          onCreateFilter={handleCreateFilter}
          loadSnippets={loadSnippets}
        />
      ) : null}
    </Shell>
  );
}

function Shell({
  accounts,
  selection,
  onSelect,
  onAddAccount,
  onSignOutOf,
  canAddAccount,
  onRescan,
  scanning,
  children,
}: {
  accounts: string[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onAddAccount: () => void;
  onSignOutOf: (email: string) => void;
  canAddAccount: boolean;
  onRescan?: () => void;
  scanning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <h1 className="brand">Inbox Sweep</h1>
          {onRescan ? (
            <button className="btn btn-sm" onClick={onRescan} disabled={scanning}>
              Rescan
            </button>
          ) : null}
          {accounts.length ? (
            <AccountSwitcher
              accounts={accounts}
              selected={selection}
              onSelect={onSelect}
              onAdd={onAddAccount}
              onSignOut={onSignOutOf}
              canAdd={canAddAccount}
              busy={scanning}
            />
          ) : null}
        </div>
      </header>
      <main className="content">
        {children}
        <VersionFooter />
      </main>
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

  if (err.isRateLimited) {
    return (
      'Gmail is throttling this account — the scan is going faster than your quota allows. ' +
      'It backs off and retries automatically, so give it a moment. If it keeps happening, ' +
      'scan a narrower scope than All mail.'
    );
  }

  if (err.isPermissionDenied) {
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
