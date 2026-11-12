# 제약 사항

- 뷰어는 브라우저 전용입니다. Node-only 환경에서는 DOM/WebGPU 표면을 만들 수 없습니다.
- in-memory 공급자는 Chromium PDF viewer 계열의 오픈소스 PDFium을
  WebAssembly로 빌드한 `@embedpdf/pdfium@2.14.0`을 사용합니다.
- in-memory 공급자의 PDFium은 Web Worker에서 돕니다. 워커마다 문서 전체 사본과
  PDFium 힙을 가지므로 메모리는 `poolSize`에 비례합니다. Vite로 번들할 때는
  `worker: { format: 'es' }`가 필요합니다(워커가 PDFium을 `import()`로 지연 로드).
- 원격 공급자는 HTTP 또는 WebSocket 서버가 이미 PDF 파싱과 DPI별 래스터 생성을 끝낸 이미지를 반환해야 합니다.
- 앱 서버의 원격 공급자 엔드포인트는 프로토콜 실증용이며, 네이티브 PDF 파서가 붙은 생산 구현이 아닙니다.
- PDF.js 폴백을 제공하지 않습니다.
- WebGPU 미지원 브라우저는 `unsupported` 상태로 노출됩니다.
- 텍스트 선택/검색/주석은 1차에서 제외합니다.
- `@pdfgpu/core`는 독립 배포 가능한 package여야 하므로 `packages/pdfgpu`
  밖의 상대 경로 의존성을 둘 수 없습니다.
- 소비자는 `dist` 파일을 복사하거나 `src`를 alias하지 말고 semver 버전과
  source commit이 기록된 package artifact를 사용해야 합니다.
- PDFium WASM은 `@embedpdf/pdfium@2.14.0`의 고정 semver dependency에서만
  공급합니다. PDFium 버전을 변경할 때는 package 버전과 통합 manifest를
  함께 갱신해야 합니다.
- `release-contracts/pdfgpu/v<PDFGPU-version>.json`은 PDFium dependency의
  릴리스별 불변 기록입니다. 이전 PDFGPU 릴리스의 계약 파일을 수정하지
  않습니다.

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
