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

// Stream one byte range, AES-encrypt each chunk in RAM, return [pkg...]
async function streamSegment({ assignment, megaLink, childId, rangeStart, rangeEnd, key, onBytes, abortSignal }) {
  const u = assignment.workerUrl.replace(/\/$/, '') + '/stream?link=' + encodeURIComponent(megaLink) +
    (childId ? '&child=' + encodeURIComponent(childId) : '');
  const headers = { Authorization: 'Bearer ' + assignment.sessionToken };
  if (rangeStart > 0 || rangeEnd !== undefined) {
    headers['Range'] = `bytes=${rangeStart}-${rangeEnd !== undefined ? rangeEnd : ''}`;
  }
  const r = await fetch(u, { headers, signal: abortSignal });
  if (!r.ok && r.status !== 206) throw new Error('Worker stream ' + r.status);

  const reader = r.body.getReader();
  const packages = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const iv = window.MegaCrypto.generateIV();
    const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    const cipher = await window.MegaCrypto.encryptChunk(key, iv, buf);
    const pkg = new Uint8Array(12 + cipher.byteLength);
    pkg.set(iv, 0); pkg.set(new Uint8Array(cipher), 12);
    packages.push(pkg);
    onBytes(value.byteLength);
  }
  return packages;
}

async function decryptAll(key, packages) {
  const out = [];
  for (const pkg of packages) {
    const iv = pkg.slice(0, 12);
    const data = await window.MegaCrypto.decryptChunk(key, iv, pkg.slice(12).buffer);
    out.push(new Uint8Array(data));
  }
  return out;
}

// ── Queue ─────────────────────────────────────────────────────────────
const queue = []; // { id, megaLink, childId, name, size, status, received, speed, startedAt, lastTick, abort, error }
let queueIdCounter = 0;

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
  // Build list
  list.innerHTML = '';
  for (const it of queue) {
    const li = document.createElement('li');
    li.className = 'q-item' + (it.status === 'active' ? ' active' : it.status === 'done' ? ' done' : it.status === 'error' ? ' error' : '');
    const pct = it.size > 0 ? (it.received / it.size) * 100 : 0;
    li.innerHTML = `
      <div class="q-row">
        <span class="q-icon">${fmtFileIcon(it.name)}</span>
        <div class="q-info">
          <div class="q-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
          <div class="q-meta">${fmtBytes(it.received)} / ${fmtBytes(it.size)} · ${it.speed > 0 ? fmtBytes(it.speed) + '/s' : ''}</div>
        </div>
        <span class="q-status ${it.status === 'done' ? 's-done' : it.status === 'error' ? 's-err' : ''}">${statusLabel(it)}</span>
        <div class="q-actions">
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

    const allPkgs = [];
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
          const pkgs = await streamSegment({
            assignment: seg.assignment, megaLink: item.megaLink, childId: item.childId,
            rangeStart: seg.start, rangeEnd: seg.end, key: sessionKey,
            abortSignal: aborter.signal,
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
          allPkgs.push(...pkgs);
          break;
        } catch (e) {
          if (aborter.signal.aborted) throw new Error('cancelled');
          if (--retries < 0) throw e;
          try { seg.assignment = await apiDownload(item.megaLink); } catch (e2) { throw new Error('retry assign: ' + e2.message); }
        }
      }
    }

    // Decrypt + save
    const plainChunks = await decryptAll(sessionKey, allPkgs);
    const blob = new Blob(plainChunks, { type: meta.mimeType || 'application/octet-stream' });
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    // Filename: keep only the basename when path contains slashes (folder)
    a.download = (item.name || 'download.bin').split('/').pop();
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 1500);

    item.status = 'done'; item.speed = 0; item.received = item.size;
    renderQueue();
    toast('Saved: ' + a.download, 'ok');
  } catch (e) {
    item.status = (e && e.message === 'cancelled') ? 'queued' : 'error';
    item.error = e && e.message ? e.message.slice(0, 40) : 'error';
    item.speed = 0;
    renderQueue();
    if (item.status === 'error') toast(item.name + ': ' + item.error, 'err');
  } finally {
    item.abort = null;
  }
}

async function startAll() {
  // Run one at a time to keep memory bounded; large files still get parallel chunk fetching inside worker
  for (const it of queue) {
    if (it.status === 'queued') {
      await runItem(it);
    }
  }
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
  $('queue-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = +btn.dataset.id;
    const it = queue.find(q => q.id === id); if (!it) return;
    if (btn.dataset.act === 'start') runItem(it);
    else if (btn.dataset.act === 'cancel') { try { it.abort && it.abort.abort(); } catch {} }
    else if (btn.dataset.act === 'remove') {
      const idx = queue.indexOf(it); if (idx >= 0) queue.splice(idx, 1);
      renderQueue();
    }
  });
});
