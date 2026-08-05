# 개요

`@pdfgpu/core`는 래스터 공급자와 WebGPU 뷰어를 분리한 PDF 뷰어 코어입니다.

- in-memory 경로는 Chromium PDF viewer에 사용되는 오픈소스 PDFium의
  WebAssembly 빌드인 `@embedpdf/pdfium@2.14.0`을 사용합니다. PDFGPU는 PDF
  parser를 재구현하지 않고 PDFium 위에 progressive viewer pipeline을
  제공합니다.
- 공급자 계층: `engine/`과 `providers/`에서 in-memory, HTTP, WebSocket 래스터 공급
- 스케줄러 계층: `scheduler/`에서 가시성 우선순위 큐와 바이트 기반 LRU 캐시
- 뷰어 계층: `viewer/`에서 단일 WebGPU 캔버스 합성, 페이지 셸 DOM 관리, 상태 노티

핵심 설계 의도:
- 파싱/래스터 공급을 원격 프로세스 또는 브라우저 함수로 교체 가능하게 유지
- 뷰어는 공급자가 반환한 특정 DPI 이미지만 소비
- 렌더링은 타일 단위로 분할해 고해상도 품질을 점진적으로 로딩
- 페이지 DOM은 시멘틱 셸만 유지하고 실제 비트맵은 단일 캔버스에서 합성
