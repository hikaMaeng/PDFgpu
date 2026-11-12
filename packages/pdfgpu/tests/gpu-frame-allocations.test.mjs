import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PageRenderer } from '../dist/render/renderer.js';

// External criterion, stated before the fix (issue #3) and taken from what a
// WebGPU frame actually needs rather than from this renderer's code:
//
// A textured-quad pass needs, per frame, one command encoder, one swap-chain
// view and one submit. Everything else it binds - the sampler, the pipeline,
// a texture's view, the bind group pairing them, and the vertex data for a
// tile whose geometry has not changed - depends only on objects that outlive
// the frame. So per-frame creation of those objects is churn, and the count
// that must stay flat as frames accumulate is createBuffer, createBindGroup
// and GPUTexture.createView.
//
// Measured in Chrome before the fix (275 frames): createBuffer 34821,
// createBindGroup 34821, createView 35096 - about 127 of each per frame.

function createCountingGpu(log) {
  const texture = () => {
    const handle = {
      createView: () => {
        log.textureViews += 1;
        return { kind: 'texture-view' };
      },
      destroy: () => {}
    };
    log.createTexture += 1;
    return handle;
  };

  const device = {
    createTexture: texture,
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (desc) => {
      log.createBindGroup += 1;
      log.bindGroupViews.push(desc.entries[1].resource);
      return { kind: 'bind-group', id: log.createBindGroup };
    },
    createBuffer: (desc) => {
      log.createBuffer += 1;
      log.bufferSizes.push(desc.size);
      return { kind: 'buffer', destroy: () => { log.bufferDestroy += 1; } };
    },
    createCommandEncoder: () => {
      log.createCommandEncoder += 1;
      return {
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: (slot, group) => { log.setBindGroup.push(group); },
          setVertexBuffer: () => { log.setVertexBuffer += 1; },
          draw: (count, instances, firstVertex) => {
            log.draws.push({ count, instances, firstVertex });
          },
          end: () => {}
        }),
        finish: () => ({})
      };
    },
    queue: {
      writeBuffer: (buffer, offset, data, dataOffset, size) => {
        log.writeBuffer += 1;
        // Keep a copy of exactly the bytes handed to the GPU.
        const view = new Float32Array(data, dataOffset, size / 4);
        log.lastVertices = Float32Array.from(view);
      },
      copyExternalImageToTexture: () => {},
      submit: () => { log.submit += 1; }
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
        getCurrentTexture: () => ({
          createView: () => ({ kind: 'swapchain-view' })
        })
      }
      : null)
  };
}

function newLog() {
  return {
    createTexture: 0,
    textureViews: 0,
    createBindGroup: 0,
    createBuffer: 0,
    bufferDestroy: 0,
    createCommandEncoder: 0,
    writeBuffer: 0,
    submit: 0,
    setVertexBuffer: 0,
    setBindGroup: [],
    draws: [],
    bufferSizes: [],
    bindGroupViews: [],
    lastVertices: null
  };
}

async function withCountingGpu(run) {
  const log = newLog();
  const previousNavigator = globalThis.navigator;
  const previousInfo = console.info;
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: createCountingGpu(log), hardwareConcurrency: 4 },
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

/** A frame of `count` tiles laid out left to right, 512px wide each. */
function tiledFrame(count) {
  const tiles = [];
  for (let index = 0; index < count; index += 1) {
    tiles.push({
      source: { id: index },
      left: index * 512,
      top: 0,
      width: 512,
      height: 512
    });
  }
  return { width: count * 512, height: 512, tiles };
}

/**
 * Clip-space vertices for a tile, derived here from the WebGPU coordinate
 * convention rather than imported from the renderer, so a change in the
 * renderer's own maths cannot make this test agree with it by construction.
 */
function expectedVertices(tile, frameWidth, frameHeight) {
  const x0 = tile.left / frameWidth * 2 - 1;
  const y0 = 1 - tile.top / frameHeight * 2;
  const x1 = (tile.left + tile.width) / frameWidth * 2 - 1;
  const y1 = 1 - (tile.top + tile.height) / frameHeight * 2;
  return [
    x0, y0, 0, 0,
    x1, y0, 1, 0,
    x0, y1, 0, 1,
    x0, y1, 0, 1,
    x1, y0, 1, 0,
    x1, y1, 1, 1
  ];
}

describe('webgpu per-frame allocations', () => {
  it('does not grow allocations as frames accumulate', async () => {
    await withCountingGpu(async (renderer, log) => {
      const frame = tiledFrame(12);
      const canvas = fakeCanvas();

      for (let n = 0; n < 30; n += 1) {
        renderer.render(canvas, frame);
      }

      assert.equal(log.submit, 30, 'one submit per frame');
      assert.equal(log.createTexture, 12, 'each tile uploads exactly once');

      // The criteria fixed in issue #3, as ratios per frame.
      assert.ok(
        log.textureViews / log.submit <= 2,
        `texture createView per frame = ${log.textureViews / log.submit}`
      );
      assert.ok(
        log.createBindGroup / log.submit <= 5,
        `createBindGroup per frame = ${log.createBindGroup / log.submit}`
      );
      assert.ok(
        log.createBuffer / log.submit <= 5,
        `createBuffer per frame = ${log.createBuffer / log.submit}`
      );

      // Stronger than the ratios: these are built once for the 12 textures and
      // then reused for all 30 frames.
      assert.equal(log.textureViews, 12, 'a texture view was rebuilt');
      assert.equal(log.createBindGroup, 12, 'a bind group was rebuilt');
      assert.equal(log.createBuffer, 1, 'the vertex buffer was reallocated');
      assert.equal(log.setVertexBuffer, 30, 'vertex buffer is bound once per frame');
      assert.equal(log.draws.length, 12 * 30, 'every tile is still drawn');
    });
  });

  it('gives each tile its own slice of the shared vertex buffer', async () => {
    await withCountingGpu(async (renderer, log) => {
      const frame = tiledFrame(4);
      renderer.render(fakeCanvas(), frame);

      assert.equal(log.writeBuffer, 1, 'vertex data is written in one call');
      assert.equal(log.draws.length, 4);

      // Tiles draw at 0, 6, 12, 18 - six vertices each, in order.
      assert.deepEqual(
        log.draws.map((d) => d.firstVertex),
        [0, 6, 12, 18]
      );
      assert.deepEqual(log.draws.map((d) => d.count), [6, 6, 6, 6]);

      // Each tile's geometry must sit at its own firstVertex offset, or tiles
      // render at another tile's position.
      for (let index = 0; index < 4; index += 1) {
        const want = expectedVertices(frame.tiles[index], frame.width, frame.height);
        const base = log.draws[index].firstVertex * 4;
        const got = Array.from(log.lastVertices.slice(base, base + 24));
        for (let k = 0; k < 24; k += 1) {
          assert.ok(
            Math.abs(got[k] - want[k]) < 1e-6,
            `tile ${index} vertex float ${k}: got ${got[k]}, want ${want[k]}`
          );
        }
      }

      // Each tile binds its own texture's view, not a shared or stale one.
      const views = log.bindGroupViews;
      assert.equal(new Set(views).size, 4, 'bind groups share a texture view');
    });
  });

  it('grows the vertex buffer instead of reallocating every frame', async () => {
    await withCountingGpu(async (renderer, log) => {
      const canvas = fakeCanvas();

      renderer.render(canvas, tiledFrame(4));
      const afterSmall = log.createBuffer;

      // A much larger frame needs more room than the 4KB floor.
      renderer.render(canvas, tiledFrame(80));
      const afterLarge = log.createBuffer;
      assert.ok(afterLarge > afterSmall, 'buffer never grew for the larger frame');

      // Re-rendering the large frame, then a smaller one, must not reallocate.
      renderer.render(canvas, tiledFrame(80));
      renderer.render(canvas, tiledFrame(4));
      assert.equal(log.createBuffer, afterLarge, 'buffer was reallocated after growing');

      assert.ok(
        log.bufferSizes[log.bufferSizes.length - 1] >= 80 * 6 * 4 * 4,
        `final buffer ${log.bufferSizes[log.bufferSizes.length - 1]} bytes is too small for 80 tiles`
      );
    });
  });
});
