const { test, expect } = require('@playwright/test');

// Detail tile coordinate contract, verified against the deployed viewer.
//
// The webapi provider puts every detail tile request on the wire as
// `/tile?pageIndex&dpi&tileX&tileY&tileWidth&tileHeight`, so the tile grid the
// viewer asks for is directly observable. The external criteria:
//
//   * the engine rasters a page at `round(widthPts * dpi / 72)` px, which is
//     the 96 DPI page size scaled by `dpi / 96` and is independent of zoom
//     (packages/pdfgpu/src/engine/pdfiumEngine.ts renderTile);
//   * the viewer composites a finished tile back with
//     `baseScale * 96 / dpi` (controller applyCompositedFrame).
//
// So for every zoom: no tile may start outside the raster, and the grid must
// reach the raster edge. A grid that overshoots wastes requests the engine
// clamps or rejects; one that stops short leaves the 96 DPI preview showing.

const TILE_SIZE = 512;
const POINTS_PER_INCH = 72;

function captureManifest(page) {
  const captured = { manifest: null };
  page.on('response', async (response) => {
    if (captured.manifest) return;
    const url = response.url();
    if (!url.endsWith('/api/pdfgpu/documents')) return;
    try {
      const body = await response.json();
      if (body && body.manifest) captured.manifest = body.manifest;
    } catch (error) {
      // non-JSON responses are not the open call
    }
  });
  return captured;
}

function collectTileRequests(page) {
  const requests = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/tile?')) return;
    const params = new URL(url).searchParams;
    requests.push({
      pageIndex: Number(params.get('pageIndex')),
      dpi: Number(params.get('dpi')),
      tileX: Number(params.get('tileX')),
      tileY: Number(params.get('tileY')),
      tileWidth: Number(params.get('tileWidth')),
      tileHeight: Number(params.get('tileHeight'))
    });
  });
  return requests;
}

async function readZoom(status) {
  const text = await status.innerText();
  const match = text.match(/Zoom:\s*(\d+)%/);
  expect(match, `no zoom in status: ${text}`).not.toBeNull();
  return Number(match[1]) / 100;
}

test('detail tiles cover the visible part of the engine raster at every zoom', async ({ page }) => {
  const base = process.env.TEST_URL || 'http://localhost:51000';
  const openCall = captureManifest(page);
  const tileRequests = collectTileRequests(page);

  await page.goto(base);
  await page.getByLabel('raster provider').selectOption('webapi');
  const status = page.getByRole('status', { name: 'viewer status' });
  await expect(status).toContainText(/Provider:\s*webapi/);
  await page.getByRole('button', { name: /sample pdf/i }).click();
  await expect(status).toContainText(/Pages:\s*1\s*\/\s*\d+/);

  // Page size in PDF points, straight from the provider manifest, so the
  // engine raster size follows from its own formula and not from the viewer.
  await expect.poll(() => (openCall.manifest ? 1 : 0), { timeout: 15000 }).toBe(1);
  const firstPage = openCall.manifest.pages[0];
  expect(firstPage.widthPts).toBeGreaterThan(100);
  expect(await readZoom(status)).toBe(1);

  // Each step pairs a zoom with its own detail DPI so the raster cache cannot
  // hide a missing tile behind an entry fetched at another zoom.
  const steps = [
    { extraZoomClicks: 0, dpi: 144 },
    { extraZoomClicks: 4, dpi: 240 },
    { extraZoomClicks: 4, dpi: 336 }
  ];
  const observed = [];

  for (const step of steps) {
    for (let index = 0; index < step.extraZoomClicks; index += 1) {
      await page.getByRole('button', { name: /zoom in/i }).click();
    }
    await page.getByLabel('detail image dpi').fill(String(step.dpi));
    await expect(status).toContainText(`DPI: ${step.dpi}`);
    const zoom = await readZoom(status);

    const region = page.getByRole('region', { name: 'PDF viewer' });
    const detail = () => tileRequests.filter((item) => item.pageIndex === 0 && item.dpi === step.dpi);
    await expect.poll(() => detail().length, { message: `DPI ${step.dpi} must produce detail tiles` }).toBeGreaterThan(0);
    const bounds = await region.evaluate((element) => {
      const shell = element.querySelector('[data-testid="pdfgpu-page-shell"][data-page-index="0"]');
      return {
        pageLeft: parseFloat(shell.style.left), pageTop: parseFloat(shell.style.top),
        pageWidth: parseFloat(shell.style.width), pageHeight: parseFloat(shell.style.height),
        viewportTop: element.scrollTop, viewportWidth: element.clientWidth, viewportHeight: element.clientHeight,
      };
    });
    const nativeWidth = Math.round(firstPage.widthPts * step.dpi / POINTS_PER_INCH);
    const nativeHeight = Math.round(firstPage.heightPts * step.dpi / POINTS_PER_INCH);
    const scale = (step.dpi / 96) / (bounds.pageWidth / Math.round(firstPage.widthPts * 96 / POINTS_PER_INCH));
    const left = Math.max(0, -bounds.pageLeft) * scale;
    const top = Math.max(0, bounds.viewportTop - bounds.pageTop) * scale;
    const right = Math.min(nativeWidth, Math.min(bounds.pageWidth, bounds.viewportWidth - bounds.pageLeft) * scale);
    const bottom = Math.min(nativeHeight, Math.min(bounds.pageHeight, bounds.viewportTop + bounds.viewportHeight - bounds.pageTop) * scale);
    const expected = [];
    for (let y = 0; y < nativeHeight; y += TILE_SIZE) {
      for (let x = 0; x < nativeWidth; x += TILE_SIZE) {
        if (x < right && x + TILE_SIZE > left && y < bottom && y + TILE_SIZE > top) expected.push(`${x},${y}`);
      }
    }
    await expect.poll(() => [...new Set(detail().map(({ tileX, tileY }) => `${tileX},${tileY}`))].sort())
      .toEqual(expected.sort());
    observed.push(`zoom ${zoom.toFixed(2)} dpi ${step.dpi}: ${expected.length} tiles in viewport, raster ${nativeWidth}x${nativeHeight}`);
  }

  for (const line of observed) {
    console.log(`[tiles] ${line}`);
  }
});
