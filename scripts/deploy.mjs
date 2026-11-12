import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD_CMD = 'npm run build';
const COMPOSE_DOWN_CMD = 'docker compose down --remove-orphans';
const COMPOSE_UP_CMD = 'docker compose up --build -d pdfgpu';
const HEALTH_PATH = '/health';
const E2E_CMD = 'docker compose run --rm --entrypoint /bin/sh e2e -lc "sh ./tests/e2e/run-e2e.sh"';
const REPORT_DIR = resolve(process.cwd(), 'tests', 'reports', 'pdfgpu-viewer');
const DEFAULT_URL = process.env.PDFGPU_BASE_URL || 'http://localhost:51000';

function run(command, options = {}) {
  console.log(`$ ${command}`);
  return execSync(command, {
    stdio: 'inherit',
    shell: true,
    ...options
  });
}

/**
 * Runs `command`, streaming its output to this process while also keeping a
 * copy, so the report can be built from what the browser actually logged.
 */
function runCapture(command) {
  console.log(`$ ${command}`);
  return new Promise((resolveRun) => {
    const child = spawn(command, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    const forward = (stream, sink) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        sink.write(text);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('close', (status) => resolveRun({ status: status ?? 1, output }));
  });
}

/**
 * Which render backend the browser under test actually used.
 *
 * Source: the viewer's own `[pdfgpu] render frame {... backend: X ...}`
 * console lines, which Playwright forwards as `[PW CONSOLE]`. The viewer only
 * logs frames 1-3 and every 60th, so `loggedFrames` counts logged frames, not
 * rendered frames. The point is not the count but whether `webgpu` appears at
 * all: the e2e container has no GPU, and if every logged frame says
 * `unsupported`, `renderWebGpu` never ran and a pass says nothing about it.
 */
export function summarizeRenderBackends(output) {
  const counts = {};
  const pattern = /render frame \{[^}]*backend: (\w+)/g;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  }
  const loggedFrames = Object.values(counts).reduce((sum, n) => sum + n, 0);
  let verdict;
  if (loggedFrames === 0) {
    verdict = 'unknown - no render frame logs were captured';
  } else if (counts.webgpu) {
    verdict = `exercised - backend: webgpu in ${counts.webgpu} of ${loggedFrames} logged frames`;
  } else {
    verdict = 'NOT exercised - no logged frame used webgpu, so this pass covers the 2D fallback only';
  }
  return { counts, loggedFrames, verdict };
}

async function waitForHealth(url, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < end) {
    attempts += 1;
    try {
      const code = spawnSync(
        'node',
        ['-e', `const http=require('http');http.get('${url}',res=>{process.exit(res.statusCode===200?0:1);}).on('error',()=>process.exit(1));`],
        { stdio: 'ignore' }
      ).status;
      if (code === 0) {
        return { ok: true, attempts };
      }
    } catch (_error) {
      // retry
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
  }
  return { ok: false, attempts };
}

function ensureReportDir() {
  mkdirSync(REPORT_DIR, { recursive: true });
}

function writeReport({ health, playwrightResult, backends }) {
  const startedAt = new Date().toISOString();
  const safeNow = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = resolve(REPORT_DIR, `${safeNow}.md`);
  const lines = [
    '# pdfgpu deploy report',
    '',
    `- Date: ${startedAt}`,
    `- URL: ${DEFAULT_URL}`,
    `- Health check: ${health.ok ? 'pass' : 'fail'} (attempts: ${health.attempts})`,
    `- Playwright: ${playwrightResult.success ? 'pass' : 'fail'}`,
    `- WebGPU path: ${backends.verdict}`,
    `- Logged frames by backend: ${backends.loggedFrames === 0
      ? 'none'
      : Object.entries(backends.counts).map(([name, n]) => `${name}=${n}`).join(', ')}`,
    '',
    '## Commands',
    `- ${BUILD_CMD}`,
    `- ${COMPOSE_DOWN_CMD}`,
    `- ${COMPOSE_UP_CMD}`,
    `- npx playwright test`,
    '',
    '## Notes',
    health.ok ? '- Health endpoint responded successfully.' : '- Health endpoint did not become ready in time.'
  ];
  writeFileSync(reportPath, `${lines.join('\n')}\n`);
  return reportPath;
}

async function main() {
  const healthUrl = `${DEFAULT_URL}${HEALTH_PATH}`;
  let browserPassed = false;
  let playwrightOutput = '';
  const start = Date.now();

  run(BUILD_CMD);
  run(COMPOSE_DOWN_CMD);
  run(COMPOSE_UP_CMD);

  const health = await waitForHealth(healthUrl, 60000);
  if (!health.ok) {
    throw new Error(`Health check failed for ${healthUrl}`);
  }

  let e2eOutput = '';
  try {
    const e2e = await runCapture(E2E_CMD);
    e2eOutput = e2e.output;
    if (e2e.status !== 0) {
      throw new Error(`Command failed: ${E2E_CMD} (exit ${e2e.status})`);
    }
    browserPassed = true;
  } catch (error) {
    playwrightOutput = error instanceof Error ? error.message : 'Playwright command failed';
    throw error;
  } finally {
    ensureReportDir();
    const backends = summarizeRenderBackends(e2eOutput);
    const reportPath = writeReport({
      health,
      playwrightResult: {
        success: browserPassed
      },
      backends
    });
    console.log(`[deploy] webgpu path: ${backends.verdict}`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[deploy] report -> ${reportPath}`);
    console.log(`[deploy] elapsed ${elapsed}s`);
    if (playwrightOutput) {
      console.log(`[deploy] playwright: ${playwrightOutput}`);
    }
  }
}

// Run only when executed directly, so tests can import summarizeRenderBackends.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
