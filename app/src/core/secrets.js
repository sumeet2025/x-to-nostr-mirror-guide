'use strict';
// Encrypted secret store backed by an OS keychain via Electron safeStorage (macOS: Keychain).
// Fails closed: refuses to store/read if encryption is unavailable or Linux uses the plaintext
// 'basic_text' backend. Secrets never leave the main process.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');

class SecretStore {
  constructor(file, safeStorage, platform = process.platform) { Object.assign(this, { file, safeStorage, platform }); }
  check() {
    const ss = this.safeStorage;
    if (!ss || !ss.isEncryptionAvailable()) throw new Error('Secure OS storage is unavailable; secrets cannot be saved');
    if (this.platform === 'linux' && typeof ss.getSelectedStorageBackend === 'function') {
      const b = ss.getSelectedStorageBackend();
      if (b === 'basic_text' || b === 'unknown') throw new Error('No OS keyring available (backend: ' + b + '); refusing plaintext storage');
    }
  }
  available() { try { this.check(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; } }
  _read() { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}; }
  set(name, value) {
    this.check();
    if (!/^[\w.:-]{1,80}$/.test(name)) throw new Error('bad secret name');
    const all = this._read();
    all[name] = this.safeStorage.encryptString(String(value)).toString('base64');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    atomicWrite(this.file, JSON.stringify(all));
  }
  get(name) {
    this.check();
    const v = this._read()[name];
    return v ? this.safeStorage.decryptString(Buffer.from(v, 'base64')) : null;
  }
  has(name) { return Boolean(this._read()[name]); }
  delete(name) { const all = this._read(); delete all[name]; atomicWrite(this.file, JSON.stringify(all)); }
}
module.exports = { SecretStore };
