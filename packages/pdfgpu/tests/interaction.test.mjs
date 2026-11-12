import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createViewerInteractionState,
  normalizeViewerPage,
  reduceViewerInteraction,
  viewerModeParts
} from '../dist/viewer/interaction.js';
import { buildLayout } from '../dist/layout/layout.js';

/**
 * 1-based first page of the spread row that holds `page`, read from the rows
 * `buildLayout` actually produces (what the user sees), for both placements.
 * Independent of normalizeViewerPage, so the test cannot agree with it by
 * construction.
 */
function spreadRowLeader(page, pageCount) {
  const sizes = new Map(Array.from({ length: pageCount }, (_, i) => [i, { baseWidth: 500, baseHeight: 700 }]));
  const leaders = new Set();
  for (const spreadPlacement of ['first-right', 'first-left']) {
    const { pagePositions } = buildLayout(pageCount, sizes, 1, 16, { viewMode: 'spread', spreadPlacement, viewportWidth: 1200 });
    const target = pagePositions.find((p) => p.index === page - 1);
    const row = pagePositions.filter((p) => p.rowIndex === target.rowIndex);
    leaders.add(Math.min(...row.map((p) => p.index)) + 1);
  }
  if (leaders.size !== 1) throw new Error(`placements disagree on the row of page ${page}`);
  return [...leaders][0];
}

describe('viewer interaction matrix', () => {
  const modes = ['scroll', 'single', 'double'];
  const pageCounts = [1, 2, 3, 6];

  it('keeps mode parts explicit', () => {
    assert.deepEqual(viewerModeParts('scroll'), { scrollMode: 'continuous', viewMode: 'single' });
    assert.deepEqual(viewerModeParts('single'), { scrollMode: 'page', viewMode: 'single' });
    assert.deepEqual(viewerModeParts('double'), { scrollMode: 'page', viewMode: 'spread' });
  });

  it('normalizes page input for every mode and document size', () => {
    for (const mode of modes) {
      for (const pageCount of pageCounts) {
        assert.equal(normalizeViewerPage(0, pageCount, mode), 1);
        assert.equal(
          normalizeViewerPage(pageCount + 99, pageCount, mode),
          mode === 'double'
            ? spreadRowLeader(Math.max(1, pageCount), pageCount)
            : Math.max(1, pageCount)
        );
        if (mode === 'double' && pageCount >= 1) {
          for (let page = 1; page <= pageCount; page += 1) {
            assert.equal(
              normalizeViewerPage(page, pageCount, mode),
              spreadRowLeader(page, pageCount),
              `page ${page} of ${pageCount} does not land on the first page of its spread row`
            );
          }
        }
      }
    }
  });

  it('turns page keys into navigation in page modes only', () => {
    // docs/architecture.md: "scroll은 native scroll을 유지하고 single/double은 threshold
    // wheel과 PageUp/PageDown을 bounded navigation effect로 변환".
    for (const key of ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp']) {
      const scroll = reduceViewerInteraction(
        createViewerInteractionState({ page: 3, pageCount: 6, mode: 'scroll' }),
        { type: 'key', key }
      );
      assert.equal(scroll.preventDefault, false, `${key} was taken from native scrolling`);
      assert.deepEqual(scroll.effects, []);
    }
    for (const mode of ['single', 'double']) {
      const step = mode === 'double' ? 2 : 1;
      for (const page of [1, 2, 3, 5]) {
        const state = createViewerInteractionState({ page, pageCount: 6, mode });
        const forward = reduceViewerInteraction(state, { type: 'key', key: 'PageDown' });
        const backward = reduceViewerInteraction(state, { type: 'key', key: 'PageUp' });
        assert.equal(forward.preventDefault, true);
        assert.equal(forward.effects[0]?.type, 'navigate');
        assert.equal(backward.effects[0]?.type, 'navigate');
        assert.equal(forward.state.page, normalizeViewerPage(state.page + step, 6, mode));
        assert.equal(backward.state.page, normalizeViewerPage(state.page - step, 6, mode));
      }
    }
  });

  it('does not steal keyboard navigation from editable targets', () => {
    const state = createViewerInteractionState({ page: 3, pageCount: 6, mode: 'single' });
    const transition = reduceViewerInteraction(state, {
      type: 'key',
      key: 'PageDown',
      editableTarget: true
    });
    assert.deepEqual(transition.state, state);
    assert.deepEqual(transition.effects, []);
    assert.equal(transition.preventDefault, false);
  });

  it('keeps continuous scrolling native and thresholds page-mode wheel paging', () => {
    const scroll = reduceViewerInteraction(
      createViewerInteractionState({ page: 2, pageCount: 6, mode: 'scroll' }),
      { type: 'wheel', deltaY: 900 }
    );
    assert.equal(scroll.preventDefault, false);
    assert.deepEqual(scroll.effects, []);
    assert.equal(scroll.state.page, 2);

    for (const mode of ['single', 'double']) {
      const first = reduceViewerInteraction(
        createViewerInteractionState({ page: 3, pageCount: 6, mode }),
        { type: 'wheel', deltaY: 10 }
      );
      assert.equal(first.preventDefault, true);
      assert.deepEqual(first.effects, []);
      const second = reduceViewerInteraction(first.state, { type: 'wheel', deltaY: 20 });
      assert.equal(second.effects[0]?.type, 'navigate');
      assert.equal(second.state.page, normalizeViewerPage(3 + (mode === 'double' ? 2 : 1), 6, mode));
    }
  });

  it('separates Ctrl+wheel zoom from page movement', () => {
    for (const mode of modes) {
      const initial = createViewerInteractionState({ page: 3, pageCount: 6, mode });
      const transition = reduceViewerInteraction(initial, { type: 'wheel', deltaY: -1, ctrlKey: true });
      assert.equal(transition.preventDefault, true);
      assert.deepEqual(transition.effects, [{ type: 'zoom', direction: 'in' }]);
      // Ctrl+wheel zooms; it must not move the page (page 3 is itself
      // normalized to its spread row's first page, 2, in double mode).
      assert.equal(transition.state.page, initial.page);
    }
  });
});
