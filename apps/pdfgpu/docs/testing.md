# Testing

## Browser Contract

- Toolbar: `getByRole('toolbar', { name: 'viewer controls' })`
- Viewer: `getByRole('region', { name: 'PDF viewer' })`
- Status: `getByRole('status', { name: 'viewer status' })`
- Provider selector: `getByLabel('raster provider')`
- Detail DPI slider: `getByLabel('detail image dpi')`
- Page shell: `data-testid="pdfgpu-page-shell"`

## Verification

Run:

```bash
npm run deploy
```

The deploy script builds packages, refreshes compose, checks `/health`, runs Playwright, and writes a report under `tests/reports/pdfgpu-viewer/`.
