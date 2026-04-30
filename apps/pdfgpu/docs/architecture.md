# Architecture

- `src/client/src/App.jsx` owns the app shell and wires UI controls to `createPdfGpuViewer`.
- `src/client/src/index.css` owns viewport-first layout, compact toolbar styling, and the fixed status surface.
- `src/server/src/index.ts` serves the built client, health endpoint, sample PDF, HTTP raster protocol, and WebSocket raster protocol.
- Docker builds the app through `apps/pdfgpu/docker/Dockerfile` and is refreshed by root `npm run deploy`.
