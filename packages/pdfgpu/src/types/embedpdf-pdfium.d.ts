declare module '@embedpdf/pdfium' {
  const pdfiumModule: {
    init: (config: { wasmBinary: ArrayBuffer }) => Promise<{
      PDFiumExt_Init: () => void;
      pdfium: {
        wasmExports: {
          malloc: (size: number) => number;
          free: (ptr: number) => void;
        };
        HEAPU8: Uint8Array;
      };
      [key: string]: unknown;
    }>;
    DEFAULT_PDFIUM_WASM_URL: string;
    [key: string]: unknown;
  };

  export default pdfiumModule;
}
