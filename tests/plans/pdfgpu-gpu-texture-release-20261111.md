# Test Plan: pdfgpu-gpu-texture-release

## Created
2026-11-11

## Goal
GPU 텍스처 누수(F2) 수정 검증. `PageRenderer`가 raster 캐시에서 이미 빠진
source의 GPU 텍스처를 계속 보유하지 않아야 한다.

## 외부 판정 기준 (수정과 같은 변경에서 작성된 산출물이 아님)

`packages/pdfgpu/src/scheduler/byteBudgetCache.ts`의 캐시 계약:
- `getBytesBudget()`가 선언된 상한이고 `evict`가 그 상한을 지킨다.
- `delete`는 `closeBitmap(source)`를 호출한다. ImageBitmap이 닫히면 그 픽셀은
  다시 읽을 수 없으므로, 캐시에서 빠진 raster는 되돌릴 수 없이 사라진다.

GPU 텍스처는 캐시된 raster 하나를 올린 결과물이다. 따라서 **살아 있는 텍스처
수는 캐시가 보유한 raster 수를 넘을 수 없다.** raster보다 오래 사는 텍스처는
아무도 해제하지 않는 GPU 메모리다.

누수의 구조적 원인도 소스에서 직접 확인된다. 수정 전 `renderer.ts`는
```
private readonly gpuTextures = new WeakMap<PdfImageSource, GpuTextureEntry>();
private readonly gpuTextureEntries = new Set<GpuTextureEntry>();
```
를 함께 들고 있었고 `GpuTextureEntry`는 `source` 필드를 가진다. 강한 `Set`이
엔트리를 붙잡으므로 `WeakMap`의 키도 전부 함께 살아남아 약한 참조가 무효가
된다. 해제 경로는 `dispose()` 하나뿐이었다.

## Environment
- OS/shell: Windows 11 / PowerShell · Git Bash
- Node: v26.4.0
- Unit: `node --test packages/pdfgpu/tests/*.test.mjs`
- Deploy entrypoint: `npm run deploy`

## Preconditions
- `packages/pdfgpu/dist`가 현재 소스로 빌드됨
- Docker 사용 가능, 포트 `51000` 사용 가능

## 이 환경에서 측정할 수 없는 것

Playwright 컨테이너(`mcr.microsoft.com/playwright:latest`)에는 WebGPU가 없어
렌더러가 `backend: unsupported`로 떨어진다. `renderWebGpu`가 실행되지 않으므로
**브라우저 실행으로는 텍스처 수명을 측정할 수 없다.** 텍스처 수명은 가짜
WebGPU device를 주입한 단위 테스트로 측정하고, 브라우저 실행은 2D fallback
경로의 무회귀만 보인다. 이 구분을 보고서에 그대로 적는다.

바이트 수치도 측정하지 않는다. `imageSize()`는 `ImageBitmap`,
`HTMLCanvasElement`, `HTMLImageElement`만 인식하고 Node에는 셋 다 없어서 가짜
source가 모두 1x1로 측정된다. 측정 가능한 것은 개수다.

## Steps

### A. 누수 정량 (수정 전/후 같은 측정기)
1. 가짜 WebGPU device로 `createTexture` / `texture.destroy()` 호출을 센다.
2. `maxBytes = 512*512*4*10` (= 타일 10장) 캐시를 만들고 `onRelease`를
   `renderer.releaseTexture`에 연결한다.
3. 512x512 raster 200개를 차례로 `cache.set` → 그 raster 한 장만 담은 프레임을
   `renderer.render`.
4. `생성 - 파괴`(살아 있는 텍스처)와 `cache.values().length`를 비교한다.
5. 같은 측정기를 수정 전 소스(`git stash`)로 빌드한 dist에 대고 다시 돌린다.

### B. 회귀 테스트 — `packages/pdfgpu/tests/gpu-texture-release.test.mjs`
6. raster 200개를 넣는 동안 **매 반복마다** 살아 있는 텍스처 수가 캐시 보유
   수를 넘지 않는지 확인한다.
7. `cache.clear()`(문서 교체) 후 `gpuTextureCount === 0`.
8. `cache.delete(key)` 후 해당 텍스처 1개가 파괴되고 수가 1 줄어든다.
9. `renderer.dispose()` 후 전부 파괴된다.
10. 가짜 텍스처의 `destroy`는 두 번 호출되면 예외를 던진다 (이중 해제 검출).

### C. 무회귀
11. `node --test packages/pdfgpu/tests/*.test.mjs` 전체 통과.
12. `npm run deploy` 통과 (2D fallback 경로 e2e 4건).

## Expected Results
- A: 수정 후 `leakedTextures = 0`, 수정 전 `leakedTextures > 0`.
- B: 4건 통과.
- C: 단위 전체 통과, 배포 e2e 4건 통과.

## Logs To Capture
- A의 수정 전/후 JSON 출력 양쪽
- `node --test` 통과 수
- `npm run deploy` 리포트 경로
