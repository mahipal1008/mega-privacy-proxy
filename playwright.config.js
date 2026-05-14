const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: 'browser.test.js',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: { trace: 'off' },
});
