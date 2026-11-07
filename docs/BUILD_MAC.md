# Building X to Nostr Mirror on a Mac

These steps build the app from the source in [`app/`](../app) and produce an **unsigned, not notarized**
`.app` inside a zip.

Status:

- Version 0.1 was built and run successfully on an Apple Silicon (M2) Mac.
- Version 0.2.0, which is the source here, passes its automated tests and was packaged on Linux. It has
  **not yet been verified on a Mac**.

## Prerequisites

| Requirement | Version |
|---|---|
| macOS | Apple Silicon (arm64) or Intel (x64) |
| Node.js | **22.12 or newer**: Node 22 LTS or Node 24 LTS. `package.json` declares `"engines": {"node": ">=22.12.0"}` because the packaging tool `@electron/rebuild` requires it. |
| npm | the version that comes with that Node.js |
| Xcode Command Line Tools | `xcode-select --install`. Provides `git`; not otherwise needed, because there are no native modules. |
| Internet access | `npm ci` and the first build download Electron (about 100 MB). |

Install Node.js from https://nodejs.org (LTS installer) or with `brew install node@22`. Then check it:

```bash
node -v   # v22.12.0 or newer
npm -v
```

## Build (one command)

```bash
git clone https://github.com/sumeet2025/x-to-nostr-mirror-guide.git
cd x-to-nostr-mirror-guide/app
bash scripts/build-mac.sh
```

`scripts/build-mac.sh` does exactly this, and stops at the first error:

1. Checks that Node.js is 22.12 or newer.
2. `npm ci`: installs the exact dependency versions from `package-lock.json`.
3. `npm test`: about 29 tests using fake data and local test relays. Nothing is posted anywhere.
4. `npm run security-check`: static checks of the app's security settings.
5. `npx electron-builder --mac zip --arm64` on Apple Silicon, or `--x64` on Intel (picked automatically
   with `uname -m`).

Output, with the version from `package.json`:

| Mac | File |
|---|---|
| Apple Silicon | `app/dist/X to Nostr Mirror-0.2.0-arm64-mac.zip` (unpacked app in `app/dist/mac-arm64/`) |
| Intel | `app/dist/X to Nostr Mirror-0.2.0-mac.zip` (unpacked app in `app/dist/mac/`) |

To build a specific architecture by hand (after `npm ci`):

```bash
npm run dist:mac-arm64   # Apple Silicon
npm run dist:mac-x64     # Intel
npm run dist:mac         # both
```

## Install the build

1. Unzip the file from `app/dist/`, then drag **X to Nostr Mirror.app** into **Applications**.
   To upgrade, quit the old app first and choose *Replace*.
2. The build is not signed with an Apple Developer ID and not notarized, so Gatekeeper blocks a normal
   double-click the first time. Allow **this one app**: right-click it → **Open** → **Open**. You can also
   use *System Settings → Privacy & Security → Open Anyway*. Don't turn off Gatekeeper system-wide.
3. If macOS asks whether the app may use the Keychain item "X to Nostr Mirror Safe Storage",
   choose **Always Allow**.

Settings, encrypted keys and history live in `~/Library/Application Support/X to Nostr Mirror/` and are
kept across upgrades. A backup is made in `backups/` when a new version first starts.

## Run from source (development)

```bash
cd app
npm ci
npm start
```

If `npm start` says Electron failed to install, your npm may have skipped Electron's download step.
Run `node node_modules/electron/install.js` once, then try `npm start` again. Packaging with
electron-builder downloads its own copy, so it isn't affected.

## Signing and notarization (optional, for distributing to other people)

The steps above produce an unsigned build, which is fine for your own Mac. To give the app to other
people without Gatekeeper warnings you need:

- an Apple Developer Program membership;
- a "Developer ID Application" certificate;
- electron-builder's signing and notarization configuration (see electron-builder's "Code Signing" and
  "Notarize" docs).

This repository doesn't include that configuration, and no signed build has been made.

## What you need to use the app

- **An X API Bearer token** from your own developer app at https://developer.x.com. One token covers all
  profiles; you don't need the mirrored accounts' logins. X sets the access levels and prices; check the
  portal. AI-assistant access to X (for example a chatbot's built-in X tools) can't be used by this app.
- **A Nostr key pair** (npub + nsec) for each destination account.
- The token and keys are stored only in the macOS Keychain (Electron safeStorage). They are never shown
  again, logged or exported. Don't put them in files, `.env` or this repository.

See the [user guide](USER_GUIDE.md) for setup, schedules (they don't run while the Mac sleeps),
duplicate protection, date ranges and more.

## Licenses

- The app is released under the MIT License ([`app/LICENSE`](../app/LICENSE)).
- Third-party components are listed in [`app/THIRD_PARTY_NOTICES.md`](../app/THIRD_PARTY_NOTICES.md).
  Their own license files (and the copyright notices of their authors) ship inside `node_modules` and
  the built app, and are left unchanged.
