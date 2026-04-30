# 사용 방법

```ts
import {
  createPdfDocumentEngine,
  createPdfGpuViewer,
  createWebApiPdfRasterProvider,
  createWebSocketPdfRasterProvider
} from '@pdfgpu/core';

const provider = await createPdfDocumentEngine();
const controller = await createPdfGpuViewer({
  container: document.querySelector('#viewer')!,
  provider,
  initialZoom: 1,
  minZoom: 0.25,
  maxZoom: 5
});

controller.subscribe((state) => {
  console.log(state.backend, state.renderQuality, state.visiblePages);
});

await controller.load('/sample.pdf');
await controller.setZoom(1.5);
await controller.scrollToPage(2);
```

## 원격 공급자

```ts
const httpProvider = createWebApiPdfRasterProvider('/api/pdfgpu');
const wsProvider = createWebSocketPdfRasterProvider('ws://localhost:51000/ws/pdfgpu');
```

두 공급자 모두 `createPdfGpuViewer({ provider })`에 그대로 전달합니다.

## 교체 / 해제

- 새 문서를 로드하면 이전 렌더 큐와 in-flight 태스크는 즉시 취소됩니다.
- `dispose()`는 공급자/랜더러/캐시를 정리합니다.
