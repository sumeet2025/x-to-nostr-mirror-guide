# Third-party software and acknowledgments

Bundled runtime dependencies (see package-lock.json for exact versions):

| Package | Version | License | Use |
|---|---|---|---|
| nostr-tools | 2.26.0 | Unlicense (public domain) | key encoding (NIP-19), event signing, relay protocol |
| ws | 8.22.1 | MIT | WebSocket client for relays in the main process |
| @noble/hashes, @noble/curves, @noble/ciphers, @scure/base | 1.x/2.x | MIT | cryptography used by nostr-tools |
| Electron | 38.x | MIT (includes Chromium/Node.js, their own licenses ship inside the app bundle) | desktop shell, OS keychain encryption (safeStorage) |

| qrcode | 1.5.4 | MIT | QR code for the creator's npub (About page) |
| pngjs | 5.0.0 | MIT | PNG encoding used by qrcode |

Build/test-only: electron-builder (MIT), jsqr 1.4.0 (Apache-2.0, QR decoding in tests).

Prior art reviewed (design ideas only, **no code copied**):
- toome123/x-to-nostr-bot (ISC): Node bot, X API v2 Bearer token, SQLite dedupe, relay list. Confirms the official-API + Bearer approach.
- ODevLibertario/twistr (GPL-3.0): scrapes X without API via twikit; its README warns this violates X's terms and risks account bans, so it was deliberately not used.
- ghobs91/nostr-birdsite-bridge (MIT): Nitter/rsslay-based bridge; relies on third-party services.
- pleblira/mirrorstr: Python scraper-based mirror (snscrape), early stage.

The mirroring rules (thread detection, t.co expansion, media imeta tags, NIP-10 tags, checkpoint semantics)
were adapted from the author's own earlier local mirror scripts.
