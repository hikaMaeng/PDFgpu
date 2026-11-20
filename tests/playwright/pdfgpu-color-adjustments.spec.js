const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { decodePng } = require('./lib/png');

const ORIGIN = 'https://pdfgpu-color.test';
const CORE_DIST = path.resolve(__dirname, '../../packages/pdfgpu/dist');

async function openViewerPage(page) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><div id="viewer" style="width:360px;height:280px"></div>'
      });
    }
    if (pathname.endsWith('.js')) {
      return route.fulfill({ contentType: 'application/javascript', path: path.join(CORE_DIST, pathname) });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(ORIGIN);
}

function mountViewer(page) {
  return page.evaluate(async () => {
    const { createPdfGpuViewer } = await import('/index.js');

    function raster(width, height, color, pageIndex, dpi, kind) {
      const source = document.createElement('canvas');
      source.width = width;
      source.height = height;
      const context = source.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
      return { source, width, height, pageIndex, dpi, kind };
    }

    let showDetail;
    let documentNumber = 0;
    const detailReady = new Promise((resolve) => { showDetail = resolve; });
    const provider = {
      open: async () => {
        documentNumber += 1;
        return { pageCount: 1, pages: [{ index: 0, widthPts: 144, heightPts: 144, rotation: 0 }] };
      },
      renderPreview: async ({ pageIndex, dpi = 96 }) => raster(dpi * 2, dpi * 2, 'rgb(32,96,224)', pageIndex, dpi, 'preview'),
      renderTile: async ({ pageIndex, dpi, tileX, tileY, tileWidth, tileHeight }) => {
        const color = documentNumber === 1 ? 'rgb(64,128,192)' : 'rgb(96,160,224)';
        const pageSize = Math.round(144 * dpi / 72);
        const width = Math.min(tileWidth, pageSize - tileX);
        const height = Math.min(tileHeight, pageSize - tileY);
        await detailReady;
        return {
          ...raster(width, height, color, pageIndex, dpi, 'detail'),
          tileX,
          tileY,
          tileWidth,
          tileHeight
        };
      },
      dispose: () => {}
    };
    const viewer = await createPdfGpuViewer({
      container: document.querySelector('#viewer'),
      provider,
      colorAdjustments: { brightness: -0.125 }
    });
    window.colorTest = { viewer, showDetail };
    await viewer.load(new ArrayBuffer(0));
    return viewer.getState().backend;
  });
}

async function expectColors(page, rgb) {
  const canvas = page.locator('#viewer canvas');
  const matches = (actual, expected) => actual.every((value, channel) => Math.abs(value - expected[channel]) <= 1);
  await expect.poll(async () => {
    const { width, height, rgba } = decodePng(await canvas.screenshot({ scale: 'css' }));
    const pixel = (x, y) => {
      const index = (y * width + x) * 4;
      return [...rgba.subarray(index, index + 3)];
    };
    const pageRgb = pixel(180, 100);
    const gaps = [pixel(width - 2, 100), pixel(180, height - 2)];
    return [
      matches(pageRgb, rgb) ? 'page' : pageRgb,
      gaps.every((gap) => matches(gap, [255, 255, 255])) ? 'gap' : gaps
    ];
  }).toEqual(['page', 'gap']);
}

test('WebGPU adjusts preview and detail colors through the viewer API', async ({ page }) => {
  await openViewerPage(page);
  const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  test.skip(!hasAdapter && process.env.PDFGPU_REQUIRE_WEBGPU !== '1', 'WebGPU adapter unavailable');
  expect(hasAdapter).toBe(true);
  expect(await mountViewer(page)).toBe('webgpu');

  await expectColors(page, [0, 64, 192]);
  await page.evaluate(() => window.colorTest.viewer.setColorAdjustments({ invert: true, brightness: 0.25 }));
  await expectColors(page, [255, 223, 95]);

  await page.evaluate(() => window.colorTest.showDetail());
  await expectColors(page, [255, 191, 127]);

  const capture = await page.evaluate(async () => {
    return window.colorTest.viewer.captureRegion({ x: 130, y: 45 }, { x: 220, y: 135 });
  });
  const capturePixels = decodePng(Buffer.from(capture.imageBase64, 'base64')).rgba;
  expect([...capturePixels.subarray(0, 3)]).toEqual([32, 96, 224]);

  const settings = await page.evaluate(() => {
    const { viewer } = window.colorTest;
    viewer.setColorAdjustments({ brightness: 0 });
    return viewer.getState().colorAdjustments;
  });
  expect(settings).toEqual({ invert: true, brightness: 0, contrast: 1, saturation: 1 });
  await expectColors(page, [191, 127, 63]);

  const reloadedSettings = await page.evaluate(async () => {
    const { viewer } = window.colorTest;
    await viewer.load(new ArrayBuffer(0));
    return viewer.getState().colorAdjustments;
  });
  expect(reloadedSettings).toEqual({ invert: true, brightness: 0, contrast: 1, saturation: 1 });
  await expectColors(page, [159, 95, 31]);

  await page.evaluate(() => window.colorTest.viewer.setColorAdjustments({ invert: false }));
  await expectColors(page, [96, 160, 224]);
  await page.evaluate(() => window.colorTest.viewer.setColorAdjustments({ contrast: 1.5 }));
  await expectColors(page, [80, 176, 255]);
  await page.evaluate(() => window.colorTest.viewer.setColorAdjustments({ contrast: 0.5, saturation: 0 }));
  await expectColors(page, [139, 139, 139]);
  const finalSettings = await page.evaluate(() => {
    const { viewer } = window.colorTest;
    viewer.dispose();
    return viewer.getState().colorAdjustments;
  });
  expect(finalSettings).toEqual({ invert: false, brightness: 0, contrast: 0.5, saturation: 0 });
});

test('Canvas 2D retains the color settings and displays original RGB', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await openViewerPage(page);
  expect(await mountViewer(page)).toBe('unsupported');
  await expectColors(page, [32, 96, 224]);

  const settings = await page.evaluate(() => {
    const { viewer } = window.colorTest;
    viewer.setColorAdjustments({ invert: true, brightness: 2, contrast: 4, saturation: -1 });
    viewer.setColorAdjustments({ brightness: Infinity, contrast: NaN });
    return viewer.getState().colorAdjustments;
  });
  expect(settings).toEqual({ invert: true, brightness: 1, contrast: 2, saturation: 0 });
  await expectColors(page, [32, 96, 224]);

  await page.evaluate(() => window.colorTest.showDetail());
  await expectColors(page, [64, 128, 192]);
  await page.evaluate(() => window.colorTest.viewer.dispose());
});
