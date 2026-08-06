import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLayout, resolveViewportWindow, visiblePageIndices } from '../dist/layout/layout.js';
import { RasterCache } from '../dist/scheduler/byteBudgetCache.js';
import { buildRenderQueue } from '../dist/scheduler/queue.js';
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
    const visible = visiblePageIndices(layout.pagePositions, window);
    assert.deepEqual(visible, [0, 1, 2]);
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

  it('sorts render queue by priority', () => {
    const layout = {
      pagePositions: [
        { index: 0, top: 0, height: 800, width: 600 },
        { index: 1, top: 840, height: 800, width: 620 },
        { index: 2, top: 1680, height: 800, width: 610 }
      ],
      totalHeight: 2500
    };
    const queue = buildRenderQueue({
      layout,
      pageCount: 3,
      visiblePages: [0, 1],
      activePage: 1,
      viewportTop: 0,
      viewportHeight: 700,
      qualityDpi: 144
    });
    assert.equal(queue.length > 0, true);
    assert.equal(queue[0].kind, 'preview');
    assert.equal(queue[0].pageIndex, 1);
  });

  it('normalizes detail dpi', () => {
    assert.equal(normalizeDetailDpi(33), 144);
    assert.equal(normalizeDetailDpi(155), 144);
    assert.equal(normalizeDetailDpi(193), 192);
    assert.equal(normalizeDetailDpi(399), 384);
  });

  it('keeps visible-active order for mixed queue requests', () => {
    const layout = {
      pagePositions: [
        { index: 0, top: 0, height: 800, width: 600 },
        { index: 1, top: 840, height: 800, width: 620 },
        { index: 2, top: 1680, height: 800, width: 610 }
      ],
      totalHeight: 2500
    };
    const queue = buildRenderQueue({
      layout,
      pageCount: 3,
      visiblePages: [0, 1],
      activePage: 1,
      viewportTop: 300,
      viewportHeight: 700,
      qualityDpi: 192
    });
    assert.equal(queue[0].kind, 'preview');
    assert.equal(queue[0].pageIndex, 1);
    const firstActiveDetailIndex = queue.findIndex((item) => item.kind === 'detail' && item.pageIndex === 1);
    const firstVisibleDetailIndex = queue.findIndex((item) => item.kind === 'detail' && item.pageIndex === 0);
    assert.equal(firstActiveDetailIndex > -1, true);
    assert.equal(firstVisibleDetailIndex > -1, true);
    assert.equal(firstActiveDetailIndex < firstVisibleDetailIndex, true);
    const previewPages = queue.filter((item) => item.kind === 'preview').map((item) => item.pageIndex);
    assert.deepEqual(previewPages, [1, 0, 2]);
  });

  it('covers the full zoomed page with detail tiles', () => {
    const layout = {
      pagePositions: [
        { index: 0, top: 0, height: 1267, width: 979 }
      ],
      totalHeight: 1267
    };
    const queue = buildRenderQueue({
      layout,
      pageCount: 1,
      visiblePages: [0],
      activePage: 0,
      viewportTop: 0,
      viewportHeight: 700,
      qualityDpi: 192,
      // 1267x979 is a 1.2x zoomed 1056x816 preview page. The provider
      // raster is still 2x the unzoomed preview dimensions.
      sourceScale: 2
    });
    const detail = queue.filter((item) => item.kind === 'detail');
    assert.equal(detail.some((item) => item.tileY >= 1536), true);
    assert.equal(detail.some((item) => item.tileX >= 1024), true);
  });

  it('orders distant visible neighbors after detail workload', () => {
    const layout = {
      pagePositions: [
        { index: 0, top: 0, height: 700, width: 600 },
        { index: 1, top: 740, height: 700, width: 620 },
        { index: 2, top: 1480, height: 700, width: 610 },
        { index: 3, top: 2220, height: 700, width: 620 }
      ],
      totalHeight: 2950
    };
    const queue = buildRenderQueue({
      layout,
      pageCount: 4,
      visiblePages: [1, 2],
      activePage: 1,
      viewportTop: 740,
      viewportHeight: 700,
      qualityDpi: 144
    });

    const firstNeighbor = queue.find((item) => item.kind === 'preview' && item.pageIndex === 2);
    const distant = queue.find((item) => item.kind === 'preview' && item.pageIndex === 3);
    const visibleOther = queue.find((item) => item.kind === 'preview' && item.pageIndex === 1);
    assert.equal(firstNeighbor !== undefined, true);
    assert.equal(distant !== undefined, true);
    assert.equal(visibleOther === undefined, false);
    const firstNeighborIndex = queue.findIndex((item) => item.kind === 'preview' && item.pageIndex === 0);
    const distantIndex = queue.findIndex((item) => item.kind === 'preview' && item.pageIndex === 3);
    assert.equal(firstNeighborIndex < distantIndex, true);
  });

  it('does not enqueue distant previews for large documents', () => {
    const pagePositions = Array.from({ length: 504 }, (_, index) => ({
      index,
      top: index * 816,
      height: 800,
      width: 600
    }));
    const queue = buildRenderQueue({
      layout: {
        pagePositions,
        totalHeight: 504 * 816
      },
      pageCount: 504,
      visiblePages: [100, 101],
      activePage: 100,
      viewportTop: 100 * 816,
      viewportHeight: 700,
      qualityDpi: 144
    });

    const previewPages = new Set(queue.filter((item) => item.kind === 'preview').map((item) => item.pageIndex));
    assert.equal(previewPages.has(0), false);
    assert.equal(previewPages.has(503), false);
    assert.deepEqual([...previewPages].sort((a, b) => a - b), [98, 99, 100, 101, 102]);
    assert.equal(queue.length < 40, true);
  });
});
