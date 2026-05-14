'use strict';

// crypto.js - Web Crypto API AES-256-GCM
// Exposed both as ES module (browser) and CommonJS (Node test environment).

const subtle = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
  ? globalThis.crypto.subtle
  : (typeof require === 'function' ? require('crypto').webcrypto.subtle : null);

const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto)
  ? globalThis.crypto
  : (typeof require === 'function' ? require('crypto').webcrypto : null);

async function generateKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToBuf(str) {
  if (typeof atob === 'function') {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  return new Uint8Array(Buffer.from(str, 'base64')).buffer;
}

async function exportKeyToBase64(key) {
  const raw = await subtle.exportKey('raw', key);
  return bufToBase64(raw);
}

async function importKeyFromBase64(str) {
  const raw = base64ToBuf(str);
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function generateIV() {
  const iv = new Uint8Array(12);
  cryptoObj.getRandomValues(iv);
  return iv;
}

async function encryptChunk(key, iv, buffer) {
  return subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
}

async function decryptChunk(key, iv, buffer) {
  return subtle.decrypt({ name: 'AES-GCM', iv }, key, buffer);
}

const api = { generateKey, exportKeyToBase64, importKeyFromBase64, encryptChunk, decryptChunk, generateIV };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.MegaCrypto = api;
