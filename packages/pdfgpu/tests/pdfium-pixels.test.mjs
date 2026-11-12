import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FPDF_REVERSE_BYTE_ORDER, pdfiumRgbxToRgba } from '../dist/engine/pixels.js';

// External criteria:
// - PDFium fpdfview.h: `#define FPDF_REVERSE_BYTE_ORDER 0x10`; with it,
//   FPDF_RenderPageBitmap emits R, G, B, x instead of B, G, R, x.
// - ImageData is R, G, B, A.
// So a pure red pixel arrives from PDFium as [255, 0, 0, x] and must reach
// ImageData as [255, 0, 0, 255].
//
// The browser evidence that motivated this: a PDF filling red / green / blue
// squares left to right (content stream `1 0 0 rg ... 0 0 1 rg`) rendered as
// blue / green / red in Chrome's WebGPU path before the fix.

describe('pdfium pixel conversion', () => {
  it('uses the PDFium flag value from fpdfview.h', () => {
    assert.equal(FPDF_REVERSE_BYTE_ORDER, 0x10);
  });

  it('keeps red red, green green and blue blue', () => {
    const fromPdfium = new Uint8ClampedArray([
      255, 0, 0, 0,     // red, unspecified fourth byte
      0, 255, 0, 17,    // green
      0, 0, 255, 200    // blue
    ]);
    const rgba = Array.from(pdfiumRgbxToRgba(fromPdfium));
    assert.deepEqual(rgba, [
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255
    ]);
  });
});
