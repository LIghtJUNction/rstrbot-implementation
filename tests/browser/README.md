# Local browser acceptance

This harness starts a disposable SQLite RstrBot instance and drives its actual
WebUI using Chromium. No personal browser, account, external model or external
website is used. All users, documents and conversations are synthetic fixtures.

Build the Rust binaries and `web/dist`, then run:

```sh
cd tests/browser
npm ci
npx playwright install chromium
npm test -- --binary ../../target/debug/rstrbot
```

To use an already-installed Chromium executable, pass `--chromium /absolute/path`.
Use `--web-dir /path/to/dist` for a separate web build, and `--evidence-dir /path/to/results` to select a receipt/log directory. Without an evidence directory, the UI harness writes to a new system temporary directory.
The harness can also load the exact pinned Playwright version from
`CODEX_PRIMARY_RUNTIME_NODE_MODULES` when that runtime is available.

The run checks setup, model and plugin forms, the actual diagnostic worker/tool
round trip, delayed **real** chat HTTP responses, draft preservation after page
unmount/remount, workspace changes while conversation creation is pending,
removal of deleted conversation content from the visible cache, denied caches
remaining empty across 503 errors and remounts until a successful read, knowledge editing,
resource pagination beyond 200 entries, an agent's default model,
account switching after session expiry, explicit credential clearing when a model
destination changes, mobile navigation, locale and theme.
The UI harness writes screenshots in the selected evidence directory and its report to `browser.json`. The binary and web hashes are checked again at exit;
a changed build invalidates the result.

The diagnostic worker is a process fixture, not an AI model. This is a bounded
Chromium acceptance check, not complete browser, screen-reader, native-desktop,
visual-design or production-provider certification. Resource list search is over
loaded pages; the harness exercises the visible pagination controls.

## Identity and account security

Run the additional authentication harness against the same built binaries and
WebUI:

```sh
node verify_security.mjs --binary ../../target/debug/rstrbot
```

It accepts the same `--binary`, `--chromium` and `--evidence-dir` arguments.
Reports use `security-browser.json` and `security-browser-server.log`; screenshots
are under `artifacts/screenshots/security/`. Python 3 is used solely to advance a
recent-authentication timestamp inside the disposable SQLite fixture.

The server listens on loopback and the browser uses `http://localhost:<port>`
with RP ID `localhost`. Chromium's CDP WebAuthn domain creates two kinds of
virtual CTAP2 authenticators: a USB security key and an internal authenticator
reporting backup eligibility and backup state. Both generate actual public-key
credentials and signatures, and the application verifies them with its normal
WebAuthn implementation and required user verification.

The checks cover:

- Administrator origin, Google and SMTP configuration, write-only secrets and
  delivery to an in-process loopback SMTP receiver.
- Multiple passkeys, accurate authenticator-reported backup labels, rename,
  cancellation before replacement submission, atomic replacement, removal of
  one key while another remains usable, and sign-in with the retained key.
- Rejection of a consumed registration challenge, a removed credential signing
  a fresh challenge, a proof missing user verification, and tampered signed
  origin data. Failed secondary proofs preserve the main authenticated session.
- Explicit same-session email verification, delivered recovery links, password
  confirmation and sign-in with the verified email after recovery.
- An account page that remains accessible without workspace membership,
  responsive navigation and both supported languages/themes.
- Shared-cookie identity changes across two tabs: the old view is blocked and
  private cached history/drafts never appear under the incoming account.
- A delayed password reauthentication response after its dialog is closed:
  it cannot run a different action queued by a new dialog.
- Background configuration changes while a local draft contains typed secrets:
  inputs and their original revision remain intact, a stale save conflicts, and
  an explicit discard/reload updates the form. Fields are locked while saving.

The harness respects the production authentication rate limit and may pause
between batches. It does not lower or disable that limit. Every request stays on
the temporary local instance; SMTP recipients and Google credentials are
synthetic. A virtual authenticator's backup flags exercise the protocol and UI
labels, not real cloud synchronization or a particular password-manager vendor.
Real Google account login, real hardware, platform-native prompts and delivery
through an external SMTP provider still require a deployment configured with
those services.

## Model and channel configuration

Run the focused configuration checks after building the binaries and WebUI:

```sh
node tests/browser/verify_configuration.mjs --chromium /absolute/path/to/chromium
```

Run this command from the implementation root. It starts and removes its own system-temp SQLite fixture, prints checks and input hashes to stdout, and creates no checkout output directory. It verifies field labels, inline step errors, keyboard submission, cancellation and stale discovery results, single-flight saving, exact prices, a disabled Webhook at 320px, and the current embedded recipe prompt with preserved browser drafts. Diagnostic discovery uses the actual core/plugin; delayed response cases intercept HTTP. No commercial provider or external delivery is exercised.

## Unconfirmed chat recovery

`verify_feedback.mjs` accepts `--web-dir /path/to/dist`. Its chat checks drop an accepted response or a request before it reaches the core, reload, and verify that manual continuation reuses the request while reconnect itself sends nothing. It also covers changed text/model/agent, explicit new intent, late acknowledgement and browser storage denial against the isolated core and diagnostic worker. This does not establish cross-device or simultaneously sending tab coordination.

The chat-recovery checks also exercise two concurrent tabs, a stale confirmation, and unavailable browser locks. These tests use same-origin Chromium and do not prove cross-device coordination.

## Delivery recovery

Run `node tests/browser/verify_delivery_ui.mjs --chromium /absolute/path/to/chromium` after building the WebUI and binaries. It creates a temporary core and loopback HTTP receiver, drops acknowledgements, and counts received requests while exercising explicit recovery, multiple tabs, reload, legacy session state, storage refusal and unavailable browser locks. The receiver is a fixture; this does not establish delivery across devices or after browser data is cleared.
