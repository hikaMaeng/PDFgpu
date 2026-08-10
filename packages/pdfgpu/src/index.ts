import { createPdfGpuViewer } from './viewer/controller.js';
import { createPdfDocumentEngine } from './engine/pdfiumEngine.js';
import { normalizeDetailDpi } from './engine/dpi.js';
import {
  createInMemoryPdfRasterProvider,
  createWebApiPdfRasterProvider,
  createWebSocketPdfRasterProvider
} from './providers/remote.js';
import type {
  PdfDocumentEngine,
  PdfDocumentSource,
  PdfGpuBackend,
  PdfGpuCapabilities,
  PdfGpuViewerController,
  PdfGpuViewerOptions,
  PdfGpuViewerState,
  PdfGpuCaptureResult,
  PdfGpuCaptureController,
  PdfGpuAbsoluteRect,
  PdfGpuScreenPoint,
  PdfGpuCaptureError,
  PdfGpuCaptureErrorCode,
  PdfGpuOverlayItem,
  PdfGpuOverlayProjection,
  PdfRasterResult,
  PdfDocumentManifest,
  PdfPageManifest,
  PdfRasterProvider,
  PdfRasterProviderKind
} from './types.js';

export * from './viewer/interaction.js';
export * from './viewer/coordinates.js';

export {
  createPdfDocumentEngine,
  createInMemoryPdfRasterProvider,
  createWebApiPdfRasterProvider,
  createWebSocketPdfRasterProvider,
  normalizeDetailDpi,
  createPdfGpuViewer,
  type PdfRasterProvider,
  type PdfRasterProviderKind,
  type PdfDocumentEngine,
  type PdfDocumentManifest,
  type PdfPageManifest,
  type PdfDocumentSource,
  type PdfRasterResult,
  type PdfGpuBackend,
  type PdfGpuCapabilities,
  type PdfGpuViewerController,
  type PdfGpuViewerOptions,
  type PdfGpuViewerState
  , type PdfGpuCaptureResult
  , type PdfGpuCaptureController
};
