import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist'
  },
  // The PDFium worker is a module worker that lazy-loads PDFium with import();
  // that needs ES-module worker output (Vite's default iife cannot split code).
  worker: {
    format: 'es'
  },
  resolve: {
    alias: {
      '@pdfgpu/core': resolve(__dirname, '../../../../packages/pdfgpu/src')
    }
  }
});
