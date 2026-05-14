'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  function log(msg) {
    const box = $('status-log');
    if (!box) return;
    const lines = box.textContent.split('\n').filter(Boolean);
    lines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    while (lines.length > 5) lines.shift();
    box.textContent = lines.join('\n');
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(2)} ${u[i]}`;
  }

  function fmtSecs(s) {
    if (!Number.isFinite(s) || s < 0) return '–';
    if (s < 60) return `${Math.ceil(s)}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${Math.ceil(s%60)}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }

  function setProgress(received, total) {
    const bar = $('progress-fill');
    const txt = $('progress-text');
    const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
    if (bar) bar.style.width = pct.toFixed(2) + '%';
    if (txt) txt.textContent = total > 0
      ? `${fmtBytes(received)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`
      : `${fmtBytes(received)}`;
  }

  function showError(msg) {
    const e = $('error-box');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
  }
  function clearError() {
    const e = $('error-box'); if (e) { e.textContent = ''; e.style.display = 'none'; }
  }

  async function startDownload(megaLink) {
    clearError();
    const orchUrl = ($('orchestrator-url').value || '').replace(/\/$/, '');
    const token = $('personal-token').value;
    if (!orchUrl || !token) { showError('Set orchestrator URL and personal token.'); return; }
    if (!megaLink) { showError('Enter a MEGA link.'); return; }
    localStorage.setItem('orchestratorUrl', orchUrl);
    localStorage.setItem('personalToken', token);

    log('Requesting worker assignment…');
    let assignment;
    try {
      const resp = await fetch(orchUrl + '/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ megaLink }),
      });
      if (!resp.ok) { showError('Orchestrator: ' + resp.status); return; }
      assignment = await resp.json();
    } catch (e) { showError('Network error contacting orchestrator.'); return; }

    log('Worker assigned. Fetching metadata…');
    let meta;
    try {
      const m = await fetch(assignment.workerUrl.replace(/\/$/, '') + '/meta?link=' + encodeURIComponent(megaLink), {
        headers: { Authorization: 'Bearer ' + assignment.sessionToken },
      });
      if (!m.ok) { showError('Worker meta error: ' + m.status); return; }
      meta = await m.json();
    } catch (e) { showError('Network error fetching metadata.'); return; }

    log(`File: ${meta.filename} (${fmtBytes(meta.fileSize)})`);
    await streamWorker({
      workerUrl: assignment.workerUrl,
      sessionToken: assignment.sessionToken,
      megaLink,
      meta,
      offset: 0,
      received: 0,
      chunks: [],
      orchUrl,
      personalToken: token,
      startedAt: Date.now(),
      lastTick: { time: Date.now(), bytes: 0 },
    });
  }

  async function streamWorker(ctx) {
    const useEncryption = $('encrypt-toggle') && $('encrypt-toggle').checked;
    let key, iv;
    if (useEncryption && window.MegaCrypto) {
      key = await window.MegaCrypto.generateKey();
      iv = window.MegaCrypto.generateIV();
    }
    const url = ctx.workerUrl.replace(/\/$/, '') + '/stream?link=' + encodeURIComponent(ctx.megaLink);
    const headers = { Authorization: 'Bearer ' + ctx.sessionToken };
    if (ctx.offset > 0) headers['Range'] = `bytes=${ctx.offset}-`;
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (e) { showError('Network error opening stream.'); return; }

    if (resp.status === 307 || resp.status === 308) {
      const newWorker = resp.headers.get('X-New-Worker-Url');
      const newToken = resp.headers.get('X-New-Worker-Token');
      if (newWorker && newToken) {
        log('Handoff to new worker…');
        return streamWorker({ ...ctx, workerUrl: newWorker, sessionToken: newToken, offset: ctx.received });
      }
    }
    if (!resp.ok && resp.status !== 206) {
      showError('Worker stream error: ' + resp.status);
      return;
    }

    const reader = resp.body.getReader();
    const total = ctx.meta.fileSize;
    while (true) {
      let r;
      try { r = await reader.read(); } catch (e) {
        log('Stream interrupted, attempting handoff…');
        try {
          const a = await fetch(ctx.orchUrl + '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.personalToken },
            body: JSON.stringify({ megaLink: ctx.megaLink }),
          });
          if (a.ok) {
            const ass = await a.json();
            return streamWorker({ ...ctx, workerUrl: ass.workerUrl, sessionToken: ass.sessionToken, offset: ctx.received });
          }
        } catch {}
        showError('Download failed mid-stream.');
        return;
      }
      if (r.done) break;
      const buf = r.value.buffer.slice(r.value.byteOffset, r.value.byteOffset + r.value.byteLength);
      let store = buf;
      if (useEncryption && key) {
        const ivChunk = window.MegaCrypto.generateIV();
        const enc = await window.MegaCrypto.encryptChunk(key, ivChunk, buf);
        const dec = await window.MegaCrypto.decryptChunk(key, ivChunk, enc);
        store = dec;
      }
      ctx.chunks.push(new Uint8Array(store));
      ctx.received += r.value.byteLength;
      setProgress(ctx.received, total);
      const now = Date.now();
      const dt = (now - ctx.lastTick.time) / 1000;
      if (dt >= 1) {
        const speed = (ctx.received - ctx.lastTick.bytes) / dt;
        $('speed').textContent = fmtBytes(speed) + '/s';
        const remaining = total > 0 ? (total - ctx.received) / Math.max(1, speed) : NaN;
        $('eta').textContent = fmtSecs(remaining);
        ctx.lastTick = { time: now, bytes: ctx.received };
      }
    }

    log('Assembling file…');
    const blob = new Blob(ctx.chunks, { type: ctx.meta.mimeType || 'application/octet-stream' });
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = ctx.meta.filename || 'download.bin';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 1000);
    log('Done.');
  }

  window.addEventListener('DOMContentLoaded', () => {
    const u = localStorage.getItem('orchestratorUrl');
    const t = localStorage.getItem('personalToken');
    if (u) $('orchestrator-url').value = u;
    if (t) $('personal-token').value = t;
    $('download-btn').addEventListener('click', () => startDownload($('mega-link').value.trim()));
    $('mega-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('download-btn').click(); });
  });
})();
