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

## Three ways to run it

| | What you get | What it costs |
| --- | --- | --- |
| **Mac app** | A real `.app` in your Applications folder. Dock icon, own window, no Terminal. Sign-in lasts ~7 days, not one hour. | [Download the `.dmg`](https://github.com/sparkly-quasar/inbox-sweep/releases); Gatekeeper needs one right-click on first launch. |
| **Laptop browser** | Works in a few minutes with only Node installed. | A Terminal window must stay open, and you re-sign-in about hourly. |
| **Phone / deployed** | Installs to the iPhone home screen from any HTTPS host. | Needs somewhere to deploy; also re-signs-in hourly. |

All three run the same app against the same Gmail account. Setting up one doesn't stop you
adding another later.

## Run it as a Mac app

The desktop build is a [Tauri](https://tauri.app) app: the same interface, wrapped in a
native window using macOS's own WebKit, so the whole thing is around 10 MB rather than the
150 MB+ an Electron app would cost.

It is not just the web app in a window, because it couldn't be. **Google has blocked OAuth
inside embedded webviews since February 2023** — a sign-in page loaded in an app window is
refused with `disallowed_useragent`, and working around it by faking the user agent breaks
Google's terms. So the desktop build authenticates the way Google intends for installed
apps ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)): it opens **your real
browser** for consent, catches the redirect on a loopback port, and exchanges the code
using PKCE.

That detour buys something worthwhile. A desktop client gets a **refresh token**, so the
app signs itself back in silently instead of prompting every hour.

How long that lasts depends on a setting most guides gloss over. Google issues a refresh
token that **expires after 7 days** to any external app whose publishing status is
*Testing* — which is where a personal OAuth client lives, and where it should stay. So in
practice the Mac app asks you to sign in about once a week rather than once an hour. Moving
to *In production* would remove that limit, but with Gmail's restricted scopes it also
demands Google's full verification and a third-party security assessment, so it isn't worth
it for a personal tool. A refresh token also dies if you change your Google password, since
it carries Gmail scopes. The app handles all of this the same way: it discards the dead
token and shows the sign-in screen.

### Download it

Grab the latest `.dmg` from
[**Releases**](https://github.com/sparkly-quasar/inbox-sweep/releases), open it, and drag
**Inbox Sweep** to Applications. The build is **universal** — one binary covering both
Apple Silicon and Intel Macs — and needs macOS 10.15 or later. Nothing to install, no
toolchain, no Terminal.

On first launch macOS will refuse to open it: *"Apple cannot check it for malicious
software."* That's Gatekeeper reacting to an app signed by nobody, not a problem with the
build. Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/Inbox Sweep.app"
```

then right-click the app → **Open** → **Open**. It launches normally from then on.

Making it open cleanly on the first double-click requires notarisation, which needs an
Apple Developer account at $99/year — hard to justify for a personal tool.

### Building it yourself

On the Mac, with [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) and Xcode
Command Line Tools (`xcode-select --install`):

```bash
git clone https://github.com/sparkly-quasar/inbox-sweep.git
cd inbox-sweep
npm install
npm run mac:build
```

The first build compiles the Rust dependency tree and takes a few minutes; later builds are
much faster. You'll find the app at:

```
src-tauri/target/release/bundle/macos/Inbox Sweep.app
```

Drag it to **Applications**. To iterate on the code instead, `npm run mac:dev` runs it with
hot reload.

A local build targets **your own Mac's architecture only**. The universal binary in
Releases comes from `--target universal-apple-darwin`, which needs both Rust targets
installed:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

### Cutting a release

Tag and push; the `release` workflow builds the universal bundle on a macOS runner,
verifies with `lipo` that both architectures really made it in, and publishes the `.dmg`
and `.zip` to the release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The arch check is there because a build that silently came out single-architecture installs
perfectly on the machine that made it and fails on half the Macs that download it. Better
to fail the release.

### Its OAuth client is a different one

The Mac app needs a **Desktop app** client, not the Web application client the browser build
uses — different type, and it comes with a client secret that the token exchange requires.
Everything else in the [setup walkthrough](#getting-a-google-oauth-client-id) is the same:
same project, same Gmail API, same scopes, same Test users entry. At step 4 choose
**Desktop app** instead of Web application, skip the authorised-origins field entirely, and
paste both the ID and the secret into the app.

Google still shows the unverified-app warning. Same reason, same answer: **Advanced → Go to
… (unsafe)**.

### Where it keeps things

Credentials live in `~/Library/Application Support/io.github.sparkly-quasar.inbox-sweep/credentials.json`,
written `0600` so only your account can read it.

This is a deliberate trade-off worth stating plainly: the browser build keeps its token in
`sessionStorage`, where it dies with the tab and never touches disk. A refresh token has to
outlive the process — that is the entire point of it — so the desktop app stores one. The
file permissions are the same protection `gcloud` and `npm` rely on. The macOS Keychain
would be stronger; if you'd rather have that, it's a contained change to `src-tauri/src/store.rs`.

**Sign out** deletes the refresh token but keeps your client credentials, so signing back in
is one click. **Change OAuth client** erases everything.

## Run it on your laptop

This is the easiest way to *try* the app — no deployment, no HTTPS certificate, no Rust
toolchain. It runs in your normal desktop browser and the layout adapts to the wider window.

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

| What you see | Cause and fix |
| --- | --- |
| **"Access blocked: … has not completed the Google verification process"** — a red screen with no way past it | The account you're signing in with isn't in **Test users**, or the app was switched to *In production*. See below — this is the most common one. |
| "Google hasn't verified this app" **with an Advanced link** | Expected, and not the same thing. Click **Advanced → Go to … (unsafe)**. Your own unverified client always shows this. |
| `redirect_uri_mismatch` or `origin_mismatch` | The origin in the browser's address bar isn't in **Authorised JavaScript origins**. It must match exactly — `http://localhost:5173`, not `127.0.0.1`, not a trailing slash. Desktop-app clients don't use this field at all. |
| `access_denied` | Same cause as the first row: missing **Test users** entry. |
| 403 on every request after signing in | The Gmail API isn't enabled on the selected project. |
| Sign-in button does nothing | An ad blocker or tracking-protection setting is blocking `accounts.google.com`. |

### "Access blocked: has not completed the Google verification process"

This one has no **Advanced** escape hatch, which is what distinguishes it from the ordinary
unverified-app warning. It means Google is refusing outright, for one of two reasons.

**Either the signing-in account isn't an approved tester.** Go to **APIs & Services → OAuth
consent screen** (newer consoles: **Google Auth Platform → Audience**) and look at **Test
users**. Add the *exact* Google account you are signing in with — a work account, or a
second personal account you happen to be signed into in that browser, will be rejected even
though the client is yours. If several Google accounts are logged in, the consent screen may
have picked a different one than you expect; check which address it shows.

**Or the app's publishing status is "In production".** With Gmail's restricted scopes, an
unverified production app is blocked for everyone, including you. On that same page click
**Back to testing**. Production status is only worth pursuing if you intend to distribute
the app publicly and complete Google's verification and security assessment.

After either change, sign in again — it takes effect immediately, no waiting.

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
npm run test:e2e     # end-to-end tests (playwright, stubbed Gmail)
npm run lint
npm run build
npm run icons        # regenerate PWA icons from public/icons/icon.svg

npm run mac:dev      # run the Mac app with hot reload   (needs Rust)
npm run mac:build    # produce the .app bundle           (needs Rust + macOS)
npm run mac:test     # Rust unit tests                   (needs Rust)
```

### Layout

```
src/            React app — shared by every build
  lib/gmail.ts    Gmail REST client: batching, quota pacing, retries
  lib/scan.ts     scan orchestration and incremental caching
  lib/auth.ts     browser OAuth (Google Identity Services, implicit)
  lib/desktop.ts  bridge to the Tauri commands; inert in the browser
src-tauri/      Rust — desktop build only
  src/oauth.rs    native-app OAuth: loopback listener, PKCE, token exchange
  src/store.rs    credential persistence
  src/lib.rs      the Tauri commands the frontend calls
```

### Tests

**70 unit tests** (vitest) cover the pure TypeScript — header parsing (quoted names,
unbracketed addresses, `List-Unsubscribe` shapes), sender grouping and display-name
selection, sorting, the multipart batch-response parser including partial failures, and
filter construction.

**16 Rust unit tests** (`cargo test`) cover the desktop OAuth logic — percent
encode/decode round-trips and malformed input, HTTP request-line and query parsing, the
consent URL carrying everything Google needs, the PKCE challenge against the RFC 7636 test
vector, and credential storage including corrupt files and file permissions.

**36 end-to-end tests** (playwright) drive the real UI against a stubbed Gmail API:

- the scan, grouping and sorting, every bulk action and its confirmation, unsubscribe,
  filter creation, the IndexedDB cache, expired sessions, and the batch→individual fallback
- iPhone-specific checks: no horizontal scroll, 44px tap targets, 16px inputs so Safari
  doesn't zoom, and an installable manifest whose icons all resolve
- the desktop flow, by replacing `window.__TAURI_INTERNALS__` with a fake backend so the
  real `src/lib/desktop.ts` runs: setup asking for a secret, silent sign-in from a stored
  refresh token, recovery from a revoked one, sign-out, and forgetting the client

Two gaps worth naming, both needing hardware this was not built on:

- The e2e suite runs on **Chromium with iPhone 13 metrics**, not WebKit. It verifies layout
  and logic, which aren't engine-specific, but real Safari deserves a look on the device.
- The Rust is compiled and unit-tested **on Linux**. The **IPC wiring between the frontend
  and the Rust commands, the `.app` bundling, and the live Google round-trip have not been
  executed** — they need a Mac. Everything either side of that boundary is tested; the
  boundary itself isn't.

## Known limits

- **Unsubscribe cannot be confirmed.** A browser sends a cross-origin one-click POST but is
  not allowed to read the response, so the app reports the request as *sent*, not
  *succeeded*. Rescan in a few days to see whether it took.
- **Filters are not retroactive.** Gmail applies them only to mail that arrives after
  creation. Use Trash or Archive for what's already there — the sheet says so.
- **Sessions expire hourly in the browser build.** A consequence of having no backend; see
  above. The Mac app doesn't have this problem — it holds a refresh token and signs itself
  back in silently.
- **A first scan of a very large mailbox takes minutes** and is quota-bound at roughly 50
  messages/second. It is cached afterwards, and it is resumable — partial progress is banked
  as it goes, so stopping and restarting doesn't start over.
