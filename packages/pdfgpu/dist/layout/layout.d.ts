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
/** Every page in the overscan window (used to keep page shells laid out ahead of scrolling). */
export declare function windowPageIndices(positions: PositionedPage[], window: ViewportWindow): number[];
/**
 * Pages that actually intersect the viewport `[scrollTop, scrollTop + viewportHeight)`.
 *
 * Only these get detail tiles and are composited ("화면에 보이는 페이지만 고해상도
 * detail tile로 보강", README). The previous filter `top + height >= 0` is always true
 * in document coordinates, so every page of the overscan window (two viewports above
 * and below) counted as visible and received full-page detail tiles.
 */
export declare function visiblePageIndices(positions: PositionedPage[], window: ViewportWindow, scrollTop: number, viewportHeight: number): number[];
