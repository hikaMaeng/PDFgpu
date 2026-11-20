# API

## 공급자

- `PdfRasterProvider`
  - `open(source, onProgress?): Promise<PdfDocumentManifest>`
  - `onProgress` receives downloaded byte counts when the source is fetched by the provider.
  - `renderPreview({ pageIndex, signal }): Promise<PdfRasterResult>`
  - `renderTile({ pageIndex, dpi, tileX, tileY, tileWidth, tileHeight, signal }): Promise<PdfRasterResult>`
  - `dispose(): void | Promise<void>`
  - `kind?: 'in-memory' | 'webapi' | 'websocket'`
  - `endpoint?: string`
  - `queueDepth?: number`

- `createPdfDocumentEngine(options?): Promise<PdfDocumentEngine>`
  - 브라우저 in-memory PDFium 공급자입니다. 기본으로 PDFium Web Worker 풀에서
    래스터화합니다. 워커를 만들 수 없으면 메인 스레드로 내려갑니다.
  - `options.poolSize?: number` — 워커 수. 기본 `min(4, hardwareConcurrency - 1)`,
    1..8. 워커마다 문서 사본과 PDFium 힙을 가지므로 메모리가 비례해 늘어납니다.
  - `options.createWorker?: () => Worker` — 워커 생성 함수. 번들러가 기본 워커
    URL을 처리하지 못할 때 직접 지정합니다.
  - `PdfDocumentEngine`은 `PdfRasterProvider`의 호환 alias입니다.

- `createInMemoryPdfRasterProvider(provider)`
  - 사용자 함수/객체 공급자에 `kind: 'in-memory'`를 부여합니다.

- `createWebApiPdfRasterProvider(endpoint)`
  - HTTP 프로토콜:
    - `POST {endpoint}/documents` with `{ bytes: base64Pdf }`
    - `GET {endpoint}/documents/{documentId}/preview?pageIndex=0`
    - `GET {endpoint}/documents/{documentId}/tile?pageIndex=0&dpi=192&tileX=0&tileY=0&tileWidth=512&tileHeight=512`

- `createWebSocketPdfRasterProvider(endpoint)`
  - JSON RPC 메서드: `open`, `renderPreview`, `renderTile`
  - 응답 이미지는 `{ image, contentType, width, height, dpi, pageIndex, kind }` 형태입니다.

## 뷰어

- `createPdfGpuViewer(options): Promise<PdfGpuViewerController>`
  - `options.provider`가 필수입니다.
  - `options.providerKind`는 상태 표시용 공급자 종류입니다.
  - `options.engine`은 이전 호출부 호환용 alias입니다.
  - `options.viewMode`: `'single' | 'spread'`
  - `options.spreadPlacement`: `'first-left' | 'first-right'` (`spreadPairing: 'paired'`에서는 무시)
  - `options.spreadPairing`: `'alone' | 'paired'`, 기본 `'alone'`. `alone` = (1), (2,3), (4,5)…, `paired` = (1,2), (3,4)…
  - `options.fitMode`: `'none' | 'width' | 'height' | 'page'`
  - `options.scrollMode`: `'continuous' | 'page'`
  - `options.detailDpi`: detail tile 래스터 요청 DPI입니다. `144..384` 범위에서 48 DPI 단위로 정규화됩니다.
  - `options.colorAdjustments`: 초기 페이지 표시 색상입니다. `invert` 기본값은 `false`, `brightness` 기본값은 `0`입니다.
  - 공개 메서드:
    - `load(source)`
    - `setZoom(value)`
    - `zoomIn()`
    - `zoomOut()`
    - `setViewMode(mode)`
    - `setSpreadPlacement(placement)`
    - `setSpreadPairing(pairing)` — 런타임 전환. 현재 페이지가 든 새 행의 첫 페이지로 착지하고 구독자에게 알립니다
    - `setFitMode(mode)`
    - `setScrollMode(mode)`
    - `setDetailDpi(dpi)`
    - `setColorAdjustments({ invert?, brightness? })` — 지정한 항목만 갱신하고 WebGPU 페이지를 다시 합성합니다.
    - `fitWidth()`
    - `fitHeight()`
    - `fitPage()`
    - `scrollToPage(index)`
    - `getState()`
    - `subscribe(listener)`
    - `dispose()`

## 상태

- `PdfGpuViewerState`
  - `provider`: `'in-memory' | 'webapi' | 'websocket'`
  - `endpoint`: 원격 공급자 주소
  - `viewMode`: 현재 단일/양쪽 보기
  - `spreadPlacement`: 양쪽 보기에서 첫 페이지 좌우 배치
  - `spreadPairing`: 양쪽 보기 행 구성 `'alone' | 'paired'`
  - `fitMode`: 현재 맞춤 정책
  - `scrollMode`: 현재 스크롤 정책
  - `queueDepth`: 뷰어의 래스터 요청 슬롯 수. 로컬 PDFium은 문서에 배정 가능한 워커를 최대 4개까지 사용합니다. 메인 스레드 폴백은 1, 내장 Web API/WebSocket은 3입니다.
  - `renderQuality`: `'idle' | 'preview' | 'detail'`
  - `detailDpi`: 현재 detail tile 래스터 요청 DPI
  - `colorAdjustments`: 컨트롤러가 제공하는 확정 설정값 `{ invert, brightness }`
  - `backend`: `'webgpu' | 'unsupported' | 'error'`
  - `loadPhase`: `'idle' | 'opening' | 'rendering' | 'ready' | 'error'`
  - `loadProgress`: 0..100 progress for opening and the initial viewport
  - `loadProgressDeterminate`: whether the download response exposed a usable total size
  - `loadedPages` / `loadPageCount`: initial preview pages completed and target count

## 페이지 색상 조정

`@pdfgpu/core`의 `setColorAdjustments`는 preview와 detail 타일에 역상, 밝기, 대비,
채도 순서로 적용합니다. 밝기는 RGB 오프셋 `-1..1`, 대비는 중간 회색을 중심으로 하는
배율 `0..2`, 채도는 휘도를 중심으로 하는 배율 `0..2`입니다. 채도 `0`은 흑백입니다.
각 단계의 채널은 `0..1`로 제한합니다. 부분 입력은 지정한 항목만 바꾸며 유한하지 않은
값은 무시합니다. `setColorAdjustments(DEFAULT_COLOR_ADJUSTMENTS)`로 초기 색상을 복원합니다.
`updateColorAdjustments`와 `sameColorAdjustments`는 동일한 정규화와 비교 규칙을 제공합니다.

효과의 지원 여부는 `backend === 'webgpu'`로 확인합니다. WebGPU 장치가 손실되면
구독자에게 상태 변화를 알리고, 복구된 장치에 현재 설정을 적용합니다. 컨트롤러에서
문서를 교체해도 설정이 유지됩니다. Canvas 2D 경로, 페이지 바깥 영역, DOM 오버레이와
`captureRegion` 결과는 원래 색상을 사용합니다.

## 상호작용 API

`viewer/interaction.ts`의 `createViewerInteractionState`, `reduceViewerInteraction`,
`normalizeViewerPage`, `viewerModeParts`는 package root에서도 export됩니다. 이
reducer는 DOM이나 React에 의존하지 않으므로 소비자별 UI adapter가 같은 페이지
이동·휠·키보드 규칙을 공유할 수 있습니다.
