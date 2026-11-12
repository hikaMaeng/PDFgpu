import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeRenderBackends } from '../../scripts/deploy.mjs';

// Input lines are copied verbatim from a real `npm run deploy` run
// (2026-11-12, e2e container without a GPU), not composed from the parser.
const CONTAINER_OUTPUT = `
[PW CONSOLE] info [pdfgpu] render frame {frame: 1, backend: unsupported, width: 1266, height: 668, tiles: 0}
[PW CONSOLE] info [pdfgpu] render frame {frame: 2, backend: unsupported, width: 1266, height: 668, tiles: 1}
[PW CONSOLE] info [pdfgpu] render frame {frame: 3, backend: unsupported, width: 1266, height: 668, tiles: 2}
[PW CONSOLE] info [pdfgpu] render frame {frame: 60, backend: unsupported, width: 1266, height: 668, tiles: 5}
  ✓  2 pdfgpu-viewer.spec.js:121:1 › in-memory PDFium provider loads sample and uploaded PDFs (6.8s)
  4 passed (21.6s)
`;

describe('deploy report: render backend coverage', () => {
  it('says the WebGPU path was not exercised when every logged frame is unsupported', () => {
    const result = summarizeRenderBackends(CONTAINER_OUTPUT);
    assert.equal(result.loggedFrames, 4);
    assert.deepEqual(result.counts, { unsupported: 4 });
    assert.match(result.verdict, /^NOT exercised/);
    assert.match(result.verdict, /2D fallback only/);
  });

  it('says exercised as soon as one logged frame used webgpu', () => {
    const output = `${CONTAINER_OUTPUT}
[PW CONSOLE] info [pdfgpu] render frame {frame: 1, backend: webgpu, width: 1266, height: 668, tiles: 0}`;
    const result = summarizeRenderBackends(output);
    assert.equal(result.counts.webgpu, 1);
    assert.match(result.verdict, /^exercised/);
  });

  it('does not report a pass as coverage when no frame was logged', () => {
    const result = summarizeRenderBackends('  4 passed (21.6s)\n');
    assert.equal(result.loggedFrames, 0);
    assert.match(result.verdict, /^unknown/);
  });
});
