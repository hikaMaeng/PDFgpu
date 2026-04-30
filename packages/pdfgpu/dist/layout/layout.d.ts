export interface PageLayoutInfo {
    baseWidth: number;
    baseHeight: number;
}
export interface PositionedPage {
    index: number;
    left: number;
    top: number;
    height: number;
    width: number;
    rowIndex: number;
}
export interface LayoutMetrics {
    pagePositions: PositionedPage[];
    totalHeight: number;
    totalWidth: number;
}
export interface ViewportWindow {
    from: number;
    to: number;
}
export type ViewMode = 'single' | 'spread';
export type SpreadPlacement = 'first-left' | 'first-right';
export interface BuildLayoutOptions {
    viewMode?: ViewMode;
    spreadPlacement?: SpreadPlacement;
    viewportWidth?: number;
    spreadGap?: number;
}
export declare function buildLayout(pageCount: number, pageSizes: Map<number, PageLayoutInfo>, zoom: number, pageGap: number, options?: BuildLayoutOptions): LayoutMetrics;
export declare function resolveViewportWindow(positions: PositionedPage[], viewportHeight: number, scrollTop: number, overscanPages: number): ViewportWindow;
export declare function visiblePageIndices(positions: PositionedPage[], window: ViewportWindow): number[];
