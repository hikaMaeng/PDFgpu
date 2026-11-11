import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLayout } from '../dist/layout/layout.js';
import { buildRenderQueue, detailSourceScale } from '../dist/scheduler/queue.js';

// External criteria, read from files this change does not touch:
//
// 1. `pdfiumEngine.renderTile` rasters a page at
//      pageWidth  = round(widthPts  * dpi / 72)
//      pageHeight = round(heightPts * dpi / 72)
//    and clamps each request to that raster:
//      tileX     = clamp(floor(tileX), 0, pageWidth - 1)
//      tileWidth = max(1, min(tileWidth, pageWidth - tileX))
//    (packages/pdfgpu/src/engine/pdfiumEngine.ts:359-369)
//
// 2. `PdfGpuController.applyCompositedFrame` places a finished tile back on
//    the canvas with
//      scale = baseScale * BASE_PREVIEW_DPI / entry.dpi
//      left  = pageLeft + entry.tileX * scale
//      width = entry.width * scale
//    (packages/pdfgpu/src/viewer/controller.ts, applyCompositedFrame)
//
// A detail tile grid is correct only when, for every zoom, (a) no tile starts
// outside the engine's raster and (b) the composited tiles tile the layout
// page exactly - no gap that would leave the 96 DPI preview showing, and no
// overshoot past the page edge.

const PREVIEW_DPI = 96;
const POINTS_PER_INCH = 72;
const PAGE_WIDTH_PTS = 612;
const PAGE_HEIGHT_PTS = 792;
const DETAIL_DPI = 192;
const VIEWPORT_HEIGHT = 900;

function roundInt(value) {
  return Math.max(1, Math.round(value));
}

/** Engine-side raster size for a page at `dpi` (criterion 1). */
function nativeRasterSize(dpi) {
  return {
    width: roundInt(PAGE_WIDTH_PTS * dpi / POINTS_PER_INCH),
    height: roundInt(PAGE_HEIGHT_PTS * dpi / POINTS_PER_INCH)
  };
}

function layoutForZoom(zoom) {
  const sizes = new Map([[0, {
    baseWidth: roundInt(PAGE_WIDTH_PTS * PREVIEW_DPI / POINTS_PER_INCH),
    baseHeight: roundInt(PAGE_HEIGHT_PTS * PREVIEW_DPI / POINTS_PER_INCH)
  }]]);
  return buildLayout(1, sizes, zoom, 16, { viewportWidth: 1 });
}

function detailTilesForZoom(zoom) {
  const layout = layoutForZoom(zoom);
  const tasks = buildRenderQueue({
    layout,
    pageCount: 1,
    visiblePages: [0],
    activePage: 0,
    viewportTop: 0,
    viewportHeight: VIEWPORT_HEIGHT,
    qualityDpi: DETAIL_DPI,
    sourceScale: detailSourceScale(DETAIL_DPI, zoom)
  });
  return { page: layout.pagePositions[0], tiles: tasks.filter((task) => task.kind === 'detail') };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Contiguous starts at `step`, last run ending exactly at `extent`. */
function assertCoversAxis(starts, step, extent, label) {
  assert.ok(starts.length > 0, `${label}: no tiles generated`);
  assert.equal(starts[0], 0, `${label}: grid does not start at 0`);
  for (let index = 1; index < starts.length; index += 1) {
    assert.equal(
      starts[index],
      starts[index - 1] + step,
      `${label}: gap between ${starts[index - 1]} and ${starts[index]}`
    );
  }
  const last = starts[starts.length - 1];
  assert.ok(last < extent, `${label}: tile at ${last} starts outside raster extent ${extent}`);
  assert.ok(
    last + step >= extent,
    `${label}: grid stops at ${last + step}, short of raster extent ${extent}`
  );
}

for (const zoom of [0.5, 1, 2]) {
  describe(`detail tile grid at zoom ${zoom}`, () => {
    const { page, tiles } = detailTilesForZoom(zoom);
    const native = nativeRasterSize(DETAIL_DPI);
    const step = tiles[0]?.tileWidth ?? 0;
    // Criterion 2, inverted: native -> layout.
    const compositeScale = zoom * PREVIEW_DPI / DETAIL_DPI;

    it('keeps every tile origin inside the engine raster', () => {
      for (const tile of tiles) {
        assert.ok(
          tile.tileX < native.width && tile.tileY < native.height,
          `tile (${tile.tileX},${tile.tileY}) is outside raster ${native.width}x${native.height}`
        );
      }
    });

    it('tiles the raster contiguously on both axes', () => {
      assert.equal(step, tiles[0].tileHeight, 'tiles are not square');
      assertCoversAxis(uniqueSorted(tiles.map((tile) => tile.tileX)), step, native.width, 'columns');
      assertCoversAxis(uniqueSorted(tiles.map((tile) => tile.tileY)), step, native.height, 'rows');
    });

    it('composites to the full layout page without gap or overshoot', () => {
      let right = 0;
      let bottom = 0;
      for (const tile of tiles) {
        // Engine clamp (criterion 1) then composite placement (criterion 2).
        const clampedWidth = Math.max(1, Math.min(tile.tileWidth, native.width - tile.tileX));
        const clampedHeight = Math.max(1, Math.min(tile.tileHeight, native.height - tile.tileY));
        right = Math.max(right, (tile.tileX + clampedWidth) * compositeScale);
        bottom = Math.max(bottom, (tile.tileY + clampedHeight) * compositeScale);
      }
      assert.ok(Math.abs(right - page.width) <= 1, `composited width ${right} != layout width ${page.width}`);
      assert.ok(Math.abs(bottom - page.height) <= 1, `composited height ${bottom} != layout height ${page.height}`);
    });
  });
}
