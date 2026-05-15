'use strict';

const { PassThrough } = require('stream');

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

// Stream a MEGA file (or child of folder) with full backpressure.
// Single sequential pipe — NO multi-part RAM buffering. Bounded memory.
function streamFile(megaLink, rangeStart, rangeEnd, childId) {
  const root = fromUrl(megaLink);
  const opts = {};
  if (typeof rangeStart === 'number' && rangeStart >= 0) opts.start = rangeStart;
  // Accept end === 0 (legitimate 1-byte range probe).
  if (typeof rangeEnd === 'number' && rangeEnd >= 0) opts.end = rangeEnd;
  const passthrough = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  let upstream = null;
  passthrough.on('close', () => { try { upstream && upstream.destroy(); } catch (_) {} });
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
      const start = typeof opts.start === 'number' ? opts.start : 0;
      const end = typeof opts.end === 'number'
        ? Math.min(opts.end, Math.max(0, size - 1))
        : Math.max(0, size - 1);
      if (size === 0) { passthrough.end(); return; }
      if (start > end) { passthrough.destroy(new Error('range_not_satisfiable')); return; }
      upstream = file.download({ start, end });
      upstream.on('error', (e) => passthrough.destroy(e));
      // pipe applies backpressure automatically.
      upstream.pipe(passthrough);
    })
    .catch((err) => passthrough.destroy(err));
  return passthrough;
}

module.exports = { authenticate, getMeta, streamFile, _internal: { fromUrl, loadAttributes, guessMime } };
