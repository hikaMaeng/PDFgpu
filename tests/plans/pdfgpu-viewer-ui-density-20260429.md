# Test Plan: pdfgpu-viewer-ui-density

## Created
2026-04-29

## Goal
Verify the compact top-control PDF viewer UI, fixed 11px loading/status surface, expanded viewer viewport, and detail image DPI slider.

## Environment
- OS/shell: current workspace shell
- Deploy entrypoint: `npm run deploy`
- Browser verification: Playwright through `docker compose run --rm --entrypoint /bin/sh e2e -lc "sh ./tests/e2e/run-e2e.sh"`

## Preconditions
- Dependencies are installed.
- Docker is available.
- Port `51000` is free or released by `docker compose down --remove-orphans`.

## Steps
1. Run `npm run deploy`.
2. Open the deployed app at `http://localhost:51000`.
3. Assert the toolbar is visible by role `toolbar` and name `viewer controls`.
4. Assert the viewer is visible by role `region` and name `PDF viewer`.
5. Assert the fixed status surface is visible by role `status` and name `viewer status`.
6. Load the sample PDF.
7. Change `detail image dpi` to `288`.
8. Verify status text includes `DPI: 288` and the viewer still renders dark pixels.

## Expected Results
- Build, compose refresh, health check, and Playwright all pass.
- The toolbar remains at the top and exposes accessible labels.
- The status/loading surface is fixed at the top-left with compact text.
- The viewer region consumes the remaining viewport height.
- DPI slider updates controller state without viewer errors.

## Logs To Capture
- `npm run deploy` output
- Docker compose build/up output
- Playwright console/page errors
- Generated deploy report path

## Locator Contract
- Toolbar: `getByRole('toolbar', { name: 'viewer controls' })`
- Viewer: `getByRole('region', { name: 'PDF viewer' })`
- Status: `getByRole('status', { name: 'viewer status' })`
- DPI slider: `getByLabel('detail image dpi')`
- Page shells: `data-testid="pdfgpu-page-shell"`
