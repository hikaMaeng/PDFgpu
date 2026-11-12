const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { decodePng } = require('./lib/png');

// External criterion: the fixture's own content stream
// (tests/fixtures/rgb-squares.pdf, 612x792pt):
//   1 0 0 rg  72 500 150 150 re f   -> red   square, x 72..222pt
//   0 1 0 rg 231 500 150 150 re f   -> green square, x 231..381pt
//   0 0 1 rg 390 500 150 150 re f   -> blue  square, x 390..540pt
// PDF y grows upward, so the squares span 142..292pt from the top.
// Whatever the viewer does internally, the screen must show red, green, blue
// from left to right at those positions.
//
// The existing quality gate (`countDarkPixelsFromPng(...) > 20`) cannot see
// colour order: the bundled sample is black text on white, which looks the
// same with red and blue swapped. A double R/B swap shipped through it.

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'rgb-squares.pdf');
const PAGE = { widthPts: 612, heightPts: 792 };
const SQUARES = [
  { name: 'red', xPts: 147, yPts: 217, want: [255, 0, 0] },
  { name: 'green', xPts: 306, yPts: 217, want: [0, 255, 0] },
  { name: 'blue', xPts: 465, yPts: 217, want: [0, 0, 255] }
];

function pixelAt(png, x, y) {
  const index = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.rgba[index], png.rgba[index + 1], png.rgba[index + 2]];
}

function matches(actual, want) {
  // Each channel within 60 of the expected 0 or 255: tolerant of scaling and
  // JPEG-free PNG rounding, strict enough that a swapped channel fails.
  return actual.every((value, channel) => Math.abs(value - want[channel]) <= 60);
}

test('renders colours in PDF order (no red/blue swap)', async ({ page }) => {
  const base = process.env.TEST_URL || 'http://localhost:51000';
  page.on('console', (msg) => console.log(`[PW CONSOLE] ${msg.type()} ${msg.text()}`));
  await page.goto(base);
  await expect(page.getByRole('toolbar', { name: 'viewer controls' })).toBeVisible();

  const status = page.getByRole('status', { name: 'viewer status' });
  await page.getByLabel('Upload PDF').setInputFiles(FIXTURE);
  await expect(status).toContainText(/Source:\s*rgb-squares\.pdf/);

  const shell = page.locator('[data-testid="pdfgpu-page-shell"][data-page-index="0"]');
  await expect(shell).toBeAttached();

  let observed = [];
  await expect.poll(async () => {
    const box = await shell.boundingBox();
    if (!box) return 'no shell box';
    const png = decodePng(await page.screenshot());
    observed = SQUARES.map((square) => {
      const x = box.x + square.xPts / PAGE.widthPts * box.width;
      const y = box.y + square.yPts / PAGE.heightPts * box.height;
      return { name: square.name, rgb: pixelAt(png, x, y), ok: matches(pixelAt(png, x, y), square.want) };
    });
    return observed.every((item) => item.ok) ? 'ok' : JSON.stringify(observed);
  }, { timeout: 15000, intervals: [250, 500, 1000] }).toBe('ok');

  const backend = (await status.textContent()).match(/Backend:\s*(\w+?)(?:Provider|\s|$)/)?.[1];
  console.log(`[color] backend ${backend}: ${observed.map((item) => `${item.name}=${item.rgb.join(',')}`).join(' ')}`);
});
