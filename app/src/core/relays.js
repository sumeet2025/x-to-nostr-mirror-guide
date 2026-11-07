'use strict';
const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');
useWebSocketImplementation(require('ws'));

function validateRelayUrl(u, { allowLoopbackWs = false } = {}) {
  let x; try { x = new URL(String(u).trim()); } catch (_) { throw new Error('Invalid relay URL: ' + u); }
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
  const norm = () => (x.pathname === '/' && !x.search ? x.origin.replace(/^http/, 'ws') : x.href);
  if (x.username || x.password || x.hash) throw new Error('Relay URL must not contain credentials or fragments');
  if (x.protocol === 'wss:') return norm().replace(/^ws:/, 'wss:');
  if (x.protocol === 'ws:' && loop && allowLoopbackWs) return norm();
  throw new Error('Relay must be a wss:// URL: ' + u);
}

class RelaySet {
  constructor(urls, { connectTimeout = 8000, publishTimeout = 10000 } = {}) { Object.assign(this, { urls, connectTimeout, publishTimeout }); this.conns = {}; this.deadUntil = {}; }
  async get(url) {
    if ((this.deadUntil[url] || 0) > Date.now()) throw new Error('backing off');
    const r = this.conns[url];
    if (r && r.connected) return r;
    try {
      const nr = await Promise.race([Relay.connect(url), new Promise((_, j) => setTimeout(() => j(new Error('connect timeout')), this.connectTimeout))]);
      this.conns[url] = nr; return nr;
    } catch (e) { delete this.conns[url]; this.deadUntil[url] = Date.now() + 5 * 60 * 1000; throw e; }
  }
  async publish(ev) {
    return Promise.all(this.urls.map(async (url) => {
      try {
        const r = await this.get(url);
        const msg = await Promise.race([r.publish(ev), new Promise((_, j) => setTimeout(() => j(new Error('publish timeout')), this.publishTimeout))]);
        return { url, ok: true, msg };
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/rate-limit|banned|too many|slow down/i.test(msg)) this.deadUntil[url] = Date.now() + 10 * 60 * 1000;
        if (/timed? ?out/i.test(msg) && this.conns[url]) { try { this.conns[url].close(); } catch (_) {} delete this.conns[url]; }
        return { url, ok: false, msg };
      }
    }));
  }
  async test() {
    return Promise.all(this.urls.map(async (url) => { try { await this.get(url); return { url, ok: true }; } catch (e) { return { url, ok: false, msg: e.message }; } }));
  }
  close() { for (const r of Object.values(this.conns)) try { r.close(); } catch (_) {} this.conns = {}; }
}
module.exports = { RelaySet, validateRelayUrl, DEFAULT_RELAYS: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social'] };
