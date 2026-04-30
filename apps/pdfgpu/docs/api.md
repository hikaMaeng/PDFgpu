# API

## Client Controls

- `raster provider`: selects `in-memory`, `webapi`, or `websocket`.
- `sample PDF`: loads `/sample.pdf`.
- `Upload PDF`: loads a local PDF file.
- `zoom in`, `zoom out`, `fit width`, `fit height`, `fit page`: viewer zoom/fit commands.
- `view mode`: selects `single` or `spread`.
- `first page spread placement`: selects `first-right` or `first-left`.
- `scroll mode`: selects `continuous` or `page`.
- `detail image dpi`: range slider from `144` to `384` in `48` DPI steps.

## Server Routes

- `GET /health`
- `GET /sample.pdf`
- `POST /api/pdfgpu/documents`
- `GET /api/pdfgpu/documents/:documentId/preview`
- `GET /api/pdfgpu/documents/:documentId/tile`
- `WS /ws/pdfgpu`
