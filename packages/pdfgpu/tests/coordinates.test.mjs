import assert from 'node:assert/strict';
import { it } from 'node:test';
import { projectOverlaysForVisiblePages } from '../dist/viewer/coordinates.js';

it('projects absolute PDF-point bookmarks into the visible viewport', () => {
  const layout = {
    pagePositions: [{ index: 0, left: 100, top: 1000, width: 612, height: 792, rowIndex: 0 }],
    totalWidth: 612,
    totalHeight: 1792,
  };
  const overlays = [{
    pageIndex: 0,
    rect: { x: 153, y: 198, width: 306, height: 396 },
    borderColor: '#3b82f6',
  }];

  assert.deepEqual(
    projectOverlaysForVisiblePages(layout, overlays, [0], 1000, [{ width: 612, height: 792 }]),
    [{ pageIndex: 0, left: 253, top: 198, width: 306, height: 396, borderColor: '#3b82f6', fillColor: undefined, fillOpacity: undefined, comment: undefined }],
  );
});
