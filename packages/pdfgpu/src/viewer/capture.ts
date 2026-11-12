/**
 * Source rectangle, in the raster's own pixels, for a capture region given in
 * PDF points.
 *
 * Internal helper (not re-exported from the package entry). The raster's
 * pixels-per-point is measured from the raster itself rather than assumed
 * from the dpi that was requested, because a provider may return a different
 * resolution: the bundled demo server answers every preview request at
 * 96 DPI. Assuming the requested dpi crops the wrong region in that case.
 */
export function captureSourceRect(
  rect: { x: number; y: number; width: number; height: number },
  raster: { width: number; height: number },
  pageWidthPts: number,
  pageHeightPts: number
): { sx: number; sy: number; sw: number; sh: number } {
  const pxPerPtX = raster.width / Math.max(1e-6, pageWidthPts);
  const pxPerPtY = raster.height / Math.max(1e-6, pageHeightPts);
  return {
    sx: rect.x * pxPerPtX,
    sy: rect.y * pxPerPtY,
    sw: Math.max(1, rect.width * pxPerPtX),
    sh: Math.max(1, rect.height * pxPerPtY)
  };
}
