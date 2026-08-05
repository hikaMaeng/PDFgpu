import type { PdfRasterProvider } from '../types.js';
/** Creates a local function provider and marks it as an in-memory supply path. */
export declare function createInMemoryPdfRasterProvider(provider: PdfRasterProvider): PdfRasterProvider;
/** Creates an HTTP provider for parser services that accept uploaded PDF bytes and return raster images. */
export declare function createWebApiPdfRasterProvider(endpoint: string): PdfRasterProvider;
/** Creates a WebSocket provider for parser services using the pdfgpu JSON RPC protocol. */
export declare function createWebSocketPdfRasterProvider(endpoint: string): PdfRasterProvider;
