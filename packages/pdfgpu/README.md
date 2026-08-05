WebGPU PDF viewer core with pluggable raster providers.

| Goal               | File                  |
|--------------------|-----------------------|
| Understand purpose | README.md             |
| Package overview   | docs/overview.md      |
| Architecture       | docs/architecture.md  |
| API reference      | docs/api.md           |
| Usage              | docs/usage.md         |
| Constraints        | docs/constraints.md   |
| Internals          | docs/internals.md     |
| Testing            | docs/testing.md       |

## 현재 범위

- `PdfRasterProvider`: 파싱 완료 문서에서 특정 DPI preview/detail 이미지를 공급하는 계약
- 공급자 구현: in-memory PDFium, HTTP Web API, WebSocket JSON RPC
- `createPdfGpuViewer`: 공급자가 반환한 이미지를 단일 WebGPU 캔버스로 합성하는 뷰어
- `viewer/interaction.ts`: React와 무관한 페이지/휠/키보드 상호작용 상태 reducer
- 스케줄링: 가시성 기반 큐, DPI 버킷, LRU 래스터 캐시

## 배포 경계

이 디렉터리가 `@pdfgpu/core`의 유일한 소스 경계입니다. PDFit 같은 소비자는
`dist`를 직접 복사하지 않고 이 패키지를 빌드·pack한 버전 고정 tarball을
사용합니다. PDFium WASM tarball은 `vendor/` 아래에 포함되어 패키지가 형제
저장소의 파일 경로에 의존하지 않도록 합니다.

## 주요 API

- `createPdfDocumentEngine()`
- `createInMemoryPdfRasterProvider(provider)`
- `createWebApiPdfRasterProvider(endpoint)`
- `createWebSocketPdfRasterProvider(endpoint)`
- `createPdfGpuViewer(options)`
- `normalizeDetailDpi(rawDpi)`
