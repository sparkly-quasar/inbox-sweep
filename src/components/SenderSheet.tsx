import { useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { MessageList } from './MessageList';
import { openUrl } from '../lib/desktop';
import type { SenderGroup } from '../lib/group';
import { formatAge, formatSize, type MessageMeta } from '../lib/parse';
import {
  buildFromCriterion,
  describeAction,
  type BulkAction,
  type FilterPlan,
  type UnsubscribeOutcome,
} from '../lib/actions';

export interface SenderSheetProps {
  group: SenderGroup;
  /** Every message in this group, for review before acting. */
  messages: MessageMeta[];
  busy: boolean;
  /** True when the combined view is on, so rows are labelled by mailbox. */
  combined?: boolean;
  onClose: () => void;
  /** Acts on exactly these messages, split by mailbox. */
  onBulk: (action: BulkAction, messagesByAccount: Record<string, string[]>) => Promise<void>;
  onUnsubscribe: () => Promise<UnsubscribeOutcome>;
  onCreateFilter: (plan: FilterPlan) => Promise<void>;
  loadSnippets?: (ids: string[]) => Promise<Record<string, string>>;
}

type View = 'actions' | 'confirm' | 'filter';

export function SenderSheet({
  group,
  messages,
  busy,
  combined,
  onClose,
  onBulk,
  onUnsubscribe,
  onCreateFilter,
  loadSnippets,
}: SenderSheetProps) {
  const [view, setView] = useState<View>('actions');
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  /** Empty means "everything in the group" — the common case. */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filter plan state.
  const [skipInbox, setSkipInbox] = useState(true);
  const [markRead, setMarkRead] = useState(true);
  const [useLabel, setUseLabel] = useState(false);
  const [labelName, setLabelName] = useState('Bulk');
  const [deleteIt, setDeleteIt] = useState(false);

  /**
   * What an action will actually touch: the reviewed selection when there is
   * one, otherwise the whole group. Split by mailbox either way, because each
   * account needs its own API call.
   */
  const target = useMemo(() => {
    if (selected.size === 0) {
      return { byAccount: group.messagesByAccount, count: group.count, accounts: group.accounts };
    }
    const byAccount: Record<string, string[]> = {};
    for (const m of messages) {
      if (selected.has(m.id)) (byAccount[m.account] ??= []).push(m.id);
    }
    return {
      byAccount,
      count: selected.size,
      accounts: Object.keys(byAccount).sort(),
    };
  }, [selected, messages, group]);

  const confirmBulk = (action: BulkAction) => {
    setPending(action);
    setNotice(null);
    setView('confirm');
  };

  const runBulk = async () => {
    if (!pending) return;
    try {
      await onBulk(pending, target.byAccount);
      // The sheet closes on success — the group is usually gone.
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
      setView('actions');
    }
  };

  const runUnsubscribe = async () => {
    setNotice(null);
    try {
      const outcome = await onUnsubscribe();
      switch (outcome.kind) {
        case 'one-click-sent':
          setNotice({
            tone: 'ok',
            text: 'Unsubscribe request sent. Your browser hides the response, so give it a few days and re-scan to confirm it took effect.',
          });
          break;
        case 'open-url':
          await openUrl(outcome.url);
          setNotice({
            tone: 'ok',
            text: 'Opened the unsubscribe page in your browser — finish it there.',
          });
          break;
        case 'mailto':
          await openUrl(outcome.url);
          break;
        case 'unavailable':
          setNotice({ tone: 'error', text: 'This sender did not include an unsubscribe link.' });
          break;
      }
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const runCreateFilter = async () => {
    setNotice(null);
    try {
      await onCreateFilter({
        from: group.addresses,
        skipInbox: deleteIt ? false : skipInbox,
        markRead: deleteIt ? false : markRead,
        labelName: !deleteIt && useLabel ? labelName.trim() : undefined,
        delete: deleteIt,
      });
      setNotice({ tone: 'ok', text: 'Filter created. It applies to mail that arrives from now on.' });
      setView('actions');
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const subtitle = (
    <>
      {group.addresses.length > 1 ? `${group.addresses.length} addresses · ` : `${group.key} · `}
      {group.count.toLocaleString()} messages · {formatSize(group.size)} · newest{' '}
      {formatAge(group.newest)} ago
      {group.accounts.length > 1 ? ` · in ${group.accounts.join(' and ')}` : ''}
    </>
  );

  if (view === 'confirm' && pending) {
    const destructive = pending === 'trash';
    return (
      <Sheet title={destructive ? 'Move to Trash?' : 'Confirm'} onClose={() => setView('actions')}>
        <p className="sub">{describeAction(pending, group, target.count, target.accounts)}</p>
        {selected.size > 0 ? (
          <p className="note">
            Only the {selected.size.toLocaleString()} message
            {selected.size === 1 ? '' : 's'} you selected. The rest are left alone.
          </p>
        ) : null}
        <div className="action-grid">
          <button
            className={`btn btn-block ${destructive ? 'btn-danger' : 'btn-primary'}`}
            onClick={runBulk}
            disabled={busy}
            data-testid="confirm-action"
          >
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Working…' : destructive ? `Trash ${target.count.toLocaleString()}` : 'Confirm'}
          </button>
          <button className="btn btn-block" onClick={() => setView('actions')} disabled={busy}>
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  if (view === 'filter') {
    return (
      <Sheet title="Create a filter" subtitle={`Future mail from ${group.name}`} onClose={() => setView('actions')}>
        {notice ? <div className={`alert alert-${notice.tone}`}>{notice.text}</div> : null}

        <label className="check">
          <input type="checkbox" checked={deleteIt} onChange={(e) => setDeleteIt(e.target.checked)} />
          <span>Send straight to Trash</span>
        </label>

        {!deleteIt && (
          <>
            <label className="check">
              <input type="checkbox" checked={skipInbox} onChange={(e) => setSkipInbox(e.target.checked)} />
              <span>Skip the inbox (archive it)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} />
              <span>Mark as read</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={useLabel} onChange={(e) => setUseLabel(e.target.checked)} />
              <span>Apply a label</span>
            </label>
            {useLabel && (
              <input
                className="field"
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                placeholder="Label name"
                aria-label="Label name"
                autoCapitalize="words"
              />
            )}
          </>
        )}

        <p className="note">
          Matches <code>from:{buildFromCriterion(group.addresses)}</code>
        </p>
        <p className="note">
          Gmail filters only apply to mail that arrives after they're created. Use Trash or Archive
          above for the {group.count.toLocaleString()} already here.
        </p>
        {group.accounts.length > 1 ? (
          <p className="note">
            This sender appears in {group.accounts.length} mailboxes, so the filter is created in
            each of them: {group.accounts.join(', ')}.
          </p>
        ) : null}

        <div className="action-grid" style={{ marginTop: 14 }}>
          <button className="btn btn-primary btn-block" onClick={runCreateFilter} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Creating…' : 'Create filter'}
          </button>
          <button className="btn btn-block" onClick={() => setView('actions')} disabled={busy}>
            Back
          </button>
        </div>
      </Sheet>
    );
  }

  const actionSuffix = selected.size > 0 ? ` ${selected.size.toLocaleString()} selected` : '';

  return (
    <Sheet title={group.name} subtitle={subtitle} onClose={onClose}>
      {notice ? <div className={`alert alert-${notice.tone}`}>{notice.text}</div> : null}

      <button
        className="btn btn-block"
        onClick={() => setReviewing((r) => !r)}
        data-testid="toggle-review"
        style={{ marginBottom: 12 }}
      >
        {reviewing ? 'Hide messages' : `Review ${group.count.toLocaleString()} messages…`}
      </button>

      {reviewing ? (
        <MessageList
          messages={messages}
          selected={selected}
          showAccounts={combined && group.accounts.length > 1}
          loadSnippets={loadSnippets}
          onToggle={(id) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectAll={() => setSelected(new Set(messages.map((m) => m.id)))}
          onClearSelection={() => setSelected(new Set())}
        />
      ) : null}

      <div className="action-grid">
        <button
          className="btn btn-danger btn-block"
          onClick={() => confirmBulk('trash')}
          disabled={busy || target.count === 0}
          data-testid="action-trash"
        >
          Trash {selected.size > 0 ? actionSuffix.trim() : `all ${group.count.toLocaleString()}`}
        </button>

        <div className="row">
          <button
            className="btn"
            onClick={() => confirmBulk('archive')}
            disabled={busy || (selected.size === 0 && group.inInbox === 0)}
          >
            Archive{selected.size > 0 ? actionSuffix : group.inInbox > 0 ? ` ${group.inInbox.toLocaleString()}` : ''}
          </button>
          <button
            className="btn"
            onClick={() => confirmBulk('markRead')}
            disabled={busy || (selected.size === 0 && group.unread === 0)}
          >
            Mark read{selected.size > 0 ? actionSuffix : group.unread > 0 ? ` ${group.unread.toLocaleString()}` : ''}
          </button>
        </div>

        <button
          className="btn btn-block"
          onClick={runUnsubscribe}
          disabled={busy || !group.unsubscribe}
          data-testid="action-unsubscribe"
        >
          {group.unsubscribe
            ? group.unsubscribe.oneClick
              ? 'Unsubscribe (one-click)'
              : 'Unsubscribe…'
            : 'No unsubscribe link'}
        </button>

        <button
          className="btn btn-block"
          onClick={() => {
            setNotice(null);
            setView('filter');
          }}
          disabled={busy}
          data-testid="action-filter"
        >
          Create a filter…
        </button>
      </div>

      {group.addresses.length > 1 && (
        <p className="note">
          Addresses: {group.addresses.slice(0, 6).join(', ')}
          {group.addresses.length > 6 ? `, +${group.addresses.length - 6} more` : ''}
        </p>
      )}

      <button className="btn btn-block" onClick={onClose} disabled={busy} style={{ marginTop: 12 }}>
        Close
      </button>
    </Sheet>
  );
}
