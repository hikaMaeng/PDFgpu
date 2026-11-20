import { previewTask } from './queue.js';
const DETAIL_DELAY = 200;
const PREFETCH_DELAY = 500;
const DIRECTIONS = [1, -1];
const BACKWARD_FIRST = [-1, 1];
const clock = {
    now: () => performance.now(),
    wake(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
    },
};
/** Holds the latest view and one actual in-flight request per slot. */
export class ProgressiveRasterScheduler {
    constructor(host, time = clock) {
        this.host = host;
        this.time = time;
        this.document = 0;
        this.detailAfter = 0;
        this.moved = false;
        this.cursors = { 1: 0, '-1': 0 };
        this.nextDirection = 1;
        this.pumping = false;
        this.running = new Map();
        this.failedPreviews = new Set();
        this.failedDetails = new Set();
        this.previewBytes = new Map();
        this.pump = () => {
            const view = this.view;
            if (this.pumping || !view?.visiblePages.length)
                return;
            this.pumping = true;
            try {
                const slots = this.host.slots();
                const low = slots.filter(({ role }) => role !== 'detail');
                for (const slot of low) {
                    if (!this.available(slot))
                        continue;
                    const task = view.visiblePages.map(previewTask).find((candidate) => this.needs(candidate));
                    if (!task)
                        break;
                    this.start(slot, task);
                }
                const now = this.time.now();
                const prefetchAfter = this.prefetchAfter ?? now;
                if (now >= this.detailAfter)
                    this.advanceDetail(view, slots.filter(({ role }) => role === 'detail' || role === 'shared'));
                if (now >= prefetchAfter)
                    this.advancePrefetch(view, low);
                this.cancelWake?.();
                const nextWake = Math.min(this.detailAfter > now ? this.detailAfter : Infinity, prefetchAfter > now ? prefetchAfter : Infinity);
                this.cancelWake = nextWake < Infinity ? this.time.wake(this.pump, nextWake - now) : undefined;
            }
            finally {
                this.pumping = false;
            }
        };
    }
    invalidate(moved = false) {
        this.view = undefined;
        this.tiles = undefined;
        this.detailSlot = undefined;
        this.failedDetails.clear();
        this.detailAfter = this.time.now() + DETAIL_DELAY;
        if (moved) {
            this.moved = true;
            this.prefetchAfter = this.time.now() + PREFETCH_DELAY;
        }
        this.cancelWake?.();
        this.cancelWake = undefined;
    }
    reset() {
        this.invalidate();
        this.document += 1;
        this.lastPage = undefined;
        this.anchor = undefined;
        this.nextDirection = 1;
        this.prefetchAfter = undefined;
        this.moved = false;
        this.failedPreviews.clear();
        this.previewBytes.clear();
        for (const work of this.running.values())
            work.controller?.abort();
    }
    update(view) {
        if (this.prefetchAfter === undefined || (!this.moved && this.lastPage !== view.activePage)) {
            this.prefetchAfter = this.time.now() + PREFETCH_DELAY;
        }
        this.moved = false;
        this.lastPage = view.activePage;
        this.view = view;
        this.cancelObsoleteRemoteWork(view);
        this.pump();
    }
    previewFailed(pageIndex) {
        return this.failedPreviews.has(pageIndex);
    }
    available(slot) {
        return slot.available && !this.running.has(slot.id);
    }
    needs(task) {
        if (this.host.has(task))
            return false;
        const failed = task.kind === 'preview' ? this.previewFailed(task.pageIndex) : this.failedDetails.has(task.key);
        return !failed && ![...this.running.values()].some((work) => work.document === this.document && work.task.key === task.key);
    }
    advanceDetail(view, slots) {
        const assigned = slots.find(({ id }) => id === this.detailSlot);
        const slot = assigned ?? slots.find((candidate) => this.available(candidate));
        if (!slot || !this.available(slot))
            return;
        const task = this.detailTiles(view).find((tile) => this.needs(tile)
            && (this.previewFailed(tile.pageIndex) || this.host.has(previewTask(tile.pageIndex))));
        if (task && this.start(slot, task))
            this.detailSlot = slot.id;
    }
    detailTiles(view) {
        return this.tiles ?? (this.tiles = view.detailTiles());
    }
    advancePrefetch(view, slots) {
        // Leave available preview capacity for the next frame when a visible
        // preview was unable to start, or is still being produced.
        if (view.visiblePages.some((page) => !this.previewFailed(page) && !this.host.has(previewTask(page))))
            return;
        const anchor = view.activePage;
        if (anchor !== this.anchor) {
            this.anchor = anchor;
            for (const direction of DIRECTIONS)
                this.cursors[direction] = anchor + direction;
        }
        const order = slots.length === 1 && this.nextDirection === -1 ? BACKWARD_FIRST : DIRECTIONS;
        for (const direction of order) {
            const role = direction === 1 ? 'forward' : 'backward';
            const dedicated = slots.find((slot) => slot.role === role);
            const slot = dedicated ?? slots.find((candidate) => this.available(candidate));
            if (!slot || !this.available(slot))
                continue;
            const inside = (page) => page >= 0 && page < view.pageCount && Math.abs(page - anchor) <= this.host.prefetchRadius;
            let page = this.cursors[direction];
            while (inside(page) && (this.previewFailed(page) || this.host.has(previewTask(page))))
                page += direction;
            this.cursors[direction] = page;
            if (!inside(page))
                continue;
            const task = previewTask(page);
            if (this.needs(task) && this.host.canPrefetch(page, anchor, this.previewBytes.get(page)) && this.start(slot, task)) {
                this.nextDirection = direction === 1 ? -1 : 1;
            }
        }
    }
    cancelObsoleteRemoteWork(view) {
        if (!this.host.abortStale)
            return;
        for (const work of this.running.values()) {
            if (work.document !== this.document || !work.controller)
                continue;
            const { task } = work;
            const wanted = task.kind === 'preview' ? view.visiblePages.includes(task.pageIndex)
                : this.detailTiles(view).some(({ key }) => key === task.key);
            if (!wanted)
                work.controller.abort();
        }
    }
    start(slot, task) {
        const document = this.document;
        const controller = this.host.abortStale ? new AbortController() : undefined;
        let result;
        try {
            result = this.host.render(slot.id, task, controller?.signal);
        }
        catch (error) {
            result = Promise.reject(error);
        }
        if (!result)
            return false;
        this.running.set(slot.id, { document, task, controller });
        void result.then((raster) => {
            if (document === this.document && !controller?.signal.aborted && !this.host.has(task)) {
                if (this.accept(task, raster))
                    return;
            }
            if (typeof ImageBitmap !== 'undefined' && raster.source instanceof ImageBitmap)
                raster.source.close();
        }, (error) => {
            if (document !== this.document || controller?.signal.aborted)
                return;
            // A failed worker doesn't make its page invalid. The next pump routes
            // the same key on another live slot.
            if (!this.host.slots().some(({ id }) => id === slot.id))
                return;
            if (task.kind === 'preview')
                this.failedPreviews.add(task.pageIndex);
            else if (this.view && this.detailTiles(this.view).some(({ key }) => key === task.key))
                this.failedDetails.add(task.key);
            this.host.failed(error);
        }).finally(() => {
            this.running.delete(slot.id);
            if (document === this.document)
                this.host.changed(task.pageIndex);
            this.pump();
        });
        return true;
    }
    accept(task, raster) {
        const view = this.view;
        if (task.kind === 'detail') {
            if (!view || !this.detailTiles(view).some(({ key }) => key === task.key))
                return false;
            if (this.host.cache(task, raster))
                return true;
            this.failedDetails.add(task.key);
            return false;
        }
        const anchor = view?.activePage ?? this.lastPage;
        if (view?.visiblePages.includes(task.pageIndex))
            return this.host.cache(task, raster);
        if (anchor === undefined || Math.abs(task.pageIndex - anchor) > this.host.prefetchRadius)
            return false;
        const accepted = this.host.cache(task, raster, anchor);
        if (!accepted)
            this.previewBytes.set(task.pageIndex, raster.width * raster.height * 4);
        return accepted;
    }
}
