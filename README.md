# pdfgpu (monorepo)

Monorepo scaffold: Turbo + pnpm + TypeScript. `pdfgpu`는 공급자 분리형 WebGPU PDF 뷰어입니다.

핵심 방침:

- PDF.js 기반 적재형 페이지 렌더러를 폐기했습니다.
- 코어는 `PdfRasterProvider` 계약으로 PDF 파싱/래스터 공급과 WebGPU 뷰어를 분리합니다.
- 공급자 형태는 in-memory 함수, HTTP Web API, WebSocket JSON RPC를 지원합니다.
- 1차 범위는 성능/스펙 회복에 집중하며 텍스트 선택/검색/주석은 제외합니다.

주요 위치:

- [packages/pdfgpu](packages/pdfgpu): 엔진/스케줄러/뷰어 코어
- [apps/pdfgpu](apps/pdfgpu): 실행 서버와 클라이언트 샘플 앱

Docker Hub 설치:

```bash
docker pull hika00/pdfgpu:latest
docker run --rm -p 51000:51000 hika00/pdfgpu:latest
```

실행 후 `http://localhost:51000`에서 뷰어를 열고 `http://localhost:51000/health`로 상태를 확인합니다.

빠른 시작:

```bash
pnpm install -w
pnpm run build
npm run deploy
```

개발:

```bash
pnpm --filter "@pdfgpu/app-client" dev
pnpm --filter "@pdfgpu/app-server" start
```
