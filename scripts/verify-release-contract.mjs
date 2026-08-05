import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function readText(relativePath) {
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) throw new Error(`missing release contract input: ${relativePath}`);
  return readFileSync(path, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function requireMatch(label, value, pattern) {
  if (!pattern.test(value)) {
    throw new Error(`${label} has an invalid value: ${value}`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const rootPackage = readJson('package.json');
const contractPath = `release-contracts/pdfgpu/v${rootPackage.version}.json`;
const contract = readJson(contractPath);
const corePackage = readJson('packages/pdfgpu/package.json');
const appPackage = readJson('apps/pdfgpu/package.json');
const clientPackage = readJson('apps/pdfgpu/src/client/package.json');
const serverPackage = readJson('apps/pdfgpu/src/server/package.json');
const installedPdfiumPackage = readJson('packages/pdfgpu/node_modules/@embedpdf/pdfium/package.json');
const expectedPdfium = contract.pdfium;
const lockfile = readText('pnpm-lock.yaml');
const engineSource = readText('packages/pdfgpu/src/engine/pdfiumEngine.ts');

requireEqual('contract PDFgpu version', contract.pdfgpuVersion, rootPackage.version);
requireEqual('contract core package name', contract.corePackageName, corePackage.name);
requireEqual('root PDFgpu version', rootPackage.version, contract.pdfgpuVersion);
requireEqual('@pdfgpu/core version', corePackage.version, contract.pdfgpuVersion);
requireEqual('apps/pdfgpu version', appPackage.version, contract.pdfgpuVersion);
requireEqual('client app version', clientPackage.version, contract.pdfgpuVersion);
requireEqual('server app version', serverPackage.version, contract.pdfgpuVersion);

const packageDependency = corePackage.dependencies?.[expectedPdfium.packageName];
requireEqual('PDFium package dependency', packageDependency, expectedPdfium.dependencySpec);
requireEqual('PDFium package version', expectedPdfium.packageVersion, expectedPdfium.dependencySpec);
requireMatch('PDFium package version', expectedPdfium.packageVersion, /^\d+\.\d+\.\d+$/);
requireEqual('installed PDFium package name', installedPdfiumPackage.name, expectedPdfium.packageName);
requireEqual('installed PDFium package version', installedPdfiumPackage.version, expectedPdfium.packageVersion);

const importerStart = lockfile.indexOf('\n  packages/pdfgpu:\n');
const importerEnd = lockfile.indexOf('\n\npackages:\n', importerStart);
if (importerStart < 0 || importerEnd < 0) {
  throw new Error('pnpm-lock.yaml is missing the packages/pdfgpu importer');
}
const importer = lockfile.slice(importerStart, importerEnd);
const importerDependency = importer.match(
  /'@embedpdf\/pdfium':\s*\n\s+specifier: ([^\n]+)\s*\n\s+version: ([^\n]+)/
);
if (!importerDependency) {
  throw new Error('pnpm-lock.yaml is missing the @embedpdf/pdfium importer dependency');
}
requireEqual('lockfile PDFium specifier', importerDependency[1], expectedPdfium.dependencySpec);
requireEqual('lockfile PDFium version', importerDependency[2], expectedPdfium.packageVersion);

const packageResolution = lockfile.match(
  new RegExp(
    `\\n  '${escapeRegex(expectedPdfium.packageName)}@${escapeRegex(expectedPdfium.packageVersion)}':\\n\\s+resolution: \\{integrity: ([^}]+)\\}`
  )
);
if (!packageResolution) {
  throw new Error('pnpm-lock.yaml is missing the PDFium package resolution');
}
requireEqual('lockfile PDFium integrity', packageResolution[1], expectedPdfium.lockfileIntegrity);

if (!engineSource.includes(`import('${expectedPdfium.packageName}')`)) {
  throw new Error('PDFium JavaScript module import does not match the release contract');
}
if (!engineSource.includes(`import('${expectedPdfium.wasmModulePath}')`)) {
  throw new Error('PDFium WASM asset import does not match the release contract');
}

console.log(
  `release contract passed: PDFgpu ${contract.pdfgpuVersion} -> ${expectedPdfium.packageName}@${expectedPdfium.packageVersion} (exact WebAssembly dependency)`
);
