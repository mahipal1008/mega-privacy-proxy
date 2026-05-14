'use strict';

const { test, expect } = require('@playwright/test');
const path = require('path');
const url = require('url');

const indexUrl = url.pathToFileURL(path.join(__dirname, '..', 'client', 'index.html')).href;

test.describe('client UI', () => {
  test('loads with dark theme + fields present', async ({ page }) => {
    await page.goto(indexUrl);
    await expect(page.locator('h1')).toHaveText('MEGA Privacy Proxy');
    await expect(page.locator('#mega-link')).toBeVisible();
    await expect(page.locator('#orchestrator-url')).toBeVisible();
    await expect(page.locator('#personal-token')).toBeVisible();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toMatch(/rgb\(13, 17, 23\)/);
  });

  test('localStorage persists URL + token but nothing else', async ({ page }) => {
    await page.goto(indexUrl);
    await page.fill('#orchestrator-url', 'https://orch.example.com');
    await page.fill('#personal-token', 'secret-token');
    await page.fill('#mega-link', 'https://mega.nz/file/aaaaaa#bbbbbbbbbbbbbbbbbbbb');
    await page.click('#download-btn');
    await page.waitForTimeout(500);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.sort()).toEqual(['orchestratorUrl', 'personalToken']);
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

  test('Enter in link field triggers download attempt', async ({ page }) => {
    await page.goto(indexUrl);
    await page.fill('#orchestrator-url', 'https://orch.invalid');
    await page.fill('#personal-token', 'tok');
    await page.fill('#mega-link', 'https://mega.nz/file/aaaaaa#bbbbbbbbbbbbbbbbbbbb');
    await page.locator('#mega-link').press('Enter');
    await page.waitForTimeout(800);
    await expect(page.locator('#status-log')).not.toHaveText('');
  });

  test('mobile viewport renders', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto(indexUrl);
    await expect(page.locator('h1')).toBeVisible();
  });
});
