# Test Plan: pdfgpu-detail-tile-coordinates

## Created
2026-11-11

## Goal
detail 타일 좌표계 결함(F1) 수정 검증. 큐가 생성하는 detail 타일 좌표가 공급자
native raster 범위를 벗어나거나 페이지에 미치지 못하는 일이 모든 zoom에서
없어야 한다.

## 외부 판정 기준 (수정과 같은 변경에서 작성된 산출물이 아님)

1. 엔진 raster 크기 — `packages/pdfgpu/src/engine/pdfiumEngine.ts:359-361`
   ```
   const scale = request.dpi / 72;
   const pageWidth = roundInt(page.widthPts * scale);
   const pageHeight = roundInt(page.heightPts * scale);
   ```
   zoom과 무관하다.

2. 엔진 clamp — 같은 파일 366-369행
   ```
   const tileX = clamp(Math.floor(request.tileX), 0, Math.max(0, pageWidth - 1));
   const tileWidth = Math.max(1, Math.min(request.tileWidth, pageWidth - tileX));
   ```
   raster를 넘는 요청은 잘려 나가거나 잘못된 영역을 돌려준다.

3. 합성 축척 — `packages/pdfgpu/src/viewer/controller.ts` `applyCompositedFrame`
   ```
   const scale = this.baseScale * BASE_PREVIEW_DPI / entry.dpi;
   left = pageLeft + entry.tileX * scale
   ```
   native → layout 역변환이므로 큐의 native/layout 비율은 이 값의 역수여야 한다.

따라서 올바른 비율은 `(dpi / 96) / baseScale`이고, 수정 전 값
`dpi / 96`은 `baseScale` 한 배수만큼 틀렸다.

## Environment
- OS/shell: Windows 11 / PowerShell · Git Bash
- Deploy entrypoint: `npm run deploy`
- Unit: `node --test packages/pdfgpu/tests/*.test.mjs`
- Browser: Playwright in `docker compose` `e2e` service, 전체 testDir 실행

## Preconditions
- Docker 사용 가능, 포트 `51000` 사용 가능
- `packages/pdfgpu/dist`가 현재 소스로 빌드됨

## Steps

### A. 단위 — `packages/pdfgpu/tests/detail-tile-coverage.test.mjs`
1. letter(612x792pt) 1페이지 layout을 zoom 0.5 / 1 / 2로 생성한다.
2. `buildRenderQueue`에 `detailSourceScale(192, zoom)`을 주고 detail 태스크를 받는다.
3. 기준 1의 공식으로 native raster(1632x2112)를 독립 계산한다.
4. 모든 타일 원점이 raster 안인지 확인한다.
5. 열/행 시작점이 512 간격으로 연속하고 마지막 칸이 raster 끝을 덮는지 확인한다.
6. 기준 2의 clamp + 기준 3의 합성 축척을 적용한 합성 폭/높이가 layout 페이지
   크기와 1px 이내로 같은지 확인한다.

### B. 음성 통제 (단위)
7. 테스트 입력의 `sourceScale`만 수정 전 값(`dpi / 96`)으로 바꿔 실행하고,
   실패가 나오는지 확인한다. 통과하면 테스트가 무효다.

### C. 브라우저 — `tests/playwright/pdfgpu-detail-tiles.spec.js`
8. 배포된 앱에서 공급자를 `webapi`로 바꾼다. 이 경로는 모든 detail 타일 요청을
   `/tile?pageIndex&dpi&tileX&tileY&...` 쿼리로 노출한다.
9. `POST /api/pdfgpu/documents` 응답의 manifest에서 1페이지 `widthPts`,
   `heightPts`를 읽는다 (뷰어 계산을 거치지 않은 값).
10. (zoom, dpi) 쌍 세 개 — 1.00/144, 1.46/240, 2.14/336 — 를 순회한다. zoom마다
    dpi 버킷을 달리해 캐시가 누락 타일을 가리지 못하게 한다.
11. 각 단계에서 관측한 타일 요청에 대해 기준 1의 raster 범위를 벗어난 원점이
    없는지, 격자 오른쪽/아래 끝이 `ceil(native/512)*512`인지 확인한다.

### D. 음성 통제 (브라우저)
12. `detailSourceScale`만 수정 전 수식으로 되돌려 재빌드·재배포하고 C를 실행해
    실패가 나오는지 확인한다.

## Expected Results
- A: 9 assertions 통과, zoom 0.5/1/2 모두.
- B: 실패 발생 (zoom 1은 통과, 0.5와 2에서 실패).
- C: 통과, 세 (zoom, dpi) 단계 모두.
- D: 실패 발생.
- `npm run deploy`: 빌드 · compose 재기동 · health · Playwright 전부 통과.

## Logs To Capture
- `node --test` 출력 (통과 수, B의 실패 메시지)
- 배포 전/후 Playwright 출력과 `[tiles]` 관측 줄
- `npm run deploy`가 생성한 리포트 경로
