export type ViewerMode = 'scroll' | 'single' | 'double';
export interface ViewerInteractionState {
    page: number;
    pageCount: number;
    mode: ViewerMode;
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
}
export declare function createViewerInteractionState(options?: ViewerInteractionOptions): ViewerInteractionState;
export declare function normalizeViewerPage(page: number, pageCount: number, mode: ViewerMode): number;
export declare function viewerPageStep(mode: ViewerMode): number;
export declare function viewerModeParts(mode: ViewerMode): {
    scrollMode: 'continuous' | 'page';
    viewMode: 'single' | 'spread';
};
export declare function viewerModeFromParts(scrollMode: 'continuous' | 'page', viewMode: 'single' | 'spread'): ViewerMode;
export declare function reduceViewerInteraction(previous: ViewerInteractionState, event: ViewerInteractionEvent): ViewerInteractionTransition;
