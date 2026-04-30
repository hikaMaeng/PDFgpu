# Test Plan: pdfgpu-docker-hub-publish

## Created

2026-04-30

## Goal

Verify that the current `pdfgpu` Docker image builds from the workspace, deploys locally through the standard compose path, passes browser verification, and is pushed to Docker Hub as `hika00/pdfgpu:latest`.

## Environment

- OS shell: Linux bash under `/mnt/f/dev/pdfgpu`
- Docker target: `hika00/pdfgpu:latest`
- Local URL: `http://localhost:51000`
- Standard entrypoint: `npm run deploy`

## Preconditions

- Docker daemon is running.
- Docker Hub credentials are available to the local Docker client.
- Dependencies are installed from the existing lockfile.

## Steps

1. Run `npm run deploy`.
2. Confirm deploy removes prior compose containers, rebuilds `pdfgpu`, starts compose, checks `/health`, and runs Playwright through the e2e container.
3. Build or reuse the tagged image `hika00/pdfgpu:latest`.
4. Push `hika00/pdfgpu:latest` to Docker Hub.
5. Pull `hika00/pdfgpu:latest` and inspect the pulled image reference.

## Expected Results

- `npm run deploy` exits with code 0.
- Browser verification passes against the deployed service.
- `docker push hika00/pdfgpu:latest` completes successfully.
- `docker pull hika00/pdfgpu:latest` resolves the uploaded image.

## Logs To Capture

- `npm run deploy` summary and generated report path.
- Docker image ID/digest from build, push, and pull.
- Any Docker Hub authentication or permission failure.

## Locator Contract

- Toolbar: `getByRole('toolbar', { name: 'viewer controls' })`
- Viewer: `getByRole('region', { name: 'PDF viewer' })`
- Status: `getByRole('status', { name: 'viewer status' })`
- Provider selector: `getByLabel('raster provider')`
- Detail DPI slider: `getByLabel('detail image dpi')`
- Page shell: `data-testid="pdfgpu-page-shell"`
