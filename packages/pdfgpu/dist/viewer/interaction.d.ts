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
export type ViewerInteractionEvent = {
    type: 'setPage';
    page: number;
} | {
    type: 'setPageCount';
    pageCount: number;
} | {
    type: 'setMode';
    mode: ViewerMode;
} | {
    type: 'setPairing';
    pairing: ViewerSpreadPairing;
} | {
    type: 'key';
    key: string;
    editableTarget?: boolean;
} | {
    type: 'wheel';
    deltaY: number;
    ctrlKey?: boolean;
};
export type ViewerInteractionEffect = {
    type: 'navigate';
    page: number;
} | {
    type: 'zoom';
    direction: 'in' | 'out';
};
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
export declare function createViewerInteractionState(options?: ViewerInteractionOptions): ViewerInteractionState;
/**
 * Clamps `page` (1-based) to the document and, in 'double' mode, moves it to
 * the first page of the spread row that contains it. Rows match `buildLayout`:
 * 'alone' = (1), (2,3), (4,5), ... ; 'paired' = (1,2), (3,4), ... .
 * Keyboard and wheel paging step by 2 and normalize, which lands on the first
 * page of the next row in both pairings (alone: 1 -> 2 -> 4; paired: 1 -> 3 -> 5),
 * including a short last row.
 */
export declare function normalizeViewerPage(page: number, pageCount: number, mode: ViewerMode, pairing?: ViewerSpreadPairing): number;
export declare function viewerPageStep(mode: ViewerMode): number;
export declare function viewerModeParts(mode: ViewerMode): {
    scrollMode: 'continuous' | 'page';
    viewMode: 'single' | 'spread';
};
export declare function viewerModeFromParts(scrollMode: 'continuous' | 'page', viewMode: 'single' | 'spread'): ViewerMode;
export declare function reduceViewerInteraction(previous: ViewerInteractionState, event: ViewerInteractionEvent): ViewerInteractionTransition;
