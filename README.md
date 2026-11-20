PDFGPU is a provider-independent, progressive PDF viewer core for the modern web.

<div align="center">
  <h1>PDFGPU</h1>
  <p><strong>Progressive PDF rendering for the modern web.</strong><br />
  WebGPU-first composition, swappable raster providers, and a viewer that stays responsive while documents get large.</p>

  <p>
    <a href="https://github.com/hikaMaeng/PDFgpu/releases/tag/v0.1.0"><img src="https://img.shields.io/github/v/release/hikaMaeng/PDFgpu?display_name=tag&sort=semver" alt="Latest release" /></a>
    <a href="https://hub.docker.com/r/hika00/pdfgpu"><img src="https://img.shields.io/docker/pulls/hika00/pdfgpu" alt="Docker pulls" /></a>
  </p>

  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#providers">Providers</a> ·
    <a href="#documentation">Documentation</a> ·
    <a href="https://github.com/hikaMaeng/PDFgpu/releases">Releases</a>
  </p>
</div>

> **Powered by PDFium.** PDFGPU's in-memory provider uses
> [`@embedpdf/pdfium@2.15.1`](https://www.embedpdf.com/docs/pdfium/getting-started),
> a WebAssembly build of [PDFium](https://github.com/chromium/pdfium), the
> open-source PDF engine used by Chromium's PDF viewer. PDFGPU does not replace
> that parser with a JavaScript approximation; it adds progressive scheduling,
> caching, layout, and GPU composition around it.

## Why PDFGPU?

Most PDF viewers make the rendering backend part of the application. PDFGPU
does the opposite: it gives the viewer a small raster contract, then lets the
application choose where PDF parsing and rendering should run.

- **Progressive by design** — show a 96-DPI preview first, then refine only the
  visible pages with high-DPI detail tiles.
- **A serious parser underneath** — complex PDF parsing and page rasterization
  start from PDFium's mature C++ engine compiled to WebAssembly, not a thin
  browser-only PDF loader.
- **Backend agnostic** — use browser-local PDFium, an HTTP service, or a
  WebSocket service without replacing the viewer.
- **GPU-first, resilient fallback** — compose visible tiles with WebGPU when it
  is available and keep the same frame pipeline on Canvas 2D when it is not.
- **Built for large documents** — visibility-aware scheduling, cancellation,
  one request per viewer worker, and byte-budgeted raster caches keep work tied to the viewport.
- **Easy to embed** — the core has no React dependency and exposes a
  framework-independent interaction reducer for application adapters.

## The model

```text
PDF bytes → raster provider → page manifest + preview/detail tiles
          → viewport scheduler → bounded cache → WebGPU/Canvas 2D canvas
```

The provider owns PDF parsing and rasterization. PDFGPU owns layout, zoom,
navigation, prioritization, cancellation, caching, and composition. That
separation is the product: move a workload from the browser to a service
without rewriting the viewing experience.

## Quick start

### Install the released core

PDFGPU `v0.1.0` is distributed as an exact GitHub Release artifact. Pin the
version in your application instead of depending on a moving branch:

```json
{
  "dependencies": {
    "@pdfgpu/core": "https://github.com/hikaMaeng/PDFgpu/releases/download/v0.1.0/pdfgpu-core-0.1.0.tgz"
  }
}
```

```bash
pnpm install
```

### Create a viewer

```html
<div id="viewer" style="height: 720px"></div>
<input id="pdf" type="file" accept="application/pdf" />
```

```ts
import {
  createPdfDocumentEngine,
  createPdfGpuViewer
} from '@pdfgpu/core';

const container = document.querySelector<HTMLElement>('#viewer');
if (!container) throw new Error('viewer container is missing');

const provider = await createPdfDocumentEngine();
const viewer = await createPdfGpuViewer({
  container,
  provider,
  detailDpi: 192
});

viewer.subscribe((state) => {
  console.log(state.backend, state.renderQuality, state.activePage);
});

const input = document.querySelector<HTMLInputElement>('#pdf');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (file) await viewer.load(file);
});

// On application teardown:
viewer.dispose();
await provider.dispose();
```

## Providers

Every provider implements the same core lifecycle:

```ts
interface PdfRasterProvider {
  open(source: PdfDocumentSource): Promise<PdfDocumentManifest>;
  renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult>;
  renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult>;
  dispose(): void | Promise<void>;
}
```

Choose the topology that fits your product:

| Provider | Use it when | Example |
| --- | --- | --- |
| In-memory PDFium | Documents should stay in the browser | `createPdfDocumentEngine()` |
| HTTP Web API | You already have request/response infrastructure | `createWebApiPdfRasterProvider('/api/pdfgpu')` |
| WebSocket JSON RPC | You want a long-lived, bidirectional session | `createWebSocketPdfRasterProvider('wss://...')` |

Switching from local to remote rendering changes the provider, not the viewer:

```ts
import {
  createPdfGpuViewer,
  createWebApiPdfRasterProvider
} from '@pdfgpu/core';

const provider = createWebApiPdfRasterProvider('/api/pdfgpu');
const viewer = await createPdfGpuViewer({ container, provider });
await viewer.load(fileOrUrl);
```

Remote providers use a deliberately small protocol:

1. `POST /documents` with `{ "bytes": "<base64 PDF>" }`.
2. Return a `documentId` and page manifest.
3. Serve preview and detail-tile requests by page, DPI, and tile coordinates.
4. Return the raster image with dimensions, DPI, page index, and tile kind.

## Included in the core

- Progressive preview/detail raster scheduling.
- Visibility-aware priority and request cancellation.
- 192 MiB default byte-budgeted raster cache.
- 96-DPI previews and normalized 144–384 DPI detail buckets.
- Single-page, continuous-scroll, and two-page spread layouts.
- Zoom, fit width/height/page, page navigation, and detail-DPI controls.
- One composited viewer canvas with lightweight page shells.
- WebGPU renderer with Canvas 2D fallback.
- Framework-independent wheel, keyboard, and page-mode interaction reducer.

## Try the demo

### Docker

```bash
docker pull hika00/pdfgpu:latest
docker run --rm -p 51000:51000 hika00/pdfgpu:latest
```

Open [localhost:51000](http://localhost:51000) and verify the service at
[`/health`](http://localhost:51000/health).

### From source

```bash
pnpm install -w
pnpm run build
pnpm run deploy
```

The deploy command builds the monorepo, refreshes the container, checks health,
runs browser coverage, and writes evidence under
`tests/reports/pdfgpu-viewer/`.

## Scope

PDFGPU `0.1.0` focuses on responsive viewing and progressive raster
composition. Text selection, full-text search, annotations, and document
management are intentionally outside the current core. They can be built above
the provider and viewer contracts without coupling the library to one product.

## PDFium release contract

`@pdfgpu/core@0.1.0` pins the in-memory parser and rasterizer to
`@embedpdf/pdfium@2.15.1`. The dependency is exact in `package.json`, resolved
and integrity-pinned in `pnpm-lock.yaml`, and recorded in the immutable
[v0.1.0 release contract](release-contracts/pdfgpu/v0.1.0.json).

PDFium updates are PDFGPU release events. A compatible PDFium patch update
creates a new PDFGPU patch release such as `0.1.1`; a change that requires
consumer migration creates a new minor release such as `0.2.0`. The old
PDFGPU release never silently begins using a newer PDFium binary.

## Documentation

- [Overview](packages/pdfgpu/docs/overview.md) — package boundary and design intent
- [Architecture](packages/pdfgpu/docs/architecture.md) — source ownership and data flow
- [API](packages/pdfgpu/docs/api.md) — public types, providers, and controller methods
- [Usage](packages/pdfgpu/docs/usage.md) — local and remote integration examples
- [Constraints](packages/pdfgpu/docs/constraints.md) — consumer and browser contracts
- [Internals](packages/pdfgpu/docs/internals.md) — scheduling, cache, and rendering decisions
- [Testing](packages/pdfgpu/docs/testing.md) — unit, integration, and browser verification
- [Release versioning](packages/pdfgpu/docs/release-versioning.md) — PDFium dependency and release contract policy

## Repository layout

| Path | Role |
| --- | --- |
| [`packages/pdfgpu`](packages/pdfgpu) | Released `@pdfgpu/core` package |
| [`apps/pdfgpu`](apps/pdfgpu) | Reference client, server, and Docker app |
| [`tests`](tests) | Test plans, Playwright suites, and reports |
| [`scripts/deploy.mjs`](scripts/deploy.mjs) | Build and verification entry point |

## Development

```bash
pnpm run verify:release-contract
pnpm --filter @pdfgpu/core test
pnpm run build
```

PDFGPU is an independent library. Integrations such as PDFit consume a pinned
release artifact and can advance on their own release schedule.

---

# 한국어

<div align="center">
  <h1>PDFGPU</h1>
  <p><strong>현대적인 웹을 위한 progressive PDF 렌더링.</strong><br />
  WebGPU 우선 합성, 교체 가능한 raster provider, 대형 문서에서도 응답성을 유지하는 뷰어입니다.</p>
</div>

> **PDFium 기반.** PDFGPU의 in-memory provider는
> [`@embedpdf/pdfium@2.15.1`](https://www.embedpdf.com/docs/pdfium/getting-started)을
> 사용합니다. 이는 Chromium PDF viewer에 사용되는 오픈소스
> [PDFium](https://github.com/chromium/pdfium)의 WebAssembly 빌드입니다.
> PDFGPU는 JavaScript로 PDF parser를 다시 구현하지 않고, PDFium 위에
> progressive scheduling, caching, layout, GPU composition을 추가합니다.

## 왜 PDFGPU인가?

일반적인 PDF 뷰어는 렌더링 backend를 애플리케이션에 강하게 결합합니다.
PDFGPU는 반대로 작은 raster 계약을 제공하고, PDF 파싱과 렌더링을 어디서
실행할지는 애플리케이션이 선택하도록 합니다.

- **처음부터 progressive입니다.** 96-DPI preview를 먼저 보여주고,
  화면에 보이는 페이지만 고해상도 detail tile로 보강합니다.
- **검증된 parser가 아래에 있습니다.** 복잡한 PDF 파싱과 페이지 래스터화는
  얇은 브라우저 전용 loader가 아니라 WebAssembly로 컴파일된 PDFium의
  성숙한 C++ 엔진에서 시작합니다.
- **backend에 독립적입니다.** 브라우저 내부 PDFium, HTTP 서비스,
  WebSocket 서비스를 뷰어 교체 없이 사용할 수 있습니다.
- **GPU 우선이면서 안전합니다.** WebGPU가 가능하면 visible tile을 합성하고,
  불가능하면 같은 frame pipeline을 Canvas 2D로 유지합니다.
- **대형 문서를 고려했습니다.** 가시성 기반 스케줄링, 워커당 요청 한 건,
  byte-budget LRU cache로 작업량을 viewport에 맞춥니다.
- **삽입하기 쉽습니다.** 코어는 React에 의존하지 않으며 애플리케이션
  adapter가 사용할 수 있는 프레임워크 독립 interaction reducer를 제공합니다.

## 핵심 모델

```text
PDF bytes → raster provider → page manifest + preview/detail tiles
          → viewport scheduler → bounded cache → WebGPU/Canvas 2D canvas
```

provider는 PDF 파싱과 래스터화를 소유합니다. PDFGPU는 레이아웃, zoom,
페이지 이동, 우선순위, 취소, 캐시, 합성을 소유합니다. 따라서 브라우저에서
원격 서비스로 PDF 작업을 옮겨도 뷰어를 다시 만들 필요가 없습니다.

## 빠른 시작

### 릴리스 코어 설치

PDFGPU `v0.1.0`은 정확한 GitHub Release artifact로 배포됩니다. 이동하는
branch 대신 애플리케이션에서 버전을 고정하십시오.

```json
{
  "dependencies": {
    "@pdfgpu/core": "https://github.com/hikaMaeng/PDFgpu/releases/download/v0.1.0/pdfgpu-core-0.1.0.tgz"
  }
}
```

```bash
pnpm install
```

### 뷰어 생성

```ts
import {
  createPdfDocumentEngine,
  createPdfGpuViewer
} from '@pdfgpu/core';

const container = document.querySelector<HTMLElement>('#viewer');
if (!container) throw new Error('viewer container is missing');

const provider = await createPdfDocumentEngine();
const viewer = await createPdfGpuViewer({
  container,
  provider,
  detailDpi: 192
});

viewer.subscribe((state) => {
  console.log(state.backend, state.renderQuality, state.activePage);
});

await viewer.load(file);
```

## Provider

모든 provider는 동일한 코어 lifecycle을 구현합니다.

```ts
interface PdfRasterProvider {
  open(source: PdfDocumentSource): Promise<PdfDocumentManifest>;
  renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult>;
  renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult>;
  dispose(): void | Promise<void>;
}
```

| Provider | 적합한 경우 | 예시 |
| --- | --- | --- |
| In-memory PDFium | 문서를 브라우저 안에 유지하고 싶은 경우 | `createPdfDocumentEngine()` |
| HTTP Web API | 기존 request/response 인프라가 있는 경우 | `createWebApiPdfRasterProvider('/api/pdfgpu')` |
| WebSocket JSON RPC | 장기 양방향 세션이 필요한 경우 | `createWebSocketPdfRasterProvider('wss://...')` |

local에서 remote 렌더링으로 바꿀 때도 viewer가 아니라 provider만 바꿉니다.

```ts
import {
  createPdfGpuViewer,
  createWebApiPdfRasterProvider
} from '@pdfgpu/core';

const provider = createWebApiPdfRasterProvider('/api/pdfgpu');
const viewer = await createPdfGpuViewer({ container, provider });
await viewer.load(fileOrUrl);
```

원격 provider 프로토콜은 의도적으로 작고 명확합니다.

1. `POST /documents`에 `{ "bytes": "<base64 PDF>" }`를 보냅니다.
2. `documentId`와 페이지 manifest를 받습니다.
3. 페이지, DPI, tile 좌표로 preview와 detail 요청을 처리합니다.
4. 크기, DPI, 페이지 번호, tile kind를 포함한 raster image를 반환합니다.

## 코어에 포함된 기능

- progressive preview/detail raster scheduling
- 가시성 기반 우선순위와 요청 취소
- 기본 192 MiB byte-budget raster cache
- 96-DPI preview와 144–384 DPI detail bucket
- single page, continuous scroll, two-page spread 레이아웃
- zoom, fit width/height/page, 페이지 이동, detail DPI 제어
- 가벼운 page shell과 하나의 합성 viewer canvas
- WebGPU renderer와 Canvas 2D fallback
- 프레임워크 독립 wheel, keyboard, page-mode interaction reducer

## Demo 실행

### Docker

```bash
docker pull hika00/pdfgpu:latest
docker run --rm -p 51000:51000 hika00/pdfgpu:latest
```

[localhost:51000](http://localhost:51000)에서 열고
[`/health`](http://localhost:51000/health)에서 상태를 확인하십시오.

### 소스에서 실행

```bash
pnpm install -w
pnpm run build
pnpm run deploy
```

deploy 명령은 monorepo 빌드, 컨테이너 갱신, health 확인, 브라우저 검증을
실행하고 `tests/reports/pdfgpu-viewer/`에 증거를 기록합니다.

## 범위

PDFGPU `0.1.0`의 중심은 응답성 있는 viewing과 progressive raster
composition입니다. 텍스트 선택, full-text search, annotation,
document management는 현재 코어 범위에서 의도적으로 제외했습니다. 이
기능들은 특정 제품에 라이브러리를 결합하지 않고 provider와 viewer 계약
위에 추가할 수 있습니다.

## 문서

- [개요](packages/pdfgpu/docs/overview.md) — 패키지 경계와 설계 의도
- [아키텍처](packages/pdfgpu/docs/architecture.md) — 소스 책임과 데이터 흐름
- [API](packages/pdfgpu/docs/api.md) — 공개 타입, provider, controller 메서드
- [사용 방법](packages/pdfgpu/docs/usage.md) — local/remote 통합 예시
- [제약 사항](packages/pdfgpu/docs/constraints.md) — 소비자와 브라우저 계약
- [내부 동작](packages/pdfgpu/docs/internals.md) — scheduler, cache, renderer 결정
- [테스트](packages/pdfgpu/docs/testing.md) — unit, integration, browser 검증

## 저장소 구성

| 경로 | 역할 |
| --- | --- |
| [`packages/pdfgpu`](packages/pdfgpu) | 릴리스되는 `@pdfgpu/core` 패키지 |
| [`apps/pdfgpu`](apps/pdfgpu) | reference client, server, Docker 앱 |
| [`tests`](tests) | 테스트 계획, Playwright suite, report |
| [`scripts/deploy.mjs`](scripts/deploy.mjs) | 빌드와 검증 진입점 |

## 개발

```bash
pnpm --filter @pdfgpu/core test
pnpm run build
```

PDFGPU는 독립 라이브러리입니다. PDFit 같은 통합 프로젝트는 고정된
릴리스 artifact를 사용하며 서로 다른 릴리스 일정으로 발전할 수 있습니다.

## PDFium 릴리스 계약

`@pdfgpu/core@0.1.0`은 in-memory parser와 rasterizer로
`@embedpdf/pdfium@2.15.1`을 사용합니다. 이 의존성은 `package.json`에서
exact로 선언되고, `pnpm-lock.yaml`에서 resolution과 integrity가 고정되며,
[v0.1.0 릴리스 계약](release-contracts/pdfgpu/v0.1.0.json)에 기록됩니다.

PDFium 업데이트는 PDFGPU 릴리스 변경입니다. 호환 가능한 PDFium patch
업데이트는 `0.1.1`과 같은 새 PDFGPU patch 릴리스를 만들고, 소비자 마이그레이션이
필요한 변경은 `0.2.0`과 같은 새 minor 릴리스로 올립니다. 기존 PDFGPU
릴리스가 조용히 새로운 PDFium 바이너리를 사용하게 두지 않습니다.

자세한 정책은 [릴리스 버전 관리 문서](packages/pdfgpu/docs/release-versioning.md)를
참조하십시오.
