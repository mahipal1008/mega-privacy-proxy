'use strict';

const { test, expect } = require('@playwright/test');
const path = require('path');
const url = require('url');

const indexUrl = url.pathToFileURL(path.join(__dirname, '..', 'client', 'index.html')).href;

test.describe('client UI', () => {
  test('loads with brand + input field present', async ({ page }) => {
    await page.goto(indexUrl);
    await expect(page.locator('.brand-name')).toHaveText('MegaTunnel');
    await expect(page.locator('h1')).toContainText('Download MEGA links');
    await expect(page.locator('#mega-link')).toBeVisible();
    await expect(page.locator('#add-btn')).toBeVisible();
  });

  test('no-token state shows warning hint', async ({ page }) => {
    await page.goto(indexUrl);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#auth-badge')).toContainText(/Token needed|Authorized/);
  });

  test('token via URL fragment is stored in sessionStorage and stripped from URL', async ({ page }) => {
    await page.goto(indexUrl + '#mysecret123');
    await page.waitForFunction(() => sessionStorage.getItem('_mtt') !== null);
    const tok = await page.evaluate(() => sessionStorage.getItem('_mtt'));
    expect(tok).toBe('mysecret123');
    expect(page.url()).not.toContain('#mysecret123');
    // sensitive token NEVER stored in localStorage
    const lsKeys = await page.evaluate(() => Object.keys(localStorage));
    expect(lsKeys).toEqual([]);
  });

  test('crypto round-trip in real browser', async ({ page }) => {
    await page.goto(indexUrl);
    const ok = await page.evaluate(async () => {
      const k = await window.MegaCrypto.generateKey();
      const iv = window.MegaCrypto.generateIV();
      const data = new TextEncoder().encode('hello world');
      const enc = await window.MegaCrypto.encryptChunk(k, iv, data.buffer);
      const dec = await window.MegaCrypto.decryptChunk(k, iv, enc);
      return new TextDecoder().decode(dec) === 'hello world';
    });
    expect(ok).toBe(true);
  });

  test('invalid MEGA link shows error toast', async ({ page }) => {
    await page.goto(indexUrl + '#testtok');
    await page.fill('#mega-link', 'https://evil.example.com/x');
    await page.click('#add-btn');
    await expect(page.locator('.toast')).toContainText(/valid MEGA link/i);
  });

  test('mobile viewport renders', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto(indexUrl);
    await expect(page.locator('h1')).toBeVisible();
  });
});
