import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from '@playwright/test';

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('mars-playwright-smoke');
});
let browser;
let page;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Smoke server did not bind to an address');
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  const response = await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
  assert.equal(response?.status(), 200);
  assert.equal(await page.locator('body').innerText(), 'mars-playwright-smoke');
} finally {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
