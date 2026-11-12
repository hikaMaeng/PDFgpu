const { test, expect } = require('@playwright/test');

// External criteria, quoted:
// - docs/architecture.md: "scroll은 native scroll을 유지하고 single/double은 threshold
//   wheel과 PageUp/PageDown을 bounded navigation effect로 변환합니다."
// - docs/architecture.md: spread "2페이지 row를 구성하고 첫 페이지를 왼쪽/오른쪽 슬롯 중
//   하나에 배치" -> rows are [1], [2,3], [4,5], ... so paging lands on 1, 2, 4, 6.
// - README.md: "화면에 보이는 페이지만 고해상도 detail tile로 보강합니다." -> the
//   viewer's visible pages must be the pages that intersect the viewer region.
//
// Unit tests of the interaction reducer could not show F12: the reducer handled
// 'key' events, but nothing in the app dispatched them. This spec presses real keys.

async function openSample(page) {
  const base = process.env.TEST_URL || 'http://localhost:51000';
  page.on('console', (msg) => console.log(`[PW CONSOLE] ${msg.type()} ${msg.text()}`));
  await page.goto(base);
  const status = page.getByRole('status', { name: 'viewer status' });
  await page.getByRole('button', { name: /sample pdf/i }).click();
  await expect(status).toContainText(/Pages:\s*1\s*\/\s*12/);
  return status;
}

function pageOf(text) {
  return Number(text.match(/Pages:\s*(\d+)\s*\//)?.[1]);
}

test('PageDown/PageUp page through single and spread page modes', async ({ page }) => {
  const status = await openSample(page);
  const region = page.getByRole('region', { name: 'PDF viewer' });
  await page.getByLabel('scroll mode').selectOption('page');

  await region.focus();
  await page.keyboard.press('PageDown');
  await expect(status).toContainText(/Pages:\s*2\s*\/\s*12/);
  await page.keyboard.press('PageDown');
  await expect(status).toContainText(/Pages:\s*3\s*\/\s*12/);
  await page.keyboard.press('PageUp');
  await expect(status).toContainText(/Pages:\s*2\s*\/\s*12/);

  await page.getByLabel('view mode').selectOption('spread');
  await region.focus();
  // Page 2 leads the row [2,3]; the next rows start at 4 and 6.
  await expect(status).toContainText(/Pages:\s*2\s*\/\s*12/);
  await page.keyboard.press('PageDown');
  await expect(status).toContainText(/Pages:\s*4\s*\/\s*12/);
  await page.keyboard.press('ArrowRight');
  await expect(status).toContainText(/Pages:\s*6\s*\/\s*12/);
  await page.keyboard.press('PageUp');
  await expect(status).toContainText(/Pages:\s*4\s*\/\s*12/);
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await expect(status).toContainText(/Pages:\s*1\s*\/\s*12/);
});

test('continuous mode leaves keyboard scrolling to the browser', async ({ page }) => {
  await openSample(page);
  const region = page.getByRole('region', { name: 'PDF viewer' });
  await region.focus();
  const before = await region.evaluate((el) => el.scrollTop);
  // Record whether the viewer cancelled the key, then press it.
  await region.evaluate((el) => {
    el.addEventListener('keydown', (event) => {
      setTimeout(() => { el.dataset.lastKeyPrevented = String(event.defaultPrevented); }, 0);
    }, { once: true });
  });
  await page.keyboard.press('PageDown');
  await expect(region).toHaveAttribute('data-last-key-prevented', 'false');
  await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
});

test('visible pages are the pages that intersect the viewer', async ({ page }) => {
  const status = await openSample(page);
  const region = page.getByRole('region', { name: 'PDF viewer' });
  await page.getByRole('button', { name: /zoom in/i }).click();
  await region.evaluate((el) => { el.scrollTop = 5000; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(800);

  const onScreen = await page.evaluate(() => {
    const viewer = document.querySelector('[role="region"][aria-label="PDF viewer"]');
    const box = viewer.getBoundingClientRect();
    return [...document.querySelectorAll('[data-testid="pdfgpu-page-shell"]')]
      .filter((shell) => {
        const r = shell.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      })
      .map((shell) => Number(shell.dataset.pageIndex) + 1)
      .sort((a, b) => a - b);
  });
  const reported = (await status.textContent()).match(/Visible:\s*([\d, ]+)/)?.[1]
    .split(',').map((v) => Number(v.trim())).filter(Boolean);
  console.log(`[visible] on screen ${onScreen.join(',')} | reported ${reported.join(',')}`);
  expect(onScreen.length).toBeGreaterThan(0);
  expect(reported).toEqual(onScreen);
});
