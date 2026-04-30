const { test, expect } = require('@playwright/test');
const zlib = require('node:zlib');

function countDarkPixelsFromPng(buffer) {
  const png = decodePng(buffer);
  let count = 0;
  for (let index = 0; index < png.rgba.length; index += 4) {
    const alpha = png.rgba[index + 3];
    if (alpha < 128) continue;
    const red = png.rgba[index];
    const green = png.rgba[index + 1];
    const blue = png.rgba[index + 2];
    if (red < 120 && green < 120 && blue < 120) {
      count += 1;
    }
  }
  return count;
}

function decodePng(buffer) {
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('not a png');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported png format ${bitDepth}/${colorType}`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(height * stride);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const scanline = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    unfilterScanline(scanline, previous, filter, channels);
    scanline.copy(raw, y * stride);
    previous = scanline;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = raw[pixel * channels];
    rgba[pixel * 4 + 1] = raw[pixel * channels + 1];
    rgba[pixel * 4 + 2] = raw[pixel * channels + 2];
    rgba[pixel * 4 + 3] = colorType === 6 ? raw[pixel * channels + 3] : 255;
  }

  return { width, height, rgba };
}

function unfilterScanline(scanline, previous, filter, bytesPerPixel) {
  for (let index = 0; index < scanline.length; index += 1) {
    const left = index >= bytesPerPixel ? scanline[index - bytesPerPixel] : 0;
    const up = previous[index] || 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] || 0 : 0;
    if (filter === 1) {
      scanline[index] = (scanline[index] + left) & 0xff;
    } else if (filter === 2) {
      scanline[index] = (scanline[index] + up) & 0xff;
    } else if (filter === 3) {
      scanline[index] = (scanline[index] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      scanline[index] = (scanline[index] + paeth(left, up, upLeft)) & 0xff;
    } else if (filter !== 0) {
      throw new Error(`unsupported png filter ${filter}`);
    }
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

async function openViewer(page) {
  const base = process.env.TEST_URL || 'http://localhost:51000';
  page.on('console', (msg) => console.log(`[PW CONSOLE] ${msg.type()} ${msg.text()}`));
  page.on('pageerror', (error) => console.log(`[PW PAGEERROR] ${error.message}`));

  await page.goto(base);
  await expect(page.getByRole('toolbar', { name: 'viewer controls' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PDF viewer' })).toBeVisible();
  return base;
}

test('in-memory PDFium provider loads sample and uploaded PDFs', async ({ page }) => {
  const base = await openViewer(page);
  const status = page.getByRole('status', { name: 'viewer status' });
  const region = page.getByRole('region', { name: 'PDF viewer' });
  const canvas = region.locator('canvas[aria-hidden="true"]');

  await expect(canvas).toBeAttached();
  await page.getByRole('button', { name: /sample pdf/i }).click();
  await expect(status).toContainText(/Provider:\s*in-memory/);
  await expect(status).toContainText(/Pages:\s*1\s*\/\s*\d+/);
  await expect(status).toContainText(/Backend:\s*(webgpu|unsupported|error)/);
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  const regionBox = await region.boundingBox();
  expect(canvasBox.height).toBeLessThanOrEqual(regionBox.height + 1);
  expect(countDarkPixelsFromPng(await region.screenshot())).toBeGreaterThan(20);
  expect(await page.getByRole('alert').count()).toBe(0);

  await expect.poll(
    () => page.locator('[data-testid="pdfgpu-page-shell"]').count(),
    { timeout: 10000 }
  ).toBeGreaterThan(0);

  await page.getByRole('button', { name: /zoom in/i }).click();
  await expect(status).toContainText(/Zoom:\s*[1-9]/);
  await expect(status).toContainText(/Quality:\s*detail/);
  await page.getByRole('button', { name: /zoom out/i }).click();
  await expect(status).toContainText(/Quality:\s*(preview|detail)/);
  await page.getByRole('button', { name: /fit height/i }).click();
  await expect(status).toContainText(/Fit:\s*height/);
  await page.getByRole('button', { name: /fit page/i }).click();
  await expect(status).toContainText(/Fit:\s*page/);
  await page.getByLabel('detail image dpi').fill('288');
  await expect(status).toContainText(/DPI:\s*288/);

  await page.getByLabel('view mode').selectOption('spread');
  await expect(status).toContainText(/View:\s*spread/);
  await page.getByLabel('first page spread placement').selectOption('first-left');
  await expect(status).toContainText(/FirstPage:\s*first-left/);
  await page.getByLabel('first page spread placement').selectOption('first-right');
  await expect(status).toContainText(/FirstPage:\s*first-right/);
  await expect.poll(
    () => page.locator('[data-testid="pdfgpu-page-shell"]').count(),
    { timeout: 10000 }
  ).toBeGreaterThanOrEqual(2);
  const spreadMetrics = await page.locator('[data-testid="pdfgpu-page-shell"][data-page-index="1"], [data-testid="pdfgpu-page-shell"][data-page-index="2"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width };
    })
  );
  expect(spreadMetrics[1].left).toBeGreaterThan(spreadMetrics[0].left + spreadMetrics[0].width * 0.5);
  expect(Math.abs(spreadMetrics[1].top - spreadMetrics[0].top)).toBeLessThan(2);
  await page.getByLabel('view mode').selectOption('single');
  await expect(status).toContainText(/View:\s*single/);

  const firstShell = page.locator('[data-testid="pdfgpu-page-shell"]').first();
  await expect(firstShell).toBeVisible();
  const textLayer = firstShell.locator('[data-testid="pdfgpu-text-layer"]');
  await expect(textLayer).toHaveAttribute('aria-hidden', 'true');
  await expect(textLayer).toHaveAttribute('inert');

  const activeState = await firstShell.getAttribute('data-render-state');
  expect(['idle', 'preview', 'detail']).toContain(activeState);

  await region.evaluate((el) => {
    el.scrollTop = 1500;
  });
  await page.waitForTimeout(350);
  await expect.poll(
    () => page.locator('[data-testid="pdfgpu-page-shell"]').count(),
    { timeout: 10000 }
  ).toBeGreaterThanOrEqual(1);

  await region.evaluate((el) => {
    for (let index = 0; index < 80; index += 1) {
      el.scrollTop = index % 2 === 0 ? index * 45 : Math.max(0, index * 20);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });
  await region.dispatchEvent('wheel', {
    deltaY: -120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });
  await region.dispatchEvent('wheel', {
    deltaY: 120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });
  await region.dispatchEvent('wheel', {
    deltaY: -120,
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });
  await page.waitForTimeout(500);
  await expect(canvas).toBeVisible();
  expect(await page.getByRole('alert').count()).toBe(0);
  expect(countDarkPixelsFromPng(await region.screenshot())).toBeGreaterThan(20);

  const uploadData = await page.request.get(`${base}/sample.pdf`);
  const file = await uploadData.body();
  await page.getByLabel('Upload PDF').setInputFiles({
    name: 'sample-upload.pdf',
    mimeType: 'application/pdf',
    buffer: file
  });
  await expect(status).toContainText(/Source:\s*sample-upload\.pdf/);
  await expect(status).toContainText(/Pages:\s*\d+\s*\/\s*\d+/);
  expect(await page.getByRole('alert').count()).toBe(0);
});

async function loadRemoteProvider(page, providerValue, providerPattern, endpointPattern) {
  await openViewer(page);
  const status = page.getByRole('status', { name: 'viewer status' });
  const provider = page.getByLabel('raster provider');
  const sample = page.getByRole('button', { name: /sample pdf/i });

  await provider.selectOption(providerValue);
  await expect(status).toContainText(providerPattern);
  await expect(status).toContainText(endpointPattern);
  await sample.click();
  await expect(status).toContainText(/Pages:\s*1\s*\/\s*\d+/);
}

test('web api raster provider loads sample PDFs', async ({ page }) => {
  await loadRemoteProvider(page, 'webapi', /Provider:\s*webapi/, /Endpoint:\s*\/api\/pdfgpu/);
});

test('websocket raster provider loads sample PDFs', async ({ page }) => {
  await loadRemoteProvider(page, 'websocket', /Provider:\s*websocket/, /Endpoint:\s*ws/);
});
