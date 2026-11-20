import type { PositionedPage } from '../layout/layout.js';
export declare const PREVIEW_DPI = 96;
type PreviewTask = {
    kind: 'preview';
    key: string;
    pageIndex: number;
    dpi: number;
};
export type DetailTask = {
    kind: 'detail';
    key: string;
    pageIndex: number;
    dpi: number;
    tileX: number;
    tileY: number;
    tileWidth: number;
    tileHeight: number;
};
export type RasterTask = PreviewTask | DetailTask;
export interface ViewportBounds {
    top: number;
    width: number;
    height: number;
}
export declare function previewTask(pageIndex: number): PreviewTask;
/** PDFium raster pixels per page layout pixel at the current zoom. */
export declare function detailSourceScale(dpi: number, baseScale: number): number;
export declare function detailTileVisible(tile: Pick<DetailTask, 'tileX' | 'tileY' | 'tileWidth' | 'tileHeight'>, page: PositionedPage, viewport: ViewportBounds, sourceScale: number): boolean;
/** Describes the intersecting tiles of one page, from the visible centre out. */
export declare function visibleDetailTiles(page: PositionedPage, viewport: ViewportBounds, dpi: number, sourceScale: number, rasterWidth: number, rasterHeight: number): DetailTask[];
export {};
