export type ViewerMode = 'scroll' | 'single' | 'double';
/** Spread row formation; see `spreadRows` in layout.ts. */
export type ViewerSpreadPairing = 'alone' | 'paired';

export interface ViewerInteractionState {
  page: number;
  pageCount: number;
  mode: ViewerMode;
  /** Spread rows used by 'double': 'alone' = (1),(2,3),... ; 'paired' = (1,2),(3,4),... */
  pairing: ViewerSpreadPairing;
  wheelRemainder: number;
}

export type ViewerInteractionEvent =
  | { type: 'setPage'; page: number }
  | { type: 'setPageCount'; pageCount: number }
  | { type: 'setMode'; mode: ViewerMode }
  | { type: 'setPairing'; pairing: ViewerSpreadPairing }
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
  pairing?: ViewerSpreadPairing;
}

const WHEEL_PAGE_THRESHOLD = 30;

export function createViewerInteractionState(options: ViewerInteractionOptions = {}): ViewerInteractionState {
  const pageCount = Math.max(0, Math.floor(options.pageCount ?? 0));
  const mode = options.mode ?? 'scroll';
  const pairing = options.pairing ?? 'alone';
  return {
    page: normalizeViewerPage(options.page ?? 1, pageCount, mode, pairing),
    pageCount,
    mode,
    pairing,
    wheelRemainder: 0,
  };
}

/**
 * Clamps `page` (1-based) to the document and, in 'double' mode, moves it to
 * the first page of the spread row that contains it. Rows match `buildLayout`:
 * 'alone' = (1), (2,3), (4,5), ... ; 'paired' = (1,2), (3,4), ... .
 * Keyboard and wheel paging step by 2 and normalize, which lands on the first
 * page of the next row in both pairings (alone: 1 -> 2 -> 4; paired: 1 -> 3 -> 5),
 * including a short last row.
 */
export function normalizeViewerPage(
  page: number,
  pageCount: number,
  mode: ViewerMode,
  pairing: ViewerSpreadPairing = 'alone',
): number {
  const count = Math.max(0, Math.floor(pageCount));
  if (count === 0) return 1;
  const clamped = Math.max(1, Math.min(count, Math.floor(Number.isFinite(page) ? page : 1)));
  if (mode !== 'double') return clamped;
  if (pairing === 'paired') return clamped % 2 === 1 ? clamped : clamped - 1;
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
    state.page = normalizeViewerPage(state.page, state.pageCount, state.mode, state.pairing);
    state.wheelRemainder = 0;
    return { state, effects, preventDefault: false };
  }

  if (event.type === 'setMode') {
    state.mode = event.mode;
    state.page = normalizeViewerPage(state.page, state.pageCount, state.mode, state.pairing);
    state.wheelRemainder = 0;
    return { state, effects, preventDefault: false };
  }

  if (event.type === 'setPairing') {
    // Land on the first page of the new row that holds the current page:
    // alone (2,3) -> paired (1,2); paired (3,4) -> alone (2,3).
    state.pairing = event.pairing;
    state.page = normalizeViewerPage(state.page, state.pageCount, state.mode, state.pairing);
    state.wheelRemainder = 0;
    return { state, effects, preventDefault: false };
  }

  if (event.type === 'setPage') {
    state.page = normalizeViewerPage(event.page, state.pageCount, state.mode, state.pairing);
    return { state, effects, preventDefault: false };
  }

  if (event.type === 'key') {
    if (event.editableTarget) return { state, effects, preventDefault: false };
    // Continuous scroll keeps native keyboard scrolling (architecture.md: "scroll은
    // native scroll을 유지"); only page modes turn keys into page navigation.
    if (state.mode === 'scroll') return { state, effects, preventDefault: false };
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
      state.page = normalizeViewerPage(state.page - viewerPageStep(state.mode), state.pageCount, state.mode, state.pairing);
      effects.push({ type: 'navigate', page: state.page });
      return { state, effects, preventDefault: true };
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') {
      state.page = normalizeViewerPage(state.page + viewerPageStep(state.mode), state.pageCount, state.mode, state.pairing);
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
    state.page = normalizeViewerPage(state.page + direction * viewerPageStep(state.mode), state.pageCount, state.mode, state.pairing);
    state.wheelRemainder = 0;
    effects.push({ type: 'navigate', page: state.page });
  }
  return { state, effects, preventDefault: true };
}
