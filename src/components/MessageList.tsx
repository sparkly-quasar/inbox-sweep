import { useEffect, useMemo, useState } from 'react';
import { formatAge, formatSize, type MessageMeta } from '../lib/parse';
import { openUrl } from '../lib/desktop';

/** How many rows to render before asking the user to expand. */
const PAGE = 50;

/**
 * Deep link to one message in Gmail's web UI.
 *
 * `authuser` picks the right mailbox when several Google accounts are signed
 * in, which matters a lot in the combined view. `#all/` searches every folder,
 * so it still resolves for archived mail.
 */
function gmailLink(message: MessageMeta): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(
    message.account,
  )}#all/${encodeURIComponent(message.id)}`;
}

/**
 * The individual messages behind a sender group, so a decision can be made on
 * what the mail actually is rather than on the sender alone.
 *
 * Subject, date, size and read state come free — the scan already cached them.
 * Previews are fetched on demand for the rows on screen, because carrying them
 * through a whole-mailbox scan would cost megabytes for text that is only ever
 * read one sender at a time.
 */
export function MessageList({
  messages,
  selected,
  onToggle,
  onSelectAll,
  onClearSelection,
  loadSnippets,
  showAccounts,
}: {
  messages: MessageMeta[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** Resolves previews for the given ids; may return fewer than asked. */
  loadSnippets?: (ids: string[]) => Promise<Record<string, string>>;
  /** Label each row with its mailbox — only useful in the combined view. */
  showAccounts?: boolean;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const [loadingPreviews, setLoadingPreviews] = useState(false);

  // Newest first: the recent mail is what people judge a sender by.
  const ordered = useMemo(() => [...messages].sort((a, b) => b.date - a.date), [messages]);
  const visible = useMemo(() => ordered.slice(0, limit), [ordered, limit]);

  // Fetch previews for rows that are actually on screen, and only once each.
  useEffect(() => {
    if (!loadSnippets) return;
    const missing = visible.filter((m) => !m.snippet && !(m.id in snippets)).map((m) => m.id);
    if (!missing.length) return;

    let cancelled = false;
    setLoadingPreviews(true);
    loadSnippets(missing)
      .then((fetched) => {
        if (cancelled) return;
        // Record every id asked for, so one that has no preview is not
        // retried on every render.
        const merged: Record<string, string> = {};
        for (const id of missing) merged[id] = fetched[id] ?? '';
        setSnippets((prev) => ({ ...prev, ...merged }));
      })
      .catch(() => {
        /* a missing preview greys out a row; it must not break the review */
      })
      .finally(() => {
        if (!cancelled) setLoadingPreviews(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visible, loadSnippets, snippets]);

  const allSelected = selected.size === messages.length && messages.length > 0;

  return (
    <div className="msg-list" data-testid="message-list">
      <div className="msg-toolbar">
        <button
          className="btn btn-sm"
          onClick={allSelected ? onClearSelection : onSelectAll}
          data-testid="toggle-select-all"
        >
          {allSelected ? 'Clear selection' : 'Select all'}
        </button>
        <span className="msg-count">
          {selected.size > 0
            ? `${selected.size.toLocaleString()} of ${messages.length.toLocaleString()} selected`
            : `${messages.length.toLocaleString()} messages`}
          {loadingPreviews ? ' · loading previews…' : ''}
        </span>
      </div>

      <ul className="msg-rows">
        {visible.map((m) => {
          const preview = m.snippet ?? snippets[m.id] ?? '';
          const isSelected = selected.has(m.id);
          return (
            <li key={`${m.account}:${m.id}`} className={m.unread ? 'msg unread' : 'msg'}>
              <label className="msg-pick">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(m.id)}
                  aria-label={`Select ${m.subject || 'message with no subject'}`}
                />
              </label>

              <div className="msg-body">
                <div className="msg-subject">
                  {m.subject || <em>(no subject)</em>}
                  {showAccounts ? <span className="tag msg-account">{m.account}</span> : null}
                </div>
                {preview ? <div className="msg-snippet">{preview}</div> : null}
              </div>

              <div className="msg-meta">
                <span>{formatAge(m.date)}</span>
                <span>{formatSize(m.size)}</span>
                <button
                  className="linkish"
                  onClick={() => void openUrl(gmailLink(m)).catch(() => undefined)}
                  title="Open this message in Gmail"
                  data-testid="open-in-gmail"
                >
                  Open
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {ordered.length > limit ? (
        <button
          className="btn btn-sm btn-block"
          onClick={() => setLimit((n) => n + PAGE)}
          data-testid="show-more-messages"
        >
          Show {Math.min(PAGE, ordered.length - limit)} more of{' '}
          {(ordered.length - limit).toLocaleString()}
        </button>
      ) : null}
    </div>
  );
}
