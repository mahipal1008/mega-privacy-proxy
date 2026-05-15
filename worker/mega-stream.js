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

// Parses a MEGA link with optional sub-folder / sub-file selector.
// Supports:
//   https://mega.nz/file/<H>#<K>
//   https://mega.nz/folder/<H>#<K>
//   https://mega.nz/folder/<H>#<K>/folder/<subId>
//   https://mega.nz/folder/<H>#<K>/file/<subId>
//   legacy #!<H>!<K>[/...] format
// Returns { baseLink, subFolderId, subFileId }.
function parseLink(link) {
  const s = String(link || '');
  // New-style
  let m = s.match(/^(https?:\/\/mega\.nz\/(?:file|folder)\/[A-Za-z0-9_-]+(?:#|%23)[A-Za-z0-9_-]+)((?:\/(?:folder|file)\/[A-Za-z0-9_-]+)*)/i);
  if (m) {
    const baseLink = m[1];
    const suffix = m[2] || '';
    let subFolderId = null, subFileId = null;
    // Walk segments — last folder wins, last file wins (file overrides folder).
    const re = /\/(folder|file)\/([A-Za-z0-9_-]+)/gi;
    let mm;
    while ((mm = re.exec(suffix)) !== null) {
      if (mm[1].toLowerCase() === 'folder') subFolderId = mm[2];
      else subFileId = mm[2];
    }
    return { baseLink, subFolderId, subFileId };
  }
  // Legacy #!H!K — no sub navigation
  m = s.match(/^(https?:\/\/mega(?:\.co)?\.nz\/#!?[A-Za-z0-9_-]+!?[A-Za-z0-9_-]+)/i);
  if (m) return { baseLink: m[1], subFolderId: null, subFileId: null };
  return { baseLink: s, subFolderId: null, subFileId: null };
}

function fromUrl(link) {
  const mega = getMega();
  const File = mega.File || mega.default && mega.default.File;
  const { baseLink } = parseLink(link);
  return File.fromURL(baseLink);
}

// Extract the child-level ID from a megajs node.
// Root nodes have downloadId as a string; children have it as [rootId, childId].
function getChildId(node) {
  const d = node.downloadId;
  if (Array.isArray(d)) return d[d.length - 1];
  return d || node.nodeId || null;
}

// Walk into a folder by child download ID. Returns the matching node.
function findNode(folder, targetId) {
  if (!targetId) return folder;
  const stack = [...(folder.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (getChildId(n) === targetId) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

// Resolve a link to the final node we should act on. If the link points
// to /folder/<sub> we descend into that sub-folder; /file/<sub> picks
// out a specific file. Returns { node, isFolder, subContext }.
async function resolveLink(link) {
  const { subFolderId, subFileId } = parseLink(link);
  const root = fromUrl(link);
  await loadAttributes(root);
  if (!root.directory && (subFolderId || subFileId)) {
    // file link with extra segments — ignore, treat as plain file
    return { node: root, isFolder: false };
  }
  if (subFileId) {
    const n = findNode(root, subFileId);
    if (!n) throw new Error('sub file not found');
    if (n.directory) throw new Error('sub id is folder');
    return { node: n, isFolder: false };
  }
  if (subFolderId) {
    const n = findNode(root, subFolderId);
    if (!n) throw new Error('sub folder not found');
    if (!n.directory) throw new Error('sub id is file');
    return { node: n, isFolder: true };
  }
  return { node: root, isFolder: !!root.directory };
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
  const { node, isFolder } = await resolveLink(megaLink);
  if (isFolder) {
    if (!childId) {
      const children = flattenChildren(node);
      return {
        type: 'folder',
        filename: node.name,
        fileSize: children.reduce((s, c) => s + (c.size || 0), 0),
        children,
      };
    }
    const child = findChild(node, childId);
    if (!child) throw new Error('child not found');
    if (child.directory) throw new Error('child is folder');
    return { type: 'file', filename: child.name, fileSize: child.size, mimeType: guessMime(child.name), childId };
  }
  return { type: 'file', filename: node.name, fileSize: node.size, mimeType: guessMime(node.name) };
}

function findChild(folder, childId) {
  const stack = [...(folder.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (getChildId(n) === childId) return n;
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
      out.push({ id: getChildId(c), name: c.name, path, size: c.size || 0 });
    }
  }
  return out;
}

// Stream a MEGA file (or child of folder) with full backpressure.
// Single sequential pipe — NO multi-part RAM buffering. Bounded memory.
function streamFile(megaLink, rangeStart, rangeEnd, childId) {
  const opts = {};
  if (typeof rangeStart === 'number' && rangeStart >= 0) opts.start = rangeStart;
  // Accept end === 0 (legitimate 1-byte range probe).
  if (typeof rangeEnd === 'number' && rangeEnd >= 0) opts.end = rangeEnd;
  const passthrough = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  let upstream = null;
  passthrough.on('close', () => { try { upstream && upstream.destroy(); } catch (_) {} });
  Promise.resolve()
    .then(() => resolveLink(megaLink))
    .then(({ node, isFolder }) => {
      let file = node;
      if (isFolder) {
        if (!childId) throw new Error('folder link requires child id');
        file = findChild(node, childId);
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

module.exports = { authenticate, getMeta, streamFile, _internal: { fromUrl, loadAttributes, guessMime, parseLink, resolveLink } };
