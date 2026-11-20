import type { PositionedPage } from '../layout/layout.js';
import { cacheKey } from './byteBudgetCache.js';

export const PREVIEW_DPI = 96;
const TILE_SIZE = 512;

type PreviewTask = { kind: 'preview'; key: string; pageIndex: number; dpi: number };
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

export function previewTask(pageIndex: number): PreviewTask {
  return { kind: 'preview', pageIndex, dpi: PREVIEW_DPI, key: cacheKey({
    kind: 'preview', pageIndex, dpiBucket: PREVIEW_DPI, tileX: 0, tileY: 0,
  }) };
}

/** PDFium raster pixels per page layout pixel at the current zoom. */
export function detailSourceScale(dpi: number, baseScale: number): number {
  return (dpi / PREVIEW_DPI) / (baseScale > 0 ? baseScale : 1);
}

export function detailTileVisible(
  tile: Pick<DetailTask, 'tileX' | 'tileY' | 'tileWidth' | 'tileHeight'>,
  page: PositionedPage,
  viewport: ViewportBounds,
  sourceScale: number,
): boolean {
  const left = page.left + tile.tileX / sourceScale;
  const top = page.top + tile.tileY / sourceScale;
  return left < viewport.width && left + tile.tileWidth / sourceScale > 0
    && top < viewport.top + viewport.height && top + tile.tileHeight / sourceScale > viewport.top;
}

/** Describes the intersecting tiles of one page, from the visible centre out. */
export function visibleDetailTiles(
  page: PositionedPage,
  viewport: ViewportBounds,
  dpi: number,
  sourceScale: number,
  rasterWidth: number,
  rasterHeight: number,
): DetailTask[] {
  const left = Math.max(0, -page.left) * sourceScale;
  const top = Math.max(0, viewport.top - page.top) * sourceScale;
  const right = Math.min(rasterWidth, Math.min(page.width, viewport.width - page.left) * sourceScale);
  const bottom = Math.min(rasterHeight, Math.min(page.height, viewport.top + viewport.height - page.top) * sourceScale);
  if (left >= right || top >= bottom) return [];

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const pageIndex = page.index;
  const tiles: Array<{ task: DetailTask; distance: number }> = [];
  for (let tileY = Math.floor(top / TILE_SIZE) * TILE_SIZE; tileY < bottom; tileY += TILE_SIZE) {
    for (let tileX = Math.floor(left / TILE_SIZE) * TILE_SIZE; tileX < right; tileX += TILE_SIZE) {
      const tileWidth = Math.min(TILE_SIZE, rasterWidth - tileX);
      const tileHeight = Math.min(TILE_SIZE, rasterHeight - tileY);
      tiles.push({
        task: {
          kind: 'detail', pageIndex, dpi, tileX, tileY, tileWidth, tileHeight,
          key: cacheKey({ kind: 'detail', pageIndex, dpiBucket: dpi, tileX, tileY }),
        },
        distance: Math.hypot(tileX + tileWidth / 2 - centerX, tileY + tileHeight / 2 - centerY),
      });
    }
  }
  return tiles.sort((a, b) => a.distance - b.distance).map(({ task }) => task);
}
