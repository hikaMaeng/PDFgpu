# 테스트 가이드

## 단위/통합

- manifest 추출
- preview 생성
- tile 생성
- abort 전파
- `PdfRasterProvider` 호환 객체가 viewer 큐에서 사용되는지 확인
- 문서 교체 시 큐 정리
- DPI 버킷 반올림
- byte-budget eviction
- 우선순위 큐 순서
- scroll/single/double 상호작용 matrix, keyboard editable target, Ctrl+wheel zoom
- detail 타일 격자가 zoom 0.5/1/2에서 엔진 native raster를 벗어나지 않고 layout 페이지를 빈틈 없이 덮는지 확인 (`tests/detail-tile-coverage.test.mjs`)
- GPU 텍스처 수가 캐시 보유 raster 수를 넘지 않고, `clear`/`delete`/`dispose`에서 전부 파괴되는지 확인 (`tests/gpu-texture-release.test.mjs`, 가짜 WebGPU device)

실행:

```bash
pnpm run verify:release-contract
pnpm --filter @pdfgpu/core test
```

현재 core unit test는 35개입니다. WebGPU 경로는 Playwright 컨테이너에서
`backend: unsupported`로 떨어지므로, 텍스처 수명은 가짜 device를 주입한 단위
테스트로만 검증할 수 있고 브라우저 실행은 2D fallback 무회귀만 보여줍니다. Windows에서도 패키지 소유의 TypeScript
devDependency와 `pnpm install`만으로 `dist`를 재생성할 수 있어야 하며, pack한
tarball의 `files` 목록에는 `dist`, 문서, PDFium vendor 자산만 포함되어야 합니다.
릴리스 계약 검증은 PDFGPU 버전, `@embedpdf/pdfium` exact dependency,
`pnpm-lock.yaml` integrity, PDFium JS/WASM import 경로, 모든 workspace package
버전을 함께 확인합니다.

## Playwright 브라우저 테스트

- 샘플 로드 후 preview 상태 진입 확인
- 공급자 selector에서 `in-memory`, `webapi`, `websocket` 선택 가능 확인
- Web API/WebSocket 공급자의 원격 placeholder raster 수신 확인
- in-memory 샘플 로드 후 뷰어 영역 스크린샷에서 실제 어두운 텍스트 픽셀 존재 확인
- zoom 조작 시 `renderQuality` 갱신 확인
- `fitWidth`, `fitHeight`, `fitPage` 조작 시 상태 갱신 확인
- detail image DPI 슬라이더 조작 시 status의 `DPI` 값과 detail 렌더 요청 버킷 갱신 확인
- `single`/`spread` 전환과 첫 페이지 좌우 배치 상태 확인
- spread 모드에서 같은 row의 두 페이지 shell이 좌우로 배치되는지 확인
- 스크롤 후 visible/active 페이지 detail 타일 재배치 확인
- 빠른 스크롤/ctrl-wheel 입력 후 queue 과부하 없이 canvas와 page shell이 유지되는지 확인
- 로딩 전 페이지 shell placeholder가 유지되고, cache 도착 후 canvas 합성으로 교체되는 구조 확인
- 500페이지급 queue 생성에서 원거리 preview가 등록되지 않고 active/visible/근접 page만 후보가 되는지 확인
- 파일 업로드 재로딩 시 이전 문서 잔상 없음 확인
- WebGPU 미지원 브라우저 노출 경로 확인(브라우저 환경 별도)

- webapi 공급자의 detail 타일 요청 좌표가 zoom 1.0/1.46/2.14에서 엔진 native raster를 벗어나지 않고 격자가 raster 끝까지 닿는지 확인

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
