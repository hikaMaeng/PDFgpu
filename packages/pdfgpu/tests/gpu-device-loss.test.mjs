import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PageRenderer } from '../dist/render/renderer.js';

// External criteria (WebGPU spec, GPUDevice.lost / HTMLCanvasElement):
// - `device.lost` resolves when the device becomes unusable, with reason
//   'destroyed' only when the page called `device.destroy()` itself.
// - Resources of a lost device are gone; recovery means requesting a new
//   adapter + device and reconfiguring the same canvas context.
// - A canvas that returned a 'webgpu' context returns null for '2d', so a
//   2D fallback cannot draw on it.

function createLosableGpu(log) {
  const makeDevice = () => {
    let resolveLost;
    const device = {
      id: log.devices.length + 1,
      lost: new Promise((resolve) => { resolveLost = resolve; }),
      createTexture: () => {
        log.textures += 1;
        return { createView: () => ({}), destroy: () => { log.textureDestroy += 1; } };
      },
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createBuffer: () => ({ destroy: () => {} }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: () => {}, end: () => {}
        }),
        finish: () => ({})
      }),
      queue: { writeBuffer: () => {}, copyExternalImageToTexture: () => {}, submit: () => { log.submit += 1; } },
      destroy: () => { resolveLost({ reason: 'destroyed', message: 'destroyed by page' }); }
    };
    device.loseUnexpectedly = () => resolveLost({ reason: 'unknown', message: 'gpu process restarted' });
    log.devices.push(device);
    return device;
  };
  return {
    requestAdapter: async () => {
      log.adapters += 1;
      return { requestDevice: async () => makeDevice() };
    },
    getPreferredCanvasFormat: () => 'bgra8unorm'
  };
}

function boundCanvas(log) {
  return {
    width: 0,
    height: 0,
    getContext: (kind) => {
      if (kind === 'webgpu') {
        return { configure: (cfg) => { log.configures.push(cfg.device.id); }, getCurrentTexture: () => ({ createView: () => ({}) }) };
      }
      log.get2d += 1;
      return null; // a webgpu-bound canvas never yields a 2d context
    }
  };
}

async function withGpu(run) {
  const log = { adapters: 0, devices: [], configures: [], textures: 0, textureDestroy: 0, submit: 0, get2d: 0 };
  const previous = globalThis.navigator;
  const info = console.info; const warn = console.warn; const error = console.error;
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: createLosableGpu(log) }, configurable: true, writable: true });
  console.info = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    return await run(log);
  } finally {
    console.info = info; console.warn = warn; console.error = error;
    if (previous === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true, writable: true });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = (n) => ({
  width: 1024,
  height: 512,
  tiles: Array.from({ length: n }, (_, i) => ({ source: { id: i }, left: i * 512, top: 0, width: 512, height: 512 }))
});

describe('webgpu device loss', () => {
  it('rebuilds on the same canvas and re-uploads textures after an unexpected loss', async () => {
    await withGpu(async (log) => {
      const renderer = new PageRenderer();
      const canvas = boundCanvas(log);
      assert.equal(await renderer.init(canvas), 'webgpu');
      let restored = 0;
      renderer.onDeviceRestored = () => { restored += 1; };

      renderer.render(canvas, frame(2));
      assert.equal(log.textures, 2);
      assert.equal(renderer.gpuTextureCount, 2);

      log.devices[0].loseUnexpectedly();
      await flush(); await flush();

      assert.equal(log.adapters, 2, 'a new adapter was not requested');
      assert.deepEqual(log.configures, [1, 2], 'the canvas was not reconfigured with the new device');
      assert.equal(restored, 1, 'the viewer was not asked to repaint');
      assert.equal(renderer.state, 'webgpu');
      assert.equal(renderer.gpuTextureCount, 0, 'textures of the dead device were kept');
      assert.equal(log.textureDestroy, 0, 'destroy() was called on textures of a lost device');

      renderer.render(canvas, frame(2));
      assert.equal(log.textures, 4, 'textures were not re-uploaded to the new device');
      assert.equal(log.get2d, 0, 'a 2d context was requested from a webgpu canvas');
    });
  });

  it('does not rebuild when the page destroyed the device itself', async () => {
    await withGpu(async (log) => {
      const renderer = new PageRenderer();
      const canvas = boundCanvas(log);
      await renderer.init(canvas);
      let restored = 0;
      renderer.onDeviceRestored = () => { restored += 1; };
      renderer.dispose();
      await flush(); await flush();
      assert.equal(log.adapters, 1);
      assert.equal(restored, 0);
    });
  });

  it('skips the frame instead of throwing when a webgpu canvas has no usable device', async () => {
    await withGpu(async (log) => {
      const renderer = new PageRenderer();
      const canvas = boundCanvas(log);
      await renderer.init(canvas);
      // Make the render pass throw, as a real validation/OOM error would.
      log.devices[0].createCommandEncoder = () => { throw new Error('encoder failed'); };
      assert.doesNotThrow(() => renderer.render(canvas, frame(1)));
      assert.equal(renderer.state, 'error');
      assert.doesNotThrow(() => renderer.render(canvas, frame(1)), 'second frame threw (old 2d fallback path)');
      assert.equal(log.get2d, 0, 'a 2d context was requested from a webgpu canvas');
    });
  });
});
