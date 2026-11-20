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
    const id = log.devices.length + 1;
    const device = {
      id,
      lost: new Promise((resolve) => { resolveLost = resolve; }),
      createTexture: () => {
        log.textures += 1;
        return { createView: () => ({}), destroy: () => { log.textureDestroy += 1; } };
      },
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: (descriptor) => ({ id, buffer: descriptor.entries[0].resource.buffer }),
      createBuffer: ({ usage }) => {
        const isUniform = Boolean(usage & 0x40);
        if (isUniform) log.uniformBuffers.push(id);
        return {
          id,
          isUniform,
          destroy: () => { if (isUniform) log.uniformsDestroyed.push(id); }
        };
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: (slot, group) => {
            if (slot === 1) log.colorBindings.push([id, group.id, group.buffer.id]);
          },
          setVertexBuffer: () => {}, draw: () => {}, end: () => {}
        }),
        finish: () => ({})
      }),
      queue: {
        writeBuffer: (buffer, _offset, data) => {
          if (buffer.isUniform) log.colorWrites.push([id, buffer.id, ...data]);
        },
        copyExternalImageToTexture: () => {},
        submit: () => { log.submit += 1; }
      },
      destroy: () => {
        log.devicesDestroyed.push(id);
        resolveLost({ reason: 'destroyed', message: 'destroyed by page' });
      }
    };
    device.loseUnexpectedly = () => resolveLost({ reason: 'unknown', message: 'gpu process restarted' });
    log.devices.push(device);
    if (id === log.immediatelyLostDevice) device.loseUnexpectedly();
    return device;
  };
  return {
    requestAdapter: async () => {
      log.adapters += 1;
      if (log.adapters === log.missingAdapterAt) return null;
      return {
        requestDevice: async () => {
          await log.beforeRequestDevice?.();
          return makeDevice();
        }
      };
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
  const log = {
    adapters: 0, devices: [], configures: [], textures: 0, textureDestroy: 0, submit: 0, get2d: 0,
    uniformBuffers: [], uniformsDestroyed: [], colorBindings: [], colorWrites: [], devicesDestroyed: []
  };
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
      const backends = [];
      renderer.onBackendChange = (backend) => { backends.push(backend); };

      const adjusted = { ...frame(2), colorAdjustments: { invert: true, brightness: 0.25, contrast: 1.5, saturation: 0 } };
      renderer.render(canvas, adjusted);
      assert.equal(log.textures, 2);
      assert.equal(renderer.gpuTextureCount, 2);

      log.devices[0].loseUnexpectedly();
      await flush(); await flush();

      assert.equal(log.adapters, 2, 'a new adapter was not requested');
      assert.deepEqual(log.configures, [1, 2], 'the canvas was not reconfigured with the new device');
      assert.deepEqual(backends, ['error', 'webgpu']);
      assert.equal(renderer.state, 'webgpu');
      assert.equal(renderer.gpuTextureCount, 0, 'textures of the dead device were kept');
      assert.equal(log.textureDestroy, 0, 'destroy() was called on textures of a lost device');

      renderer.render(canvas, adjusted);
      assert.equal(log.textures, 4, 'textures were not re-uploaded to the new device');
      assert.equal(log.get2d, 0, 'a 2d context was requested from a webgpu canvas');
      assert.deepEqual(log.uniformBuffers, [1, 2]);
      assert.deepEqual(log.colorWrites, [[1, 1, 1, 0.25, 1.5, 0], [2, 2, 1, 0.25, 1.5, 0]]);
      assert.deepEqual(log.colorBindings, [[1, 1, 1], [2, 2, 2]]);
      renderer.dispose();
      assert.deepEqual(log.uniformsDestroyed, [2]);
    });
  });

  it('does not rebuild when the page destroyed the device itself', async () => {
    await withGpu(async (log) => {
      const renderer = new PageRenderer();
      const canvas = boundCanvas(log);
      await renderer.init(canvas);
      const backends = [];
      renderer.onBackendChange = (backend) => { backends.push(backend); };
      renderer.dispose();
      await flush(); await flush();
      assert.equal(log.adapters, 1);
      assert.deepEqual(backends, []);
      assert.deepEqual(log.uniformsDestroyed, [1]);
    });
  });

  it('destroys a replacement device that arrives after dispose', async () => {
    await withGpu(async (log) => {
      const renderer = new PageRenderer();
      const canvas = boundCanvas(log);
      await renderer.init(canvas);
      const backends = [];
      renderer.onBackendChange = (backend) => { backends.push(backend); };
      let finishRequest;
      const pendingDevice = new Promise((resolve) => { finishRequest = resolve; });
      log.beforeRequestDevice = () => pendingDevice;

      log.devices[0].loseUnexpectedly();
      await flush();
      assert.deepEqual(backends, ['error']);
      assert.equal(log.adapters, 2);
      renderer.dispose();
      finishRequest();
      await flush();

      assert.deepEqual(log.devicesDestroyed, [2]);
      assert.deepEqual(log.configures, [1]);
      assert.deepEqual(log.uniformBuffers, [1]);
      assert.deepEqual(backends, ['error']);
    });
  });

  it('reports a failed recovery after reporting the device loss', async () => {
    await withGpu(async (log) => {
      const renderer = new PageRenderer();
      await renderer.init(boundCanvas(log));
      const backends = [];
      renderer.onBackendChange = (backend) => { backends.push(backend); };
      log.beforeRequestDevice = () => { throw new Error('replacement unavailable'); };

      log.devices[0].loseUnexpectedly();
      await flush();
      assert.deepEqual(backends, ['error']);
      assert.equal(renderer.state, 'error');
      assert.equal(renderer.reason, 'replacement unavailable');
      renderer.dispose();
    });
  });

  for (const missingAdapter of [false, true]) {
    it(`does not report an immediately lost replacement as restored (next adapter ${missingAdapter ? 'missing' : 'available'})`, async () => {
      await withGpu(async (log) => {
        const renderer = new PageRenderer();
        await renderer.init(boundCanvas(log));
        const backends = [];
        renderer.onBackendChange = (backend) => { backends.push(backend); };
        log.immediatelyLostDevice = 2;
        if (missingAdapter) log.missingAdapterAt = 3;

        log.devices[0].loseUnexpectedly();
        await flush();

        assert.equal(log.adapters, 3);
        assert.deepEqual(backends, missingAdapter ? ['error', 'error'] : ['error', 'error', 'webgpu']);
        assert.equal(renderer.state, missingAdapter ? 'error' : 'webgpu');
        renderer.dispose();
      });
    });
  }

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
