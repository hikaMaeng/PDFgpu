WebGPU PDF viewer core with pluggable raster providers.

| Goal               | File                  |
|--------------------|-----------------------|
| Understand purpose | README.md             |
| API reference      | docs/api.md           |
| Constraints        | docs/constraints.md   |
| Testing            | docs/testing.md       |

## 현재 범위

- `PdfRasterProvider`: 파싱 완료 문서에서 특정 DPI preview/detail 이미지를 공급하는 계약
- 공급자 구현: in-memory PDFium, HTTP Web API, WebSocket JSON RPC
- `createPdfGpuViewer`: 공급자가 반환한 이미지를 단일 WebGPU 캔버스로 합성하는 뷰어
- 스케줄링: 가시성 기반 큐, DPI 버킷, LRU 래스터 캐시

## 주요 API

- `createPdfDocumentEngine()`
- `createInMemoryPdfRasterProvider(provider)`
- `createWebApiPdfRasterProvider(endpoint)`
- `createWebSocketPdfRasterProvider(endpoint)`
- `createPdfGpuViewer(options)`
- `normalizeDetailDpi(rawDpi)`
