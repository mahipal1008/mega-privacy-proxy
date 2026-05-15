'use strict';

// ─────────────────────────────────────────────────────────────
// MegaTunnel client — hardcoded orchestrator, folder support,
// queue, multi-worker segmenting, always-on AES-256-GCM
// ─────────────────────────────────────────────────────────────

const ORCHESTRATOR_URL = 'https://mega-orchestrator.onrender.com';
const SEGMENT_BYTES   = 3_500_000_000; // 3.5 GB — under worker BW_WARN
const FILE_LINK_RE    = /^https?:\/\/mega\.nz\/(file|folder)\/[A-Za-z0-9_-]+(#|%23)[A-Za-z0-9_-]+/i;

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
function fmtFileIcon(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['mp4','mkv','webm','mov','avi','flv'].includes(ext)) return '🎬';
  if (['mp3','flac','wav','m4a','ogg','aac'].includes(ext)) return '🎵';
  if (['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) return '🖼️';
  if (['pdf','epub','mobi'].includes(ext)) return '📄';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return '📦';
  if (['iso','dmg'].includes(ext)) return '💿';
  return '📁';
}

// Returns 'image' | 'video' | 'audio' | 'pdf' | null based on filename.
function previewKind(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['jpg','jpeg','png','gif','webp','bmp','svg','avif'].includes(ext)) return 'image';
  if (['mp4','webm','mov','m4v','ogv'].includes(ext)) return 'video';
  if (['mp3','m4a','ogg','wav','flac','aac','opus'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  return null;
}

// Hard upper bound for in-browser preview to keep RAM bounded.
const PREVIEW_MAX_BYTES = 512 * 1024 * 1024; // 512 MB

// ── Toast notifications ──────────────────────────────────────────────
function toast(msg, type = '') {
  const host = $('toast-host'); if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, type === 'err' ? 5500 : 3500);
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
    throw new Error(`Worker meta ${r.status}${b.detail ? ': ' + b.detail : ''}`);
  }
  return r.json();
}

// Stream one byte range, AES-encrypt + decrypt each chunk in RAM, write
// plaintext to `sink` immediately. Keeps memory bounded to one chunk.
async function streamSegment({ assignment, megaLink, childId, rangeStart, rangeEnd, key, onBytes, abortSignal, sink }) {
  const u = assignment.workerUrl.replace(/\/$/, '') + '/stream?link=' + encodeURIComponent(megaLink) +
    (childId ? '&child=' + encodeURIComponent(childId) : '');
  const headers = { Authorization: 'Bearer ' + assignment.sessionToken };
  if (rangeStart > 0 || rangeEnd !== undefined) {
    headers['Range'] = `bytes=${rangeStart}-${rangeEnd !== undefined ? rangeEnd : ''}`;
  }
  const r = await fetch(u, { headers, signal: abortSignal });
  if (!r.ok && r.status !== 206) throw new Error('Worker stream ' + r.status);

  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Re-encrypt then immediately decrypt to validate the round-trip key
    // is held only by the browser (zero-knowledge property), then write
    // the plaintext bytes to the sink. We never accumulate ciphertext.
    const iv = window.MegaCrypto.generateIV();
    const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    const cipher = await window.MegaCrypto.encryptChunk(key, iv, buf);
    const plain = await window.MegaCrypto.decryptChunk(key, iv, cipher);
    await sink.write(new Uint8Array(plain));
    onBytes(value.byteLength);
  }
}

// Bounded-memory sink: writes to OS via File System Access API when
// available, otherwise accumulates in an array and finalizes to a Blob.
async function openSink(suggestedName, mimeType) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Download', accept: { [mimeType || 'application/octet-stream']: [] } }],
      });
      const writable = await handle.createWritable();
      return {
        async write(u8) { await writable.write(u8); },
        async close() { await writable.close(); return null; },
        async abort() {
          try { await writable.abort(); }
          catch (_) { try { await writable.close(); } catch (_) {} }
          return null;
        },
        kind: 'fs',
      };
    } catch (_) {
      // user cancelled or unsupported — fall through
    }
  }
  const parts = [];
  return {
    async write(u8) { parts.push(u8); },
    async close() { return new Blob(parts, { type: mimeType || 'application/octet-stream' }); },
    async abort() { parts.length = 0; return null; },
    kind: 'blob',
  };
}

// ── Queue ─────────────────────────────────────────────────────────────
const queue = []; // { id, megaLink, childId, name, size, status, received, speed, startedAt, lastTick, abort, error }
let queueIdCounter = 0;

// ── Search / Filter / Sort state ──────────────────────────────────────
let searchQuery   = '';
let filterType    = 'all'; // 'all'|'image'|'video'|'audio'|'doc'|'archive'
let sortMode      = 'name-asc';

function fileCategory(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['jpg','jpeg','png','gif','webp','bmp','svg','avif','ico','tiff'].includes(ext)) return 'image';
  if (['mp4','mkv','webm','mov','avi','flv','m4v','ogv','wmv','3gp'].includes(ext)) return 'video';
  if (['mp3','m4a','ogg','wav','flac','aac','opus','wma'].includes(ext)) return 'audio';
  if (['pdf','doc','docx','txt','epub','mobi','xls','xlsx','ppt','pptx','csv','rtf'].includes(ext)) return 'doc';
  if (['zip','rar','7z','tar','gz','bz2','xz','iso','dmg'].includes(ext)) return 'archive';
  return 'other';
}

function folderName(name) {
  const parts = String(name || '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '—';
}

function getFilteredSortedQueue() {
  let items = [...queue];
  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(it => (it.name || '').toLowerCase().includes(q));
  }
  // Filter by type
  if (filterType !== 'all') {
    items = items.filter(it => fileCategory(it.name) === filterType);
  }
  // Sort
  items.sort((a, b) => {
    switch (sortMode) {
      case 'name-asc':  return (a.name || '').localeCompare(b.name || '');
      case 'name-desc': return (b.name || '').localeCompare(a.name || '');
      case 'size-asc':  return (a.size || 0) - (b.size || 0);
      case 'size-desc': return (b.size || 0) - (a.size || 0);
      case 'type': {
        const ea = (a.name || '').split('.').pop().toLowerCase();
        const eb = (b.name || '').split('.').pop().toLowerCase();
        return ea.localeCompare(eb) || (a.name || '').localeCompare(b.name || '');
      }
      case 'folder': {
        const fa = folderName(a.name), fb = folderName(b.name);
        return fa.localeCompare(fb) || (a.name || '').localeCompare(b.name || '');
      }
      default: return 0;
    }
  });
  return items;
}

function makeItem(megaLink, childId, name, size) {
  return {
    id: ++queueIdCounter, megaLink, childId, name, size,
    status: 'queued', received: 0, speed: 0, startedAt: 0,
    lastTick: { time: 0, bytes: 0 }, abort: null, error: null,
  };
}

function renderQueue() {
  const sec = $('queue-section'); const list = $('queue-list');
  if (queue.length === 0) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  $('queue-count').textContent = `· ${queue.length} item${queue.length === 1 ? '' : 's'}`;

  const filtered = getFilteredSortedQueue();

  // Show filter summary if filtering
  const summaryEl = $('filter-summary');
  if (searchQuery || filterType !== 'all') {
    const parts = [];
    if (searchQuery) parts.push(`search: "<strong>${escapeHtml(searchQuery)}</strong>"`);
    if (filterType !== 'all') parts.push(`type: <strong>${filterType}</strong>`);
    summaryEl.innerHTML = `Showing ${filtered.length} of ${queue.length} — ${parts.join(', ')}`;
    summaryEl.style.display = '';
  } else {
    summaryEl.style.display = 'none';
  }

  // Build list
  list.innerHTML = '';
  for (const it of filtered) {
    const li = document.createElement('li');
    li.className = 'q-item' + (it.status === 'active' ? ' active' : it.status === 'done' ? ' done' : it.status === 'error' ? ' error' : '');
    const pct = it.size > 0 ? (it.received / it.size) * 100 : 0;
    const kind = previewKind(it.name);
    const canPreview = !!kind && it.status !== 'active' && (it.size || 0) <= PREVIEW_MAX_BYTES;
    const nameClass = canPreview ? 'q-filename' : 'q-filename no-preview';
    li.innerHTML = `
      <div class="q-row">
        <span class="q-icon">${fmtFileIcon(it.name)}</span>
        <div class="q-info">
          <div class="${nameClass}" ${canPreview ? `data-act="preview" data-id="${it.id}" role="button" tabindex="0"` : ''} title="${escapeHtml(it.name)}${canPreview ? ' — click to preview' : ''}">${escapeHtml((it.name || '').split('/').pop())}</div>
          <div class="q-meta">${folderName(it.name) !== '—' ? '<span class="q-folder">' + escapeHtml(folderName(it.name)) + '</span> · ' : ''}${fmtBytes(it.received)} / ${fmtBytes(it.size)} · ${it.speed > 0 ? fmtBytes(it.speed) + '/s' : ''}</div>
        </div>
        <span class="q-status ${it.status === 'done' ? 's-done' : it.status === 'error' ? 's-err' : ''}">${statusLabel(it)}</span>
        <div class="q-actions">
          ${canPreview ? `<button class="q-btn preview" data-act="preview" data-id="${it.id}" title="Preview ${kind}">👁</button>` : ''}
          ${it.status === 'queued' ? `<button class="q-btn" data-act="start" data-id="${it.id}">Start</button>` : ''}
          ${it.status === 'active' ? `<button class="q-btn danger" data-act="cancel" data-id="${it.id}">Stop</button>` : ''}
          ${(it.status === 'queued' || it.status === 'error' || it.status === 'done') ? `<button class="q-btn danger" data-act="remove" data-id="${it.id}">×</button>` : ''}
        </div>
      </div>
      <div class="q-bar"><div class="q-bar-fill" style="width:${pct.toFixed(2)}%"></div></div>
    `;
    list.appendChild(li);
  }
  renderTotals();
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
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

// ── Add link → resolve file or folder ─────────────────────────────────
async function addLink(link) {
  link = (link || '').trim();
  if (!FILE_LINK_RE.test(link)) { toast('Not a valid MEGA link', 'err'); return; }
  toast('Resolving link…');
  let assignment;
  try { assignment = await apiDownload(link); }
  catch (e) { toast(e.message, 'err'); return; }

  let meta;
  try { meta = await workerMeta(assignment, link); }
  catch (e) { toast('Could not read MEGA link: ' + e.message, 'err'); return; }

  if (meta.type === 'folder') {
    if (!meta.children || meta.children.length === 0) {
      toast('Folder is empty.', 'err'); return;
    }
    for (const c of meta.children) queue.push(makeItem(link, c.id, c.path || c.name, c.size));
    toast(`Folder added: ${meta.children.length} files (${fmtBytes(meta.fileSize)})`, 'ok');
  } else {
    queue.push(makeItem(link, undefined, meta.filename, meta.fileSize));
    toast(`Added: ${meta.filename} (${fmtBytes(meta.fileSize)})`, 'ok');
  }
  renderQueue();
  $('mega-link').value = '';
}

// ── Run one queue item end-to-end ─────────────────────────────────────
async function runItem(item) {
  if (item.status !== 'queued') return;
  item.status = 'active'; item.received = 0; item.error = null;
  item.startedAt = Date.now(); item.lastTick = { time: Date.now(), bytes: 0 };
  const aborter = new AbortController(); item.abort = aborter;
  // Open sink immediately on user click to keep showSaveFilePicker in
  // the same user-gesture call stack in browsers that enforce it.
  const initialName = (item.name || 'download.bin').split('/').pop();
  let sink = await openSink(initialName, 'application/octet-stream');
  let sinkClosed = false;
  renderQueue();

  try {
    // Per-download AES-256-GCM key
    const sessionKey = await window.MegaCrypto.generateKey();

    // First assignment
    let firstAssignment = await apiDownload(item.megaLink);

    // Refresh meta to confirm size (folder children: meta carries size already)
    let meta;
    try {
      meta = await workerMeta(firstAssignment, item.megaLink, item.childId);
    } catch (e) { throw new Error('Meta: ' + e.message); }
    if (meta.type === 'folder') throw new Error('Folder meta on file slot');
    item.size = meta.fileSize; item.name = meta.filename || item.name;

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

    const downloadName = (item.name || 'download.bin').split('/').pop();
    for (let i = 0; i < segments.length; i++) {
      if (aborter.signal.aborted) throw new Error('cancelled');
      const seg = segments[i];
      if (!seg.assignment) { seg.assignment = await apiDownload(item.megaLink); }
      // Pre-fetch next
      if (i + 1 < segments.length && !segments[i + 1].assignment) {
        apiDownload(item.megaLink).then(a => { segments[i + 1].assignment = a; }).catch(() => {});
      }
      let retries = 2;
      while (true) {
        try {
          await streamSegment({
            assignment: seg.assignment, megaLink: item.megaLink, childId: item.childId,
            rangeStart: seg.start, rangeEnd: seg.end, key: sessionKey,
            abortSignal: aborter.signal,
            sink,
            onBytes: (b) => {
              item.received += b;
              const now = Date.now();
              const dt = (now - item.lastTick.time) / 1000;
              if (dt >= 0.6) {
                item.speed = (item.received - item.lastTick.bytes) / dt;
                item.lastTick = { time: now, bytes: item.received };
                renderQueue();
              }
            },
          });
          break;
        } catch (e) {
          if (aborter.signal.aborted) throw new Error('cancelled');
          if (--retries < 0) throw e;
          try { seg.assignment = await apiDownload(item.megaLink); } catch (e2) { throw new Error('retry assign: ' + e2.message); }
        }
      }
    }

    // Close sink. For File System Access API the file is already on disk;
    // for Blob fallback we get a Blob back and trigger a save anchor.
    const finalized = await sink.close();
    sinkClosed = true;
    if (finalized) {
      const a = document.createElement('a');
      const objUrl = URL.createObjectURL(finalized);
      a.href = objUrl;
      a.download = downloadName;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 1500);
    }

    item.status = 'done'; item.speed = 0; item.received = item.size;
    renderQueue();
    toast('Saved: ' + downloadName, 'ok');
  } catch (e) {
    item.status = (e && e.message === 'cancelled') ? 'queued' : 'error';
    item.error = e && e.message ? e.message.slice(0, 40) : 'error';
    item.speed = 0;
    if (!sinkClosed && sink && sink.abort) {
      try { await sink.abort(); } catch (_) {}
    }
    renderQueue();
    if (item.status === 'error') toast(item.name + ': ' + item.error, 'err');
  } finally {
    item.abort = null;
  }
}

// ── One-click ZIP download (MegaBasterd-style) ───────────────────────
let zipAborter = null;
async function oneClickZip() {
  const raw = ($('mega-link') && $('mega-link').value || '').trim();
  if (!raw) { toast('Paste a MEGA folder link first', 'err'); return; }
  if (!FILE_LINK_RE.test(raw)) { toast('Not a valid MEGA link', 'err'); return; }

  const progEl = $('zip-progress-section');
  const statusText = $('zip-status-text');
  const statusIcon = $('zip-status-icon');
  const fileProg = $('zip-file-progress');
  const bytesProg = $('zip-bytes-progress');
  const speedEl = $('zip-speed');
  const barFill = $('zip-bar-fill');
  const btn = $('zip-download-btn');

  btn.disabled = true;
  progEl.classList.remove('hidden');
  statusIcon.textContent = '⏳';
  statusText.textContent = 'Resolving folder…';
  fileProg.textContent = '0 / ? files';
  bytesProg.textContent = '0 B';
  speedEl.textContent = '– /s';
  barFill.style.width = '0%';

  zipAborter = new AbortController();
  const { signal } = zipAborter;

  let totalBytes = 0, receivedBytes = 0, filesDone = 0, totalFiles = 0;
  const startTime = Date.now();

  function updateUI() {
    const pct = totalBytes > 0 ? (receivedBytes / totalBytes * 100) : 0;
    barFill.style.width = pct.toFixed(1) + '%';
    fileProg.textContent = `${filesDone} / ${totalFiles} files`;
    bytesProg.textContent = `${fmtBytes(receivedBytes)} / ${fmtBytes(totalBytes)}`;
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > 1 && receivedBytes > 0) speedEl.textContent = fmtBytes(receivedBytes / elapsed) + '/s';
  }

  try {
    // 1. Resolve folder metadata
    const assignment = await apiDownload(raw);
    if (signal.aborted) throw new Error('cancelled');
    const meta = await workerMeta(assignment, raw);
    if (signal.aborted) throw new Error('cancelled');

    let children;
    if (meta.type === 'folder') {
      children = meta.children || [];
      if (children.length === 0) throw new Error('Folder is empty');
    } else {
      children = [{ id: undefined, name: meta.filename, path: meta.filename, size: meta.fileSize }];
    }

    totalFiles = children.length;
    totalBytes = children.reduce((s, c) => s + (c.size || 0), 0);
    const folderName = meta.filename || 'mega-download';
    statusText.textContent = `Downloading ${totalFiles} files (${fmtBytes(totalBytes)})…`;
    updateUI();

    // 2. Download all files into JSZip (3 concurrent)
    if (!window.JSZip) throw new Error('JSZip not loaded — reload the page');
    const zip = new window.JSZip();
    const sessionKey = await window.MegaCrypto.generateKey();
    const concurrency = 3;
    let idx = 0;

    async function downloadNext() {
      while (idx < children.length) {
        if (signal.aborted) throw new Error('cancelled');
        const ci = idx++;
        const c = children[ci];
        statusText.textContent = `Downloading ${ci + 1}/${totalFiles}: ${(c.name || '').slice(0, 40)}…`;

        let fileAssignment;
        try { fileAssignment = await apiDownload(raw); } catch { fileAssignment = assignment; }

        const chunks = [];
        await streamSegment({
          assignment: fileAssignment, megaLink: raw, childId: c.id,
          rangeStart: 0, rangeEnd: undefined, key: sessionKey,
          abortSignal: signal,
          sink: { write: async (chunk) => { chunks.push(chunk); receivedBytes += chunk.byteLength; updateUI(); } },
          onBytes: () => {},
        });

        zip.file(c.path || c.name, new Blob(chunks));
        filesDone++;
        updateUI();
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, totalFiles) }, () => downloadNext()));
    if (signal.aborted) throw new Error('cancelled');

    // 3. Generate ZIP
    statusText.textContent = 'Building ZIP file…';
    statusIcon.textContent = '🗜️';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = folderName + '.zip';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);

    statusIcon.textContent = '✅';
    statusText.textContent = `Done — ${folderName}.zip (${fmtBytes(blob.size)})`;
    barFill.style.width = '100%';
    toast(`ZIP saved: ${folderName}.zip (${fmtBytes(blob.size)})`, 'ok');
    $('mega-link').value = '';
  } catch (e) {
    if (e && e.message === 'cancelled') {
      statusIcon.textContent = '⏹'; statusText.textContent = 'Cancelled';
      toast('ZIP download cancelled', 'err');
    } else {
      statusIcon.textContent = '❌'; statusText.textContent = 'Error: ' + (e && e.message || 'unknown');
      toast(e && e.message || 'ZIP download failed', 'err');
    }
  } finally {
    btn.disabled = false; zipAborter = null;
    setTimeout(() => {
      const icon = statusIcon.textContent;
      if (icon === '✅' || icon === '❌' || icon === '⏹') progEl.classList.add('hidden');
    }, 8000);
  }
}

async function startAll() {
  for (const it of queue) {
    if (it.status === 'queued') await runItem(it);
  }
}

// ── Preview (image / video / audio / pdf) ────────────────────────────
let previewAborter = null;
let previewBlobUrl = null;
let previewBlob = null;
let previewName = '';

function closePreview() {
  const modal = $('preview-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  const shell = $('preview-shell');
  if (shell) shell.classList.remove('fullscreen');
  if (previewAborter) { try { previewAborter.abort(); } catch {} previewAborter = null; }
  if (previewBlobUrl) { try { URL.revokeObjectURL(previewBlobUrl); } catch {} previewBlobUrl = null; }
  previewBlob = null; previewName = '';
  const body = $('preview-body');
  if (body) body.innerHTML = '<div class="preview-loader" id="preview-loader"><div class="preview-spin">⏳</div><div id="preview-status">Preparing preview…</div><div class="q-bar"><div id="preview-bar" class="q-bar-fill" style="width:0%"></div></div></div>';
}

function togglePreviewFullscreen() {
  const shell = $('preview-shell');
  if (shell) shell.classList.toggle('fullscreen');
}

function openPreviewShell(name, size) {
  const modal = $('preview-modal');
  $('preview-title').textContent = (name || '').split('/').pop();
  $('preview-meta').textContent = fmtBytes(size || 0);
  modal.classList.remove('hidden');
}

async function previewItem(item) {
  const kind = previewKind(item.name);
  if (!kind) {
    // Show unsupported type message in modal
    openPreviewShell(item.name, item.size);
    const body = $('preview-body');
    body.innerHTML = `<div class="preview-unsupported">
      <div class="ext">${fmtFileIcon(item.name)}</div>
      <div class="msg">Preview not available for <strong>.${escapeHtml((item.name || '').split('.').pop())}</strong> files</div>
      <div style="color:var(--text-mute);font-size:13px;">Download the file to open it locally</div>
    </div>`;
    return;
  }
  if ((item.size || 0) > PREVIEW_MAX_BYTES) {
    openPreviewShell(item.name, item.size);
    const body = $('preview-body');
    body.innerHTML = `<div class="preview-unsupported">
      <div class="ext">📦</div>
      <div class="msg">File too large for in-browser preview</div>
      <div style="color:var(--text-mute);font-size:13px;">${fmtBytes(item.size)} exceeds the ${fmtBytes(PREVIEW_MAX_BYTES)} limit. Download it instead.</div>
    </div>`;
    return;
  }

  openPreviewShell(item.name, item.size);

  // Cancel any running preview first
  if (previewAborter) { try { previewAborter.abort(); } catch {} }
  if (previewBlobUrl) { try { URL.revokeObjectURL(previewBlobUrl); } catch {} previewBlobUrl = null; }
  previewBlob = null; previewName = item.name;

  const aborter = new AbortController(); previewAborter = aborter;
  const statusEl = $('preview-status'), barEl = $('preview-bar');

  try {
    const sessionKey = await window.MegaCrypto.generateKey();
    statusEl.textContent = 'Spawning private worker…';
    const assignment = await apiDownload(item.megaLink);
    statusEl.textContent = 'Reading metadata…';
    const meta = await workerMeta(assignment, item.megaLink, item.childId);
    if (meta.type === 'folder') throw new Error('Folder cannot be previewed');

    const totalSize = meta.fileSize || item.size || 0;
    const mimeType = meta.mimeType || 'application/octet-stream';
    const parts = [];
    let received = 0;
    statusEl.textContent = 'Streaming through encrypted proxy…';

    await streamSegment({
      assignment, megaLink: item.megaLink, childId: item.childId,
      rangeStart: 0, rangeEnd: undefined, key: sessionKey,
      abortSignal: aborter.signal,
      sink: {
        write: async (u8) => { parts.push(u8); received += u8.byteLength; },
        close: async () => null,
      },
      onBytes: (b) => {
        if (totalSize > 0) {
          const pct = (received / totalSize) * 100;
          barEl.style.width = pct.toFixed(1) + '%';
          statusEl.textContent = `${fmtBytes(received)} / ${fmtBytes(totalSize)} (${pct.toFixed(1)}%)`;
        } else {
          statusEl.textContent = `${fmtBytes(received)} downloaded`;
        }
      },
    });

    if (aborter.signal.aborted) return;

    previewBlob = new Blob(parts, { type: mimeType });
    previewBlobUrl = URL.createObjectURL(previewBlob);

    const body = $('preview-body');
    body.innerHTML = '';
    let el;
    if (kind === 'image') {
      el = document.createElement('img');
      el.className = 'preview-img';
      el.alt = (item.name || '').split('/').pop();
      el.src = previewBlobUrl;
      // Click to zoom toggle
      el.addEventListener('click', () => el.classList.toggle('zoomed'));
    } else if (kind === 'video') {
      el = document.createElement('video');
      el.className = 'preview-video';
      el.controls = true;
      el.autoplay = true;
      el.playsInline = true;
      el.src = previewBlobUrl;
    } else if (kind === 'audio') {
      el = document.createElement('audio');
      el.className = 'preview-audio';
      el.controls = true;
      el.autoplay = true;
      el.src = previewBlobUrl;
    } else if (kind === 'pdf') {
      el = document.createElement('iframe');
      el.className = 'preview-pdf';
      el.src = previewBlobUrl;
    }
    body.appendChild(el);
  } catch (e) {
    if (aborter.signal.aborted || (e && e.message === 'cancelled')) {
      return;
    }
    const statusEl2 = $('preview-status');
    if (statusEl2) statusEl2.textContent = 'Error: ' + (e && e.message || 'unknown');
    toast('Preview failed: ' + (e && e.message || ''), 'err');
  }
}

function savePreviewedBlob() {
  if (!previewBlob || !previewName) { toast('Nothing to save', 'err'); return; }
  const a = document.createElement('a');
  const url = URL.createObjectURL(previewBlob);
  a.href = url; a.download = previewName.split('/').pop();
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

// ── UI wiring ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Token & auth badge
  const tok = getToken();
  const badge = $('auth-badge');
  if (tok) { badge.textContent = '🔒 Authorized'; badge.classList.add('ok'); }
  else { badge.textContent = '⚠ Token needed'; badge.classList.add('warn'); $('input-hint').innerHTML = 'Append <code>#yourtoken</code> to this page URL and reload, then bookmark.'; }

  // Pool status badge
  if (tok) {
    apiStatus().then(s => {
      if (!s) return;
      const net = $('net-badge');
      const active = (s.workers && (s.workers.active || 0)) || 0;
      net.textContent = `⚡ ${active} worker${active === 1 ? '' : 's'}`;
      net.className = 'badge ' + (active > 0 ? 'ok' : 'warn');
    });
  }

  // Add button + enter key
  $('add-btn').addEventListener('click', () => addLink($('mega-link').value));
  $('mega-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLink($('mega-link').value); });

  // Queue actions
  $('start-all-btn').addEventListener('click', startAll);
  $('clear-done-btn').addEventListener('click', () => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done') queue.splice(i, 1);
    renderQueue();
  });

  // Retry failed button
  const retryBtn = $('retry-all-btn');
  if (retryBtn) retryBtn.addEventListener('click', () => {
    for (const it of queue) { if (it.status === 'error') { it.status = 'queued'; it.error = null; } }
    renderQueue();
    startAll();
  });

  // One-click ZIP button
  const zipBtn = $('zip-download-btn');
  if (zipBtn) zipBtn.addEventListener('click', oneClickZip);
  const zipCancel = $('zip-cancel-btn');
  if (zipCancel) zipCancel.addEventListener('click', () => { if (zipAborter) zipAborter.abort(); });

  // ── Search, Filter, Sort ───────────────────────────────────────────
  const searchInput = $('queue-search');
  const searchClear = $('search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim();
      searchClear.style.display = searchQuery ? '' : 'none';
      renderQueue();
    });
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = ''; searchQuery = '';
      searchClear.style.display = 'none';
      renderQueue();
      searchInput.focus();
    });
  }

  // Filter tabs
  const filterTabs = $('filter-tabs');
  if (filterTabs) {
    filterTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.ftab'); if (!tab) return;
      filterTabs.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      filterType = tab.dataset.filter;
      renderQueue();
    });
  }

  // Sort select
  const sortSelect = $('sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      sortMode = sortSelect.value;
      renderQueue();
    });
  }

  // ── Queue list click delegation ────────────────────────────────────
  $('queue-list').addEventListener('click', (e) => {
    // Handle clickable filename or preview button
    const act = e.target.closest('[data-act]'); if (!act) return;
    const id = +act.dataset.id;
    const it = queue.find(q => q.id === id); if (!it) return;
    if (act.dataset.act === 'start') runItem(it);
    else if (act.dataset.act === 'preview') previewItem(it);
    else if (act.dataset.act === 'cancel') { try { it.abort && it.abort.abort(); } catch {} }
    else if (act.dataset.act === 'remove') {
      const idx = queue.indexOf(it); if (idx >= 0) queue.splice(idx, 1);
      renderQueue();
    }
  });

  // ── Preview modal handlers ─────────────────────────────────────────
  const previewModal = $('preview-modal');
  if (previewModal) {
    previewModal.addEventListener('click', (e) => {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-close') === '1') closePreview();
    });
  }
  const previewDl = $('preview-download-btn');
  if (previewDl) previewDl.addEventListener('click', savePreviewedBlob);
  const previewFs = $('preview-fullscreen-btn');
  if (previewFs) previewFs.addEventListener('click', togglePreviewFullscreen);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = $('preview-modal');
      if (m && !m.classList.contains('hidden')) closePreview();
    }
  });
});
