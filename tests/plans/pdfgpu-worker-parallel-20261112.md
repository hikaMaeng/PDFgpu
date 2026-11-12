# Test Plan: pdfgpu-worker-parallel (issue #6 (b))

## 대상
in-memory PDFium 래스터화를 Web Worker 풀로 옮겨 병렬화하고 메인 스레드에서 뺀다.

## 판정 기준

issue #6 본문에 미리 고정한 기준:
> (b)를 택하면: 스크롤 중 메인 스레드 long task 시간이 수정 전 대비 감소해야 하며,
> 그 측정은 수정과 같은 변경에 포함된 지표가 아니라 브라우저 Performance API로 한다.

**기준 보강 (구현 전, 기준선 측정 결과로):** 샘플 PDF(글자 몇 줄)로 잰 기준선은
`longtask` 0건이었다 — 래스터화가 가벼워 메인 스레드가 거의 놀고 있었다(하트비트 p95
6ms). 그래서 이 문서로는 기준을 판정할 수 없다. 래스터화가 실제로 무거운 문서
(`tests/fixtures/heavy-vector.pdf`, 6페이지 × 베지어 12,000개, 1.8MB)로 바꾸고, 같은
Performance API 계열 지표를 함께 본다:

| 지표 | 출처 | 판정 |
|---|---|---|
| long task 합계·최대 | `PerformanceObserver('longtask')` | 감소 (원 기준) |
| LoAF blocking 합계 | `PerformanceObserver('long-animation-frame').blockingDuration` | 감소 |
| 하트비트 초과 지연 합계·p95·최대 | 0ms `setTimeout` 연쇄의 (실제 지연 − 4ms) | 감소 |
| 화면 회귀 | 스크린샷, 색 순서 스펙 | 없음 |

## 시나리오 (수정 전/후 동일, 매 회 새 페이지)
1. `http://localhost:51000` 열기, DPI 슬라이더 384, 계측 설치.
2. `heavy-vector.pdf` 업로드 → 4초 → zoom in 6회(150ms 간격) → 4초 →
   스크롤 120px × 40회(16ms 간격) → 5초.

## 알려진 교란
- 이 크롬 창은 유휴 rAF 지연이 ~895ms다(가려진 창의 프레임 제한, visibilityState는
  visible). rAF에 묶인 지표(첫 타일 시간, 업로드 수)는 판정에 쓰지 않는다.
  하트비트(`setTimeout`)와 long task는 rAF와 무관하다.

## 단위
`tests/worker-pool-engine.test.mjs` — 프로토콜을 흉내 내는 가짜 워커. 변이 검사: 배정을
첫 워커 고정으로, 늦은 비트맵 close 제거로 바꿔 각각 실패하는지 확인.

## 재현
```
cd F:\dev\pdfgpu
node --test packages/pdfgpu/tests/*.test.mjs tests/scripts/*.test.mjs
npm run deploy
```
브라우저 측정은 호스트 크롬에서 수동(시나리오 스크립트는 보고서에 기록).
