# X to Nostr Mirror

A desktop app (macOS first) that copies posts from X (Twitter) accounts to Nostr accounts from your own
computer. It has previews, original-date (backdated) notes, duplicate protection, multiple profiles,
date-range fetches, progress tracking and schedules. There is no cloud service and no tracking.

This repository contains the **app source code** and the **user guide**.

| | |
|---|---|
| 📖 User guide | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| 🛠 Build it on a Mac | [docs/BUILD_MAC.md](docs/BUILD_MAC.md) |
| 💻 Source code | [app/](app): Electron + Node.js, current version **0.2.0** |
| 🔁 Migrating from scripts | [app/docs/MIGRATION.md](app/docs/MIGRATION.md) |

## Status

- **v0.1** was built and tested on an Apple Silicon (M2) Mac and works.
- **v0.2.0** (this source) passes its automated tests (fake data, local test relays) and was packaged on
  Linux. It has **not yet been verified on a Mac**.
- Builds are **unsigned and not notarized**. See [BUILD_MAC.md](docs/BUILD_MAC.md).
- No prebuilt downloads are published here. Build from source.

## Features

- Multiple profiles, each one X account to one Nostr account.
- Reads posts through the official X API with **your own developer Bearer token**.
- Preview before publishing, then publish selected posts after a confirmation.
- Fetch new posts, the full history the API allows, or an inclusive **date range** in your time zone.
- Original X timestamps or time of publishing; threads linked with NIP-10 tags; media links.
- Duplicate protection: per-profile history, a checkpoint that only advances past handled posts, and
  signed notes reused after crashes or partial relay failures.
- Per-profile status (posts mirrored, latest X post date, last published, last run) and live progress
  that keeps running while you navigate.
- Schedules with start time, interval, active hours and time zone. They run while the app is open, or
  through an optional macOS LaunchAgent; nothing runs while the Mac sleeps.
- Keys and token encrypted with the macOS Keychain; hardened Electron window; no telemetry.

## Quick build

```bash
git clone https://github.com/sumeet2025/x-to-nostr-mirror-guide.git
cd x-to-nostr-mirror-guide/app
bash scripts/build-mac.sh      # needs Node.js 22.12+ (22 LTS or 24 LTS)
```

## Find the creator on Nostr

`npub19dfd7w8zxfdfywqmqxpt92wq6tx4p0mvfqv6yuyg0cv9d7duj4uskuccks`
([njump.me profile](https://njump.me/npub19dfd7w8zxfdfywqmqxpt92wq6tx4p0mvfqv6yuyg0cv9d7duj4uskuccks))

## License

MIT. See [LICENSE](LICENSE) and [app/LICENSE](app/LICENSE). Third-party components and their licenses
are listed in [app/THIRD_PARTY_NOTICES.md](app/THIRD_PARTY_NOTICES.md).
