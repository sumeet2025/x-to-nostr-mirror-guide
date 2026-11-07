#!/bin/bash
# Build an unsigned macOS app zip on a Mac for this Mac's CPU.
# Usage (from the app folder): bash scripts/build-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Install Node.js 22 LTS (22.12+) or 24 LTS first: https://nodejs.org"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<12)) { console.error("Node "+process.versions.node+" is too old; need 22.12+ (22 LTS or 24 LTS)."); process.exit(1); }'
[ "$(uname -s)" = "Darwin" ] || echo "Warning: not macOS. The zip will be built but cannot be signed or tested here."
npm ci
npm test
npm run security-check
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
npx electron-builder --mac zip --$ARCH
ls -1 dist/*.zip
echo "Unzip, move 'X to Nostr Mirror.app' to /Applications, then right-click -> Open the first time (unsigned build)."
