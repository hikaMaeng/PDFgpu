import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUILD_CMD = 'pnpm run build';
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

function writeReport({ health, playwrightResult }) {
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

  try {
    run(E2E_CMD);
    browserPassed = true;
  } catch (error) {
    playwrightOutput = error instanceof Error ? error.message : 'Playwright command failed';
    throw error;
  } finally {
    ensureReportDir();
    const reportPath = writeReport({
      health,
      playwrightResult: {
        success: browserPassed
      }
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[deploy] report -> ${reportPath}`);
    console.log(`[deploy] elapsed ${elapsed}s`);
    if (playwrightOutput) {
      console.log(`[deploy] playwright: ${playwrightOutput}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
