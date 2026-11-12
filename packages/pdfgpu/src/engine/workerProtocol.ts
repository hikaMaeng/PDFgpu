import type { PdfDocumentManifest, PdfRasterResult } from '../types.js';

/**
 * Messages between `WorkerPoolPdfEngine` (main thread) and
 * `pdfiumWorkerMain` (one dedicated worker per PDFium instance).
 *
 * Every request carries an `id` unique per worker; the worker answers each
 * request exactly once with the same `id`. `cancel` is the exception: it has
 * no reply of its own; it makes the cancelled request answer `AbortError` if
 * that request has not started rendering yet.
 */
export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'open'; bytes: ArrayBuffer; manifest?: PdfDocumentManifest }
  | { id: number; type: 'preview'; pageIndex: number; dpi?: number }
  | {
      id: number;
      type: 'tile';
      pageIndex: number;
      dpi: number;
      tileX: number;
      tileY: number;
      tileWidth: number;
      tileHeight: number;
    }
  | { id: number; type: 'close' }
  | { id: number; type: 'cancel'; target: number };

/** A request before the pool assigns its `id`. */
export type WorkerRequestBody = WorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

/** Raster without `signal`; `source` is an ImageBitmap transferred back. */
export type WorkerRaster = Omit<PdfRasterResult, 'source'> & { source: ImageBitmap };

export type WorkerResponse =
  | { id: number; ok: true; manifest?: PdfDocumentManifest; raster?: WorkerRaster }
  | { id: number; ok: false; error: string; name?: string };
