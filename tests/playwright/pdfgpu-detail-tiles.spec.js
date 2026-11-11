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

test('detail tile grid matches the engine raster at every zoom', async ({ page }) => {
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

    tileRequests.length = 0;
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(3000);

    const detail = tileRequests.filter(
      (item) => item.pageIndex === 0 && Number.isFinite(item.tileX) && item.dpi === step.dpi
    );
    expect(detail.length, `no detail tiles requested at zoom ${zoom} dpi ${step.dpi}`).toBeGreaterThan(0);

    // Engine raster size: round(pts * dpi / 72), independent of zoom.
    const nativeWidth = Math.round(firstPage.widthPts * step.dpi / POINTS_PER_INCH);
    const nativeHeight = Math.round(firstPage.heightPts * step.dpi / POINTS_PER_INCH);
    const expectedRight = Math.ceil(nativeWidth / TILE_SIZE) * TILE_SIZE;
    const expectedBottom = Math.ceil(nativeHeight / TILE_SIZE) * TILE_SIZE;

    const outside = detail.filter((item) => item.tileX >= nativeWidth || item.tileY >= nativeHeight);
    expect(
      outside,
      `zoom ${zoom}: ${outside.length}/${detail.length} tiles start outside the ${nativeWidth}x${nativeHeight} raster`
    ).toEqual([]);

    const maxRight = Math.max(...detail.map((item) => item.tileX + TILE_SIZE));
    const maxBottom = Math.max(...detail.map((item) => item.tileY + TILE_SIZE));
    expect(maxRight, `zoom ${zoom}: grid right edge`).toBe(expectedRight);
    expect(maxBottom, `zoom ${zoom}: grid bottom edge`).toBe(expectedBottom);

    observed.push(
      `zoom ${zoom.toFixed(2)} dpi ${step.dpi}: ${detail.length} tiles, raster ${nativeWidth}x${nativeHeight}, grid ${maxRight}x${maxBottom}`
    );
  }

  for (const line of observed) {
    console.log(`[tiles] ${line}`);
  }
});
