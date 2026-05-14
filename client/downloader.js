'use strict';

(function () {
  // 3.5 GB per worker segment — keeps each worker under the 3.8 GB warn threshold
  const SEGMENT_BYTES = 3_500_000_000;

  const $ = (id) => document.getElementById(id);

  // ── Token: read once from URL fragment, keep in sessionStorage, strip from URL ──
  function getToken() {
    const hash = window.location.hash.slice(1).trim();
    if (hash) {
      sessionStorage.setItem('_mpp', hash);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem('_mpp') || '';
  }

  function log(msg) {
    const box = $('status-log');
    if (!box) return;
    const lines = box.textContent.split('\n').filter(Boolean);
    lines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    while (lines.length > 8) lines.shift();
    box.textContent = lines.join('\n');
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(2)} ${u[i]}`;
  }

  function fmtSecs(s) {
    if (!Number.isFinite(s) || s < 0) return '–';
    if (s < 60) return `${Math.ceil(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  function setProgress(received, total) {
    const bar = $('progress-fill');
    const txt = $('progress-text');
    const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
    if (bar) bar.style.width = pct.toFixed(2) + '%';
    if (txt) txt.textContent = total > 0
      ? `${fmtBytes(received)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`
      : fmtBytes(received);
  }

  function showError(msg) {
    const e = $('error-box');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
  }
  function clearError() {
    const e = $('error-box');
    if (e) { e.textContent = ''; e.style.display = 'none'; }
  }

  function setDownloading(active) {
    const btn = $('download-btn');
    if (btn) { btn.disabled = active; btn.textContent = active ? 'Downloading…' : 'Download'; }
  }

  // ── Request a worker from orchestrator ──
  async function getWorker(orchUrl, token, megaLink) {
    const resp = await fetch(orchUrl + '/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ megaLink }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(`Orchestrator ${resp.status}: ${body.error || 'unknown'}`);
    }
    return resp.json();
  }

  // ── Stream one byte range from a worker, AES-GCM encrypting each chunk in RAM ──
  // Returns array of Uint8Array packages: [12-byte IV][ciphertext]
  async function streamSegment({ workerUrl, sessionToken, megaLink, rangeStart, rangeEnd, key, onBytes }) {
    const url = workerUrl.replace(/\/$/, '') + '/stream?link=' + encodeURIComponent(megaLink);
    const headers = { Authorization: 'Bearer ' + sessionToken };
    if (rangeStart > 0 || rangeEnd !== undefined) {
      headers['Range'] = `bytes=${rangeStart}-${rangeEnd !== undefined ? rangeEnd : ''}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok && resp.status !== 206) throw new Error('Worker stream ' + resp.status);

    const reader = resp.body.getReader();
    const encryptedChunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Encrypt chunk in RAM with a per-chunk IV
      const iv = window.MegaCrypto.generateIV();
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      const cipher = await window.MegaCrypto.encryptChunk(key, iv, buf);

      // Pack: [IV 12B][ciphertext]
      const pkg = new Uint8Array(12 + cipher.byteLength);
      pkg.set(iv, 0);
      pkg.set(new Uint8Array(cipher), 12);
      encryptedChunks.push(pkg);

      onBytes(value.byteLength);
    }

    return encryptedChunks;
  }

  // ── Decrypt all packed chunks back to plaintext ──
  async function decryptAll(key, encryptedChunks) {
    const plain = [];
    for (const pkg of encryptedChunks) {
      const iv = pkg.slice(0, 12);
      const cipher = pkg.slice(12).buffer;
      const data = await window.MegaCrypto.decryptChunk(key, iv, cipher);
      plain.push(new Uint8Array(data));
    }
    return plain;
  }

  async function startDownload(megaLink) {
    clearError();
    const token = getToken();
    const orchUrl = ($('orchestrator-url').value || '').replace(/\/$/, '');

    if (!token) {
      showError('No access token. Add #yourtoken to this page URL and reload, then bookmark it.');
      return;
    }
    if (!orchUrl) { showError('Enter orchestrator URL.'); return; }
    if (!megaLink) { showError('Enter a MEGA link.'); return; }

    localStorage.setItem('orchestratorUrl', orchUrl);
    setDownloading(true);
    $('speed').textContent = '–';
    $('eta').textContent = '–';
    setProgress(0, 0);

    // One AES-256-GCM session key for the entire download
    const sessionKey = await window.MegaCrypto.generateKey();

    try {
      // ── Step 1: First worker assignment ──
      log('Requesting worker…');
      let firstAssignment;
      try {
        firstAssignment = await getWorker(orchUrl, token, megaLink);
      } catch (e) { showError(e.message); return; }

      const workerName = firstAssignment.workerUrl.replace(/^https?:\/\//, '').split('.')[0];
      log(`Worker: ${workerName}`);

      // ── Step 2: File metadata ──
      let meta;
      try {
        const m = await fetch(
          firstAssignment.workerUrl.replace(/\/$/, '') + '/meta?link=' + encodeURIComponent(megaLink),
          { headers: { Authorization: 'Bearer ' + firstAssignment.sessionToken } }
        );
        if (!m.ok) throw new Error('meta ' + m.status);
        meta = await m.json();
      } catch (e) { showError('Metadata error: ' + e.message); return; }

      log(`File: ${meta.filename}  (${fmtBytes(meta.fileSize)})`);

      // ── Step 3: Plan segments ──
      const totalSize = meta.fileSize;
      const segments = [];
      if (!totalSize || totalSize <= SEGMENT_BYTES) {
        segments.push({ start: 0, end: totalSize ? totalSize - 1 : undefined, assignment: firstAssignment });
      } else {
        let offset = 0;
        let isFirst = true;
        while (offset < totalSize) {
          const end = Math.min(offset + SEGMENT_BYTES - 1, totalSize - 1);
          segments.push({ start: offset, end, assignment: isFirst ? firstAssignment : null });
          offset = end + 1;
          isFirst = false;
        }
        log(`Split into ${segments.length} segments across ${segments.length} workers`);
      }

      // ── Step 4: Download each segment ──
      let totalReceived = 0;
      let lastTick = { time: Date.now(), bytes: 0 };
      const allEncrypted = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];

        // Fetch this segment's worker if not pre-assigned
        if (!seg.assignment) {
          log(`Segment ${i + 1}/${segments.length}: getting worker…`);
          try {
            seg.assignment = await getWorker(orchUrl, token, megaLink);
          } catch (e) { showError(`Segment ${i + 1} worker error: ${e.message}`); return; }
        }

        // Pre-fetch next segment's worker in the background
        if (i + 1 < segments.length && !segments[i + 1].assignment) {
          getWorker(orchUrl, token, megaLink)
            .then(a => { segments[i + 1].assignment = a; })
            .catch(() => {});
        }

        const segName = segments[i].assignment.workerUrl.replace(/^https?:\/\//, '').split('.')[0];
        if (segments.length > 1) log(`Segment ${i + 1}/${segments.length} via ${segName}`);

        // Retry up to 2 times on failure
        let retries = 2;
        while (true) {
          try {
            const chunks = await streamSegment({
              workerUrl: seg.assignment.workerUrl,
              sessionToken: seg.assignment.sessionToken,
              megaLink,
              rangeStart: seg.start,
              rangeEnd: seg.end,
              key: sessionKey,
              onBytes: (bytes) => {
                totalReceived += bytes;
                setProgress(totalReceived, totalSize);
                const now = Date.now();
                const dt = (now - lastTick.time) / 1000;
                if (dt >= 1) {
                  const speed = (totalReceived - lastTick.bytes) / dt;
                  $('speed').textContent = fmtBytes(speed) + '/s';
                  const eta = (totalSize - totalReceived) / Math.max(1, speed);
                  $('eta').textContent = fmtSecs(eta);
                  lastTick = { time: now, bytes: totalReceived };
                }
              },
            });
            allEncrypted.push(...chunks);
            break; // segment done
          } catch (e) {
            if (--retries < 0) { showError(`Segment ${i + 1} failed: ${e.message}`); return; }
            log(`Segment ${i + 1} error — retrying with new worker…`);
            try {
              seg.assignment = await getWorker(orchUrl, token, megaLink);
            } catch (e2) { showError('Retry worker: ' + e2.message); return; }
          }
        }
      }

      // ── Step 5: Decrypt → assemble → save ──
      log('Decrypting and saving…');
      const plainChunks = await decryptAll(sessionKey, allEncrypted);
      const blob = new Blob(plainChunks, { type: meta.mimeType || 'application/octet-stream' });
      const a = document.createElement('a');
      const objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = meta.filename || 'download.bin';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 2000);
      log('✓ Done.');

    } finally {
      setDownloading(false);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('orchestratorUrl');
    if (saved) $('orchestrator-url').value = saved;

    // Read token from URL hash on load; update status hint
    const tok = getToken();
    const status = $('token-status');
    if (status) {
      status.textContent = tok
        ? '🔒 Token loaded · AES-GCM always on · Multi-worker auto-segments large files'
        : '⚠️ Add #yourtoken to this page URL and reload, then bookmark';
      status.style.color = tok ? '#4caf50' : '#ff9800';
    }

    $('download-btn').addEventListener('click', () => startDownload($('mega-link').value.trim()));
    $('mega-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('download-btn').click(); });
  });
})();

