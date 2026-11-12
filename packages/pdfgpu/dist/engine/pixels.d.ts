/**
 * `FPDF_REVERSE_BYTE_ORDER` from PDFium's `fpdfview.h`. With this flag
 * `FPDF_RenderPageBitmap` writes pixels as R, G, B, x instead of its native
 * B, G, R, x, i.e. already in the byte order `ImageData` expects.
 */
export declare const FPDF_REVERSE_BYTE_ORDER = 16;
/**
 * Converts a PDFium bitmap rendered WITH `FPDF_REVERSE_BYTE_ORDER` into
 * `ImageData` bytes.
 *
 * The colour bytes are already R, G, B, so they are copied unchanged; only the
 * fourth byte is forced to 255, because the bitmap is created without alpha
 * (`FPDFBitmap_Create(w, h, 0)`) and PDFium leaves that byte unspecified.
 *
 * The previous conversion swapped bytes 0 and 2 on top of the flag, so red and
 * blue were exchanged on screen (a red square rendered blue). A grayscale page
 * looks identical either way, which is why it went unnoticed.
 */
export declare function pdfiumRgbxToRgba(sourceBytes: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer>;
