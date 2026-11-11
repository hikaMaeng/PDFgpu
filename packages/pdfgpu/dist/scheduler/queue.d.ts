import type { LayoutMetrics } from '../layout/layout.js';
export interface QueueRenderTask {
    key: string;
    kind: 'preview' | 'detail';
    pageIndex: number;
    dpi: number;
    tileX: number;
    tileY: number;
    tileWidth: number;
    tileHeight: number;
    priority: number;
}
type BuildRenderQueueOptions = {
    layout: LayoutMetrics;
    pageCount: number;
    visiblePages: number[];
    activePage: number | undefined;
    viewportTop: number;
    viewportHeight: number;
    qualityDpi: number;
    sourceScale?: number;
};
/**
 * Native/layout ratio for detail tile coordinates.
 *
 * Layout page dimensions already include `baseScale` (the zoom), while the
 * engine rasters a page at `widthPts * dpi / 72` px, i.e. `BASE_PREVIEW_DPI`
 * layout px at zoom 1 scaled by `dpi / BASE_PREVIEW_DPI`. Tile coordinates
 * live in that native space, so the layout extent must be converted with this
 * ratio. It is the exact inverse of the composite factor the viewer uses to
 * place a finished tile back on the canvas (`baseScale * PREVIEW_DPI / dpi`).
 */
export declare function detailSourceScale(dpi: number, baseScale: number): number;
export declare function buildRenderQueue(options: BuildRenderQueueOptions): QueueRenderTask[];
export {};
