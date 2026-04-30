# Constraints

- The app shell must keep one top-level `<main>`.
- Non-viewer UI should stay in the top toolbar or fixed top-left status surface.
- Avoid page titles or decorative headers in the runtime UI.
- The viewer region must retain `role="region"` and accessible name `PDF viewer`.
- The status/loading surface must retain `role="status"` and accessible name `viewer status`.
- The toolbar must retain `role="toolbar"` and accessible name `viewer controls`.
- The detail DPI slider must retain accessible name `detail image dpi`.
- Browser tests may use `data-testid="pdfgpu-scroll-area"` and `data-testid="pdfgpu-page-shell"` for viewer internals.
