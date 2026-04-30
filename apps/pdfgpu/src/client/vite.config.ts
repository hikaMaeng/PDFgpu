import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist'
  },
  resolve: {
    alias: {
      '@pdfgpu/core': resolve(__dirname, '../../../../packages/pdfgpu/src')
    }
  }
});
