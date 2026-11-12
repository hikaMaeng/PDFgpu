# 아키텍처

## 패키지 경계

- `packages/pdfgpu/src`가 `@pdfgpu/core`의 단일 소스입니다.
- `apps/pdfgpu`는 provider와 뷰어 계약을 실증하는 샘플 소비자이며 코어의
  런타임 로직을 소유하지 않습니다.
- PDFit은 이 패키지를 `@pdfgpu/core`로만 import하고, 연동 시 `dist`를
  `npm pack`/`pnpm pack`한 tarball과 source commit을 manifest에 고정합니다.
- in-memory PDF parsing/rasterization은 Chromium PDF viewer 계열의 PDFium
  WebAssembly build인 `@embedpdf/pdfium@2.14.0`에 위임합니다. PDFGPU의
  고유 책임은 provider-independent viewer orchestration입니다.
- PDFium 버전 계약은 `release-contracts/pdfgpu/v<version>.json`에 보존되며,
  `scripts/verify-release-contract.mjs`가 package, lockfile, WASM import와
  함께 검증합니다.
- PDFium WASM은 `@embedpdf/pdfium@2.14.0` semver dependency로 해석되며,
  코어 package가 형제 저장소의 파일 경로를 참조하지 않게 합니다.

## 소스 라우터

| Path | Contract |
| --- | --- |
| `src/adapter` | browser/provider adapter boundary |
| `src/engine` | PDFium engine and DPI normalization |
| `src/layout` | manifest-driven page positioning |
| `src/providers` | in-memory, HTTP, and WebSocket raster providers |
| `src/render` | WebGPU/2D frame composition |
| `src/scheduler` | byte-budget cache and bounded render queue |
| `src/types` | PDFium module declarations and public type support |
| `src/viewer` | controller and framework-independent interaction reducer |

## 1) Provider Layer (`engine/`, `providers/`)

- `PdfRasterProvider`는 PDF 파싱/래스터 공급 경계를 소유합니다.
- in-memory 공급자: `createPdfDocumentEngine()`이 PDFium Web Worker 풀을 띄우고, 워커마다 `@embedpdf/pdfium` WASM을 지연 로드해 문서 사본을 엽니다. 래스터는 transfer된 `ImageBitmap`으로 메인 스레드에 돌아옵니다. 워커를 만들 수 없으면 메인 스레드 단일 인스턴스로 동작합니다.
- HTTP 공급자: `createWebApiPdfRasterProvider(endpoint)`가 원격 API에 PDF bytes를 업로드하고 preview/detail 이미지를 요청합니다.
- WebSocket 공급자: `createWebSocketPdfRasterProvider(endpoint)`가 동일 계약을 JSON RPC로 수행합니다.
- 공통 렌더 API:
  - `renderPreview({ pageIndex, signal })`: 페이지 전체를 96 DPI로 렌더
  - `renderTile({ pageIndex, dpi, tileX, tileY, tileWidth, tileHeight, signal })`: 타일 렌더

## 2) Scheduler Layer (`scheduler/`)

- 캐시 키: `kind/pageIndex/dpiBucket/tileX/tileY`
- 캐시 예산: 기본 192MB
- LRU 정책은 byte 기준으로 동작하며, 원거리 프리뷰는 남겨두더라도 현재 ±1 페이지 preview는 보존 우선
- 우선순위 큐:
  1. 현재 visible preview
  2. active page detail
  3. 나머지 visible page detail
  4. visible 기준 ±1 preview
  5. 그 외 preview prefetch

## 3) Viewer Layer (`viewer/`)

- 스크롤 가능한 단일 영역(`region`) 내에 하나의 페이지 컨테이너와 하나의 WebGPU 캔버스를 둡니다.
- 뷰어는 PDF 파싱 구현을 알지 않고 `PdfRasterProvider`만 호출합니다.
- 레이아웃은 공급자와 분리됩니다.
  - `single`: 페이지를 한 장씩 세로 연속 배치
  - `spread`: 2페이지 row를 구성하고 첫 페이지를 왼쪽/오른쪽 슬롯 중 하나에 배치
  - `fitWidth`, `fitHeight`, `fitPage`: 현재 레이아웃 row 기준으로 확대율 계산
- 캔버스는 문서 전체가 아니라 viewport 크기만 유지하고, 스크롤 위치에 맞춰 현재 visible tile만 합성합니다.
- 각 페이지는 shell만 유지:
  - `data-testid="pdfgpu-page-shell"`
  - `data-page-index`
  - `data-render-state`
- 렌더 상태 변경은 shell에서 관리하고, 실제 픽셀은 캔버스 합성으로 표시
- 스크롤/줌/페이지 점프는 raster IO를 기다리지 않습니다. viewport는 manifest 기반 page shell을 즉시 이동시키고, background loader가 완료한 이미지만 cache에서 canvas로 합성합니다.
- background loader는 pending task 우선순위를 계속 갱신하지만 진행 중 IO를 UI thread의 인터랙션 완료 조건으로 삼지 않습니다.
- 대규모 문서에서도 scheduler는 전체 페이지 preview를 큐에 넣지 않습니다. 현재 active/visible/근접 page만 후보로 만들어 스크롤당 작업량을 viewport 크기에 비례시킵니다.
- in-memory PDFium은 아직 실제 Web Worker가 아니라 main thread WASM 경로입니다. 그래서 viewer는 고속 입력 중 새 raster 시작을 멈추고, 입력이 잠잠해진 뒤 1개씩 진행해 스크롤 응답성을 우선합니다.
- `viewer/interaction.ts`는 순수 상태 reducer입니다. `scroll`은 native scroll을
  유지하고 `single`/`double`은 threshold wheel과 PageUp/PageDown을 bounded
  navigation effect로 변환합니다. UI 프레임워크는 이 reducer의 source of truth가
  아닙니다.

## 4) Render Layer (`render/`)

- WebGPU 가능 브라우저에서는 공급자 이미지(`ImageBitmap`/canvas/image)를 GPU texture로 올리고 textured quad render pass로 합성합니다.
- GPU texture는 raster 캐시가 그 raster를 버릴 때 함께 파괴됩니다. 캐시 생성 시 주는 `onRelease` 훅이 유일한 연결점입니다 (`docs/internals.md` GPU 텍스처 소유권).
- WebGPU 미지원 브라우저와 CI는 동일 frame contract를 2D canvas fallback으로 검증합니다.
- 렌더러는 PDF 문서를 열거나 파싱하지 않습니다. 입력은 이미 래스터화된 page/tile 이미지와 viewport 좌표뿐입니다.
