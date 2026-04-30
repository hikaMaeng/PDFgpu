# PDFGPU Viewer v1 검증 계획

## 목표

래스터 공급자 분리 + 타일 렌더 + viewport 크기 WebGPU/2D 합성 파이프라인의
렌더/큐/레이아웃/재로드/원격 공급자 선택 동작을 검증합니다.

## 파이프라인

- 라이브러리 단위 테스트: `pnpm --filter @pdfgpu/core test`
- 앱 빌드: `pnpm run build`
- 배포: `npm run deploy`
- 브라우저 테스트: `docker compose run --rm e2e`

## 테스트 시나리오

1. 샘플 PDF 로드 후 preview 진입
2. provider selector에서 in-memory, web api, websocket 선택 확인
3. Web API/WebSocket 공급자 선택 후 원격 raster placeholder 수신 확인
4. visible 페이지 detail tile 요청으로 상태 업그레이드 확인
5. 줌 인/아웃 시 renderQuality 토큰/상태 변화 확인
6. fit width/height/page 조작 시 fit 상태 변화 확인
7. detail image DPI 슬라이더 조작 시 상태와 detail tile 요청 DPI 갱신 확인
8. single/spread 전환과 첫 페이지 좌우 배치 상태 확인
9. spread row의 두 페이지 shell 좌우 배치 확인
10. 스크롤 시 active page 기준 detail 타일 재배치 확인
11. 로딩 전 page shell placeholder 유지 확인
12. 빠른 스크롤/ctrl-wheel 입력 후 큐 과부하 없이 canvas와 page shell 유지 확인
13. 500페이지급 queue 생성에서 원거리 preview를 만들지 않는지 확인
14. 문서 재업로드 시 이전 캐시/요청 정리 확인
15. WebGPU 미지원/오류 경로 노출 확인

## 로케이터 계약

- toolbar: `getByRole('toolbar', { name: 'viewer controls' })`
- viewer: `getByRole('region', { name: 'PDF viewer' })`
- status: `getByRole('status', { name: 'viewer status' })`
- provider/view/spread/scroll selectors: `getByLabel(...)`
- detail DPI slider: `getByLabel('detail image dpi')`
- page shells: `data-testid="pdfgpu-page-shell"` with `data-page-index`
