# Usage

## Docker Hub

```bash
docker pull hika00/pdfgpu:latest
docker run --rm -p 51000:51000 hika00/pdfgpu:latest
```

Open `http://localhost:51000`. Check `http://localhost:51000/health` before browser verification.

## Workspace

```bash
pnpm --filter "@pdfgpu/app-client" dev
pnpm --filter "@pdfgpu/app-server" start
npm run deploy
```

Use `npm run deploy` for completion verification because it builds, refreshes compose, checks health, and runs browser tests.
