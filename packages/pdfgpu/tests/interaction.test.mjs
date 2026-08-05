import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createViewerInteractionState,
  normalizeViewerPage,
  reduceViewerInteraction,
  viewerModeParts
} from '../dist/viewer/interaction.js';

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
          mode === 'double' && pageCount > 1
            ? pageCount - (pageCount % 2 === 0 ? 1 : 0)
            : Math.max(1, pageCount)
        );
        if (mode === 'double' && pageCount >= 2) {
          assert.equal(normalizeViewerPage(2, pageCount, mode), 1);
          assert.equal(normalizeViewerPage(4, pageCount, mode), pageCount >= 3 ? 3 : 1);
        }
      }
    }
  });

  it('uses one keyboard contract across modes', () => {
    for (const mode of modes) {
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
      const transition = reduceViewerInteraction(
        createViewerInteractionState({ page: 3, pageCount: 6, mode }),
        { type: 'wheel', deltaY: -1, ctrlKey: true }
      );
      assert.equal(transition.preventDefault, true);
      assert.deepEqual(transition.effects, [{ type: 'zoom', direction: 'in' }]);
      assert.equal(transition.state.page, 3);
    }
  });
});
