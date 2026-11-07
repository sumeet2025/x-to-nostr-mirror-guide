'use strict';
const QRCode = require('qrcode');
const { nip19 } = require('nostr-tools');
// Creator's public Nostr identity (as provided by the creator). This is NOT a mirror destination.
const AUTHOR_NPUB = 'npub19dfd7w8zxfdfywqmqxpt92wq6tx4p0mvfqv6yuyg0cv9d7duj4uskuccks';
const GUIDE_URL = 'https://github.com/sumeet2025/x-to-nostr-mirror-guide/blob/main/docs/USER_GUIDE.md'; // verified public

const EXTERNAL = {
  authorProfile: () => 'https://njump.me/' + validNpub(AUTHOR_NPUB),
  guide: () => GUIDE_URL,
  xDeveloper: () => 'https://developer.x.com/',
};
function validNpub(n) { const d = nip19.decode(n); if (d.type !== 'npub' || !/^[0-9a-f]{64}$/.test(d.data)) throw new Error('invalid npub'); return n; }
function externalUrl(key) {
  if (!Object.prototype.hasOwnProperty.call(EXTERNAL, key)) throw new Error('Link not allowed');
  const u = EXTERNAL[key](); if (!u) throw new Error('Not available yet');
  const x = new URL(u); if (x.protocol !== 'https:' || !['njump.me', 'github.com', 'developer.x.com'].includes(x.hostname)) throw new Error('Link not allowed');
  return x.href;
}
async function aboutInfo() {
  const npub = validNpub(AUTHOR_NPUB);
  return { npub, profileUrl: externalUrl('authorProfile'), guideUrl: GUIDE_URL, qr: await QRCode.toDataURL('nostr:' + npub, { margin: 1, width: 220, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }) };
}
module.exports = { AUTHOR_NPUB, GUIDE_URL, externalUrl, aboutInfo, validNpub };
