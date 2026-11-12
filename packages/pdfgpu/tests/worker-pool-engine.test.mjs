import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkerPoolPdfEngine } from '../dist/engine/workerPoolEngine.js';
import { createPdfDocumentEngine } from '../dist/engine/pdfiumEngine.js';

// External criteria (HTML Web Workers + structured clone semantics), not the
// pool's own code:
// - Each dedicated worker runs independently; N workers can work at once.
// - postMessage answers arrive asynchronously, in any order across workers.
// - A transferred ArrayBuffer is detached in the sender, so every worker
//   needs its own copy of the document bytes.
// - A worker that errors stops answering.
// The fake below behaves that way and records what the pool asked of it.

const MANIFEST = { pageCount: 3, pages: [0, 1, 2].map((index) => ({ index, widthPts: 612, heightPts: 792, rotation: 0 })) };

function createFakeWorkers({ renderMs = 20, openDelayMs = [] } = {}) {
  const shared = { running: 0, maxRunning: 0, closed: 0, workers: [] };
  const factory = () => {
    const listeners = { message: [], error: [] };
    const worker = {
      index: shared.workers.length,
      received: [],
      terminated: false,
      queue: Promise.resolve(),
      cancelled: new Set(),
      started: new Set(),
      addEventListener(type, fn) { listeners[type].push(fn); },
      emit(type, data) { for (const fn of listeners[type]) fn(type === 'message' ? { data } : data); },
      terminate() { worker.terminated = true; },
      crash(message) { worker.emit('error', { message }); },
      postMessage(message) {
        worker.received.push(message);
        if (message.type === 'cancel') {
          if (!worker.started.has(message.target)) worker.cancelled.add(message.target);
          return;
        }
        // Serial within one worker, like the real entry's promise chain.
        worker.queue = worker.queue.then(async () => {
          if (worker.terminated) return;
          if (worker.cancelled.delete(message.id)) {
            worker.emit('message', { id: message.id, ok: false, error: 'render aborted', name: 'AbortError' });
            return;
          }
          worker.started.add(message.id);
          if (message.type === 'init' || message.type === 'close') {
            worker.emit('message', { id: message.id, ok: true });
            return;
          }
          if (message.type === 'open') {
            const delay = openDelayMs[worker.index] ?? 0;
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            worker.emit('message', { id: message.id, ok: true, manifest: message.manifest ?? MANIFEST });
            return;
          }
          shared.running += 1;
          shared.maxRunning = Math.max(shared.maxRunning, shared.running);
          await new Promise((resolve) => setTimeout(resolve, renderMs));
          shared.running -= 1;
          if (worker.terminated) return;
          const source = { worker: worker.index, close() { shared.closed += 1; } };
          worker.emit('message', {
            id: message.id,
            ok: true,
            raster: { source, width: 512, height: 512, dpi: message.dpi ?? 96, pageIndex: message.pageIndex, kind: message.type === 'tile' ? 'detail' : 'preview' }
          });
        });
      }
    };
    shared.workers.push(worker);
    return worker;
  };
  return { factory, shared };
}

const loadBytes = async (source) => source;
const tile = (pageIndex, signal) => ({ pageIndex, dpi: 192, tileX: 0, tileY: 0, tileWidth: 512, tileHeight: 512, signal });

async function openPool(size, fakeOptions) {
  const { factory, shared } = createFakeWorkers(fakeOptions);
  const engine = await WorkerPoolPdfEngine.create({ createWorker: factory, size, loadBytes });
  await engine.open(new Uint8Array([37, 80, 68, 70, 1, 2, 3, 4]));
  return { engine, shared };
}

describe('pdfium worker pool', () => {
  it('starts one worker per slot and reports that as its queue depth', async () => {
    const { factory, shared } = createFakeWorkers();
    const engine = await WorkerPoolPdfEngine.create({ createWorker: factory, size: 4, loadBytes });
    assert.equal(engine.queueDepth, 4);
    assert.equal(shared.workers.length, 4);
    assert.ok(shared.workers.every((w) => w.received[0].type === 'init'));
  });

  it('gives every worker its own copy of the bytes, and the manifest of the first', async () => {
    const { shared } = await openPool(3);
    const opens = shared.workers.map((w) => w.received.find((m) => m.type === 'open'));
    assert.ok(opens.every((m) => m.bytes.byteLength === 8));
    assert.equal(new Set(opens.map((m) => m.bytes)).size, 3, 'workers share one ArrayBuffer');
    assert.equal(opens[0].manifest, undefined, 'first worker should extract the manifest');
    assert.deepEqual(opens[1].manifest, MANIFEST);
    assert.deepEqual(opens[2].manifest, MANIFEST);
  });

  it('renders on all workers at the same time and spreads work evenly', async () => {
    const { engine, shared } = await openPool(4, { renderMs: 30 });
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => engine.renderTile(tile(i % 3))));
    const elapsed = Date.now() - started;
    assert.equal(shared.maxRunning, 4, `only ${shared.maxRunning} renders ran at once`);
    const perWorker = [0, 0, 0, 0];
    for (const r of results) perWorker[r.source.worker] += 1;
    assert.deepEqual(perWorker, [2, 2, 2, 2]);
    // 8 renders x 30ms on 4 workers ~ 60ms; serial would be ~240ms.
    assert.ok(elapsed < 200, `took ${elapsed}ms, looks serial`);
  });

  it('returns from open as soon as one worker is ready and adds the rest later', async () => {
    const { factory, shared } = createFakeWorkers({ renderMs: 5, openDelayMs: [0, 80, 80] });
    const engine = await WorkerPoolPdfEngine.create({ createWorker: factory, size: 3, loadBytes });
    const started = Date.now();
    await engine.open(new Uint8Array([1, 2, 3]));
    assert.ok(Date.now() - started < 60, 'open waited for the slow workers');
    assert.equal(engine.readyWorkers, 1);
    // Workers still opening must not be asked to render.
    const early = await Promise.all([0, 1, 2].map((i) => engine.renderTile(tile(i))));
    assert.deepEqual(early.map((r) => r.source.worker), [0, 0, 0]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(engine.readyWorkers, 3);
    const late = await Promise.all([0, 1, 2].map((i) => engine.renderTile(tile(i))));
    assert.deepEqual(late.map((r) => r.source.worker).sort(), [0, 1, 2]);
    assert.equal(shared.workers.length, 3);
  });

  it('cancels a queued render in the worker and rejects with AbortError', async () => {
    const { engine, shared } = await openPool(1, { renderMs: 30 });
    const first = engine.renderTile(tile(0));
    const controller = new AbortController();
    const second = engine.renderTile(tile(1, controller.signal));
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const worker = shared.workers[0];
    const target = worker.received.find((m) => m.type === 'tile' && m.pageIndex === 1).id;
    assert.ok(worker.received.some((m) => m.type === 'cancel' && m.target === target), 'cancel was not sent');
    assert.equal(worker.started.has(target), false, 'the cancelled render still ran');
  });

  it('closes the bitmap of a render that finished after its caller aborted', async () => {
    const { engine, shared } = await openPool(1, { renderMs: 30 });
    const controller = new AbortController();
    const pending = engine.renderTile(tile(0, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 10)); // now running
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(shared.closed, 1, 'late raster was not closed');
  });

  it('fails a crashed worker\'s requests and keeps serving on the others', async () => {
    const { engine, shared } = await openPool(2, { renderMs: 40 });
    const a = engine.renderTile(tile(0));
    const b = engine.renderTile(tile(1));
    shared.workers[0].crash('wasm trap');
    const outcomes = await Promise.allSettled([a, b]);
    assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 1);
    assert.match(String(outcomes.find((o) => o.status === 'rejected').reason.message), /wasm trap/);
    assert.equal(engine.liveWorkers, 1);
    const next = await engine.renderTile(tile(2));
    assert.equal(next.source.worker, 1);
  });

  it('terminates every worker on dispose and rejects what was in flight', async () => {
    const { engine, shared } = await openPool(2, { renderMs: 50 });
    const inflight = engine.renderTile(tile(0));
    await engine.dispose();
    await assert.rejects(inflight, { name: 'AbortError' });
    assert.ok(shared.workers.every((w) => w.terminated));
  });

  it('falls back to the main-thread engine when workers cannot start', async () => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
      // Node has no PDFium browser environment, so the fallback itself then
      // fails with its own error; what matters is that it was attempted.
      await assert.rejects(
        createPdfDocumentEngine({ createWorker: () => { throw new Error('blocked by CSP'); } }),
        /browser-only/
      );
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some((w) => w.includes('rendering on the main thread')), JSON.stringify(warnings));
  });
});
