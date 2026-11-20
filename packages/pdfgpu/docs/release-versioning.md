# Release and PDFium versioning

## Current contract

Every PDFGPU release has an exact runtime dependency contract:

| Consumer release | PDFium package | Dependency specifier | Contract |
| --- | --- | --- | --- |
| `@pdfgpu/core@0.1.0`–`0.1.9` | `@embedpdf/pdfium@2.14.0` | `2.14.0` | [`v0.1.0.json`](../../../release-contracts/pdfgpu/v0.1.0.json) … [`v0.1.9.json`](../../../release-contracts/pdfgpu/v0.1.9.json) |
| `@pdfgpu/core@0.1.10` | `@embedpdf/pdfium@2.15.1` | `2.15.1` | [`v0.1.10.json`](../../../release-contracts/pdfgpu/v0.1.10.json) |
| `@pdfgpu/core@0.1.11` | `@embedpdf/pdfium@2.15.1` | `2.15.1` | [`v0.1.11.json`](../../../release-contracts/pdfgpu/v0.1.11.json) |
| `@pdfgpu/core@0.1.12` | `@embedpdf/pdfium@2.15.1` | `2.15.1` | [`v0.1.12.json`](../../../release-contracts/pdfgpu/v0.1.12.json) |
| `@pdfgpu/core@0.1.13` | `@embedpdf/pdfium@2.15.1` | `2.15.1` | [`v0.1.13.json`](../../../release-contracts/pdfgpu/v0.1.13.json) |

The contract covers more than `package.json`:

- the exact dependency specifier in `packages/pdfgpu/package.json`;
- the resolved version and integrity in `package-lock.json`;
- the PDFium JavaScript module import;
- the PDFium WASM asset import used by `src/engine/pdfiumCore.ts` (loaded both on the main thread and inside each PDFium worker);
- the installed PDFium package under `node_modules`;
- the versions of the root, core, sample app, client, and server packages.

`scripts/verify-release-contract.mjs` checks these edges before the monorepo
build and library test commands proceed.

## Update policy

PDFium is a runtime implementation dependency, not an incidental development
tool. Any PDFium version change produces a new PDFGPU release and a new
versioned contract file.

| Change | PDFGPU release action |
| --- | --- |
| Compatible PDFium update, such as a PDFium patch release | Bump the PDFGPU patch version, for example `0.1.0` → `0.1.1` |
| PDFium update changes supported behavior or requires a consumer migration | Bump the PDFGPU minor version, for example `0.1.x` → `0.2.0` |
| PDFGPU public contract becomes incompatible | Follow the project major-version policy |

For every new release:

1. Update `@embedpdf/pdfium` to the intended exact version.
2. Run `npm install` so the lockfile resolution and integrity are refreshed, and compare
   the lockfile integrity with `npm view <pkg>@<version> dist.integrity`.
3. Bump every PDFGPU package version that is part of the release.
4. Add `release-contracts/pdfgpu/v<PDFGPU-version>.json`; do not edit an older contract.
5. Run `npm run verify:release-contract` (also the first step of `npm run deploy`)
   and the core test suite.
6. Tag the PDFGPU release only after the contract, lockfile, and artifact agree.

The `v0.1.0` tag therefore remains permanently associated with
`@embedpdf/pdfium@2.14.0`. A future `@embedpdf/pdfium@2.14.1` or `2.14.4`
must appear through a new PDFGPU release rather than silently changing the
meaning of `v0.1.0`.

## 0.1.10: PDFium 2.14.0 → 2.15.1

Treated as a compatible update (patch bump), from a comparison of the published
2.14.0 and 2.15.1 tarballs: one function added (`EPDF_GetPageBoxByIndex`), none
removed; the 14 functions PDFGPU calls keep identical signatures; `init()` and the
`./pdfium.wasm` export are unchanged. `pdfium.wasm` grew from 4,626,775 to 4,646,932
bytes. No changelog for the package was found, so what changed inside the WASM is
not known; rendering was re-verified by the e2e gate (colour order, tile grid,
navigation) and in Chrome on the WebGPU path.

## Why the coupling is explicit

PDFium performs the PDF parsing and page rasterization for the in-memory path.
Its version can affect compatibility, rendering output, memory behavior, and
WASM initialization. PDFGPU owns the viewer pipeline around PDFium, so the
consumer needs both identities to reproduce a release:

```text
PDFGPU release
  ├── @pdfgpu/core version
  └── @embedpdf/pdfium version + lockfile integrity + WASM import contract
```

Remote providers remain independent of the in-memory PDFium package, but they
must still satisfy the same `PdfRasterProvider` result contract.

## 한국어

PDFium은 단순한 개발 도구가 아니라 실행 시 사용하는 구현 의존성입니다.
따라서 PDFium 버전이 바뀌면 PDFGPU도 새 릴리스와 새 계약 파일을 가져야
합니다.

PDFGPU `0.1.0`은 정확히 `@embedpdf/pdfium@2.14.0`에 의존합니다. 이후
`2.14.1` 또는 `2.14.4`를 사용하려면 기존 `v0.1.0`의 의미를 바꾸지 않고
새 PDFGPU 버전과 새 `release-contracts/pdfgpu/v<version>.json`을 추가해야
합니다.
