import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockEngine() {
  const manifest = {
    pageCount: 3,
    pages: [
      { index: 0, widthPts: 612, heightPts: 792, rotation: 0 },
      { index: 1, widthPts: 612, heightPts: 792, rotation: 90 },
      { index: 2, widthPts: 300, heightPts: 400, rotation: 180 }
    ]
  };

  return {
    async open() {
      return manifest;
    },
    async renderPreview(request) {
      if (request.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return {
        source: { close() {} },
        width: 100,
        height: 120,
        dpi: 96,
        pageIndex: request.pageIndex,
        kind: 'preview'
      };
    },
    async renderTile(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (request.signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          resolve({
            source: { close() {} },
            width: 512,
            height: 512,
            dpi: request.dpi,
            pageIndex: request.pageIndex,
            kind: 'detail',
            tileX: request.tileX,
            tileY: request.tileY,
            tileWidth: request.tileWidth,
            tileHeight: request.tileHeight
          });
        }, 10);
        request.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
    dispose() {}
  };
}

describe('engine contract', () => {
  it('extracts manifest fields', async () => {
    const engine = createMockEngine();
    const manifest = await engine.open();
    assert.equal(manifest.pageCount, 3);
    assert.deepEqual(manifest.pages[0], {
      index: 0,
      widthPts: 612,
      heightPts: 792,
      rotation: 0
    });
    assert.deepEqual(manifest.pages[1].rotation, 90);
  });

  it('creates preview result', async () => {
    const engine = createMockEngine();
    const preview = await engine.renderPreview({ pageIndex: 1, signal: new AbortController().signal });
    assert.equal(preview.kind, 'preview');
    assert.equal(preview.dpi, 96);
    assert.equal(preview.width, 100);
  });

  it('creates detail tile result', async () => {
    const engine = createMockEngine();
    const tile = await engine.renderTile({
      pageIndex: 1,
      dpi: 288,
      tileX: 0,
      tileY: 0,
      tileWidth: 512,
      tileHeight: 512,
      signal: new AbortController().signal
    });
    assert.equal(tile.kind, 'detail');
    assert.equal(tile.tileWidth, 512);
    assert.equal(tile.tileHeight, 512);
  });

  it('aborts render task', async () => {
    const engine = createMockEngine();
    const ac = new AbortController();
    const task = engine.renderTile({
      pageIndex: 1,
      dpi: 288,
      tileX: 0,
      tileY: 0,
      tileWidth: 512,
      tileHeight: 512,
      signal: ac.signal
    });
    ac.abort();
    await assert.rejects(task, (error) => error.name === 'AbortError');
  });
});
