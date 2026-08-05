const TILE_DPI_MIN = 144;
const TILE_DPI_MAX = 384;
const TILE_DPI_STEP = 48;
export function normalizeDetailDpi(rawDpi) {
    return Math.max(TILE_DPI_MIN, Math.min(TILE_DPI_MAX, Math.round(rawDpi / TILE_DPI_STEP) * TILE_DPI_STEP));
}
