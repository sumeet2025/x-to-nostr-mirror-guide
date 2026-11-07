'use strict';
const { getPublicKey, nip19 } = require('nostr-tools');
const { hexToBytes } = require('@noble/hashes/utils');

// Accepts nsec1... or 64-hex. Returns { sk(Uint8Array), pk(hex), npub }. Never logs input.
function parseSecretKey(input) {
  const s = String(input || '').trim();
  let sk;
  if (/^nsec1/.test(s)) {
    let d; try { d = nip19.decode(s); } catch (_) { throw new Error('Not a valid nsec'); }
    if (d.type !== 'nsec') throw new Error('Not a valid nsec');
    sk = d.data;
  } else if (/^[0-9a-f]{64}$/i.test(s)) sk = hexToBytes(s.toLowerCase());
  else if (/^npub1/.test(s)) throw new Error('That is a public key (npub). Posting needs the secret key (nsec).');
  else throw new Error('Expected an nsec1... or 64-character hex secret key');
  const pk = getPublicKey(sk);
  return { sk, pk, npub: nip19.npubEncode(pk) };
}
function parsePublicKey(input) {
  const s = String(input || '').trim();
  if (/^npub1/.test(s)) { let d; try { d = nip19.decode(s); } catch (_) { throw new Error('Not a valid npub'); } if (d.type !== 'npub') throw new Error('Not a valid npub'); return { pk: d.data, npub: s }; }
  if (/^[0-9a-f]{64}$/i.test(s)) return { pk: s.toLowerCase(), npub: nip19.npubEncode(s.toLowerCase()) };
  if (/^nsec1/.test(s)) throw new Error('That is a SECRET key. Enter it only in the secret key field.');
  throw new Error('Expected npub1... or 64-character hex public key');
}
// Verify a secret derives the expected public key (if given).
function verifyKeyPair(secret, expectedPublic) {
  const k = parseSecretKey(secret);
  if (expectedPublic) { const p = parsePublicKey(expectedPublic); if (p.pk !== k.pk) throw new Error('Secret key does not match the expected npub'); }
  return { pk: k.pk, npub: k.npub };
}
module.exports = { parseSecretKey, parsePublicKey, verifyKeyPair };
