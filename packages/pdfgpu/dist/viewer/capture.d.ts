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
export declare function captureSourceRect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
}, raster: {
    width: number;
    height: number;
}, pageWidthPts: number, pageHeightPts: number): {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
};
