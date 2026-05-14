'use strict';

const { webcrypto } = require('crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const C = require('../client/crypto');

describe('crypto.js', () => {
  test('generateKey produces AES-GCM 256', async () => {
    const k = await C.generateKey();
    expect(k.algorithm.name).toBe('AES-GCM');
    expect(k.algorithm.length).toBe(256);
  });

  test('encrypt/decrypt round-trip', async () => {
    const k = await C.generateKey();
    const iv = C.generateIV();
    const data = new TextEncoder().encode('Hello MEGA Privacy Proxy!');
    const enc = await C.encryptChunk(k, iv, data.buffer);
    const dec = await C.decryptChunk(k, iv, enc);
    expect(new TextDecoder().decode(dec)).toBe('Hello MEGA Privacy Proxy!');
  });

  test('different IV each call', () => {
    const ivs = new Set();
    for (let i = 0; i < 50; i++) ivs.add(Buffer.from(C.generateIV()).toString('hex'));
    expect(ivs.size).toBe(50);
  });

  test('export/import round-trip', async () => {
    const k = await C.generateKey();
    const b64 = await C.exportKeyToBase64(k);
    const k2 = await C.importKeyFromBase64(b64);
    const iv = C.generateIV();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const enc = await C.encryptChunk(k, iv, data.buffer);
    const dec = await C.decryptChunk(k2, iv, enc);
    expect(new Uint8Array(dec)).toEqual(data);
  });

  test('empty buffer round-trip', async () => {
    const k = await C.generateKey();
    const iv = C.generateIV();
    const enc = await C.encryptChunk(k, iv, new ArrayBuffer(0));
    const dec = await C.decryptChunk(k, iv, enc);
    expect(new Uint8Array(dec).length).toBe(0);
  });

  test('large 5MB buffer round-trip', async () => {
    const k = await C.generateKey();
    const iv = C.generateIV();
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff;
    const enc = await C.encryptChunk(k, iv, big.buffer);
    const dec = await C.decryptChunk(k, iv, enc);
    expect(new Uint8Array(dec).length).toBe(big.length);
    expect(new Uint8Array(dec)[0]).toBe(0);
  }, 30000);
});
