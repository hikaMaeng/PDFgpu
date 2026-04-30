import type { LayoutMetrics } from '../layout/layout';
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
export declare function buildRenderQueue(options: BuildRenderQueueOptions): QueueRenderTask[];
export {};
