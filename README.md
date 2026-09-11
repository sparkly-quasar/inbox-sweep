# Inbox Sweep

A bulk Gmail cleanup tool that installs to an iPhone home screen. Groups your mailbox by
sender, then lets you trash or archive a sender's entire history in one tap, unsubscribe
from the ones that offer it, and create a Gmail filter so they never come back.

Inspired by [Mailstrom](https://mailstrom.co), which does this well on the desktop web but
isn't usable from a phone. Not affiliated with them, and shares no code with them.

## What it does

- **Group by sender or domain.** Every message is reduced to sender, size, age, unread and
  inbox state, then bucketed. Domain mode folds `news@acme.com` and `billing@acme.com`
  into one row.
- **Bulk actions.** Trash, archive, or mark-read an entire sender at once, behind a
  confirmation step. Trash means Gmail's Trash — recoverable for 30 days. The app never
  calls the permanent-delete endpoint.
- **Unsubscribe.** Senders advertising `List-Unsubscribe` are badged. One-click (RFC 8058)
  senders get a POST; everyone else hands you their link.
- **Filters.** Create a Gmail filter for a sender — skip inbox, mark read, apply a label, or
  send straight to trash. A domain group produces a single filter matching every address.
- **Scopes.** Inbox, all mail, unread, older than a year, large, or newsletters.

## Architecture, and why

**There is no backend.** The app is static files. It talks to the Gmail REST API directly
from the browser using Google Identity Services' implicit token flow.

The trade-off is deliberate. A server would let it hold refresh tokens and run scans in the
background, but it would also mean a machine that holds an access token to your entire
mailbox. There isn't one. Your mail is never transmitted anywhere except between your phone
and Google. The cost you pay: access tokens last about an hour and cannot be silently
refreshed forever, so a long session will occasionally ask you to sign in again.

A few other decisions worth knowing:

- **Tokens live in `sessionStorage`**, not `localStorage`, so they die with the tab rather
  than persisting on disk.
- **Scanning is batched and incremental.** Reading headers one message at a time costs one
  request — and one ~1 KB bearer token — per message, which on a 30 000-message mailbox is
  tens of megabytes of pure overhead on cellular. The Gmail batch endpoint folds 100 reads
  into one request. If batching ever fails the app falls back to concurrent individual
  requests, so a Google-side change degrades speed rather than breaking the app.
- **Message metadata is cached in IndexedDB**, keyed by mailbox. A rescan only fetches IDs
  it has not seen and evicts ones that disappeared, so the expensive full scan happens once.
- **Requests are paced to Gmail's quota** (250 units/sec; `messages.get` costs 5) and back
  off on 429/5xx, honouring `Retry-After`.
- **The service worker caches the app shell only** — never API responses. Caching mail in a
  store that outlives the tab would undo the point of keeping tokens in `sessionStorage`.

## Run it on your laptop

This is the easiest way to use the app, and the best way to try it before bothering with
hosting. No deployment, no HTTPS certificate, no phone involved. It runs in your normal
desktop browser and the layout adapts to the wider window.

You need [Node.js](https://nodejs.org) 20 or newer (`node --version` to check).

```bash
git clone https://github.com/sparkly-quasar/inbox-sweep.git
cd inbox-sweep
npm install
npm start
```

Open **http://localhost:5173**. The app will ask for a Google OAuth client ID — that's the
one genuinely fiddly part, and the next section walks through it. Stop the server with
`Ctrl-C`; run `npm start` again whenever you want it back.

Nothing is installed into your browser and no data leaves your machine: the page talks to
Gmail directly, and closing the tab discards the session.

## Getting a Google OAuth client ID

You need your own. There is no way around this and it isn't a limitation of this app:
Gmail's read/modify permissions are what Google calls **restricted scopes**, and any app
that ships a shared client ID for them must pass Google's verification and a third-party
security assessment. A client you create for yourself skips all of that.

It's free, takes a few minutes, and you only ever do it once. The client ID is **not a
secret** — browser OAuth clients are public by design, so there's no risk in pasting it
into the app or committing it.

Work through these in order at
[console.cloud.google.com](https://console.cloud.google.com):

**1. Make a project.** Click the project dropdown in the top bar → **New Project**. Name it
anything (`inbox-sweep` is fine) → **Create**. Wait for it to finish, then make sure that
new project is the one selected in the top bar — this trips people up, and every step below
applies to whichever project is selected.

**2. Turn on the Gmail API.** Search "Gmail API" in the top search bar, open it, and click
**Enable**. Without this every request fails with a 403.

**3. Set up the consent screen.** In the left menu find **APIs & Services → OAuth consent
screen** (in newer consoles this is **Google Auth Platform**, and the pieces below are split
across its *Branding*, *Audience* and *Data Access* pages):

- **User type / Audience:** choose **External**. "Internal" only exists for Workspace
  organisations and will be greyed out on a personal account.
- **App information / Branding:** an app name and your own email address. Everything else is
  optional — skip it.
- **Data access / Scopes:** click **Add or remove scopes**, then paste each of these into
  the filter box and tick it:
  - `https://www.googleapis.com/auth/gmail.modify` — read headers, apply labels, move to trash
  - `https://www.googleapis.com/auth/gmail.settings.basic` — create filters

  Google will warn that these are sensitive/restricted. That warning is about *publishing*
  an app to the public; it doesn't apply while you're the only user.
- **Test users / Audience:** click **Add users** and add **your own Gmail address**. Miss
  this and sign-in fails with `access_denied`, which is the single most common thing to get
  wrong here.

**4. Create the client.** **APIs & Services → Credentials → Create credentials → OAuth
client ID** → application type **Web application**. Under **Authorised JavaScript origins**
click **Add URI** and enter exactly:

```
http://localhost:5173
```

No trailing slash, no path. Plain `http` is correct here — Google requires HTTPS for every
origin *except* localhost, which is specifically exempt. Leave **Authorised redirect URIs**
empty; this app doesn't use one.

Click **Create**. Copy the client ID that pops up — it looks like
`948...-abc123.apps.googleusercontent.com`.

**5. Paste it into the app** at http://localhost:5173 and click **Save and continue**, then
**Sign in with Google**.

> **The scary warning is expected.** Google shows "Google hasn't verified this app". Click
> **Advanced** → **Go to … (unsafe)**. It says that because *you* created the client and
> haven't submitted it for review — you are trusting an app you built, running on your own
> machine.

If you later deploy the app somewhere, add that new origin (e.g.
`https://inbox-sweep.you.vercel.app`) to the same client's **Authorised JavaScript
origins** — a client can hold several. Changes can take a few minutes to take effect.

### When sign-in doesn't work

| What you see | Cause |
| --- | --- |
| `redirect_uri_mismatch` or `origin_mismatch` | The origin in the browser's address bar isn't in **Authorised JavaScript origins**. It must match exactly — `http://localhost:5173`, not `127.0.0.1`, not a trailing slash. |
| `access_denied` | Your Gmail address isn't in **Test users**. |
| 403 on every request after signing in | The Gmail API isn't enabled on the selected project. |
| Sign-in button does nothing | An ad blocker or tracking-protection setting is blocking `accounts.google.com`. |

## Putting it on your iPhone

For the phone you *do* need to deploy it, because Google won't accept a local-network
address as an origin: the rule is HTTPS-only, with localhost as the sole exception, and raw
IPs like `192.168.1.20` are rejected outright. So running `npm start` and browsing to your
laptop's IP from the phone will not work for sign-in.

Build the static output and put it on any static host — Vercel, Netlify, Cloudflare Pages,
GitHub Pages, or your own web server:

```bash
npm run build      # → dist/
```

Add the resulting HTTPS URL to your OAuth client's **Authorised JavaScript origins**, then
on the phone:

1. Open the URL in **Safari** — only Safari can add to the home screen on iOS.
2. **Share** → **Add to Home Screen**.
3. Launch it from the icon. It runs full-screen with no browser chrome.

For a quick test without deploying, a tunnel such as `cloudflared tunnel --url
http://localhost:5173` or `ngrok http 5173` gives you a temporary public HTTPS address.
Add that address as an origin too — note it changes each time you restart the tunnel.

## Development

```bash
npm install
npm start            # or: npm run dev — http://localhost:5173
npm test             # unit tests (vitest)
npm run test:e2e     # end-to-end tests (playwright, iPhone viewport, stubbed Gmail)
npm run lint
npm run build
npm run icons        # regenerate PNG icons from public/icons/icon.svg
```

### Tests

70 unit tests cover the pure logic — header parsing (quoted names, unbracketed addresses,
`List-Unsubscribe` shapes), sender grouping and display-name selection, sorting, the
multipart batch-response parser including partial failures, and filter construction.

23 end-to-end tests drive the real UI at iPhone viewport against a stubbed Gmail API,
covering the scan, grouping and sorting, every bulk action and its confirmation, unsubscribe,
filter creation, the IndexedDB cache, expired-session handling, the batch→individual
fallback, plus iPhone-specific checks (no horizontal scroll, 44px tap targets, 16px inputs
so Safari doesn't zoom, and an installable manifest whose icons all resolve).

The e2e suite runs on **Chromium with iPhone 13 metrics**, not WebKit — WebKit isn't
installed in this environment. It verifies layout, tap targets and app logic, none of which
are engine-specific. Real Safari behaviour is worth a check on the device itself.

## Known limits

- **Unsubscribe cannot be confirmed.** A browser sends a cross-origin one-click POST but is
  not allowed to read the response, so the app reports the request as *sent*, not
  *succeeded*. Rescan in a few days to see whether it took.
- **Filters are not retroactive.** Gmail applies them only to mail that arrives after
  creation. Use Trash or Archive for what's already there — the sheet says so.
- **Sessions expire hourly.** A consequence of having no backend; see above.
- **A first scan of a very large mailbox takes minutes** and is quota-bound at roughly 50
  messages/second. It is cached afterwards, and it is resumable — partial progress is banked
  as it goes, so stopping and restarting doesn't start over.
