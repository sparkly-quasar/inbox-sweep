import { useState } from 'react';

export type SetupMode = 'browser' | 'desktop';

/**
 * First-run screen: collect the Google OAuth client.
 *
 * The two builds need genuinely different clients, so this screen adapts
 * rather than pretending they're the same:
 *
 * - **Browser** wants a *Web application* client, identified by an authorised
 *   JavaScript origin. No secret — the token never leaves the page.
 * - **Desktop** wants a *Desktop app* client, which also issues a secret.
 *   Google documents that secret as non-confidential for installed apps, but
 *   requires it in the token exchange regardless.
 *
 * In the browser build the ID can also be baked in at build time via
 * `VITE_GOOGLE_CLIENT_ID`. Accepting it at runtime means the app can be
 * deployed once and configured later, without a rebuild.
 */
export function SetupScreen({
  origin,
  onSave,
  error,
  mode = 'browser',
}: {
  origin: string;
  onSave: (clientId: string, clientSecret?: string) => void | Promise<void>;
  error?: string | null;
  mode?: SetupMode;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const desktop = mode === 'desktop';
  const id = clientId.trim();
  const secret = clientSecret.trim();
  const looksValid = /\.apps\.googleusercontent\.com$/.test(id);
  const canSave = desktop ? Boolean(id && secret) : Boolean(id);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(id, desktop ? secret : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>One-time setup</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Inbox Sweep talks to Gmail directly from this device. To let it, you create a free Google
        OAuth client — it takes about three minutes and you only do it once.
      </p>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <ol className="setup-steps">
        <li>
          Open <code>console.cloud.google.com</code> and create a project.
        </li>
        <li>
          Under <b>APIs &amp; Services → Library</b>, enable the <b>Gmail API</b>.
        </li>
        <li>
          Under <b>OAuth consent screen</b>, choose <b>External</b>, fill in the app name and your
          email, and add your own Gmail address under <b>Test users</b> — miss this and sign-in
          fails.
        </li>
        <li>
          Add the scopes <code>gmail.modify</code> and <code>gmail.settings.basic</code>.
        </li>
        {desktop ? (
          <li>
            Under <b>Credentials</b>, create an <b>OAuth client ID</b> of type <b>Desktop app</b>.
            Copy both the client ID and the client secret.
          </li>
        ) : (
          <li>
            Under <b>Credentials</b>, create an <b>OAuth client ID</b> of type{' '}
            <b>Web application</b>, and add this exact URL under{' '}
            <b>Authorised JavaScript origins</b>:
            <br />
            <code>{origin}</code>
          </li>
        )}
      </ol>

      <label className="lbl" htmlFor="client-id" style={{ marginTop: 14 }}>
        OAuth client ID
      </label>
      <input
        id="client-id"
        className="field"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        placeholder="1234-abc.apps.googleusercontent.com"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        data-testid="client-id-input"
      />

      {desktop && (
        <>
          <label className="lbl" htmlFor="client-secret" style={{ marginTop: 12 }}>
            Client secret
          </label>
          <input
            id="client-secret"
            className="field"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="GOCSPX-…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="client-secret-input"
          />
          <p className="note">
            Google issues this alongside the ID for desktop clients and requires it when exchanging
            the sign-in code. It is stored on this computer only.
          </p>
        </>
      )}

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 12 }}
        disabled={!canSave || saving}
        onClick={save}
        data-testid="save-client-id"
      >
        {saving ? <span className="spinner" /> : null}
        {saving ? 'Saving…' : 'Save and continue'}
      </button>

      {id && !looksValid ? (
        <p className="note">
          That doesn't look like a Google client ID — they normally end in
          <code>.apps.googleusercontent.com</code>. You can still try it.
        </p>
      ) : null}
    </div>
  );
}
