import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLayout, resolveViewportWindow, visiblePageIndices, windowPageIndices } from '../dist/layout/layout.js';
import { RasterCache } from '../dist/scheduler/byteBudgetCache.js';
import { normalizeDetailDpi } from '../dist/engine/dpi.js';

function createBitmap() {
  return Object.create({ close() {} });
}

function makeBitmapEntry(key, width, height, source) {
  return {
    kind: 'preview',
    pageIndex: Number.parseInt(key.replace('p', ''), 10),
    dpi: 96,
    tileX: 0,
    tileY: 0,
    tileWidth: 1,
    tileHeight: 1,
    sourceWidth: width,
    sourceHeight: height,
    dpiRounded: 96,
    key,
    source,
    width,
    height
  };
}

describe('layout calculations', () => {
  it('computes fallback layout for unknown page sizes', () => {
    const layout = buildLayout(3, new Map(), 1, 16);
    assert.equal(layout.pagePositions.length, 3);
    assert.ok(layout.totalHeight > 0);
  });

  it('computes visible window with overscan', () => {
    const map = new Map([
      [0, { baseWidth: 500, baseHeight: 700 }],
      [1, { baseWidth: 500, baseHeight: 700 }],
      [2, { baseWidth: 500, baseHeight: 700 }]
    ]);
    const layout = buildLayout(3, map, 1, 16);
    const window = resolveViewportWindow(layout.pagePositions, 600, 650, 1);
    assert.deepEqual(windowPageIndices(layout.pagePositions, window), [0, 1, 2]);
  });

  it('puts the first spread page in the left or right slot of a two-page row', () => {
    // architecture.md: spread "2페이지 row를 구성하고 첫 페이지를 왼쪽/오른쪽 슬롯 중 하나에
    // 배치". The slots are the columns that the following two-page rows use.
    const map = new Map([0, 1, 2, 3, 4].map((i) => [i, { baseWidth: 500, baseHeight: 700 }]));
    for (const [placement, column] of [['first-left', 1], ['first-right', 2]]) {
      const { pagePositions } = buildLayout(5, map, 1, 16, { viewMode: 'spread', spreadPlacement: placement, viewportWidth: 1600, spreadGap: 20 });
      const first = pagePositions.find((p) => p.index === 0);
      const sameColumn = pagePositions.find((p) => p.index === column); // row [2,3] in 1-based: page 2 left, page 3 right
      assert.equal(first.left, sameColumn.left, `${placement}: page 1 is not in the ${placement === 'first-left' ? 'left' : 'right'} slot`);
    }
  });

  it('counts as visible only the pages that intersect the viewport', () => {
    // Pages are 700px tall with a 16px gap: page 0 = 0..700, page 1 = 716..1416,
    // page 2 = 1432..2132. A 600px viewport at scrollTop 650 spans 650..1250, so by
    // plain interval intersection pages 0 and 1 are on screen and page 2 is not.
    const map = new Map([0, 1, 2].map((i) => [i, { baseWidth: 500, baseHeight: 700 }]));
    const layout = buildLayout(3, map, 1, 16);
    const window = resolveViewportWindow(layout.pagePositions, 600, 650, 1);
    assert.deepEqual(visiblePageIndices(layout.pagePositions, window, 650, 600), [0, 1]);
    // Entirely inside page 1.
    assert.deepEqual(visiblePageIndices(layout.pagePositions, window, 800, 400), [1]);
    // The 16px gap between pages 1 and 2 plus the edges of both.
    assert.deepEqual(visiblePageIndices(layout.pagePositions, window, 1410, 30), [1, 2]);
  });
});

describe('texture cache', () => {
  it('keeps byte budget and evicts oldest entry', () => {
    const cache = new RasterCache({ maxBytes: 12_000 }); // 3x2x2000 approx
    const entryA = { 
      key: 'preview/0/96/0/0',
      kind: 'preview',
      pageIndex: 0,
      dpi: 96,
      tileX: 0,
      tileY: 0,
      tileWidth: 1,
      tileHeight: 1,
      sourceWidth: 20,
      sourceHeight: 20,
      dpiRounded: 96,
      source: createBitmap(),
      width: 3000,
      height: 1
    };
    const entryB = { 
      key: 'preview/1/96/0/0',
      kind: 'preview',
      pageIndex: 1,
      dpi: 96,
      tileX: 0,
      tileY: 0,
      tileWidth: 1,
      tileHeight: 1,
      sourceWidth: 20,
      sourceHeight: 20,
      dpiRounded: 96,
      source: createBitmap(),
      width: 3000,
      height: 1
    };
    const entryC = { 
      key: 'preview/2/96/0/0',
      kind: 'preview',
      pageIndex: 2,
      dpi: 96,
      tileX: 0,
      tileY: 0,
      tileWidth: 1,
      tileHeight: 1,
      sourceWidth: 20,
      sourceHeight: 20,
      dpiRounded: 96,
      source: createBitmap(),
      width: 3000,
      height: 1
    };
    cache.set(entryA);
    cache.set(entryB);
    cache.set({
      key: 'preview/2/96/0/0',
      kind: 'preview',
      pageIndex: 2,
      dpi: 96,
      tileX: 0,
      tileY: 0,
      tileWidth: 1,
      tileHeight: 1,
      sourceWidth: 20,
      sourceHeight: 20,
      dpiRounded: 96,
      source: createBitmap(),
      width: 100,
      height: 100
    });
    cache.set(entryB);
    cache.set(entryC);

    assert.equal(cache.usedBytes > 0, true);
    assert.equal(cache.has(entryA.key), false);
    assert.equal(cache.has(entryC.key), true);
  });

  it('retains only active keys after pruning', () => {
    const cache = new RasterCache({ maxBytes: 40 });
    const entries = [
      makeBitmapEntry('p1', 10, 10, createBitmap()),
      makeBitmapEntry('p2', 10, 10, createBitmap()),
      makeBitmapEntry('p3', 10, 10, createBitmap()),
      makeBitmapEntry('p4', 10, 10, createBitmap())
    ];
    const large = makeBitmapEntry('p5', 20, 30, createBitmap());
    const map = new Map();
    let bytes = 0;
    for (const entry of entries) {
      map.set(entry.key, { ...entry, bytes: entry.width * entry.height * 4 });
      bytes += entry.width * entry.height * 4;
    }
    map.set(large.key, { ...large, bytes: large.width * large.height * 4 });
    bytes += large.width * large.height * 4;

    cache.entriesMap = map;
    cache.bytesUsed = bytes;

    cache.prune(new Set(['p2', 'p4']));
    assert.equal(cache.has('p1'), false);
    assert.equal(cache.has('p2'), true);
    assert.equal(cache.has('p3'), false);
    assert.equal(cache.has('p4'), true);
    assert.equal(cache.has('p5'), false);
  });

  it('protects visible raster keys while adding new tiles', () => {
    const cache = new RasterCache({ maxBytes: 80 });
    const entry = (key, pageIndex) => ({
      key,
      kind: 'detail',
      pageIndex,
      dpi: 192,
      tileX: 0,
      tileY: 0,
      tileWidth: 1,
      tileHeight: 1,
      sourceWidth: 4,
      sourceHeight: 4,
      dpiRounded: 192,
      source: createBitmap(),
      width: 4,
      height: 4
    });

    cache.set(entry('detail/0/192/0/0', 0));
    cache.set(entry('detail/0/192/0/512', 0), new Set(['detail/0/192/0/0', 'detail/0/192/0/512']));
    cache.set(entry('detail/0/192/0/1024', 0), new Set([
      'detail/0/192/0/0',
      'detail/0/192/0/512',
      'detail/0/192/0/1024'
    ]));

    assert.equal(cache.has('detail/0/192/0/0'), true);
    assert.equal(cache.has('detail/0/192/0/512'), true);
    assert.equal(cache.has('detail/0/192/0/1024'), true);
  });

  it('normalizes detail dpi', () => {
    assert.equal(normalizeDetailDpi(33), 144);
    assert.equal(normalizeDetailDpi(155), 144);
    assert.equal(normalizeDetailDpi(193), 192);
    assert.equal(normalizeDetailDpi(399), 384);
  });

  it('checks cache admission without evicting nearer or pinned rasters', () => {
    const cache = new RasterCache({ maxBytes: 800 });
    cache.set(makeBitmapEntry('p0', 10, 10, createBitmap()));
    cache.set(makeBitmapEntry('p4', 10, 10, createBitmap()));
    assert.equal(cache.canFit(400, new Set(['p0'])), true);
    assert.equal(cache.canFit(401, new Set(['p0'])), false);
    assert.equal(cache.canFit(400, new Set(['p0', 'p4'])), false);
    assert.equal(cache.usedBytes, 800);
  });

});
