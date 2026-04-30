Runnable pdfgpu viewer app with compact controls and server-backed sample routes.

| Goal               | File                 |
|--------------------|----------------------|
| Understand purpose | README.md            |
| API reference      | docs/api.md          |
| Constraints        | docs/constraints.md  |
| Testing            | docs/testing.md      |

## Scope

- `src/client`: React viewer shell for provider selection, document loading, layout controls, and detail image DPI control.
- `src/server`: HTTP/WebSocket sample server and static asset host.
- `docker`: app container definition and runtime environment examples.

## Docker Hub

Published image:

```bash
docker pull hika00/pdfgpu:latest
docker run --rm -p 51000:51000 hika00/pdfgpu:latest
```

Health check:

```bash
curl http://localhost:51000/health
```
