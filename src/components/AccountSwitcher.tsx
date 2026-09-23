import { useEffect, useRef, useState } from 'react';

/** `null` selects the combined view across every mailbox. */
export type Selection = string | null;

/**
 * Mailbox picker for the header.
 *
 * Sits top-right because that is where account controls live in every mail
 * client, and because the header is the one element present on every screen.
 */
export function AccountSwitcher({
  accounts,
  selected,
  onSelect,
  onAdd,
  onSignOut,
  canAdd,
  busy,
}: {
  accounts: string[];
  selected: Selection;
  onSelect: (selection: Selection) => void;
  onAdd: () => void;
  onSignOut: (email: string) => void;
  /** False in the browser build, which can only hold one mailbox. */
  canAdd: boolean;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Dismiss on an outside click or Escape, like any other menu.
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const combined = selected === null && accounts.length > 1;
  const label = combined ? 'All inboxes' : (selected ?? accounts[0] ?? '');

  const choose = (selection: Selection) => {
    onSelect(selection);
    setOpen(false);
  };

  return (
    <div className="switcher" ref={wrapper}>
      <button
        className="btn btn-sm switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        data-testid="account-switcher"
      >
        <span className="switcher-label">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="switcher-menu" role="menu">
          {accounts.length > 1 ? (
            <button
              className="switcher-item"
              role="menuitem"
              aria-checked={combined}
              onClick={() => choose(null)}
              data-testid="select-combined"
            >
              <span className="switcher-check">{combined ? '✓' : ''}</span>
              <span>
                All inboxes
                <small>Every mailbox at once</small>
              </span>
            </button>
          ) : null}

          {accounts.map((email) => (
            <div className="switcher-row" key={email}>
              <button
                className="switcher-item"
                role="menuitem"
                aria-checked={selected === email}
                onClick={() => choose(email)}
                data-testid="select-account"
              >
                <span className="switcher-check">{selected === email ? '✓' : ''}</span>
                <span className="switcher-email">{email}</span>
              </button>
              <button
                className="switcher-remove"
                onClick={() => {
                  // The row is about to disappear; leaving the menu open over
                  // a stale list reads as a bug.
                  setOpen(false);
                  onSignOut(email);
                }}
                title={`Sign out of ${email}`}
                aria-label={`Sign out of ${email}`}
                data-testid="switcher-sign-out"
              >
                ×
              </button>
            </div>
          ))}

          {canAdd ? (
            <button
              className="switcher-item switcher-add"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
              data-testid="add-account"
            >
              <span className="switcher-check">+</span>
              <span>Add another account…</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
