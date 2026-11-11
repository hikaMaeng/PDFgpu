import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PageRenderer } from '../dist/render/renderer.js';
import { RasterCache } from '../dist/scheduler/byteBudgetCache.js';

// External criterion, from the cache's own contract (byteBudgetCache.ts):
// `RasterCache` is a byte-budget LRU - `getBytesBudget()` is its declared
// bound, and anything it drops is gone (`delete` closes the bitmap, so the
// pixels can no longer be read). A GPU texture is an upload of exactly one
// cached raster. So the number of live GPU textures can never exceed the
// number of rasters the cache still holds; any texture outliving its raster
// is unreachable GPU memory that nothing will ever free.
//
// Bytes are not asserted here: `imageSize()` recognises only ImageBitmap,
// HTMLCanvasElement and HTMLImageElement, none of which exist under Node, so
// every fake source measures 1x1. Counts are what this harness can measure.

function createFakeGpu(log) {
  const texture = () => {
    const handle = {
      destroyed: false,
      createView: () => ({}),
      destroy: () => {
        if (handle.destroyed) throw new Error('texture destroyed twice');
        handle.destroyed = true;
        log.destroyed += 1;
      }
    };
    log.created += 1;
    log.textures.push(handle);
    return handle;
  };

  const device = {
    createTexture: texture,
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        setVertexBuffer: () => {},
        draw: () => {},
        end: () => {}
      }),
      finish: () => ({})
    }),
    queue: {
      writeBuffer: () => {},
      copyExternalImageToTexture: () => {},
      submit: () => {}
    },
    destroy: () => {}
  };

  return {
    requestAdapter: async () => ({ requestDevice: async () => device }),
    getPreferredCanvasFormat: () => 'rgba8unorm'
  };
}

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: (kind) => (kind === 'webgpu'
      ? {
        configure: () => {},
        getCurrentTexture: () => ({ createView: () => ({}) })
      }
      : null)
  };
}

async function withFakeGpu(run) {
  const log = { created: 0, destroyed: 0, textures: [] };
  const previousNavigator = globalThis.navigator;
  const previousInfo = console.info;
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: createFakeGpu(log), hardwareConcurrency: 4 },
    configurable: true,
    writable: true
  });
  console.info = () => {};
  try {
    const renderer = new PageRenderer();
    const backend = await renderer.init(fakeCanvas());
    assert.equal(backend, 'webgpu', 'fake gpu did not initialize the webgpu path');
    return await run(renderer, log);
  } finally {
    console.info = previousInfo;
    if (previousNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        value: previousNavigator,
        configurable: true,
        writable: true
      });
    }
  }
}

function rasterEntry(index) {
  return {
    key: `detail/0/192/${index}/0`,
    kind: 'detail',
    pageIndex: 0,
    dpi: 192,
    tileX: index,
    tileY: 0,
    tileWidth: 512,
    tileHeight: 512,
    source: { id: index },
    width: 512,
    height: 512
  };
}

describe('gpu texture release', () => {
  it('never holds more textures than the cache holds rasters', async () => {
    await withFakeGpu(async (renderer, log) => {
      // 10 entries fit the budget: 512*512*4 = 1048576 bytes each.
      const cache = new RasterCache({
        maxBytes: 512 * 512 * 4 * 10,
        onRelease: (source) => renderer.releaseTexture(source)
      });

      for (let index = 0; index < 200; index += 1) {
        const entry = rasterEntry(index);
        cache.set(entry);
        renderer.render(fakeCanvas(), {
          width: 1024,
          height: 1024,
          tiles: [{ source: entry.source, left: 0, top: 0, width: 512, height: 512 }]
        });

        const live = log.created - log.destroyed;
        assert.ok(
          live <= cache.values().length,
          `after ${index + 1} rasters: ${live} live textures vs ${cache.values().length} cached rasters`
        );
      }

      assert.equal(log.created, 200, 'every raster should have been uploaded once');
      assert.equal(renderer.gpuTextureCount, cache.values().length);
      assert.ok(log.destroyed >= 190, `only ${log.destroyed} textures were destroyed`);
    });
  });

  it('destroys every texture when the document is replaced', async () => {
    await withFakeGpu(async (renderer, log) => {
      const cache = new RasterCache({
        maxBytes: 512 * 512 * 4 * 100,
        onRelease: (source) => renderer.releaseTexture(source)
      });

      for (let index = 0; index < 8; index += 1) {
        const entry = rasterEntry(index);
        cache.set(entry);
        renderer.render(fakeCanvas(), {
          width: 1024,
          height: 1024,
          tiles: [{ source: entry.source, left: 0, top: 0, width: 512, height: 512 }]
        });
      }
      assert.equal(renderer.gpuTextureCount, 8);

      cache.clear();
      assert.equal(cache.values().length, 0);
      assert.equal(renderer.gpuTextureCount, 0, 'textures outlived the cleared cache');
      assert.equal(log.destroyed, 8);
    });
  });

  it('destroys textures dropped by prune', async () => {
    await withFakeGpu(async (renderer, log) => {
      const cache = new RasterCache({
        maxBytes: 512 * 512 * 4 * 4,
        onRelease: (source) => renderer.releaseTexture(source)
      });

      const entries = [];
      for (let index = 0; index < 4; index += 1) {
        const entry = rasterEntry(index);
        entries.push(entry);
        cache.set(entry);
        renderer.render(fakeCanvas(), {
          width: 1024,
          height: 1024,
          tiles: [{ source: entry.source, left: 0, top: 0, width: 512, height: 512 }]
        });
      }
      assert.equal(renderer.gpuTextureCount, 4);

      cache.delete(entries[0].key);
      assert.equal(log.destroyed, 1, 'delete did not release the texture');
      assert.equal(renderer.gpuTextureCount, 3);
    });
  });

  it('releases everything on dispose', async () => {
    await withFakeGpu(async (renderer, log) => {
      const cache = new RasterCache({ maxBytes: 512 * 512 * 4 * 100 });
      const entry = rasterEntry(0);
      cache.set(entry);
      renderer.render(fakeCanvas(), {
        width: 1024,
        height: 1024,
        tiles: [{ source: entry.source, left: 0, top: 0, width: 512, height: 512 }]
      });
      assert.equal(renderer.gpuTextureCount, 1);

      renderer.dispose();
      assert.equal(renderer.gpuTextureCount, 0);
      assert.equal(log.destroyed, 1);
    });
  });
});
