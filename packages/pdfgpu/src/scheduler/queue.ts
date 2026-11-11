import type { LayoutMetrics, PositionedPage } from '../layout/layout.js';

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

const PREVIEW_DPI = 96;
const PRIORITY_PREVIEW_ACTIVE = 0;
const PRIORITY_PREVIEW_VISIBLE = 100;
const PRIORITY_PREVIEW_NEIGHBOR = 200;
const PRIORITY_DETAIL_ACTIVE = 1000;
const PRIORITY_DETAIL_VISIBLE_OTHER = 2000;
const TILE_SIZE = 512;
const PREFETCH_RADIUS = 2;

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
export function detailSourceScale(dpi: number, baseScale: number): number {
  const safeScale = baseScale > 0 ? baseScale : 1;
  return (dpi / PREVIEW_DPI) / safeScale;
}

function makePreviewTask(pageIndex: number, priority: number): QueueRenderTask {
  return {
    key: `preview/${pageIndex}/${Math.round(PREVIEW_DPI)}/0/0`,
    kind: 'preview',
    pageIndex,
    dpi: PREVIEW_DPI,
    tileX: 0,
    tileY: 0,
    tileWidth: 0,
    tileHeight: 0,
    priority
  };
}

function toPagePosition(positions: PositionedPage[], pageIndex: number) {
  return positions[pageIndex];
}

function chooseActiveCandidate(visiblePages: number[]) {
  if (!visiblePages.length) return undefined;
  return visiblePages[Math.floor(visiblePages.length / 2)];
}

function buildDetailTasksForPage(
  page: PositionedPage,
  pageIndex: number,
  viewportTop: number,
  viewportHeight: number,
  dpi: number,
  sourceScale = 1
): QueueRenderTask[] {
  const sourceWidth = Math.max(1, page.width * sourceScale);
  const sourceHeight = Math.max(1, page.height * sourceScale);
  const rows = Math.max(1, Math.ceil(sourceHeight / TILE_SIZE));
  const columns = Math.max(1, Math.ceil(sourceWidth / TILE_SIZE));
  const viewportCenter = viewportTop + viewportHeight / 2;
  const localViewportCenterY = viewportCenter - page.top;
  const items: Array<{
    tileX: number;
    tileY: number;
    sortKey: number;
  }> = [];

  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      const left = tileX * TILE_SIZE;
      const top = tileY * TILE_SIZE;
      const cx = (left + TILE_SIZE / 2) / sourceScale;
      const cy = (top + TILE_SIZE / 2) / sourceScale;
      const distance = Math.hypot(cx - page.width / 2, cy - localViewportCenterY);
      items.push({
        tileX: left,
        tileY: top,
        sortKey: distance
      });
    }
  }

  return items
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((item, index) => ({
      key: `detail/${pageIndex}/${Math.round(dpi)}/${item.tileX}/${item.tileY}`,
      kind: 'detail' as const,
      pageIndex,
      dpi: Math.round(dpi),
      tileX: item.tileX,
      tileY: item.tileY,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      priority: PRIORITY_DETAIL_ACTIVE + index
    }));
}

export function buildRenderQueue(options: BuildRenderQueueOptions): QueueRenderTask[] {
  const { layout, pageCount, visiblePages, activePage, viewportTop, viewportHeight, qualityDpi } = options;
  const sourceScale = options.sourceScale ?? 1;
  const visibleSet = new Set(visiblePages);
  const tasks: QueueRenderTask[] = [];

  const focusPage = activePage ?? chooseActiveCandidate(visiblePages);
  if (focusPage !== undefined && visibleSet.has(focusPage)) {
    tasks.push(makePreviewTask(focusPage, PRIORITY_PREVIEW_ACTIVE));
  } else if (visiblePages[0] !== undefined) {
    tasks.push(makePreviewTask(visiblePages[0], PRIORITY_PREVIEW_ACTIVE));
  }

  for (const pageIndex of visiblePages) {
    if (pageIndex === focusPage) continue;
    tasks.push(makePreviewTask(pageIndex, PRIORITY_PREVIEW_VISIBLE + Math.abs(pageIndex - (focusPage ?? pageIndex))));
  }

  const neighborPages: number[] = [];
  if (focusPage !== undefined) {
    for (let distance = 1; distance <= PREFETCH_RADIUS; distance += 1) {
      neighborPages.push(focusPage + distance, focusPage - distance);
    }
  }
  for (const pageIndex of neighborPages) {
    if (pageIndex < 0 || pageIndex >= pageCount || visibleSet.has(pageIndex)) continue;
    tasks.push(makePreviewTask(pageIndex, PRIORITY_PREVIEW_NEIGHBOR + Math.abs(pageIndex - (focusPage ?? pageIndex))));
  }

  if (focusPage !== undefined && visibleSet.has(focusPage)) {
    const position = toPagePosition(layout.pagePositions, focusPage);
    if (position) {
      const detail = buildDetailTasksForPage(position, focusPage, viewportTop, viewportHeight, qualityDpi, sourceScale);
      for (const item of detail) {
        tasks.push(item);
      }
    }
  }

  for (const pageIndex of visiblePages) {
    if (pageIndex === focusPage) continue;
    const page = toPagePosition(layout.pagePositions, pageIndex);
    if (page) {
      const detail = buildDetailTasksForPage(page, pageIndex, viewportTop, viewportHeight, qualityDpi, sourceScale);
      for (let i = 0; i < detail.length; i += 1) {
        const item = detail[i];
        tasks.push({
          ...item,
          priority: PRIORITY_DETAIL_VISIBLE_OTHER + Math.abs(pageIndex - (focusPage ?? pageIndex)) * 100 + i
        });
      }
    }
  }

  const seen = new Set<string>();
  const deduped: QueueRenderTask[] = [];
  for (const task of tasks) {
    if (seen.has(task.key)) continue;
    seen.add(task.key);
    deduped.push(task);
  }

  return deduped.sort((a, b) => a.priority - b.priority);
}
