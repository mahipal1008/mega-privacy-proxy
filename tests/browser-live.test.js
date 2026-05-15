'use strict';
// Comprehensive browser test for live deployed MEGA Privacy Proxy
// Tests: page load, auth, file link, folder link, edge cases, UI, errors

const { chromium } = require('playwright');
const TOKEN = process.env.TEST_TOKEN;
const CLIENT_URL = 'https://mega-privacy-client.onrender.com';
const ORCH_URL = 'https://mega-orchestrator.onrender.com';

// Known working links
const FILE_LINK = 'https://mega.nz/file/mKoSQDTD#H9zhTK-HGyCfolQuhSGCJ-jOSXfA_IlOsWVU5xPTAgU';
const FOLDER_LINK = 'https://mega.nz/folder/w01wVR5D#sfZ0pBZARm9RP1EIwj6aew';

const results = [];
function log(test, pass, detail) {
  const icon = pass ? '✅' : '❌';
  results.push({ test, pass, detail });
  console.log(`${icon} ${test}: ${detail}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({ 
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36'
  });
  
  // Collect console errors
  const consoleErrors = [];
  const networkErrors = [];

  try {
    // ═══════════════════════════════════════════════
    // TEST 1: Page loads correctly with token in hash
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 1: Page Load & Auth ══════');
    const page = await context.newPage();
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(err.message));
    page.on('requestfailed', req => networkErrors.push(`${req.url()} - ${req.failure()?.errorText}`));

    const resp = await page.goto(`${CLIENT_URL}/#${TOKEN}`, { waitUntil: 'networkidle', timeout: 30000 });
    log('Page load', resp.status() === 200, `HTTP ${resp.status()}`);

    // Check title
    const title = await page.title();
    log('Page title', title.includes('StreamVault') || title.includes('MEGA') || title.includes('Download'), `"${title}"`);

    // Check auth badge shows authorized
    await sleep(2000);
    const authBadge = await page.$eval('#auth-badge', el => el.textContent).catch(() => 'NOT_FOUND');
    log('Auth badge', authBadge.includes('Authorized') || authBadge.includes('🔒'), `"${authBadge}"`);

    // Check token was stripped from URL (security)
    const currentUrl = page.url();
    log('Token stripped from URL', !currentUrl.includes(TOKEN), `URL: ${currentUrl.substring(0, 80)}`);

    // Check pool status badge loads
    await sleep(3000);
    const netBadge = await page.$eval('#net-badge', el => el.textContent).catch(() => 'NOT_FOUND');
    log('Pool badge', netBadge.includes('active') || netBadge.includes('⚡'), `"${netBadge}"`);

    // ═══════════════════════════════════════════════
    // TEST 2: CSS & UI elements present
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 2: UI Elements ══════');
    const inputExists = await page.$('#mega-link') !== null;
    log('Link input exists', inputExists, inputExists ? 'found' : 'missing');

    const addBtn = await page.$('#add-btn') !== null;
    log('Add button exists', addBtn, addBtn ? 'found' : 'missing');

    const startAllBtn = await page.$('#start-all-btn') !== null;
    log('Start All button exists', startAllBtn, startAllBtn ? 'found' : 'missing');

    const clearDoneBtn = await page.$('#clear-done-btn') !== null;
    log('Clear Done button exists', clearDoneBtn, clearDoneBtn ? 'found' : 'missing');

    // Check dark theme applied
    const bgColor = await page.$eval('body', el => getComputedStyle(el).backgroundColor);
    const isDark = bgColor.includes('rgb(1') || bgColor.includes('rgb(2') || bgColor.includes('#1') || bgColor.includes('#0');
    log('Dark theme', isDark, `bg: ${bgColor}`);

    // ═══════════════════════════════════════════════
    // TEST 3: Edge case — empty link
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 3: Edge Cases ══════');
    await page.fill('#mega-link', '');
    await page.click('#add-btn');
    await sleep(1500);
    const toastEmpty = await page.$$eval('.toast', els => els.map(e => e.textContent));
    const hasErrToast = toastEmpty.some(t => t.toLowerCase().includes('not a valid') || t.toLowerCase().includes('error') || t.toLowerCase().includes('invalid'));
    log('Empty link → error toast', hasErrToast, `Toasts: ${JSON.stringify(toastEmpty.slice(-2))}`);

    // TEST 3b: Invalid link
    await page.fill('#mega-link', 'https://google.com/notmega');
    await page.click('#add-btn');
    await sleep(1500);
    const toastInvalid = await page.$$eval('.toast', els => els.map(e => e.textContent));
    const hasInvalidToast = toastInvalid.some(t => t.toLowerCase().includes('not a valid'));
    log('Invalid link → error toast', hasInvalidToast, `Last toast: ${JSON.stringify(toastInvalid.slice(-1))}`);

    // TEST 3c: Malformed mega link
    await page.fill('#mega-link', 'https://mega.nz/file/short');
    await page.click('#add-btn');
    await sleep(1500);
    const toastMalformed = await page.$$eval('.toast', els => els.map(e => e.textContent));
    log('Malformed MEGA link → error', toastMalformed.length > 0, `Toasts present: ${toastMalformed.length}`);

    // ═══════════════════════════════════════════════
    // TEST 4: Add valid FILE link
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 4: File Link Resolution ══════');
    // Clear any old toasts
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); });
    
    await page.fill('#mega-link', FILE_LINK);
    await page.click('#add-btn');
    
    // Wait for resolution (may take a few seconds over network)
    let fileResolved = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const queueItems = await page.$$('.q-item');
      if (queueItems.length > 0) { fileResolved = true; break; }
      // Check for error toast
      const errToasts = await page.$$eval('.toast.err', els => els.map(e => e.textContent));
      if (errToasts.length > 0) {
        log('File link resolution', false, `Error: ${errToasts[0]}`);
        break;
      }
    }
    
    if (fileResolved) {
      const queueHtml = await page.$eval('.q-item', el => el.textContent);
      const hasFilename = queueHtml.includes('dl-windows') || queueHtml.includes('.zip');
      log('File added to queue', true, `Queue item: ${queueHtml.substring(0, 80)}`);
      log('Correct filename shown', hasFilename, queueHtml.substring(0, 60));
      
      // Check file size shown
      const hasSizeInfo = queueHtml.includes('GB') || queueHtml.includes('MB') || queueHtml.includes('2.');
      log('File size displayed', hasSizeInfo, queueHtml.substring(0, 80));

      // Check input was cleared
      const inputVal = await page.$eval('#mega-link', el => el.value);
      log('Input cleared after add', inputVal === '', `Input value: "${inputVal}"`);
    } else {
      log('File link resolution', false, 'Timed out after 30s');
    }

    // ═══════════════════════════════════════════════
    // TEST 5: Add FOLDER link
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 5: Folder Link Resolution ══════');
    const queueBefore = await page.$$('.q-item');
    const countBefore = queueBefore.length;

    await page.fill('#mega-link', FOLDER_LINK);
    await page.click('#add-btn');
    
    let folderResolved = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const queueItems = await page.$$('.q-item');
      if (queueItems.length > countBefore) { folderResolved = true; break; }
      const errToasts = await page.$$eval('.toast.err', els => els.map(e => e.textContent));
      if (errToasts.length > 0) {
        log('Folder link resolution', false, `Error: ${errToasts[errToasts.length - 1]}`);
        break;
      }
    }

    if (folderResolved) {
      const queueItems = await page.$$('.q-item');
      const folderCount = queueItems.length - countBefore;
      log('Folder expanded to files', folderCount > 1, `${folderCount} files added from folder`);
      
      // Check various file types in folder
      const allNames = await page.$$eval('.q-name', els => els.map(e => e.textContent));
      const hasJava = allNames.some(n => n.includes('.java'));
      const hasPdf = allNames.some(n => n.includes('.pdf'));
      const hasTxt = allNames.some(n => n.includes('.txt'));
      log('Folder has .java files', hasJava, allNames.filter(n => n.includes('.java')).slice(0, 3).join(', '));
      log('Folder has .pdf files', hasPdf, allNames.filter(n => n.includes('.pdf')).slice(0, 3).join(', '));
      
      // Check toast shows folder summary
      const toasts = await page.$$eval('.toast', els => els.map(e => e.textContent));
      const hasFolderToast = toasts.some(t => t.includes('Folder added') || t.includes('files'));
      log('Folder toast notification', hasFolderToast, `Toast: ${toasts.slice(-2).join(' | ')}`);
    } else {
      log('Folder link resolution', false, 'Timed out after 30s');
    }

    // ═══════════════════════════════════════════════
    // TEST 6: Queue UI features
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 6: Queue UI ══════');
    const queueSection = await page.$('#queue-section');
    const isVisible = queueSection && !(await queueSection.evaluate(el => el.classList.contains('hidden')));
    log('Queue section visible', isVisible, isVisible ? 'shown' : 'hidden');
    
    // Check queue count badge
    const queueCount = await page.$eval('#queue-count', el => el.textContent).catch(() => '');
    log('Queue count shown', queueCount.includes('item'), `"${queueCount}"`);

    // Check totals bar
    const totalSize = await page.$eval('#total-size', el => el.textContent).catch(() => '');
    log('Total size shown', totalSize.length > 0 && totalSize !== '0 B', `"${totalSize}"`);

    // Check Start buttons exist on queued items
    const startBtns = await page.$$('button[data-act="start"]');
    log('Individual Start buttons', startBtns.length > 0, `${startBtns.length} Start buttons`);

    // Check Remove buttons
    const removeBtns = await page.$$('button[data-act="remove"]');
    log('Remove buttons present', removeBtns.length > 0, `${removeBtns.length} Remove buttons`);

    // ═══════════════════════════════════════════════
    // TEST 7: Download a small file (from folder - a tiny .java file ~500 bytes)
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 7: Download Small File ══════');
    // Find a small file in the queue (a .java file ~500 bytes)
    const allItems = await page.$$eval('.q-item', items => {
      return items.map((el, i) => ({
        index: i,
        name: el.querySelector('.q-name')?.textContent || '',
        meta: el.querySelector('.q-meta')?.textContent || ''
      }));
    });
    
    // Find a small file (under 2KB)
    const smallFile = allItems.find(it => it.meta.includes('B') && !it.meta.includes('KB') && !it.meta.includes('MB') && !it.meta.includes('GB') && it.index > 0);
    const targetFile = smallFile || allItems.find(it => it.meta.includes('KB') && it.index > 0);
    
    if (targetFile) {
      log('Found small test file', true, `"${targetFile.name}" ${targetFile.meta}`);
      
      // Click its Start button
      const targetStartBtn = await page.$$('button[data-act="start"]');
      // Find the start button for our target item
      if (targetStartBtn.length > 1) {
        // In headless, showSaveFilePicker is NOT available, so it'll use Blob fallback
        // which should work for small files. Let's click start and watch for download or error.
        
        // Set up download listener
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
        
        // Click start on second item (first folder file, small)
        await targetStartBtn[1].click(); // index 1 = first folder file
        
        await sleep(2000);
        
        // Check if item status changed to active
        const statusAfterClick = await page.$$eval('.q-item', items => {
          return items.map(el => ({
            name: el.querySelector('.q-name')?.textContent || '',
            status: el.querySelector('.q-status')?.textContent || '',
            cls: el.className
          }));
        });
        
        const activeItem = statusAfterClick.find(s => s.cls.includes('active'));
        if (activeItem) {
          log('Item became active', true, `"${activeItem.name}" status: ${activeItem.status}`);
        }
        
        // Wait for download or completion
        let downloadOk = false;
        for (let i = 0; i < 45; i++) {
          await sleep(1000);
          const statuses = await page.$$eval('.q-item', items => {
            return items.map(el => ({
              name: el.querySelector('.q-name')?.textContent || '',
              status: el.querySelector('.q-status')?.textContent || '',
              cls: el.className
            }));
          });
          const doneItem = statuses.find(s => s.cls.includes('done') && !s.name.includes('dl-windows'));
          const errItem = statuses.find(s => s.cls.includes('error') && !s.name.includes('dl-windows'));
          if (doneItem) {
            log('Small file downloaded', true, `"${doneItem.name}" → ${doneItem.status}`);
            downloadOk = true;
            break;
          }
          if (errItem) {
            log('Small file download', false, `Error: "${errItem.name}" → ${errItem.status}`);
            downloadOk = true; // test complete even if failed
            break;
          }
        }
        if (!downloadOk) {
          // Check current state
          const current = await page.$$eval('.q-item', items => items.map(el => ({
            name: el.querySelector('.q-name')?.textContent || '',
            status: el.querySelector('.q-status')?.textContent || '',
            meta: el.querySelector('.q-meta')?.textContent || ''
          })));
          const item = current.find(c => !c.name.includes('dl-windows'));
          log('Small file download', false, `Timeout. Current: ${JSON.stringify(item || 'none')}`);
        }
      }
    } else {
      log('Find small test file', false, 'No small file in queue');
    }

    // ═══════════════════════════════════════════════
    // TEST 8: Remove item from queue
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 8: Queue Management ══════');
    const countBeforeRemove = (await page.$$('.q-item')).length;
    const removeBtn = await page.$('button[data-act="remove"]');
    if (removeBtn) {
      await removeBtn.click();
      await sleep(500);
      const countAfterRemove = (await page.$$('.q-item')).length;
      log('Remove item works', countAfterRemove === countBeforeRemove - 1, `${countBeforeRemove} → ${countAfterRemove}`);
    } else {
      log('Remove item', false, 'No remove button found');
    }

    // ═══════════════════════════════════════════════
    // TEST 9: No console errors
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 9: Console & Network ══════');
    const criticalErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('manifest'));
    log('No critical console errors', criticalErrors.length === 0, 
      criticalErrors.length === 0 ? 'Clean console' : `Errors: ${criticalErrors.slice(0, 3).join(' | ')}`);
    log('No network failures', networkErrors.length === 0,
      networkErrors.length === 0 ? 'All requests OK' : `Failures: ${networkErrors.slice(0, 3).join(' | ')}`);

    // ═══════════════════════════════════════════════
    // TEST 10: Security headers (fetch from page context)
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 10: Security ══════');
    const secHeaders = await page.evaluate(async (url) => {
      const r = await fetch(url + '/health');
      return {
        csp: r.headers.get('content-security-policy'),
        xframe: r.headers.get('x-frame-options'),
        xct: r.headers.get('x-content-type-options'),
        hsts: r.headers.get('strict-transport-security'),
        referrer: r.headers.get('referrer-policy'),
      };
    }, ORCH_URL).catch(() => ({}));
    
    log('CSP header set', !!secHeaders.csp, secHeaders.csp ? secHeaders.csp.substring(0, 50) + '…' : 'missing');
    log('X-Frame-Options', secHeaders.xframe === 'DENY', secHeaders.xframe || 'missing');
    log('X-Content-Type-Options', secHeaders.xct === 'nosniff', secHeaders.xct || 'missing');
    log('HSTS enabled', !!secHeaders.hsts, secHeaders.hsts || 'missing');
    log('Referrer-Policy', secHeaders.referrer === 'no-referrer', secHeaders.referrer || 'missing');

    // ═══════════════════════════════════════════════
    // TEST 11: Auth protection (try API without token from browser)
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 11: Auth Protection ══════');
    const authTests = await page.evaluate(async (url) => {
      const results = {};
      // No auth
      try {
        const r1 = await fetch(url + '/api/status');
        results.noAuth = r1.status;
      } catch (e) { results.noAuth = 'error: ' + e.message; }
      // Wrong token
      try {
        const r2 = await fetch(url + '/api/status', { headers: { Authorization: 'Bearer wrong' } });
        results.wrongToken = r2.status;
      } catch (e) { results.wrongToken = 'error: ' + e.message; }
      // Health (no auth needed)
      try {
        const r3 = await fetch(url + '/health');
        results.health = r3.status;
      } catch (e) { results.health = 'error: ' + e.message; }
      return results;
    }, ORCH_URL);
    
    log('No auth → 403', authTests.noAuth === 403, `Status: ${authTests.noAuth}`);
    log('Wrong token → 403', authTests.wrongToken === 403, `Status: ${authTests.wrongToken}`);
    log('Health no auth → 200', authTests.health === 200, `Status: ${authTests.health}`);

    // ═══════════════════════════════════════════════
    // TEST 12: Page without token
    // ═══════════════════════════════════════════════
    console.log('\n══════ TEST 12: No Token Page ══════');
    const page2 = await context.newPage();
    await page2.goto(CLIENT_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await sleep(2000);
    const noTokenBadge = await page2.$eval('#auth-badge', el => el.textContent).catch(() => '');
    log('No-token page shows warning', noTokenBadge.includes('Token needed') || noTokenBadge.includes('⚠'), `"${noTokenBadge}"`);
    await page2.close();

  } catch (err) {
    console.error('FATAL TEST ERROR:', err.message);
    log('Test execution', false, err.message);
  } finally {
    await browser.close();
  }

  // ═══════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════
  console.log('\n══════════════════════════════════════');
  console.log('         TEST SUMMARY');
  console.log('══════════════════════════════════════');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`PASSED: ${passed} | FAILED: ${failed} | TOTAL: ${results.length}`);
  if (failed > 0) {
    console.log('\nFAILED TESTS:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.test}: ${r.detail}`));
  }
  console.log('══════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
})();
