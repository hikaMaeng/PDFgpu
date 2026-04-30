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

실행:

```bash
pnpm --filter @pdfgpu/core test
```

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

기본 스펙은 `tests/playwright/pdfgpu-viewer.spec.js`에 명시되어 있습니다.

## 렌더 진단 로그

- `[pdfgpu] webgpu renderer initialized`: WebGPU context/device 초기화 성공
- `[pdfgpu] render frame`: 합성 프레임 크기와 tile 개수
- `[pdfgpu] webgpu render failed; falling back to 2d`: WebGPU render pass 실패 후 fallback 진입
