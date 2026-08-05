`@pdfgpu/core` is a provider-independent, progressive PDF viewer core for the web.

<div align="center">
  <h1>@pdfgpu/core</h1>
  <p>Keep the viewer. Change the PDF backend.</p>
</div>

## Highlights

- Progressive preview and viewport-driven detail tiles.
- In-memory PDFium, HTTP, and WebSocket providers behind one contract.
- WebGPU composition with Canvas 2D fallback.
- Visibility-aware scheduling, cancellation, and byte-budgeted caching.
- No React dependency; framework-independent interaction state.

## Install

```json
{
  "dependencies": {
    "@pdfgpu/core": "https://github.com/hikaMaeng/PDFgpu/releases/download/v0.1.0/pdfgpu-core-0.1.0.tgz"
  }
}
```

## Minimal usage

```ts
import {
  createPdfDocumentEngine,
  createPdfGpuViewer
} from '@pdfgpu/core';

const provider = await createPdfDocumentEngine();
const container = document.querySelector<HTMLElement>('#viewer');
if (!container) throw new Error('viewer container is missing');

const viewer = await createPdfGpuViewer({
  container,
  provider,
  detailDpi: 192
});

await viewer.load('/document.pdf');
```

Replace the provider to move rendering to a service:

```ts
import { createWebApiPdfRasterProvider } from '@pdfgpu/core';

const provider = createWebApiPdfRasterProvider('/api/pdfgpu');
```

## Documentation

| Goal | Documentation |
| --- | --- |
| Understand the package boundary | [Overview](docs/overview.md) |
| Locate source ownership | [Architecture](docs/architecture.md) |
| Integrate the public API | [API reference](docs/api.md) |
| Build local or remote viewers | [Usage](docs/usage.md) |
| Check consumer obligations | [Constraints](docs/constraints.md) |
| Understand scheduling and caching | [Internals](docs/internals.md) |
| Run package and browser tests | [Testing](docs/testing.md) |

PDFGPU `v0.1.0` is available as the exact
[GitHub Release artifact](https://github.com/hikaMaeng/PDFgpu/releases/tag/v0.1.0).

---

# 한국어

`@pdfgpu/core`는 웹을 위한 공급자 독립형 progressive PDF 뷰어 코어입니다.

<div align="center">
  <h1>@pdfgpu/core</h1>
  <p>뷰어는 유지하고 PDF backend만 교체하십시오.</p>
</div>

## 핵심 기능

- progressive preview와 viewport 기반 detail tile
- 하나의 계약 뒤에 연결되는 in-memory PDFium, HTTP, WebSocket provider
- WebGPU 합성과 Canvas 2D fallback
- 가시성 기반 scheduling, 취소, byte-budget cache
- React 비의존 및 프레임워크 독립 interaction state

## 설치

```json
{
  "dependencies": {
    "@pdfgpu/core": "https://github.com/hikaMaeng/PDFgpu/releases/download/v0.1.0/pdfgpu-core-0.1.0.tgz"
  }
}
```

## 최소 사용법

```ts
import {
  createPdfDocumentEngine,
  createPdfGpuViewer
} from '@pdfgpu/core';

const provider = await createPdfDocumentEngine();
const container = document.querySelector<HTMLElement>('#viewer');
if (!container) throw new Error('viewer container is missing');

const viewer = await createPdfGpuViewer({
  container,
  provider,
  detailDpi: 192
});

await viewer.load('/document.pdf');
```

provider만 바꾸면 렌더링을 원격 서비스로 이동할 수 있습니다.

```ts
import { createWebApiPdfRasterProvider } from '@pdfgpu/core';

const provider = createWebApiPdfRasterProvider('/api/pdfgpu');
```

## 문서

| 목적 | 문서 |
| --- | --- |
| 패키지 경계 이해 | [개요](docs/overview.md) |
| 소스 책임 확인 | [아키텍처](docs/architecture.md) |
| 공개 API 통합 | [API](docs/api.md) |
| local/remote viewer 구성 | [사용 방법](docs/usage.md) |
| 소비자 의무 확인 | [제약 사항](docs/constraints.md) |
| scheduling과 caching 이해 | [내부 동작](docs/internals.md) |
| 패키지와 브라우저 테스트 실행 | [테스트](docs/testing.md) |

PDFGPU `v0.1.0`은 정확한
[GitHub Release artifact](https://github.com/hikaMaeng/PDFgpu/releases/tag/v0.1.0)로
사용할 수 있습니다.
