'use strict';

// ─────────────────────────────────────────────────────────────
// MegaTunnel client — streams directly to disk via File System
// Access API (no RAM accumulation). Falls back to Blob for
// browsers without showSaveFilePicker (Firefox, Safari, mobile).
//
// Folders are enumerated and queued as individual files.
// Files >3.5 GB auto-segment across fresh workers seamlessly.
// Parallel downloads (up to N concurrent), multi-link paste,
// retry-failed, rolling speed average.
// ─────────────────────────────────────────────────────────────

const ORCHESTRATOR_URL = 'https://mega-orchestrator.onrender.com';
const SEGMENT_BYTES   = 3_500_000_000;
const BLOB_FALLBACK_MAX = 1_900_000_000; // ~1.9 GB Blob safety ceiling
const FILE_LINK_RE    = /^https?:\/\/mega\.nz\/(file|folder)\/[A-Za-z0-9_-]+(#|%23)[A-Za-z0-9_-]+(\/folder\/[A-Za-z0-9_-]+|\/file\/[A-Za-z0-9_-]+)?/i;
const MEGA_LINK_GLOBAL_RE = /https?:\/\/mega\.nz\/(file|folder)\/[A-Za-z0-9_-]+(#|%23)[A-Za-z0-9_-]+(\/folder\/[A-Za-z0-9_-]+|\/file\/[A-Za-z0-9_-]+)?/gi;
const SPEED_WINDOW_SEC = 5;

const supportsFSA = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

const $ = (id) => document.getElementById(id);

// ── Token (URL fragment → sessionStorage; never sent on requests) ─────
function getToken() {
  const hash = window.location.hash.slice(1).trim();
  if (hash) {
    sessionStorage.setItem('_mtt', hash);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return sessionStorage.getItem('_mtt') || '';
}

// ── Formatting ────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : (n >= 10 ? 1 : 2))} ${u[i]}`;
}
function fmtSecs(s) {
  if (!Number.isFinite(s) || s < 0) return '–';
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function fileIcon(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['mp4','mkv','webm','mov','avi','flv','m4v'].includes(ext)) return '🎬';
  if (['mp3','flac','wav','m4a','ogg','aac','opus'].includes(ext)) return '🎵';
  if (['jpg','jpeg','png','gif','webp','bmp','svg','heic'].includes(ext)) return '🖼️';
  if (['pdf','epub','mobi','djvu'].includes(ext)) return '📄';
  if (['zip','rar','7z','tar','gz','xz','bz2'].includes(ext)) return '📦';
  if (['iso','dmg','img'].includes(ext)) return '💿';
  if (['exe','msi','apk','deb','rpm','appimage'].includes(ext)) return '⚙️';
  if (['doc','docx','xls','xlsx','ppt','pptx','odt'].includes(ext)) return '📝';
  return '📁';
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ── Toast notifications ──────────────────────────────────────────────
function toast(msg, type = '') {
  const host = $('toast-host'); if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, type === 'err' ? 6000 : 3500);
}

// ── Orchestrator API ──────────────────────────────────────────────────
async function apiDownload(megaLink) {
  const token = getToken();
  if (!token) throw new Error('No access token. Append #yourtoken to the URL and reload.');
  const r = await fetch(ORCHESTRATOR_URL + '/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ megaLink }),
  });
  if (r.status === 403) throw new Error('Bad access token.');
  if (r.status === 429) throw new Error('Rate limited. Wait a minute.');
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(`Orchestrator ${r.status}: ${b.error || 'unknown'}`);
  }
  return r.json();
}
async function apiStatus() {
  const token = getToken(); if (!token) return null;
  try {
    const r = await fetch(ORCHESTRATOR_URL + '/api/status', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// ── Worker API ────────────────────────────────────────────────────────
async function workerMeta(assignment, megaLink, childId) {
  const u = assignment.workerUrl.replace(/\/$/, '') + '/meta?link=' + encodeURIComponent(megaLink) +
    (childId ? '&child=' + encodeURIComponent(childId) : '');
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + assignment.sessionToken } });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(`meta ${r.status}${b.detail ? ': ' + b.detail : ''}`);
  }
  return r.json();
}

// Retry workerMeta with fresh assignment on network/worker failure
// Suppresses intermediate CORS/network errors; only surfaces final failure.
async function workerMetaWithRetry(megaLink, childId, maxRetries = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const assignment = await apiDownload(megaLink);
      const meta = await workerMeta(assignment, megaLink, childId);
      return { assignment, meta };
    } catch (e) {
      lastErr = e;
      if (e && e.message && (e.message.includes('Bad access token') || e.message.includes('Rate limited'))) throw e;
      // Silently retry — don't log intermediate failures
      if (i < maxRetries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  // Only surface error after all retries exhausted
  throw lastErr;
}

// Stream one byte range and write directly to writable (FSA) or push into chunks (fallback).
// onBytes(bytesRead) called for progress, returns when range fully consumed.
async function streamSegment({ assignment, megaLink, childId, rangeStart, rangeEnd, sink, onBytes, abortSignal }) {
  const u = assignment.workerUrl.replace(/\/$/, '') + '/stream?link=' + encodeURIComponent(megaLink) +
    (childId ? '&child=' + encodeURIComponent(childId) : '');
  const headers = { Authorization: 'Bearer ' + assignment.sessionToken };
  if (rangeStart > 0 || rangeEnd !== undefined) {
    headers['Range'] = `bytes=${rangeStart}-${rangeEnd !== undefined ? rangeEnd : ''}`;
  }
  const r = await fetch(u, { headers, signal: abortSignal });
  if (!r.ok && r.status !== 206) throw new Error('stream ' + r.status);
  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await sink.write(value);
    onBytes(value.byteLength);
  }
}

// ── Sinks ─────────────────────────────────────────────────────────────
// FSA sink: writes directly to disk.
function fsaSink(writable) {
  return {
    kind: 'fsa',
    async write(chunk) { await writable.write(chunk); },
    async finalize() { await writable.close(); },
    async abort() { try { await writable.abort(); } catch {} },
  };
}
// Blob sink: accumulates in RAM, finalize() triggers browser save.
function blobSink(filename, mimeType) {
  const chunks = [];
  return {
    kind: 'blob',
    async write(chunk) { chunks.push(chunk); },
    async finalize() {
      const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' });
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    },
    async abort() { chunks.length = 0; },
  };
}

// ── Queue ─────────────────────────────────────────────────────────────
const queue = [];
let queueIdCounter = 0;
let running = false;
let activeCount = 0;

function makeItem(megaLink, childId, name, size) {
  return {
    id: ++queueIdCounter, megaLink, childId, name, size,
    status: 'queued', received: 0, speed: 0, startedAt: 0,
    lastTick: { time: 0, bytes: 0 },
    speedSamples: [],
    abort: null, error: null,
  };
}
function makeZipItem(megaLink, folderName, children, totalSize) {
  return {
    id: ++queueIdCounter, megaLink, name: (folderName || 'folder') + '.zip',
    size: totalSize || 0, received: 0, speed: 0, startedAt: 0,
    lastTick: { time: 0, bytes: 0 }, speedSamples: [],
    abort: null, error: null,
    status: 'queued', isZip: true, zipChildren: children,
    zipDone: 0, zipTotal: children.length,
  };
}

function renderQueue() {
  const sec = $('queue-section'); const list = $('queue-list');
  if (queue.length === 0) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  const activeItems = queue.filter(i => i.status === 'active').length;
  $('queue-count').textContent = `· ${queue.length} item${queue.length === 1 ? '' : 's'}`;
  const activeBadge = $('active-count');
  if (activeBadge) {
    activeBadge.textContent = activeItems > 0 ? `${activeItems} active` : '';
    activeBadge.style.display = activeItems > 0 ? '' : 'none';
  }
  list.innerHTML = '';
  for (const it of queue) {
    const li = document.createElement('li');
    li.className = 'q-item' + (it.status === 'active' ? ' active' : it.status === 'done' ? ' done' : it.status === 'error' ? ' error' : '') + (it.isZip ? ' zip-item' : '');
    const pct = it.size > 0 ? (it.received / it.size) * 100 : 0;
    const zipLabel = it.isZip ? ` <span class="zip-badge">ZIP · ${it.zipDone || 0}/${it.zipTotal || 0} files</span>` : '';
    li.innerHTML = `
      <div class="q-row">
        <span class="q-icon">${it.isZip ? '🗜️' : fileIcon(it.name)}</span>
        <div class="q-info">
          <div class="q-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}${zipLabel}</div>
          <div class="q-meta">${fmtBytes(it.received)} / ${fmtBytes(it.size)}${it.speed > 0 ? ' · ' + fmtBytes(it.speed) + '/s' : ''}</div>
        </div>
        <span class="q-status ${it.status === 'done' ? 's-done' : it.status === 'error' ? 's-err' : ''}">${statusLabel(it)}</span>
        <div class="q-actions">
          ${it.status === 'queued' ? `<button class="q-btn" data-act="start" data-id="${it.id}">▶ Start</button>` : ''}
          ${it.status === 'active' ? `<button class="q-btn danger" data-act="cancel" data-id="${it.id}">⏹ Stop</button>` : ''}
          ${it.status === 'error' ? `<button class="q-btn retry-btn" data-act="retry" data-id="${it.id}">⟳ Retry</button>` : ''}
          <button class="q-btn danger" data-act="remove" data-id="${it.id}" title="Remove">×</button>
        </div>
      </div>
      <div class="q-bar"><div class="q-bar-fill" style="width:${pct.toFixed(2)}%"></div></div>
    `;
    list.appendChild(li);
  }
  renderTotals();
}
function statusLabel(it) {
  if (it.status === 'done') return '✓ Done';
  if (it.status === 'error') return '✗ ' + (it.error || 'Error');
  if (it.status === 'active') {
    const remain = it.size > 0 && it.speed > 0 ? fmtSecs((it.size - it.received) / it.speed) : '–';
    return `${((it.received / Math.max(1, it.size)) * 100).toFixed(1)}% · ${remain}`;
  }
  return 'Queued';
}
function renderTotals() {
  const total = queue.reduce((s, i) => s + (i.size || 0), 0);
  const recvd = queue.reduce((s, i) => s + (i.received || 0), 0);
  const speed = queue.filter(i => i.status === 'active').reduce((s, i) => s + (i.speed || 0), 0);
  $('total-size').textContent = fmtBytes(total);
  $('total-progress').textContent = total > 0 ? ((recvd / total) * 100).toFixed(1) + '%' : '0%';
  $('total-speed').textContent = speed > 0 ? fmtBytes(speed) + '/s' : '– /s';
  $('total-eta').textContent = (speed > 0 && total > recvd) ? fmtSecs((total - recvd) / speed) : '–';
}

// ── Add link → resolve file or folder (supports multi-link paste) ─────
async function addLink(raw) {
  raw = (raw || '').trim();
  if (!raw) return;

  // Extract all mega links from the pasted text
  const links = raw.match(MEGA_LINK_GLOBAL_RE);
  if (!links || links.length === 0) {
    // Fallback: try the whole input as a single link
    if (!FILE_LINK_RE.test(raw)) { toast('No valid MEGA links found', 'err'); return; }
    return addSingleLink(raw);
  }

  // Deduplicate
  const unique = [...new Set(links)];
  if (unique.length === 1) return addSingleLink(unique[0]);

  // Multi-link resolve
  toast(`Resolving ${unique.length} links…`);
  $('add-btn').disabled = true;
  if ($('paste-btn')) $('paste-btn').disabled = true;
  let resolved = 0, failed = 0;
  for (const link of unique) {
    try {
      const { assignment, meta } = await workerMetaWithRetry(link);
      if (meta.type === 'folder') {
        if (meta.children && meta.children.length > 0) {
          for (const c of meta.children) queue.push(makeItem(link, c.id, c.path || c.name, c.size));
          resolved += meta.children.length;
        }
      } else {
        queue.push(makeItem(link, undefined, meta.filename, meta.fileSize));
        resolved++;
      }
    } catch (e) {
      failed++;
      toast(`Failed: ${link.slice(0, 50)}…`, 'err');
    }
  }
  toast(`Added ${resolved} file${resolved !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`, resolved > 0 ? 'ok' : 'err');
  renderQueue();
  $('mega-link').value = '';
  if ($('clear-btn')) $('clear-btn').style.display = 'none';
  $('add-btn').disabled = false;
  if ($('paste-btn')) $('paste-btn').disabled = false;
}

async function addSingleLink(link) {
  link = (link || '').trim();
  if (!FILE_LINK_RE.test(link)) { toast('Not a valid MEGA link', 'err'); return; }
  toast('Resolving link…');
  $('add-btn').disabled = true;
  if ($('paste-btn')) $('paste-btn').disabled = true;
  try {
    const { assignment, meta } = await workerMetaWithRetry(link);
    const folderMode = ($('folder-mode') && $('folder-mode').value) || 'individual';
    if (meta.type === 'folder') {
      if (!meta.children || meta.children.length === 0) { toast('Folder is empty.', 'err'); return; }
      if (folderMode === 'zip') {
        const totalSize = meta.children.reduce((s, c) => s + (c.size || 0), 0);
        if (totalSize > 2 * 1024 * 1024 * 1024) {
          toast(`⚠ ZIP mode not recommended for folders >2 GB (${fmtBytes(totalSize)}). Using individual files instead.`, 'warn');
          for (const c of meta.children) queue.push(makeItem(link, c.id, c.path || c.name, c.size));
          toast(`Folder added: ${meta.children.length} files (${fmtBytes(meta.fileSize)})`, 'ok');
        } else {
          const folderName = meta.filename || 'folder';
          queue.push(makeZipItem(link, folderName, meta.children, totalSize));
          toast(`Folder queued as ZIP: ${folderName}.zip (${fmtBytes(totalSize)}, ${meta.children.length} files)`, 'ok');
        }
      } else {
        for (const c of meta.children) queue.push(makeItem(link, c.id, c.path || c.name, c.size));
        toast(`Folder added: ${meta.children.length} file${meta.children.length === 1 ? '' : 's'} (${fmtBytes(meta.fileSize)})`, 'ok');
      }
    } else {
      queue.push(makeItem(link, undefined, meta.filename, meta.fileSize));
      toast(`Added: ${meta.filename} (${fmtBytes(meta.fileSize)})`, 'ok');
    }
    renderQueue();
    $('mega-link').value = '';
    if ($('clear-btn')) $('clear-btn').style.display = 'none';
  } catch (e) {
    toast(e.message || 'Failed to add link', 'err');
  } finally {
    $('add-btn').disabled = false;
    if ($('paste-btn')) $('paste-btn').disabled = false;
  }
}

// ── Run one item end-to-end ───────────────────────────────────────────
async function runItem(item) {
  if (item.status !== 'queued') return;
  item.status = 'active'; item.received = 0; item.error = null;
  item.startedAt = Date.now(); item.lastTick = { time: Date.now(), bytes: 0 };
  item.speedSamples = [{ time: Date.now(), bytes: 0 }];
  const aborter = new AbortController(); item.abort = aborter;
  renderQueue();

  let sink = null;
  try {
    // Refresh meta + first assignment together (with retry on dead workers)
    const { assignment: firstAssignment, meta } = await workerMetaWithRetry(item.megaLink, item.childId);
    if (meta.type === 'folder') throw new Error('folder slot got folder meta');
    item.size = meta.fileSize; item.name = meta.filename || item.name;

    // Set up sink: prefer File System Access API (true streaming, unlimited size)
    const filename = (item.name || 'download.bin').split('/').pop();
    if (supportsFSA) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'File', accept: { '*/*': ['.' + (filename.split('.').pop() || 'bin')] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { item.status = 'queued'; renderQueue(); return; }
        // SecurityError or gesture error — fall back to Blob sink silently
        if (item.size > BLOB_FALLBACK_MAX) {
          throw new Error('File too large for browser save fallback (>1.9 GB). Use Chrome/Edge and click Start directly.');
        }
        sink = blobSink(filename, null);
      }
      if (handle) {
        const writable = await handle.createWritable();
        sink = fsaSink(writable);
      }
    } else {
      if (item.size > BLOB_FALLBACK_MAX) {
        throw new Error('Browser lacks File System Access. Use Chrome/Edge for files >1.9 GB.');
      }
      sink = blobSink(filename, meta.mimeType);
    }

    // Plan segments
    const totalSize = item.size;
    const segments = [];
    if (!totalSize || totalSize <= SEGMENT_BYTES) {
      segments.push({ start: 0, end: totalSize ? totalSize - 1 : undefined, assignment: firstAssignment });
    } else {
      let off = 0, first = true;
      while (off < totalSize) {
        const end = Math.min(off + SEGMENT_BYTES - 1, totalSize - 1);
        segments.push({ start: off, end, assignment: first ? firstAssignment : null });
        off = end + 1; first = false;
      }
    }

    // Stream each segment in order to the sink
    for (let i = 0; i < segments.length; i++) {
      if (aborter.signal.aborted) throw new Error('cancelled');
      const seg = segments[i];
      if (!seg.assignment) seg.assignment = await apiDownload(item.megaLink);
      if (i + 1 < segments.length && !segments[i + 1].assignment) {
        apiDownload(item.megaLink).then(a => { segments[i + 1].assignment = a; }).catch(() => {});
      }
      let retries = 2;
      while (true) {
        try {
          await streamSegment({
            assignment: seg.assignment, megaLink: item.megaLink, childId: item.childId,
            rangeStart: seg.start, rangeEnd: seg.end,
            sink, abortSignal: aborter.signal,
            onBytes: (b) => {
              item.received += b;
              const now = Date.now();
              const dt = (now - item.lastTick.time) / 1000;
              if (dt >= 0.6) {
                // Rolling speed: keep samples from last SPEED_WINDOW_SEC seconds
                item.speedSamples.push({ time: now, bytes: item.received });
                const cutoff = now - SPEED_WINDOW_SEC * 1000;
                while (item.speedSamples.length > 2 && item.speedSamples[0].time < cutoff) {
                  item.speedSamples.shift();
                }
                const oldest = item.speedSamples[0];
                const elapsed = (now - oldest.time) / 1000;
                item.speed = elapsed > 0 ? (item.received - oldest.bytes) / elapsed : 0;
                item.lastTick = { time: now, bytes: item.received };
                renderQueue();
              }
            },
          });
          break;
        } catch (e) {
          if (aborter.signal.aborted) throw new Error('cancelled');
          if (--retries < 0) throw e;
          try { seg.assignment = await apiDownload(item.megaLink); }
          catch (e2) { throw new Error('retry assign: ' + e2.message); }
        }
      }
    }

    await sink.finalize();
    item.status = 'done'; item.speed = 0; item.received = item.size;
    renderQueue();
    toast('Saved: ' + filename, 'ok');
  } catch (e) {
    if (sink) await sink.abort();
    if (e && e.message === 'cancelled') { item.status = 'queued'; }
    else { item.status = 'error'; item.error = (e && e.message ? e.message : 'error').slice(0, 60); toast(item.name + ': ' + item.error, 'err'); }
    item.speed = 0;
    renderQueue();
  } finally {
    item.abort = null;
  }
}

// ── Run a folder-as-ZIP item ──────────────────────────────────────────
async function runZipItem(item) {
  if (item.status !== 'queued') return;
  if (!window.JSZip) { item.status = 'error'; item.error = 'JSZip not loaded'; renderQueue(); return; }
  item.status = 'active'; item.received = 0; item.error = null;
  item.startedAt = Date.now(); item.lastTick = { time: Date.now(), bytes: 0 };
  item.speedSamples = [{ time: Date.now(), bytes: 0 }];
  const aborter = new AbortController(); item.abort = aborter;
  renderQueue();
  try {
    const zip = new window.JSZip();
    for (let i = 0; i < item.zipChildren.length; i++) {
      if (aborter.signal.aborted) throw new Error('cancelled');
      const c = item.zipChildren[i];
      item.zipDone = i; renderQueue();
      const { assignment } = await workerMetaWithRetry(item.megaLink, c.id);
      const chunks = [];
      await streamSegment({
        assignment, megaLink: item.megaLink, childId: c.id,
        rangeStart: 0, rangeEnd: undefined,
        sink: { write: async (chunk) => chunks.push(chunk), finalize: async () => {}, abort: async () => {} },
        abortSignal: aborter.signal,
        onBytes: (b) => {
          item.received += b;
          const now = Date.now();
          const dt = (now - item.lastTick.time) / 1000;
          if (dt >= 0.6) {
            item.speedSamples.push({ time: now, bytes: item.received });
            const cutoff = now - SPEED_WINDOW_SEC * 1000;
            while (item.speedSamples.length > 2 && item.speedSamples[0].time < cutoff) item.speedSamples.shift();
            const oldest = item.speedSamples[0];
            const elapsed = (now - oldest.time) / 1000;
            item.speed = elapsed > 0 ? (item.received - oldest.bytes) / elapsed : 0;
            item.lastTick = { time: now, bytes: item.received };
            renderQueue();
          }
        },
      });
      zip.file(c.path || c.name, new Blob(chunks));
    }
    item.zipDone = item.zipTotal; renderQueue();
    toast('Building ZIP…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = item.name || 'folder.zip'; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
    item.status = 'done'; item.speed = 0; item.size = blob.size; item.received = blob.size;
    renderQueue();
    toast('ZIP saved: ' + item.name, 'ok');
  } catch (e) {
    if (e && e.message === 'cancelled') { item.status = 'queued'; }
    else { item.status = 'error'; item.error = (e && e.message ? e.message : 'error').slice(0, 60); toast(item.name + ': ' + item.error, 'err'); }
    item.speed = 0;
    renderQueue();
  } finally {
    item.abort = null;
  }
}

async function startAll() {
  if (running) return;
  running = true;
  $('start-all-btn').disabled = true;

  const pending = () => queue.find(i => i.status === 'queued');

  async function runNext() {
    while (true) {
      const next = pending();
      if (!next) break;
      activeCount++;
      renderQueue();
      try {
        if (next.isZip) await runZipItem(next);
        else await runItem(next);
      } finally {
        activeCount--;
      }
    }
  }

  try {
    const maxC = parseInt(($('max-concurrent') && $('max-concurrent').value) || '3', 10);
    const workers = Array.from({ length: maxC }, () => runNext());
    await Promise.all(workers);
  } finally {
    running = false;
    $('start-all-btn').disabled = false;
    refreshPoolBadge();
  }
}

// ── Pool status badge (live) ──────────────────────────────────────────
async function refreshPoolBadge() {
  const s = await apiStatus();
  if (!s) return;
  const net = $('net-badge');
  const active = (s.workers && s.workers.active) || 0;
  const warming = (s.workers && s.workers.warming) || 0;
  net.textContent = `⚡ ${active} active${warming > 0 ? ' · ' + warming + ' warming' : ''}`;
  net.className = 'badge ' + (active > 0 ? 'ok' : 'warn');
}

// ── UI wiring ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const tok = getToken();
  const badge = $('auth-badge');
  if (tok) { badge.textContent = '🔒 Authorized'; badge.classList.add('ok'); }
  else { badge.textContent = '⚠ Token needed'; badge.classList.add('warn'); $('input-hint').innerHTML = 'Append <code>#yourtoken</code> to this page URL and reload, then bookmark.'; }

  if (!supportsFSA) {
    const hint = $('input-hint');
    if (hint) hint.innerHTML += '<br><span style="color:#ffb13d">⚠ Browser doesn\'t support File System Access. Files >1.9 GB unsupported. Use Chrome/Edge.</span>';
  }

  refreshPoolBadge();
  setInterval(refreshPoolBadge, 15000);

  $('add-btn').addEventListener('click', () => addLink($('mega-link').value));
  $('mega-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLink($('mega-link').value); });
  $('mega-link').addEventListener('input', () => {
    const cb = $('clear-btn');
    if (cb) cb.style.display = $('mega-link').value ? '' : 'none';
  });
  const clearBtn = $('clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      $('mega-link').value = '';
      clearBtn.style.display = 'none';
      $('mega-link').focus();
    });
  }
  $('start-all-btn').addEventListener('click', startAll);
  $('clear-done-btn').addEventListener('click', () => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done') queue.splice(i, 1);
    renderQueue();
  });

  // Paste button: read clipboard
  const pasteBtn = $('paste-btn');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          $('mega-link').value = text.trim();
          if ($('clear-btn')) $('clear-btn').style.display = '';
          addLink(text.trim());
        } else {
          toast('Clipboard is empty', 'err');
        }
      } catch (e) {
        toast('Clipboard access denied. Paste manually.', 'err');
      }
    });
  }

  // Retry all failed button
  const retryAllBtn = $('retry-all-btn');
  if (retryAllBtn) {
    retryAllBtn.addEventListener('click', () => {
      let count = 0;
      for (const it of queue) {
        if (it.status === 'error') {
          it.status = 'queued'; it.received = 0; it.error = null; it.speed = 0;
          it.speedSamples = [];
          count++;
        }
      }
      if (count > 0) {
        renderQueue();
        toast(`${count} item${count !== 1 ? 's' : ''} re-queued — click ▶ Start all to download`, 'ok');
      } else {
        toast('No failed items', 'err');
      }
    });
  }

  // Drag-and-drop on input area
  const inputCard = document.querySelector('.input-card');
  if (inputCard) {
    inputCard.addEventListener('dragover', (e) => { e.preventDefault(); inputCard.classList.add('drag-over'); });
    inputCard.addEventListener('dragleave', () => { inputCard.classList.remove('drag-over'); });
    inputCard.addEventListener('drop', (e) => {
      e.preventDefault();
      inputCard.classList.remove('drag-over');
      const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || '';
      if (text.trim()) {
        $('mega-link').value = text.trim();
        if ($('clear-btn')) $('clear-btn').style.display = '';
        addLink(text.trim());
      }
    });
  }

  // Queue action delegation (start, cancel, remove, retry)
  $('queue-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = +btn.dataset.id;
    const it = queue.find(q => q.id === id); if (!it) return;
    if (btn.dataset.act === 'start') { if (it.isZip) runZipItem(it); else runItem(it); }
    else if (btn.dataset.act === 'cancel') { try { it.abort && it.abort.abort(); } catch {} }
    else if (btn.dataset.act === 'retry') {
      it.status = 'queued'; it.received = 0; it.error = null; it.speed = 0;
      it.speedSamples = [];
      renderQueue();
      if (it.isZip) runZipItem(it); else runItem(it);
    }
    else if (btn.dataset.act === 'remove') {
      const idx = queue.indexOf(it); if (idx >= 0) queue.splice(idx, 1);
      renderQueue();
    }
  });
});
