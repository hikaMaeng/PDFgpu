# 제약 사항

- 뷰어는 브라우저 전용입니다. Node-only 환경에서는 DOM/WebGPU 표면을 만들 수 없습니다.
- in-memory 공급자는 브라우저 전용 PDFium WASM을 사용합니다.
- 원격 공급자는 HTTP 또는 WebSocket 서버가 이미 PDF 파싱과 DPI별 래스터 생성을 끝낸 이미지를 반환해야 합니다.
- 앱 서버의 원격 공급자 엔드포인트는 프로토콜 실증용이며, 네이티브 PDF 파서가 붙은 생산 구현이 아닙니다.
- PDF.js 폴백을 제공하지 않습니다.
- WebGPU 미지원 브라우저는 `unsupported` 상태로 노출됩니다.
- 텍스트 선택/검색/주석은 1차에서 제외합니다.

## 브라우저 테스트 마크업 계약

- main: `<main>` 루트 영역 사용
- viewer region: `role="region"` 및 `aria-label="PDF viewer"`
- status surface: `role="status"` 및 `aria-label="viewer status"`
- provider selector: `select#provider-mode`, accessible name `raster provider`
- view selector: `select#view-mode`, accessible name `view mode`
- spread placement selector: `select#spread-placement`, accessible name `first page spread placement`
- scroll selector: `select#scroll-mode`, accessible name `scroll mode`
- detail DPI slider: `input#detail-dpi`, accessible name `detail image dpi`
- page shell:
  - `data-testid="pdfgpu-page-shell"`
  - `data-page-index`
  - `data-render-state`
- hidden text-layer host:
  - `data-testid="pdfgpu-text-layer"`
  - `data-page-index`
  - `aria-hidden="true"`
  - `inert="true"`
