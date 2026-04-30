# Internals

- The status surface is fixed and intentionally small; its text remains in the DOM for browser assertions even when visually clipped.
- `detail image dpi` calls `PdfGpuViewerController.setDetailDpi`.
- The viewer controller normalizes requested detail DPI through the core PDFium DPI bucket rules.
- The app recreates the viewer only when the raster provider mode changes.
