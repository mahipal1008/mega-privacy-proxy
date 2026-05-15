'use strict';

const { Readable, PassThrough } = require('stream');

let megaLib = null;
function getMega() {
  if (megaLib) return megaLib;
  try {
    megaLib = require('megajs');
  } catch (e) {
    throw new Error('megajs not installed: ' + e.message);
  }
  return megaLib;
}

let cachedStorage = null;
let authPromise = null;

async function authenticate({ email, password } = {}) {
  if (cachedStorage) return cachedStorage;
  if (authPromise) return authPromise;
  const mega = getMega();
  const Storage = mega.Storage || mega.default && mega.default.Storage;
  authPromise = new Promise((resolve, reject) => {
    if (!email || !password) return reject(new Error('mega creds missing'));
    const storage = new Storage({ email, password, autologin: true });
    storage.once('ready', () => { cachedStorage = storage; resolve(storage); });
    storage.once('error', (err) => { authPromise = null; reject(err); });
  });
  return authPromise;
}

function fromUrl(link) {
  const mega = getMega();
  const File = mega.File || mega.default && mega.default.File;
  return File.fromURL(link);
}

async function loadAttributes(file) {
  return new Promise((resolve, reject) => {
    if (file.name && typeof file.size === 'number') return resolve(file);
    file.loadAttributes((err) => err ? reject(err) : resolve(file));
  });
}

function guessMime(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  const map = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
    txt: 'text/plain', json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

async function getMeta(megaLink, childId) {
  const file = fromUrl(megaLink);
  await loadAttributes(file);
  if (file.directory) {
    if (!childId) {
      return {
        type: 'folder',
        filename: file.name,
        fileSize: (file.children || []).reduce((s, c) => s + (c.directory ? 0 : (c.size || 0)), 0),
        children: flattenChildren(file),
      };
    }
    const child = findChild(file, childId);
    if (!child) throw new Error('child not found');
    if (child.directory) throw new Error('child is folder');
    return { type: 'file', filename: child.name, fileSize: child.size, mimeType: guessMime(child.name), childId };
  }
  return { type: 'file', filename: file.name, fileSize: file.size, mimeType: guessMime(file.name) };
}

function findChild(folder, childId) {
  const stack = [...(folder.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (n.nodeId === childId) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

function flattenChildren(folder, prefix = '') {
  const out = [];
  for (const c of (folder.children || [])) {
    const path = prefix ? `${prefix}/${c.name}` : c.name;
    if (c.directory) {
      out.push(...flattenChildren(c, path));
    } else {
      out.push({ id: c.nodeId, name: c.name, path, size: c.size || 0 });
    }
  }
  return out;
}

function streamFile(megaLink, rangeStart, rangeEnd, childId) {
  const root = fromUrl(megaLink);
  const opts = {};
  if (typeof rangeStart === 'number' && rangeStart >= 0) opts.start = rangeStart;
  if (typeof rangeEnd === 'number' && rangeEnd > 0) opts.end = rangeEnd;
  const passthrough = new PassThrough();
  Promise.resolve()
    .then(() => loadAttributes(root))
    .then(() => {
      let file = root;
      if (root.directory) {
        if (!childId) throw new Error('folder link requires child id');
        file = findChild(root, childId);
        if (!file) throw new Error('child not found');
        if (file.directory) throw new Error('child is folder');
      }
      const size = file.size || 0;
      const start = opts.start || 0;
      const end = typeof opts.end === 'number' ? opts.end : Math.max(0, size - 1);
      const length = Math.max(0, end - start + 1);
      const CHUNK = 50 * 1024 * 1024;
      const desired = Math.max(1, Math.ceil(length / CHUNK));
      const parts = Math.min(8, desired);
      if (parts <= 1 || length === 0) {
        const s = file.download({ start, end });
        s.on('error', (e) => passthrough.destroy(e));
        s.pipe(passthrough);
        return;
      }
      const partSize = Math.ceil(length / parts);
      const ranges = [];
      for (let i = 0; i < parts; i++) {
        const ps = start + i * partSize;
        if (ps > end) break;
        const pe = Math.min(end, ps + partSize - 1);
        ranges.push({ start: ps, end: pe });
      }
      const buffers = new Array(ranges.length).fill(null);
      let nextToWrite = 0;
      let cancelled = false;
      function tryDrain() {
        while (!cancelled && nextToWrite < ranges.length && buffers[nextToWrite]) {
          const chunks = buffers[nextToWrite];
          buffers[nextToWrite] = null;
          for (const c of chunks) passthrough.write(c);
          nextToWrite++;
        }
        if (!cancelled && nextToWrite >= ranges.length) passthrough.end();
      }
      ranges.forEach((r, i) => {
        const acc = [];
        const s = file.download({ start: r.start, end: r.end });
        s.on('data', (d) => acc.push(d));
        s.on('end', () => { buffers[i] = acc; tryDrain(); });
        s.on('error', (e) => { cancelled = true; passthrough.destroy(e); });
      });
    })
    .catch((err) => passthrough.destroy(err));
  return passthrough;
}

module.exports = { authenticate, getMeta, streamFile, _internal: { fromUrl, loadAttributes, guessMime } };
