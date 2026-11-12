# 내부 동작

## DPI 버킷

`normalizeDetailDpi(rawDpi)`:
- `round(rawDpi / 48) * 48`로 반올림
- `144~384` 구간으로 clamp
- preview는 항상 `96` 유지

## 상호작용 상태

- `viewer/interaction.ts`가 mode, page, pageCount, wheel accumulation을 보유합니다.
- `reduceViewerInteraction`은 navigation/zoom effect를 반환하고 DOM을 직접
  변경하지 않습니다.
- controller는 reducer 상태를 `PdfGpuViewerState`로 projection하며, React나
  샘플 앱이 별도 페이지 계산을 복제하지 않습니다.

## 타일 좌표계

detail 타일은 **공급자의 native raster 좌표**로 요청하고, 합성할 때 layout
좌표로 되돌립니다. 두 축척은 서로 역수여야 합니다.

- layout 페이지 크기: `widthPts * 96 / 72 * baseScale` (= zoom 포함)
- 엔진 native raster 크기: `round(widthPts * dpi / 72)` (zoom 무관)
- 큐가 쓰는 native/layout 비율: `detailSourceScale(dpi, baseScale)` =
  `(dpi / 96) / baseScale`
- 합성이 쓰는 layout/native 비율: `baseScale * 96 / dpi`

`baseScale`을 빼면 zoom > 1에서 타일 격자가 raster를 넘어서고(엔진이 clamp
하거나 버리는 요청), zoom < 1에서는 페이지에 미치지 못해 남은 영역이 96 DPI
preview로 남습니다. zoom 0.5 / 1 / 2 회귀 테스트가
`tests/detail-tile-coverage.test.mjs`에 있습니다.

## 캐시

- 키는 `kind/pageIndex/dpiBucket/tileX/tileY`
- 엔트리 바이트 산정: `width * height * 4`
- 기본 한도: `192 * 1024 * 1024` bytes
- `prune(keepKeys)`는 이름과 달리 keep 밖 항목을 전부 지우지 않습니다. 예산 이하이면
  아무것도 하지 않고, 예산을 넘으면 keep 밖에서 가장 오래된 항목부터 예산에
  맞을 때까지 축출합니다(보호 집합이 있는 LRU).
- 의도된 동작입니다. keep 집합은 보이는 페이지와 활성 ±1만 담으므로, 엄격하게
  지우면 두 페이지만 떨어져도 되돌아올 때 다시 래스터화합니다. 크롬 실측
  (WebGPU, 확대, DPI 384): 세 화면을 되돌아가는 동안 새 텍스처 업로드 0건.
- GPU 텍스처는 `onRelease`로 같은 수명을 따르므로 GPU 메모리도 이 예산에 묶입니다.

## GPU 텍스처 소유권

- 키: raster `source` 객체 동일성. 범위: `PageRenderer` 인스턴스 1개당 source 1개.
- 생성: 해당 source가 프레임에 처음 그려질 때 `copyExternalImageToTexture` 1회.
- 해제: `RasterCache`에서 그 raster가 빠질 때(축출 · `delete` · `clear` ·
  같은 키 교체) `onRelease` 훅이 `PageRenderer.releaseTexture(source)`를
  호출합니다. 그 밖에 해제하는 경로는 `dispose()`뿐입니다.
- 상한: raster 캐시의 byte budget. 프레임에 그려지는 source는 모두 살아 있는
  캐시 항목이므로 GPU 바이트가 캐시 바이트를 따라갑니다. 현재 보유량은
  `gpuTextureCount` / `gpuTextureBytes`로 읽습니다.
- `WeakMap`으로는 이 일을 할 수 없습니다. 엔트리가 `source`를 들고 있어서,
  엔트리를 담는 강한 컬렉션이 하나라도 있으면 모든 키가 함께 살아남습니다.
  이 때문에 이전 구현은 캐시가 버린 raster의 텍스처를 영구히 보유했습니다
  (측정: raster 200개 삽입 시 생성 200 · 파괴 0 · 캐시 보유 10 → 190개 누수).

## 프레임당 GPU 객체

`renderWebGpu`는 프레임마다 command encoder 1개, 스왑체인 view 1개, submit 1회만
새로 만듭니다. 타일에 묶인 것은 전부 프레임보다 오래 삽니다.

- 텍스처 view와 bind group은 `GpuTextureEntry`에 한 번 만들어 보관합니다. 둘 다
  텍스처 · sampler · pipeline 레이아웃에만 의존하고 셋 다 텍스처가 사는 동안
  바뀌지 않습니다. `bindGroupPipeline`에 어느 pipeline으로 만들었는지 기록해,
  렌더러가 pipeline을 다시 만들면 낡은 bind group을 교체합니다.
- 정점 데이터는 프레임의 모든 타일을 **하나의 버퍼**에 담고 타일마다
  `draw(6, 1, firstVertex)`로 제 몫을 그립니다. 버퍼는 더 큰 프레임이 올 때만
  재할당되며 단조 증가하므로, 타일 수가 안정되면 할당이 멈춥니다.

이전 구현은 타일마다 매 프레임 `createBuffer` · `writeBuffer` ·
`createBindGroup` · `createView`를 새로 했습니다. 실제 크롬에서 275프레임 구간에
`createBuffer` 34,821회(프레임당 126.6)가 관측됐습니다. 같은 조작에서 수정 후는
269프레임에 160회(프레임당 0.59)입니다.

## GPU 장치 상실

- `device.lost`가 `'destroyed'` 외의 이유로 풀리면(GPU 프로세스 재시작 등) 같은
  캔버스에 새 adapter/device를 요청해 context를 다시 configure합니다. 죽은 장치의
  텍스처는 `destroy()` 없이 버리고, 캐시의 raster에서 다음 프레임에 다시 올립니다.
  복구되면 `onDeviceRestored`로 뷰어에 다시 그리기를 요청합니다.
- `webgpu` context를 받은 캔버스는 2D context를 줄 수 없습니다. 그래서 WebGPU 렌더가
  실패해도 그 캔버스에 2D fallback을 시도하지 않고 프레임을 건너뜁니다. 이전
  구현은 이 경우 매 프레임 `'2d context unavailable'`을 던졌습니다. 2D 경로는
  WebGPU를 처음부터 쓸 수 없던 경우(`unsupported`)에만 씁니다.

## 상태 알림

- `renderCycle`은 스크롤 중 매 animation frame마다 `notify()`를 부릅니다. 모든 상태
  필드(원시값, `visiblePages`는 원소 비교)가 직전 스냅샷과 같으면 구독자를 부르지
  않습니다. React 소비자가 같은 상태로 매 프레임 전체를 다시 렌더링하던 것을
  막기 위한 것입니다. 상태에 중첩 객체가 없으므로 제자리 수정이 묻힐 일은 없습니다.

## 보이는 페이지

- `visiblePages`는 뷰포트 `[scrollTop, scrollTop + clientHeight)`와 실제로 겹치는
  페이지입니다(`layout.ts` `visiblePageIndices`). 디테일 타일 발주와 합성은 이 페이지에만
  합니다. 오버스캔 창(위아래 뷰포트 `overscanPages`개) 전체는 `windowPageIndices`로 따로
  구해 page shell을 미리 배치하는 데만 씁니다.
- 이전 필터 `top + height >= 0`은 문서 좌표에서 항상 참이라 오버스캔 창 전체가
  "보이는" 페이지였습니다. 크롬 실측(110%, scrollTop 5000, 화면 위 페이지 2개): 디테일
  요청 89건 중 60건이 화면 밖 페이지 → 수정 후 40건 전부 화면 위.

## 스프레드 행과 페이지 이동

- 스프레드 행은 두 배치 모두 [1], [2,3], [4,5], …(1 기준)입니다. `normalizeViewerPage`는
  double 모드에서 페이지를 그 행의 첫 페이지로 보냅니다(1, 2, 4, 6, …). 이전 규칙(홀수가
  행 선두)은 3페이지를 행 [2,3]의 오른쪽에 착지시키고 2페이지를 1로 되돌렸습니다.
- 행 구성(`spreadPairing`, `layout.ts` `spreadRows`): `alone`(기본) = (1), (2,3), (4,5)…,
  `paired` = (1,2), (3,4)…. `buildLayout`, `normalizeViewerPage(page, count, mode, pairing)`,
  `createViewerInteractionState({ pairing })`/`reduceViewerInteraction`, 컨트롤러의
  `scrollToPage`와 fit 행 크기가 모두 같은 함수를 따릅니다. 키·휠은 ±2 후 행 선두로 정규화하므로
  두 구성 모두 "다음 행의 첫 페이지"가 됩니다(마지막 홀수 페이지 포함).
- `paired`에서는 `spreadPlacement`를 무시합니다. 1페이지는 항상 (1,2) 행의 왼쪽입니다.
- 짝이 없는 마지막 페이지는 가운데가 아니라 2페이지 행의 왼쪽 슬롯에 놓여 위 행들의 왼쪽 열에
  맞춰집니다(0.1.11부터).
- `setSpreadPairing` 전환은 현재 페이지가 든 새 행의 첫 페이지로 착지합니다(alone (2,3) →
  paired (1,2)). 착지한 행의 첫 페이지가 새 기준이 되므로 왕복하면 앞쪽으로 밀릴 수 있습니다
  (page 모드 (2,3) → (1,2) → (1)).
- 스프레드 첫 페이지는 두 배치 모두 2페이지 행 폭의 한 슬롯에 놓입니다(first-left는 왼쪽
  열, first-right는 오른쪽 열). 이전에는 first-left가 페이지를 가운데에 놓았습니다.
- page 모드의 현재 페이지: 컨트롤러는 자기 이동(`scrollToPage`)이 남긴 scrollTop을 기준점으로
  기억합니다. scrollTop이 그와 1px 넘게 다르면 사용자가 스크롤바 등으로 움직인 것이므로 가운데
  페이지를 따라갑니다. 마지막 행처럼 가운데로 올 수 없는 위치도 이동 결과는 그대로 유지됩니다.
  이전에는 스크롤바로 2~3페이지를 봐도 상태가 8에 남고 PageDown이 10으로 갔습니다.
- fit width/height/page는 viewport의 client 크기에서 padding을 뺀 콘텐츠 영역으로 계산합니다.
  이전에는 padding만큼(데모 앱 위아래 6px) 페이지가 넘쳤습니다.
- 키보드: 컨트롤러가 viewport `keydown`을 reducer로 보냅니다. `single`/`double`에서
  PageUp/PageDown/화살표가 페이지 이동이 되고, `scroll`에서는 가로채지 않아 브라우저의
  기본 스크롤이 동작합니다. 편집 가능한 대상의 키와 Ctrl/Alt/Meta 조합은 무시합니다.

## 큐

- 스크롤/줌은 입력 debounce 없이 다음 animation frame에서 즉시 viewport/window를 갱신합니다.
- 페이지 shell은 manifest의 페이지 크기로 먼저 배치됩니다. 이미지가 없으면 흰 placeholder로 남고, preview/detail이 도착하면 shell 배경이 투명해져 canvas 합성이 보입니다.
- 가시성/활성 기준 priority를 계산해 전역 pending map에 등록합니다.
- 큐 후보는 active page, visible pages, active 기준 ±2 preview, visible detail로 제한합니다. 전체 페이지를 순회하며 원거리 preview를 등록하지 않습니다.
- background loader는 `queueDepth` 슬롯만큼만 공급자 IO를 실행합니다.
- in-memory 공급자의 동시 실행 수는 엔진의 `queueDepth`(워커 풀 크기, 최대 8; 메인 스레드 fallback은 1)를 따릅니다. 원격 Web API/WebSocket 공급자는 최대 3개까지 병렬 요청을 유지할 수 있습니다.
- 고속 스크롤/휠 입력 중에는 새 raster 작업을 시작하지 않습니다. 이미 가진 cache/placeholder만 움직이고, 입력이 약 140ms 동안 잠잠해지면 background loader가 다시 시작됩니다.
- 새 스크롤/페이지 점프가 들어오면 pending map의 우선순위만 재정렬됩니다. 이미 진행 중인 작업은 완료 후 현재 visible 여부를 재평가해 화면에 합성하거나 cache에만 남깁니다.
- pending map은 최대 96개 task만 유지합니다. 대규모 PDF에서 원거리 preview/detail이 무한히 쌓이지 않게 하기 위한 상한입니다.
- 문서 교체처럼 문서 세대가 바뀌는 경우에만 토큰을 증가시켜 이전 작업을 abort합니다.
- viewport window 계산은 페이지 배열 선형 스캔이 아니라 binary search를 사용합니다.
- frame 합성은 cache 전체를 visible page마다 반복 스캔하지 않고, 한 번만 visible detail 항목을 page별로 그룹화합니다.

## PDFium in-memory 공급자

- 렌더 플래그는 `FPDF_REVERSE_BYTE_ORDER`(0x10)입니다. PDFium이 이미 R,G,B,x 순서로
  출력하므로 JS 변환은 4번째 바이트만 255로 채웁니다(`engine/pixels.ts`). 이전
  구현은 플래그 위에 R/B를 한 번 더 바꿔 빨강이 파랑으로 보였습니다. 변환이
  렌더러 앞에 있으므로 WebGPU와 2D 두 경로 모두에 해당했습니다.

- URL source downloads are read through the response stream. When the server
  provides `Content-Length`, byte progress is reported to the controller and
  mapped to the opening portion of `PdfGpuViewerState.loadProgress`; without a
  total size the consumer receives an indeterminate opening state.
- 문서 open 시 manifest(page count, page size, rotation)는 첫 PDFium document에서 한 번만 추출합니다.
- 기본 엔진은 **워커 풀**입니다(`engine/workerPoolEngine.ts`). 워커마다 전용 Web
  Worker(`engine/pdfiumWorkerMain.ts`)에 자기 PDFium WASM 인스턴스와 문서 사본을
  가지므로, 풀 크기만큼 동시에 래스터화하고 래스터화는 메인 스레드에서 돌지
  않습니다. 결과는 transfer된 `ImageBitmap`이라 `copyExternalImageToTexture`에
  바로 씁니다.
- 풀 크기: `poolSize` 또는 `min(4, hardwareConcurrency - 1)`, 1..8로 제한. 메모리는
  풀 크기에 비례합니다 — 워커마다 파일 전체와 PDFium 힙을 갖습니다.
- `open()`: 첫 워커가 manifest를 추출하고 나머지는 그 manifest를 받아 페이지를 다시
  훑지 않습니다. 워커마다 바이트 사본을 따로 transfer합니다. 첫 워커가 열리면
  바로 반환하고 나머지는 백그라운드에서 열며, 렌더는 현재 문서를 연 워커에만
  배정합니다.
- 배정: 응답을 기다리는 요청이 가장 적은 워커. 워커 안에서는 요청을 직렬로
  처리합니다(PDFium 상태를 공유하므로).
- 취소: 시작 전이면 워커가 건너뛰고 `AbortError`로 답합니다. 이미 렌더 중이면
  호출자는 즉시 `AbortError`를 받고, 나중에 도착한 비트맵은 닫힙니다.
- 워커가 `error`를 내면 그 워커의 대기 요청만 실패하고 그 워커는 배정에서
  빠집니다. 나머지 워커는 계속 일합니다.
- 워커를 만들 수 없으면(`Worker` 없음, CSP 등) 메인 스레드 엔진으로 내려갑니다.
  이 경우 문서 사본은 1개이고 `queueDepth`는 1입니다.
- 패키징: 소스는 `new Worker(new URL('./pdfiumWorkerMain.ts', import.meta.url),
  { type: 'module' })`로 워커를 만듭니다. Vite는 실제 파일을 가리키는 경로만 워커로
  인식하는데 앱이 이 패키지를 소스로 번들하므로 `.ts`여야 하고, `tsc`가 문자열을
  바꾸지 않으므로 `scripts/rewrite-worker-url.mjs`가 빌드 후 `dist`의 경로를
  `.js`로 고칩니다. 워커가 PDFium을 `import()`로 지연 로드하므로 Vite 소비자는
  `worker: { format: 'es' }`가 필요합니다.

## 원격 공급자 프로토콜

- HTTP 공급자는 PDF bytes를 base64 JSON으로 업로드하고 `documentId`를 받습니다.
- preview/detail 요청은 `documentId`와 페이지/DPI/타일 좌표를 전달합니다.
- WebSocket 공급자는 같은 payload를 `{ id, method, payload }` JSON RPC로 보냅니다.
- preview 요청도 `dpi`가 있으면 전달합니다(HTTP query `dpi`, WebSocket payload
  `dpi`). 이전에는 두 공급자 모두 preview dpi를 버렸습니다.
- 서버는 요청 dpi와 다른 해상도로 답할 수 있습니다(동봉 데모 서버는 preview를
  항상 96 DPI로 돌려줍니다). 그래서 캡처는 요청 dpi가 아니라 **반환된 raster의
  실제 크기/페이지 포인트**로 원본 영역을 잘라냅니다(`viewer/capture.ts`).

## 소유권

- 컨트롤러가 공급자를 소유합니다. `controller.dispose()`가 공급자 · 렌더러 ·
  캐시를 정리하며, 소비자는 공급자를 따로 dispose하지 않습니다.
- `dispose()`는 멱등입니다. 두 번째 호출은 아무것도 하지 않습니다.
- 원격 이미지는 base64 인코딩된 이미지와 `contentType`을 반환하며, 클라이언트는 `HTMLImageElement`로 디코드합니다.
