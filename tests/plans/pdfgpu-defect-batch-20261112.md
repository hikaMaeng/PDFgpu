# Test Plan: pdfgpu-defect-batch (issues #4 #5 #6 #7 #8, 색 순서)

## 대상과 판정 기준 (각 기준은 수정 전에 이슈 본문 또는 여기 고정)

| 대상 | 외부 기준 | 측정 |
|---|---|---|
| #4 prune | 이슈 #4 기준: 예산 10%에서 prune하면 keep 밖 전부 제거 | 크롬: 되돌아가기 스크롤 중 새 업로드 수 |
| #5 캔버스 재대입 | 이슈 #5 기준: 같은 시나리오에서 `canvasSetSameValue` 0, 화면 회귀 없음 | 크롬 `HTMLCanvasElement` 접근자 계측 |
| #6 가짜 풀 | 이슈 #6 (a): 문서 사본 1개, 기존 e2e·단위 회귀 없음 | 코드 + e2e |
| #7 게이트 | 이슈 #7: GPU 없는 환경에서 리포트에 "WebGPU 미검증" 명시 | 실제 `npm run deploy` 리포트 |
| 색 순서 | 테스트 PDF content stream: 왼쪽부터 `1 0 0 rg` / `0 1 0 rg` / `0 0 1 rg` | 크롬 스크린샷 + 새 Playwright 스펙 |
| 원격 preview dpi | HTTP preview 요청에 tile과 같이 `dpi` query가 실림 | 가짜 fetch로 실제 URL 관측 |
| 캡처 영역 | DPI 정의: 72pt = dpi px. 데모 서버 preview = 816x1056 (96 DPI) | 단위 |
| 이중 dispose | `docs/usage.md:41` "dispose()는 공급자/랜더러/캐시를 정리" | 크롬 공급자 전환 16회 |

## 음성 통제
- 색 순서: `pdfiumEngine.ts`만 되돌려 빌드·재기동 후 색 스펙 단독 실행 → 실패해야 함.
- 원격 dpi: `remote.ts`만 되돌려 재빌드 후 단위 실행 → 실패해야 함.

## 재현
```
cd F:\dev\pdfgpu
node --test packages/pdfgpu/tests/*.test.mjs tests/scripts/*.test.mjs
npm run deploy
```
브라우저 WebGPU 계측은 호스트 크롬(WebGPU 있음)에서 수동으로 한다.
