const assert = require('node:assert/strict');
// Requires Playwright, Chrome, and the generated preview served on port 4387.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const width of [1920, 1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('http://127.0.0.1:4387');
      assert.equal(await page.locator('.delivery-overview-section').count(), 4);
      assert.equal(await page.locator('.delivery-overview-progress').count(), 3);
      await page.locator('.overview-channel summary').first().click();
      assert(await page.locator('.overview-channel[open] .overview-channel-detail').first().isVisible());
      await page.locator('#overview-revenue-channel').selectOption('AMAZON');
      assert((await page.locator('#overview-revenue-chart').innerText()).includes('6.000'));
      const overflow = await page.evaluate(() => ({
        body: document.documentElement.scrollWidth > innerWidth + 1,
        summary: [...document.querySelectorAll('.delivery-overview-grid .metric')].filter((item) => item.scrollWidth > item.clientWidth + 1).length,
      }));
      assert.equal(overflow.body, false, `Body overflow at ${width}px`);
      assert.equal(overflow.summary, 0, `Metric overflow at ${width}px`);
      await page.screenshot({ path: `.next/overview-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('Overview browser checks passed at desktop, laptop and mobile widths.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
