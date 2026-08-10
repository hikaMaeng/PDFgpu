import type { LayoutMetrics, PositionedPage } from '../layout/layout.js';
import type { PdfGpuAbsoluteRect, PdfGpuOverlayItem, PdfGpuOverlayProjection } from '../types.js';
export type PdfPageRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type ViewportPoint = {
    x: number;
    y: number;
};
export type PdfPageAbsoluteSize = {
    width: number;
    height: number;
};
export declare function viewportToPageRect(page: PositionedPage, start: ViewportPoint, end: ViewportPoint, scrollTop: number): PdfPageRect;
export declare function pageRectToViewportRect(page: PositionedPage, rect: PdfPageRect, scrollTop: number): {
    left: number;
    top: number;
    width: number;
    height: number;
};
export declare function findPageAtViewportPoint(layout: LayoutMetrics, point: ViewportPoint, scrollTop: number): PositionedPage | undefined;
export declare function projectOverlaysForVisiblePages(layout: LayoutMetrics, overlays: PdfGpuOverlayItem[], visiblePages: readonly number[], scrollTop: number, pageSizes: readonly PdfPageAbsoluteSize[]): PdfGpuOverlayProjection[];
export declare function screenRectToAbsoluteRect(page: PositionedPage, start: ViewportPoint, end: ViewportPoint, scrollTop: number, pageWidth: number, pageHeight: number): PdfGpuAbsoluteRect;
