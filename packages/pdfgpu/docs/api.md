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
  - `options.spreadPlacement`: `'first-left' | 'first-right'`
  - `options.fitMode`: `'none' | 'width' | 'height' | 'page'`
  - `options.scrollMode`: `'continuous' | 'page'`
  - `options.detailDpi`: detail tile 래스터 요청 DPI입니다. `144..384` 범위에서 48 DPI 단위로 정규화됩니다.
  - 공개 메서드:
    - `load(source)`
    - `setZoom(value)`
    - `zoomIn()`
    - `zoomOut()`
    - `setViewMode(mode)`
    - `setSpreadPlacement(placement)`
    - `setFitMode(mode)`
    - `setScrollMode(mode)`
    - `setDetailDpi(dpi)`
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
  - `fitMode`: 현재 맞춤 정책
  - `scrollMode`: 현재 스크롤 정책
  - `queueDepth`: 실제 동시 래스터 요청 수. in-memory 공급자는 워커 풀 크기(메인 스레드 fallback은 1), 원격 공급자는 3(내장 Web API/WebSocket 공급자가 `queueDepth = 3`을 선언)
  - `renderQuality`: `'idle' | 'preview' | 'detail'`
  - `detailDpi`: 현재 detail tile 래스터 요청 DPI
  - `backend`: `'webgpu' | 'unsupported' | 'error'`
  - `loadPhase`: `'idle' | 'opening' | 'rendering' | 'ready' | 'error'`
  - `loadProgress`: 0..100 progress for opening and the initial viewport
  - `loadProgressDeterminate`: whether the download response exposed a usable total size
  - `loadedPages` / `loadPageCount`: initial preview pages completed and target count

## 상호작용 API

`viewer/interaction.ts`의 `createViewerInteractionState`, `reduceViewerInteraction`,
`normalizeViewerPage`, `viewerModeParts`는 package root에서도 export됩니다. 이
reducer는 DOM이나 React에 의존하지 않으므로 소비자별 UI adapter가 같은 페이지
이동·휠·키보드 규칙을 공유할 수 있습니다.
