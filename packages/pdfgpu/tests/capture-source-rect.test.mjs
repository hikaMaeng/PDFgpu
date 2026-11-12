import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureSourceRect } from '../dist/viewer/capture.js';
import { createWebApiPdfRasterProvider, createWebSocketPdfRasterProvider } from '../dist/index.js';

// External criterion: the definition of DPI. One inch is 72 PDF points and
// `dpi` raster pixels, so a region starting 1 inch (72pt) into a page sits
// `dpi` pixels into a raster rendered at that dpi - whatever dpi the capture
// originally asked for.
//
// Concrete case from the bundled demo server (apps/pdfgpu/src/server):
// every preview is 816x1056 for a 612x792pt Letter page, i.e. 96 DPI,
// even when capture requests 192 DPI.

const LETTER = { widthPts: 612, heightPts: 792 };

describe('capture source rectangle', () => {
  it('samples a 96 DPI raster at 96 px per inch even when 192 DPI was requested', () => {
    const rect = { x: 72, y: 144, width: 144, height: 72 }; // 1in, 2in, 2in x 1in
    const raster = { width: 816, height: 1056 };
    const got = captureSourceRect(rect, raster, LETTER.widthPts, LETTER.heightPts);
    assert.deepEqual(got, { sx: 96, sy: 192, sw: 192, sh: 96 });
    // The previous code used the requested dpi (192/72 px per pt) and would
    // have started at x = 192: twice too far into the 96 DPI raster.
  });

  it('samples a raster that does match the requested dpi unchanged', () => {
    const rect = { x: 72, y: 72, width: 72, height: 72 };
    const raster = { width: 612 * 192 / 72, height: 792 * 192 / 72 }; // 1632 x 2112
    const got = captureSourceRect(rect, raster, LETTER.widthPts, LETTER.heightPts);
    assert.deepEqual(got, { sx: 192, sy: 192, sw: 192, sh: 192 });
  });
});

describe('remote preview requests carry the requested dpi', () => {
  it('web api provider puts dpi on the preview query', async () => {
    const urls = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith('/documents')) {
        return new Response(JSON.stringify({ documentId: 'doc-1', manifest: { pageCount: 1, pages: [] } }), { status: 200 });
      }
      // Stop after the request is observed; image decoding is not under test.
      throw new Error('stop');
    };
    try {
      const provider = createWebApiPdfRasterProvider('http://test/api/pdfgpu');
      await provider.open(new Uint8Array([37, 80, 68, 70]));
      await provider.renderPreview({ pageIndex: 0, dpi: 192 }).catch(() => {});
    } finally {
      globalThis.fetch = previousFetch;
    }
    const preview = urls.find((url) => url.includes('/preview?'));
    assert.ok(preview, `no preview request among ${JSON.stringify(urls)}`);
    assert.equal(new URL(preview).searchParams.get('dpi'), '192');
  });
});

describe('remote provider concurrency', () => {
  // docs/api.md: queueDepth "원격 공급자는 최대 3"; the viewer reads it from the
  // provider and defaulted to 1 when the built-in providers did not declare it.
  it('declares three concurrent requests for both built-in remote providers', () => {
    assert.equal(createWebApiPdfRasterProvider('http://test/api').queueDepth, 3);
    const ws = createWebSocketPdfRasterProvider('ws://test/ws');
    assert.equal(ws.queueDepth, 3);
    ws.dispose();
  });
});
