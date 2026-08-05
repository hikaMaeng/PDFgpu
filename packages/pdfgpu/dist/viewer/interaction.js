const WHEEL_PAGE_THRESHOLD = 30;
export function createViewerInteractionState(options = {}) {
    const pageCount = Math.max(0, Math.floor(options.pageCount ?? 0));
    const mode = options.mode ?? 'scroll';
    return {
        page: normalizeViewerPage(options.page ?? 1, pageCount, mode),
        pageCount,
        mode,
        wheelRemainder: 0,
    };
}
export function normalizeViewerPage(page, pageCount, mode) {
    const count = Math.max(0, Math.floor(pageCount));
    if (count === 0)
        return 1;
    const clamped = Math.max(1, Math.min(count, Math.floor(Number.isFinite(page) ? page : 1)));
    if (mode !== 'double')
        return clamped;
    return clamped % 2 === 0 ? clamped - 1 : clamped;
}
export function viewerPageStep(mode) {
    return mode === 'double' ? 2 : 1;
}
export function viewerModeParts(mode) {
    return mode === 'scroll'
        ? { scrollMode: 'continuous', viewMode: 'single' }
        : { scrollMode: 'page', viewMode: mode === 'double' ? 'spread' : 'single' };
}
export function viewerModeFromParts(scrollMode, viewMode) {
    if (scrollMode === 'continuous')
        return 'scroll';
    return viewMode === 'spread' ? 'double' : 'single';
}
export function reduceViewerInteraction(previous, event) {
    const state = { ...previous };
    const effects = [];
    if (event.type === 'setPageCount') {
        state.pageCount = Math.max(0, Math.floor(event.pageCount));
        state.page = normalizeViewerPage(state.page, state.pageCount, state.mode);
        state.wheelRemainder = 0;
        return { state, effects, preventDefault: false };
    }
    if (event.type === 'setMode') {
        state.mode = event.mode;
        state.page = normalizeViewerPage(state.page, state.pageCount, state.mode);
        state.wheelRemainder = 0;
        return { state, effects, preventDefault: false };
    }
    if (event.type === 'setPage') {
        state.page = normalizeViewerPage(event.page, state.pageCount, state.mode);
        return { state, effects, preventDefault: false };
    }
    if (event.type === 'key') {
        if (event.editableTarget)
            return { state, effects, preventDefault: false };
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
            state.page = normalizeViewerPage(state.page - viewerPageStep(state.mode), state.pageCount, state.mode);
            effects.push({ type: 'navigate', page: state.page });
            return { state, effects, preventDefault: true };
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') {
            state.page = normalizeViewerPage(state.page + viewerPageStep(state.mode), state.pageCount, state.mode);
            effects.push({ type: 'navigate', page: state.page });
            return { state, effects, preventDefault: true };
        }
        return { state, effects, preventDefault: false };
    }
    if (event.ctrlKey) {
        state.wheelRemainder = 0;
        effects.push({ type: 'zoom', direction: event.deltaY < 0 ? 'in' : 'out' });
        return { state, effects, preventDefault: true };
    }
    if (state.mode === 'scroll') {
        state.wheelRemainder = 0;
        return { state, effects, preventDefault: false };
    }
    state.wheelRemainder += event.deltaY;
    const crossed = Math.abs(state.wheelRemainder) >= WHEEL_PAGE_THRESHOLD;
    if (crossed) {
        const direction = state.wheelRemainder > 0 ? 1 : -1;
        state.page = normalizeViewerPage(state.page + direction * viewerPageStep(state.mode), state.pageCount, state.mode);
        state.wheelRemainder = 0;
        effects.push({ type: 'navigate', page: state.page });
    }
    return { state, effects, preventDefault: true };
}
