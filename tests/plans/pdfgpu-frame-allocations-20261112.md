# Test Plan: pdfgpu-frame-allocations

## 대상
`renderWebGpu`가 타일마다 매 프레임 GPU 객체를 새로 만드는 문제(issue #3) 수정.

## 판정 기준 (결과 전에 고정, issue #3 본문에 기록)
같은 조작 시나리오를 같은 방식으로 계측해:

| 지표 | 기준 | 수정 전 실측 |
|---|---|---|
| `createView / submit` | <= 2 | 127.6 |
| `createBindGroup / submit` | <= 5 | 126.6 |
| `createBuffer / submit` | <= 5 | 126.6 |
| `createTexture`, 화면 출력 | 회귀 없음 | 261 |

기준은 이 렌더러의 코드가 아니라 **WebGPU 프레임이 실제로 필요로 하는 것**에서
나왔다. textured-quad 패스가 프레임마다 반드시 새로 만들어야 하는 것은 command
encoder 1개, 스왑체인 view 1개, submit 1회뿐이다. sampler · pipeline · 텍스처의
view · 그 둘을 묶는 bind group · 기하가 변하지 않는 타일의 정점 데이터는 모두
프레임보다 오래 사는 객체에만 의존하므로, 프레임마다 다시 만드는 것은 churn이다.

## 계측 방법 (외부 기준)
앱이 보고하는 카운터를 쓰지 않는다. 브라우저의 `GPUDevice` · `GPUTexture` ·
`GPUBuffer` · `GPUQueue` · `GPUCanvasContext` 프로토타입 메서드를 감싸 **호출
자체를 센다**. 캔버스 크기 재대입은 `HTMLCanvasElement.prototype`의
`width`/`height` 접근자를 가로채 이전 값과 비교해 "값이 바뀐 대입"과 "같은 값
재대입"을 구분한다.

## 시나리오 (수정 전/후 동일)
1. `http://localhost:51000` 열고 sample PDF 로드, 계측 설치.
2. zoom in 4회 → 5초 대기 → 스크롤 10틱 x 2회(사이 대기).
3. DPI 슬라이더를 최대(384)로 → zoom in 6회 → 스크롤 10틱 x 3회.
4. 누계 카운터와 프레임당 비율을 읽는다.

프레임 수는 `GPUQueue.submit` 호출 수로 센다. 앱의 `console.info` 프레임 로그는
프레임 1~3과 매 60프레임에만 찍히므로 프레임 수가 아니다.

## 단위 회귀 (`tests/gpu-frame-allocations.test.mjs`)
호출을 세는 가짜 WebGPU device로:
1. 12타일 프레임을 30번 그려도 view/bind group/buffer 생성이 늘지 않는다.
2. 타일마다 공유 버퍼의 제 `firstVertex` 위치에 올바른 clip 좌표가 쓰인다
   (clip 좌표는 렌더러에서 import하지 않고 테스트가 독립 계산한다).
3. 버퍼는 더 큰 프레임에서만 커지고, 작은 프레임으로 돌아가도 재할당하지 않는다.

## 음성 통제
`renderer.ts`만 수정 전으로 되돌려 재빌드한 뒤 위 단위 테스트를 돌린다.
3건 모두 실패해야 한다.

## 재현
```
cd F:\dev\pdfgpu
node --test packages/pdfgpu/tests/*.test.mjs
npm run deploy
```
브라우저 계측은 WebGPU가 있는 호스트 크롬에서 수동으로 수행한다
(Playwright 컨테이너에는 GPU가 없다 — issue #7).
