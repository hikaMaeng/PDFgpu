#!/bin/sh
set -eu

RETRIES=60
URL=${TEST_URL:-http://pdfgpu:51000}
i=0
echo "Waiting for ${URL}/health..."
until curl -sSf "${URL}/health" >/dev/null 2>&1; do
  i=$((i+1))
  echo "waiting for ${URL} ($i)"
  if [ "$i" -ge "$RETRIES" ]; then
    echo "Timed out waiting for ${URL}"
    exit 1
  fi
  sleep 1
done

echo "Running Playwright tests (using local @playwright/test)..."
if [ ! -d /work/node_modules/@playwright/test ]; then
  echo "@playwright/test not found in /work; installing into /work..."
  npm --prefix /work install "@playwright/test@1.46.1" --no-audit --no-fund --no-save
  # try installing browsers (best-effort; container image often already contains compatible browsers)
  npx --yes playwright install chromium || true
fi

# run the local playwright test (now that @playwright/test exists under /work)
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/root/.cache/ms-playwright}
echo "Using PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}"
npx playwright test tests/playwright/pdfgpu-viewer.spec.js --reporter=list
