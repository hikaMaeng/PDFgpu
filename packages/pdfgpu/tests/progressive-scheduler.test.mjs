import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ProgressiveRasterScheduler } from '../dist/scheduler/progressive.js';
import { previewTask } from '../dist/scheduler/queue.js';

const FLUSH = () => new Promise(setImmediate);
const detailTask = (pageIndex, tileX = 0) => ({
  key: `detail/${pageIndex}/192/${tileX}/0`, kind: 'detail', pageIndex, dpi: 192,
  tileX, tileY: 0, tileWidth: 512, tileHeight: 512,
});

function setup({ radius = Infinity, roles = ['forward', 'backward', 'detail', 'detail'] } = {}) {
  let now = 0;
  let wake;
  const time = {
    now: () => now,
    wake(callback, delay) {
      const scheduled = { callback, at: now + delay };
      wake = scheduled;
      return () => { if (wake === scheduled) wake = undefined; };
    },
  };
  const slots = roles.map((role, id) => ({ role, id, available: true }));
  const requests = [];
  const running = new Map();
  const cache = new Set();
  const limits = { scan: true };
  const scheduler = new ProgressiveRasterScheduler({
    slots: () => slots,
    render(id, task) {
      assert.equal(running.has(id), false, `slot ${id} already occupied`);
      requests.push({ id, task, at: now });
      return new Promise((resolve, reject) => running.set(id, { task, resolve, reject }));
    },
    has: ({ key }) => cache.has(key),
    canPrefetch: () => limits.scan,
    cache: ({ key }) => { cache.add(key); return true; },
    changed() {},
    failed() {},
    prefetchRadius: radius,
  }, time);
  return {
    scheduler, slots, requests, cache, limits,
    advance(ms) {
      const until = now + ms;
      while (wake && wake.at <= until) {
        now = wake.at;
        const { callback } = wake;
        wake = undefined;
        callback();
      }
      now = until;
    },
    view(activePage, pages = [activePage], detail = pages.map((p) => detailTask(p))) {
      scheduler.invalidate(true);
      scheduler.update({ activePage, visiblePages: pages, pageCount: 18, detailTiles: () => detail });
    },
    async finish(id, error) {
      const operation = running.get(id);
      assert.ok(operation, `slot ${id} has nothing to finish`);
      running.delete(id);
      if (error) operation.reject(error);
      else operation.resolve({ source: {}, width: 512, height: 512, dpi: operation.task.dpi, pageIndex: operation.task.pageIndex });
      await FLUSH();
    },
  };
}

function posted(fixture, kind) {
  return fixture.requests.filter(({ task }) => !kind || task.kind === kind)
    .map(({ id, task, at }) => [id, task.pageIndex + 1, at]);
}

it('starts the visible preview immediately, detail at 200ms, and independent neighbors at 500ms', async () => {
  const f = setup();
  f.view(2);
  assert.deepEqual(posted(f), [[0, 3, 0]]);
  await f.finish(0);
  f.advance(199);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.deepEqual(posted(f, 'detail'), [[2, 3, 200]]);
  f.advance(300);
  assert.deepEqual(posted(f, 'preview'), [[0, 3, 0], [0, 4, 500], [1, 2, 500]]);
  await f.finish(0);
  await f.finish(0);
  await f.finish(0);
  assert.deepEqual(posted(f, 'preview').slice(-3), [[0, 5, 500], [0, 6, 500], [0, 7, 500]]);
  await f.finish(1);
  assert.deepEqual(posted(f, 'preview').at(-1), [1, 1, 500]);
});

it('rebases 3→8 after the last movement and skips a retained preview on either side', async () => {
  const f = setup();
  f.view(2);
  await f.finish(0);
  f.advance(500);
  await f.finish(0); // page 4 remains cached, page 5 is being rendered.
  f.view(7);
  assert.deepEqual(posted(f, 'preview').slice(-1), [[0, 5, 500]]);
  await f.finish(1);
  assert.deepEqual(posted(f, 'preview').at(-1), [1, 8, 500]);
  await f.finish(1);
  await f.finish(0);
  f.advance(300);
  f.view(7); // scroll within page 8 also delays the speculative work.
  f.cache.add(previewTask(8).key);
  f.advance(499);
  assert.deepEqual(posted(f, 'preview').at(-1), [1, 8, 500]);
  f.advance(1);
  assert.deepEqual(posted(f, 'preview').slice(-2), [[0, 10, 1300], [1, 7, 1300]]);
  assert.ok(f.cache.has(previewTask(3).key));
});

it('uses the second detail slot on a different view and drops the previous result', async () => {
  const f = setup();
  f.view(2, [2], [detailTask(2), detailTask(2, 512)]);
  await f.finish(0);
  f.advance(200);
  f.view(7);
  await f.finish(0);
  f.advance(200);
  assert.deepEqual(posted(f, 'detail'), [[2, 3, 200], [3, 8, 400]]);
  await f.finish(2);
  assert.equal(f.cache.has(detailTask(2).key), false);
  assert.equal(posted(f, 'detail').length, 2);
  await f.finish(3);
  assert.ok(f.cache.has(detailTask(7).key));
});

it('adopts a late result when the same document and tile are visible again', async () => {
  const f = setup();
  f.view(2);
  await f.finish(0);
  f.advance(200);
  f.view(7);
  await f.finish(0);
  f.view(2);
  await f.finish(2);
  f.advance(200);
  assert.ok(f.cache.has(detailTask(2).key));
  assert.deepEqual(posted(f, 'detail'), [[2, 3, 200]]);
});

it('waits for a real completion when both detail slots are still busy', async () => {
  const f = setup();
  for (const page of [2, 7, 9]) {
    f.view(page);
    await f.finish(0);
    f.advance(200);
  }
  assert.deepEqual(posted(f, 'detail'), [[2, 3, 200], [3, 8, 400]]);
  await f.finish(2);
  assert.deepEqual(posted(f, 'detail').at(-1), [2, 10, 600]);
  await f.finish(3);
  assert.equal(f.cache.has(detailTask(7).key), false);
  await f.finish(2);
  assert.equal(f.cache.has(detailTask(9).key), true);
});

it('refreshes readiness, retries after a worker failure and permits detail after a page preview failure', async () => {
  const f = setup();
  f.slots[1].available = false;
  f.view(2, [2, 3]);
  assert.deepEqual(posted(f), [[0, 3, 0]]);
  f.slots[1].available = true;
  f.scheduler.pump();
  assert.deepEqual(posted(f), [[0, 3, 0], [1, 4, 0]]);
  f.slots.shift();
  await f.finish(0, new Error('worker crashed'));
  assert.equal(f.scheduler.previewFailed(2), false);
  await f.finish(1);
  assert.deepEqual(posted(f).at(-1), [1, 3, 0]);
  await f.finish(1, new Error('cannot render preview'));
  assert.equal(f.scheduler.previewFailed(2), true);
  f.advance(200);
  assert.deepEqual(posted(f, 'detail'), [[2, 3, 200]]);
});

it('keeps physical slot occupancy through a document reset and ignores old rasters', async () => {
  const f = setup({ roles: ['shared'] });
  f.view(2);
  f.scheduler.reset();
  f.view(2);
  assert.equal(f.requests.length, 1);
  await f.finish(0);
  assert.equal(f.cache.has(previewTask(2).key), false);
  assert.deepEqual(posted(f), [[0, 3, 0], [0, 3, 0]]);
  await f.finish(0);
  assert.ok(f.cache.has(previewTask(2).key));
  f.scheduler.reset();
  f.advance(1000);
  assert.equal(f.requests.length, 2);
});

it('limits speculative requests to two pages per direction for a non-worker provider', async () => {
  const f = setup({ radius: 2, roles: ['shared', 'shared', 'shared'] });
  f.view(7, [7, 8]);
  assert.deepEqual(posted(f), [[0, 8, 0], [1, 9, 0]]);
  await f.finish(0);
  await f.finish(1);
  f.advance(200);
  await f.finish(0);
  await f.finish(0);
  f.limits.scan = false;
  f.advance(300);
  assert.equal(posted(f, 'preview').length, 2);
  f.limits.scan = true;
  f.scheduler.pump();
  assert.deepEqual(posted(f, 'preview').slice(-2), [[0, 10, 500], [1, 7, 500]]);
  await f.finish(0);
  await f.finish(1);
  await f.finish(0);
  assert.deepEqual(posted(f, 'preview').map(([, page]) => page), [8, 9, 10, 7, 6]);
});
