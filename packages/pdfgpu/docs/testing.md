# 테스트 가이드

## 단위/통합

- manifest 추출
- preview 생성
- tile 생성
- abort 전파
- `PdfRasterProvider` 호환 객체가 뷰어에서 사용되는지 확인
- 문서 교체 시 큐 정리
- DPI 버킷 반올림
- byte-budget eviction
- 우선순위 큐 순서
- scroll/single/double 상호작용 matrix, keyboard editable target, Ctrl+wheel zoom
- detail 타일 격자가 zoom 0.5/1/2에서 엔진 native raster를 벗어나지 않고 layout 페이지를 빈틈 없이 덮는지 확인 (`tests/detail-tile-coverage.test.mjs`)
- GPU 텍스처 수가 캐시 보유 raster 수를 넘지 않고, `clear`/`delete`/`dispose`에서 전부 파괴되는지 확인 (`tests/gpu-texture-release.test.mjs`, 가짜 WebGPU device)
- 프레임이 쌓여도 `createBuffer`/`createBindGroup`/`createView` 호출이 늘지 않고,
  타일마다 공유 정점 버퍼의 제 몫(`firstVertex`)에 올바른 clip 좌표가 쓰이는지 확인
  (`tests/gpu-frame-allocations.test.mjs`, 호출을 세는 가짜 WebGPU device)
- 캡처가 요청 dpi가 아니라 반환 raster의 실제 해상도로 원본 영역을 자르고, 원격
  preview 요청에 dpi가 실리는지 확인 (`tests/capture-source-rect.test.mjs`)
- PDFium `FPDF_REVERSE_BYTE_ORDER` 출력(R,G,B,x)이 그대로 R,G,B,255가 되는지 확인
  (`tests/pdfium-pixels.test.mjs`)
- 예기치 않은 `device.lost` 뒤 같은 캔버스에서 새 장치로 재구성·재업로드하고, 스스로
  destroy한 장치는 재구성하지 않으며, WebGPU 캔버스에 2D context를 요청하지 않는지 확인
  (`tests/gpu-device-loss.test.mjs`)
- 스프레드 짝: 7쪽 행 구성(paired [1,2],[3,4],[5,6],[7] / alone [1],[2,3],[4,5],[6,7]),
  `spreadRows`와 `buildLayout`의 일치(1~9쪽), paired에서 배치 무시, 단독 마지막 페이지의 왼쪽 열,
  모든 페이지의 행 선두 정규화, 행 단위 앞뒤 이동, 전환 착지 (`tests/spread-pairing.test.mjs`).
  기대 행은 리듀서가 아니라 `buildLayout`이 그린 결과에서 읽습니다.
- PDFium 워커 풀: 워커마다 바이트 사본과 첫 워커의 manifest, 동시 렌더(4 워커에서
  최대 4개 동시)와 균등 배정, 첫 워커만 열렸을 때 조기 반환과 준비된 워커에만 배정,
  대기 요청 취소, 늦게 온 비트맵 닫기, 워커 충돌 격리, dispose 종료, 워커 생성 실패 시
  메인 스레드 fallback 시도 (`tests/worker-pool-engine.test.mjs`, 프로토콜을 흉내 내는
  가짜 워커)

실행:

```bash
npm run verify:release-contract
npm run test -w packages/pdfgpu
```

현재 core unit test는 66개입니다. 배포 리포트 파서 테스트 3개는 저장소 루트의
`tests/scripts/deploy-report.test.mjs`에 있습니다(`node --test tests/scripts/*.test.mjs`).

WebGPU 경로는 Playwright 컨테이너에서 `backend: unsupported`로 떨어집니다.
compose의 `e2e` 서비스에 GPU가 전달되지 않기 때문이며(`playwright.config.js`는
`--enable-unsafe-webgpu` 등을 이미 넘기고 있습니다), 따라서 **배포 e2e 통과는 2D
fallback 무회귀만 뜻합니다**. 배포 리포트는 이 사실을 직접 적습니다: `WebGPU path:` 줄이
Playwright가 전달한 `[pdfgpu] render frame {... backend: X}` 로그를 세어
`NOT exercised` / `exercised` / `unknown`을 기록합니다. 뷰어는 프레임 1~3과 매
60프레임만 로그하므로 이 수는 "로그된 프레임" 수입니다. `renderWebGpu`는 그 컨테이너에서 한 줄도 실행되지
않습니다.

실제 WebGPU 경로 검증은 호스트 브라우저에서 합니다. 배포된 스택을 WebGPU가 있는
크롬으로 열고, `GPUDevice`/`GPUTexture`/`GPUBuffer`/`GPUQueue` 프로토타입을 감싸
호출 수를 직접 셉니다(앱 자체 카운터가 아니라 브라우저 API 호출을 세는 것이
요점입니다). 이 절차로 측정한 값은
`tests/reports/pdfgpu-frame-allocations/`에 남깁니다.

Windows에서도 패키지 소유의 TypeScript
devDependency와 `npm install`만으로 `dist`를 재생성할 수 있어야 하며, pack한
tarball의 `files` 목록에는 `dist`, 문서, PDFium vendor 자산만 포함되어야 합니다.
릴리스 계약 검증은 PDFGPU 버전, `@embedpdf/pdfium` exact dependency,
`package-lock.json` integrity, PDFium JS/WASM import 경로, 모든 workspace package
버전을 함께 확인합니다.

## Playwright 브라우저 테스트

- 샘플 로드 후 preview 상태 진입 확인
- 공급자 selector에서 `in-memory`, `webapi`, `websocket` 선택 가능 확인
- Web API/WebSocket 공급자의 원격 placeholder raster 수신 확인
- in-memory 샘플 로드 후 뷰어 영역 스크린샷에서 실제 어두운 텍스트 픽셀 존재 확인
- 빨강·초록·파랑 사각형 PDF(`tests/fixtures/rgb-squares.pdf`)를 업로드해 화면의 세
  위치가 PDF content stream 순서대로 빨강·초록·파랑인지 확인
  (`tests/playwright/pdfgpu-color-order.spec.js`). 흑백 샘플은 R/B가 바뀌어도 똑같이
  보이므로 어두운 픽셀 검사로는 채널 순서를 볼 수 없습니다.
- `tests/playwright/pdfgpu-color-adjustments.spec.js`는 공개 뷰어 API를 통해 WebGPU의
  preview/detail 픽셀, 페이지 바깥 배경, 원본 캡처, 설정 유지와 Canvas 2D 경로를 확인합니다.
  코어 빌드 후 실행하며, `PDFGPU_REQUIRE_WEBGPU=1`이면 WebGPU 어댑터가 없는 환경에서 실패합니다.
- 실제 키 입력으로 single/spread 페이지 모드의 PageDown/PageUp/화살표 이동(스프레드는
  1, 2, 4, 6 착지), continuous 모드에서 키를 가로채지 않음, 상태의 Visible 목록이 뷰어와
  겹치는 shell과 같음을 확인 (`tests/playwright/pdfgpu-navigation.spec.js`). 리듀서 단위
  테스트만으로는 키 분기에 실제로 도달하는지 증명할 수 없어서 브라우저에서 누릅니다.
- 같은 스펙에서 page 모드가 스크롤바식 이동(키 없이 scrollTop 변경)을 따라가는지(옛 행이 일부
  남는 경우 포함), fit height/page에서 페이지 전체가 뷰어 안에 들어오는지, 짝 전환 토글이 행을
  바꾸고 페이지 이동이 새 행을 따르는지 확인.
- zoom 조작 시 `renderQuality` 갱신 확인
- `fitWidth`, `fitHeight`, `fitPage` 조작 시 상태 갱신 확인
- detail image DPI 슬라이더 조작 시 status의 `DPI` 값과 detail 렌더 요청 버킷 갱신 확인
- `single`/`spread` 전환과 첫 페이지 좌우 배치 상태 확인
- spread 모드에서 같은 row의 두 페이지 shell이 좌우로 배치되는지 확인
- 스크롤 후 visible/active 페이지 detail 타일 재배치 확인
- 빠른 스크롤/ctrl-wheel 입력 후 queue 과부하 없이 canvas와 page shell이 유지되는지 확인
- 로딩 전 페이지 shell placeholder가 유지되고, cache 도착 후 canvas 합성으로 교체되는 구조 확인
- 화면 프리뷰의 즉시 발행, 상세 200ms, 프리캐시 500ms, 워커당 한 건, 문서 및 화면 전환을 제어된 시간으로 검증 (`tests/progressive-scheduler.test.mjs`)
- 파일 업로드 재로딩 시 이전 문서 잔상 없음 확인
- WebGPU 미지원 브라우저 노출 경로 확인(브라우저 환경 별도)

- Web API의 상세 요청이 zoom 1.0/1.46/2.14에서 viewport와 겹치는 native raster 타일을 빠짐없이 요청하는지 확인

기본 스펙은 `tests/playwright/pdfgpu-viewer.spec.js`, 타일 좌표계 스펙은
`tests/playwright/pdfgpu-detail-tiles.spec.js`에 있습니다. `tests/e2e/run-e2e.sh`는
개별 스펙 대신 `testDir` 전체(`npx playwright test`)를 실행하므로 새 스펙이
`npm run deploy` 게이트에 자동으로 포함됩니다.

`countDarkPixelsFromPng(...) > 20` 같은 픽셀 합계 게이트는 타일 위치 오류, 채널
순서 오류, 해상도 누락을 잡지 못합니다. 좌표·해상도 계약은 요청 좌표를 직접
관측하는 스펙으로 검증합니다.

## 렌더 진단 로그

- `[pdfgpu] webgpu renderer initialized`: WebGPU context/device 초기화 성공
- `[pdfgpu] render frame`: 합성 프레임 크기와 tile 개수
- `[pdfgpu] webgpu render failed; falling back to 2d`: WebGPU render pass 실패 후 fallback 진입
