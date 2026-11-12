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
- `keepKeys`가 지정되면 해당 키는 `prune`에서 보호

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

## 큐

- 스크롤/줌은 입력 debounce 없이 다음 animation frame에서 즉시 viewport/window를 갱신합니다.
- 페이지 shell은 manifest의 페이지 크기로 먼저 배치됩니다. 이미지가 없으면 흰 placeholder로 남고, preview/detail이 도착하면 shell 배경이 투명해져 canvas 합성이 보입니다.
- 가시성/활성 기준 priority를 계산해 전역 pending map에 등록합니다.
- 큐 후보는 active page, visible pages, active 기준 ±2 preview, visible detail로 제한합니다. 전체 페이지를 순회하며 원거리 preview를 등록하지 않습니다.
- background loader는 `queueDepth` 슬롯만큼만 공급자 IO를 실행합니다.
- in-memory PDFium 공급자는 현재 브라우저 main thread WASM 경로이므로 viewer가 동시 실행을 1개로 제한합니다. 원격 Web API/WebSocket 공급자는 최대 3개까지 병렬 요청을 유지할 수 있습니다.
- 고속 스크롤/휠 입력 중에는 새 raster 작업을 시작하지 않습니다. 이미 가진 cache/placeholder만 움직이고, 입력이 약 140ms 동안 잠잠해지면 background loader가 다시 시작됩니다.
- 새 스크롤/페이지 점프가 들어오면 pending map의 우선순위만 재정렬됩니다. 이미 진행 중인 작업은 완료 후 현재 visible 여부를 재평가해 화면에 합성하거나 cache에만 남깁니다.
- pending map은 최대 96개 task만 유지합니다. 대규모 PDF에서 원거리 preview/detail이 무한히 쌓이지 않게 하기 위한 상한입니다.
- 문서 교체처럼 문서 세대가 바뀌는 경우에만 토큰을 증가시켜 이전 작업을 abort합니다.
- viewport window 계산은 페이지 배열 선형 스캔이 아니라 binary search를 사용합니다.
- frame 합성은 cache 전체를 visible page마다 반복 스캔하지 않고, 한 번만 visible detail 항목을 page별로 그룹화합니다.

## PDFium in-memory 공급자

- URL source downloads are read through the response stream. When the server
  provides `Content-Length`, byte progress is reported to the controller and
  mapped to the opening portion of `PdfGpuViewerState.loadProgress`; without a
  total size the consumer receives an indeterminate opening state.
- 문서 open 시 manifest(page count, page size, rotation)는 첫 PDFium document에서 한 번만 추출합니다.
- 렌더 worker용 추가 document들은 같은 manifest를 공유합니다. 500페이지급 문서에서 worker 수만큼 모든 페이지를 다시 여는 일을 피합니다.

## 원격 공급자 프로토콜

- HTTP 공급자는 PDF bytes를 base64 JSON으로 업로드하고 `documentId`를 받습니다.
- preview/detail 요청은 `documentId`와 페이지/DPI/타일 좌표를 전달합니다.
- WebSocket 공급자는 같은 payload를 `{ id, method, payload }` JSON RPC로 보냅니다.
- 원격 이미지는 base64 인코딩된 이미지와 `contentType`을 반환하며, 클라이언트는 `HTMLImageElement`로 디코드합니다.
