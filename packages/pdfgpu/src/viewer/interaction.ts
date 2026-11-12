export type ViewerMode = 'scroll' | 'single' | 'double';

export interface ViewerInteractionState {
  page: number;
  pageCount: number;
  mode: ViewerMode;
  wheelRemainder: number;
}

export type ViewerInteractionEvent =
  | { type: 'setPage'; page: number }
  | { type: 'setPageCount'; pageCount: number }
  | { type: 'setMode'; mode: ViewerMode }
  | { type: 'key'; key: string; editableTarget?: boolean }
  | { type: 'wheel'; deltaY: number; ctrlKey?: boolean };

export type ViewerInteractionEffect =
  | { type: 'navigate'; page: number }
  | { type: 'zoom'; direction: 'in' | 'out' };

export interface ViewerInteractionTransition {
  state: ViewerInteractionState;
  effects: ViewerInteractionEffect[];
  preventDefault: boolean;
}

export interface ViewerInteractionOptions {
  page?: number;
  pageCount?: number;
  mode?: ViewerMode;
}

const WHEEL_PAGE_THRESHOLD = 30;

export function createViewerInteractionState(options: ViewerInteractionOptions = {}): ViewerInteractionState {
  const pageCount = Math.max(0, Math.floor(options.pageCount ?? 0));
  const mode = options.mode ?? 'scroll';
  return {
    page: normalizeViewerPage(options.page ?? 1, pageCount, mode),
    pageCount,
    mode,
    wheelRemainder: 0,
  };
}

export function normalizeViewerPage(page: number, pageCount: number, mode: ViewerMode): number {
  const count = Math.max(0, Math.floor(pageCount));
  if (count === 0) return 1;
  const clamped = Math.max(1, Math.min(count, Math.floor(Number.isFinite(page) ? page : 1)));
  if (mode !== 'double') return clamped;
  // Spread rows from `buildLayout`: page 1 alone, then (2,3), (4,5), ... in both
  // placements. A page normalizes to the first page of its row. The old rule
  // (odd pages lead) paired (2,3) as (1) + (3,4): page 3 landed on the right half
  // of its row and page 2 jumped back to page 1.
  if (clamped <= 1) return 1;
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

export function viewerPageStep(mode: ViewerMode): number {
  return mode === 'double' ? 2 : 1;
}

export function viewerModeParts(mode: ViewerMode): {
  scrollMode: 'continuous' | 'page';
  viewMode: 'single' | 'spread';
} {
  return mode === 'scroll'
    ? { scrollMode: 'continuous', viewMode: 'single' }
    : { scrollMode: 'page', viewMode: mode === 'double' ? 'spread' : 'single' };
}

export function viewerModeFromParts(
  scrollMode: 'continuous' | 'page',
  viewMode: 'single' | 'spread',
): ViewerMode {
  if (scrollMode === 'continuous') return 'scroll';
  return viewMode === 'spread' ? 'double' : 'single';
}

export function reduceViewerInteraction(
  previous: ViewerInteractionState,
  event: ViewerInteractionEvent,
): ViewerInteractionTransition {
  const state = { ...previous };
  const effects: ViewerInteractionEffect[] = [];

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
    if (event.editableTarget) return { state, effects, preventDefault: false };
    // Continuous scroll keeps native keyboard scrolling (architecture.md: "scroll은
    // native scroll을 유지"); only page modes turn keys into page navigation.
    if (state.mode === 'scroll') return { state, effects, preventDefault: false };
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
