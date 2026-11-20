# 아키텍처

## 패키지 경계

- `packages/pdfgpu/src`가 `@pdfgpu/core`의 단일 소스입니다.
- `apps/pdfgpu`는 provider와 뷰어 계약을 실증하는 샘플 소비자이며 코어의
  런타임 로직을 소유하지 않습니다.
- PDFit은 이 패키지를 `@pdfgpu/core`로만 import하고, 연동 시 `dist`를
  `npm pack`/`pnpm pack`한 tarball과 source commit을 manifest에 고정합니다.
- in-memory PDF parsing/rasterization은 Chromium PDF viewer 계열의 PDFium
  WebAssembly build인 `@embedpdf/pdfium@2.15.1`에 위임합니다. PDFGPU의
  고유 책임은 provider-independent viewer orchestration입니다.
- PDFium 버전 계약은 `release-contracts/pdfgpu/v<version>.json`에 보존되며,
  `scripts/verify-release-contract.mjs`가 package, lockfile, WASM import와
  함께 검증합니다.
- PDFium WASM은 `@embedpdf/pdfium@2.15.1` semver dependency로 해석되며,
  코어 package가 형제 저장소의 파일 경로를 참조하지 않게 합니다.

## 소스 라우터

| Path | Contract |
| --- | --- |
| `src/adapter` | browser/provider adapter boundary |
| `src/engine` | PDFium engine and DPI normalization |
| `src/layout` | manifest-driven page positioning |
| `src/providers` | in-memory, HTTP, and WebSocket raster providers |
| `src/render` | WebGPU/2D frame composition |
| `src/scheduler` | latest viewport scheduling and byte-budgeted raster caches |
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
- 캐시는 프리뷰 64 MiB와 상세 타일 128 MiB를 사용합니다. 사전 로딩은 화면에 보이는 프리뷰와 더 가까운 프리뷰를 보호합니다.
- 화면 프리뷰는 즉시 검토합니다. 상세 타일은 화면이 200ms 안정된 후, 양방향 프리캐시는 이동이 500ms 멈춘 후 시작합니다.
- 스케줄러는 최신 viewport, 방향별 탐색 위치와 진행 중인 요청만 유지합니다. 상세 타일의 범위는 현재 viewport와 겹치는 영역입니다.

## 3) Viewer Layer (`viewer/`)

- 스크롤 가능한 단일 영역(`region`) 내에 하나의 페이지 컨테이너와 하나의 WebGPU 캔버스를 둡니다.
- 파싱과 래스터화는 `PdfRasterProvider`가 담당합니다. 기본 PDFium 워커 풀은 뷰어에 빈 슬롯을 직접 제공합니다.
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
- 로컬 앱의 PDFium 워커 4개는 전진 프리뷰, 후진 프리뷰, 상세 A, 상세 B를 맡습니다. 뷰어 스케줄러는 워커마다 응답을 받은 뒤 다음 요청을 발행합니다.
- 프리캐시는 캐시 슬롯과 메모리에 여유가 있는 동안 각 방향으로 한 장씩 확장합니다. 메인 스레드 및 원격 공급자는 앞뒤 두 장으로 제한합니다.
- `viewer/interaction.ts`는 순수 상태 reducer입니다. `scroll`은 native scroll을
  유지하고 `single`/`double`은 threshold wheel과 PageUp/PageDown을 bounded
  navigation effect로 변환합니다. 컨트롤러가 viewport의 `wheel`과 `keydown`을 이
  reducer로 보냅니다(입력란 등 편집 가능한 대상의 키는 가로채지 않음). UI 프레임워크는
  이 reducer의 source of truth가 아닙니다.

## 4) Render Layer (`render/`)

- WebGPU 가능 브라우저에서는 공급자 이미지(`ImageBitmap`/canvas/image)를 GPU texture로 올리고 textured quad render pass로 합성합니다.
- GPU texture는 raster 캐시가 그 raster를 버릴 때 함께 파괴됩니다. 캐시 생성 시 주는 `onRelease` 훅이 유일한 연결점입니다 (`docs/internals.md` GPU 텍스처 소유권).
- WebGPU 미지원 브라우저와 CI는 동일 frame contract를 2D canvas fallback으로 검증합니다.
- 렌더러는 PDF 문서를 열거나 파싱하지 않습니다. 입력은 이미 래스터화된 page/tile 이미지와 viewport 좌표뿐입니다.
