// Encrypted storage for store logins and the card CVV.
//
// The vault is sealed with AES-256-GCM under a key derived from your passphrase
// (PBKDF2-SHA256, 310k rounds) and saved in chrome.storage.local. Unlocking
// writes the decrypted copy to chrome.storage.session, which lives in memory
// only, is cleared when Chrome closes, and isn't readable by content scripts.
(function (root) {
  const ITERATIONS = 310000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function seal(data, passphrase) {
    if (!passphrase || passphrase.length < 6) throw new Error('Use a passphrase of at least 6 characters');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, ITERATIONS);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
    return { v: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  async function open(sealed, passphrase) {
    const key = await deriveKey(passphrase, unb64(sealed.salt), sealed.iterations || ITERATIONS);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
    } catch (_) {
      throw new Error('Wrong passphrase');
    }
    return JSON.parse(dec.decode(plain));
  }

  function empty() {
    return { cvv: '', logins: {} };
  }

  const api = { seal, open, empty };
  root.PS5Vault = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
