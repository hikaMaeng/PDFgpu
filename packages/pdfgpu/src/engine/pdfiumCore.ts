// PDFium rendering shared by the main-thread engine and the worker entry.
import { FPDF_REVERSE_BYTE_ORDER, pdfiumRgbxToRgba } from './pixels.js';
import type {
  PdfDocumentManifest,
  PdfImageSource,
  PdfPageManifest,
  PdfPreviewRenderRequest,
  PdfRasterResult,
  PdfTileRenderRequest
} from '../types.js';

export type PdfiumWrapped = {
  pdfium: {
    wasmExports: {
      malloc(size: number): number;
      free(ptr: number): void;
    };
    HEAPU8: Uint8Array;
  };
} & PdfiumFunctions;

type PdfiumFunctions = {
  PDFiumExt_Init: () => void;
  FPDF_GetPageCount: (docPtr: number) => number;
  FPDF_LoadMemDocument: (dataPtr: number, length: number, password: string | number | null) => number;
  FPDF_CloseDocument: (docPtr: number) => void;
  FPDF_LoadPage: (docPtr: number, pageIndex: number) => number;
  FPDF_ClosePage: (pagePtr: number) => void;
  FPDF_GetPageWidthF: (pagePtr: number) => number;
  FPDF_GetPageHeightF: (pagePtr: number) => number;
  EPDF_GetPageRotationByIndex: (docPtr: number, pageIndex: number) => number;
  FPDFBitmap_Create: (width: number, height: number, alpha: number) => number;
  FPDFBitmap_FillRect: (
    bitmapPtr: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number
  ) => void;
  FPDF_RenderPageBitmap: (
    bitmapPtr: number,
    pagePtr: number,
    startX: number,
    startY: number,
    width: number,
    height: number,
    rotate: number,
    flags: number
  ) => void;
  FPDFBitmap_GetBuffer: (bitmapPtr: number) => number;
  FPDFBitmap_Destroy: (bitmapPtr: number) => void;
};

type PdfiumModule = {
  init: (config: { wasmBinary: ArrayBuffer }) => Promise<PdfiumWrapped>;
  DEFAULT_PDFIUM_WASM_URL: string;
};

type LoadedDocument = {
  docPtr: number;
  filePtr: number;
};

const PREVIEW_DPI = 96;
export const TILE_SIZE = 512;
// PDFium writes R, G, B, x with this flag; see engine/pixels.ts.
const RENDER_FLAGS = FPDF_REVERSE_BYTE_ORDER;
const WHITE = 0xffffffff;
const PT_TO_PX_SCALE = 96 / 72;

const ROTATE_TO_FLAG: Record<number, number> = {
  0: 0,
  90: 1,
  180: 2,
  270: 3
};

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundInt(value: number) {
  return Math.max(1, Math.round(value));
}


function normalizeRotation(rawRotation: number) {
  const normalized = ((rawRotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function rotateFlag(rawRotation: number) {
  return ROTATE_TO_FLAG[normalizeRotation(rawRotation)] ?? 0;
}

function isBrowserEnvironment() {
  // A window or a dedicated worker: both have fetch, WebAssembly and
  // createImageBitmap, which is all PDFium rendering needs.
  const hasWindow = typeof window !== 'undefined';
  const hasWorkerScope = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
  return (hasWindow || hasWorkerScope) && typeof fetch !== 'undefined';
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('render aborted', 'AbortError');
  }
}

function extractManifest(pdfium: PdfiumWrapped, docPtr: number): PdfPageManifest[] {
  const pageCount = pdfium.FPDF_GetPageCount(docPtr);
  const pages: PdfPageManifest[] = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
    if (!pagePtr) {
      throw new Error(`failed to inspect page ${pageIndex}`);
    }
    try {
      const rawWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
      const rawHeight = pdfium.FPDF_GetPageHeightF(pagePtr);
      const rawRotation = pdfium.EPDF_GetPageRotationByIndex(docPtr, pageIndex);
      const rotation = normalizeRotation(rawRotation);
      const widthPts = rotation === 90 || rotation === 270 ? rawHeight : rawWidth;
      const heightPts = rotation === 90 || rotation === 270 ? rawWidth : rawHeight;
      pages.push({
        index: pageIndex,
        widthPts,
        heightPts,
        rotation
      });
    } finally {
      pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  return pages;
}

let pdfiumShared: Promise<PdfiumWrapped> | null = null;

export async function ensurePdfium(): Promise<PdfiumWrapped> {
  if (pdfiumShared) return pdfiumShared;
  if (!isBrowserEnvironment()) {
    throw new Error('PDFium engine is browser-only');
  }

  pdfiumShared = Promise.all([
    import('@embedpdf/pdfium'),
    import('@embedpdf/pdfium/pdfium.wasm?url')
  ]).then(async ([raw, wasmAsset]) => {
    const pdfiumModule = raw as unknown as PdfiumModule;
    const response = await fetch(wasmAsset.default);
    const wasmBinary = await response.arrayBuffer();
    const wrapped = await pdfiumModule.init({ wasmBinary });
    wrapped.PDFiumExt_Init();
    return wrapped;
  });

  try {
    return await pdfiumShared;
  } catch (error) {
    pdfiumShared = null;
    throw error;
  }
}

async function createBitmapImage(
  pdfium: PdfiumWrapped,
  pagePtr: number,
  bitmapWidth: number,
  bitmapHeight: number,
  startX: number,
  startY: number,
  renderWidth: number,
  renderHeight: number,
  rotate: number
): Promise<PdfImageSource> {
  const targetBitmapWidth = roundInt(bitmapWidth);
  const targetBitmapHeight = roundInt(bitmapHeight);
  const bitmapPtr = pdfium.FPDFBitmap_Create(targetBitmapWidth, targetBitmapHeight, 0);
  if (!bitmapPtr) throw new Error('failed to allocate bitmap');

  try {
    pdfium.FPDFBitmap_FillRect(bitmapPtr, 0, 0, targetBitmapWidth, targetBitmapHeight, WHITE);
    pdfium.FPDF_RenderPageBitmap(
      bitmapPtr,
      pagePtr,
      startX,
      startY,
      roundInt(renderWidth),
      roundInt(renderHeight),
      rotate,
      RENDER_FLAGS
    );

    const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
    if (!bufferPtr) throw new Error('failed to read rendered buffer');

    const bytesPerPixel = 4;
    const byteCount = targetBitmapWidth * targetBitmapHeight * bytesPerPixel;
    const sourceBytes = new Uint8ClampedArray(new ArrayBuffer(byteCount));
    sourceBytes.set(
      pdfium.pdfium.HEAPU8.subarray(
        bufferPtr,
        bufferPtr + byteCount
      )
    );
    const imageData = new ImageData(
      pdfiumRgbxToRgba(sourceBytes),
      targetBitmapWidth,
      targetBitmapHeight
    );
    return await createImageBitmap(imageData);
  } finally {
    pdfium.FPDFBitmap_Destroy(bitmapPtr);
  }
}

/**
 * One PDFium document opened on one PDFium WASM instance.
 *
 * Runs wherever `ensurePdfium` runs: on the main thread (fallback engine) or
 * inside a dedicated worker (`pdfiumWorkerMain.ts`), where each worker owns
 * its own WASM instance and therefore its own copy of the document.
 */
export class PdfiumDocument {
  private loaded: LoadedDocument | null = null;
  private currentManifest: PdfDocumentManifest | null = null;

  constructor(private readonly pdfium: PdfiumWrapped) {}

  async open(bytes: Uint8Array, manifest?: PdfDocumentManifest): Promise<PdfDocumentManifest> {
    await this.dispose();

    const dataPtr = this.pdfium.pdfium.wasmExports.malloc(bytes.length);
    if (!dataPtr) throw new Error('failed to allocate source bytes');
    this.pdfium.pdfium.HEAPU8.set(bytes, dataPtr);

    const docPtr = this.pdfium.FPDF_LoadMemDocument(dataPtr, bytes.length, null);
    if (!docPtr) {
      this.pdfium.pdfium.wasmExports.free(dataPtr);
      throw new Error('failed to open document');
    }
    this.loaded = { docPtr, filePtr: dataPtr };
    this.currentManifest = manifest ?? (() => {
      const pages = extractManifest(this.pdfium, docPtr);
      return { pageCount: pages.length, pages };
    })();
    return this.currentManifest;
  }

  async renderPreview(
    request: PdfPreviewRenderRequest & { signal?: AbortSignal }
  ): Promise<PdfRasterResult> {
    assertNotAborted(request.signal);
    const page = this.currentManifest?.pages[request.pageIndex];
    if (!page) throw new Error(`invalid page index: ${request.pageIndex}`);

    const pagePtr = this.pdfium.FPDF_LoadPage(this.requireOpen().docPtr, request.pageIndex);
    if (!pagePtr) throw new Error(`failed to load page ${request.pageIndex}`);
    try {
      const dpi = request.dpi ?? PREVIEW_DPI;
      const scale = dpi / 72;
      const width = roundInt(page.widthPts * scale);
      const height = roundInt(page.heightPts * scale);
      const source = await createBitmapImage(
        this.pdfium,
        pagePtr,
        width,
        height,
        0,
        0,
        width,
        height,
        rotateFlag(page.rotation)
      );
      assertNotAborted(request.signal);
      return {
        source,
        width,
        height,
        dpi,
        pageIndex: request.pageIndex,
        kind: 'preview'
      };
    } finally {
      this.pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  async renderTile(
    request: PdfTileRenderRequest & { signal?: AbortSignal }
  ): Promise<PdfRasterResult> {
    assertNotAborted(request.signal);
    const page = this.currentManifest?.pages[request.pageIndex];
    if (!page) throw new Error(`invalid page index: ${request.pageIndex}`);

    const scale = request.dpi / 72;
    const pageWidth = roundInt(page.widthPts * scale);
    const pageHeight = roundInt(page.heightPts * scale);
    const pagePtr = this.pdfium.FPDF_LoadPage(this.requireOpen().docPtr, request.pageIndex);
    if (!pagePtr) throw new Error(`failed to load page ${request.pageIndex}`);

    try {
      const tileX = clamp(Math.floor(request.tileX), 0, Math.max(0, pageWidth - 1));
      const tileY = clamp(Math.floor(request.tileY), 0, Math.max(0, pageHeight - 1));
      const tileWidth = Math.max(1, Math.min(request.tileWidth, pageWidth - tileX));
      const tileHeight = Math.max(1, Math.min(request.tileHeight, pageHeight - tileY));
      const source = await createBitmapImage(
        this.pdfium,
        pagePtr,
        tileWidth,
        tileHeight,
        -tileX,
        -tileY,
        pageWidth,
        pageHeight,
        rotateFlag(page.rotation)
      );
      assertNotAborted(request.signal);
      return {
        source,
        width: tileWidth,
        height: tileHeight,
        dpi: request.dpi,
        pageIndex: request.pageIndex,
        kind: 'detail',
        tileX,
        tileY,
        tileWidth,
        tileHeight
      };
    } finally {
      this.pdfium.FPDF_ClosePage(pagePtr);
    }
  }

  async dispose() {
    if (!this.loaded) return;
    const { docPtr, filePtr } = this.loaded;
    this.loaded = null;
    this.currentManifest = null;
    this.pdfium.FPDF_CloseDocument(docPtr);
    this.pdfium.pdfium.wasmExports.free(filePtr);
  }

  private requireOpen() {
    if (!this.loaded || !this.currentManifest) {
      throw new Error('document is not opened');
    }
    return this.loaded;
  }
}

