import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLayout, spreadRows } from '../dist/layout/layout.js';
import {
  createViewerInteractionState,
  normalizeViewerPage,
  reduceViewerInteraction
} from '../dist/viewer/interaction.js';

// External criteria:
// - Row formation agreed with the PDFit integration (it ships the same toggle
//   in its PDF.js viewer), 1-based, 7 pages:
//     paired -> [1,2],[3,4],[5,6],[7]     alone -> [1],[2,3],[4,5],[6,7]
// - Keyboard/wheel paging moves to the first page of the next row.
// - Switching pairing lands on the row that holds the current page:
//     alone (2,3) -> paired (1,2).
// Expected rows below are read from buildLayout (what is drawn), never from the
// reducer under test.

const sizes = (n) => new Map(Array.from({ length: n }, (_, i) => [i, { baseWidth: 500, baseHeight: 700 }]));

/** 1-based rows exactly as buildLayout lays them out. */
function drawnRows(pageCount, pairing, placement = 'first-right') {
  const { pagePositions } = buildLayout(pageCount, sizes(pageCount), 1, 16, {
    viewMode: 'spread', spreadPairing: pairing, spreadPlacement: placement, viewportWidth: 1600, spreadGap: 20
  });
  const byRow = new Map();
  for (const p of pagePositions) {
    if (!byRow.has(p.rowIndex)) byRow.set(p.rowIndex, []);
    byRow.get(p.rowIndex).push(p.index + 1);
  }
  return [...byRow.keys()].sort((a, b) => a - b).map((k) => byRow.get(k).sort((a, b) => a - b));
}

function leaderOf(page, rows) {
  return rows.find((row) => row.includes(page))[0];
}

describe('spread pairing', () => {
  it('forms the agreed rows for a 7-page document', () => {
    assert.deepEqual(drawnRows(7, 'paired'), [[1, 2], [3, 4], [5, 6], [7]]);
    assert.deepEqual(drawnRows(7, 'alone'), [[1], [2, 3], [4, 5], [6, 7]]);
    assert.deepEqual(spreadRows(7, 'paired').map((r) => r.map((i) => i + 1)), [[1, 2], [3, 4], [5, 6], [7]]);
    assert.deepEqual(spreadRows(7, 'alone').map((r) => r.map((i) => i + 1)), [[1], [2, 3], [4, 5], [6, 7]]);
  });

  it('keeps spreadRows and buildLayout in agreement for every size', () => {
    for (const pairing of ['alone', 'paired']) {
      for (let n = 1; n <= 9; n += 1) {
        assert.deepEqual(
          drawnRows(n, pairing),
          spreadRows(n, pairing).map((r) => r.map((i) => i + 1)),
          `${pairing} ${n} pages`
        );
      }
    }
  });

  it('defaults to the cover-alone rows', () => {
    const { pagePositions } = buildLayout(5, sizes(5), 1, 16, { viewMode: 'spread', viewportWidth: 1600 });
    assert.notEqual(pagePositions[0].rowIndex, pagePositions[1].rowIndex);
    assert.equal(normalizeViewerPage(3, 5, 'double'), 2);
  });

  it('ignores spreadPlacement in paired mode: page 1 is the left page', () => {
    for (const placement of ['first-left', 'first-right']) {
      const { pagePositions } = buildLayout(5, sizes(5), 1, 16, {
        viewMode: 'spread', spreadPairing: 'paired', spreadPlacement: placement, viewportWidth: 1600, spreadGap: 20
      });
      const left = (i) => pagePositions.find((p) => p.index === i).left;
      assert.equal(left(0), left(2), `${placement}: page 1 is not in the left column`);
      assert.ok(left(1) > left(0), `${placement}: page 2 is not right of page 1`);
    }
  });

  it('puts a lone last page in the left column', () => {
    for (const [pairing, n, lone, above] of [['paired', 7, 7, 5], ['alone', 6, 6, 4]]) {
      const { pagePositions } = buildLayout(n, sizes(n), 1, 16, {
        viewMode: 'spread', spreadPairing: pairing, viewportWidth: 1600, spreadGap: 20
      });
      const left = (p) => pagePositions.find((x) => x.index === p - 1).left;
      assert.equal(left(lone), left(above), `${pairing}: page ${lone} is not under page ${above}`);
    }
  });

  it('normalizes every page to the first page of its drawn row', () => {
    for (const pairing of ['alone', 'paired']) {
      for (let n = 1; n <= 9; n += 1) {
        const rows = drawnRows(n, pairing);
        for (let page = 1; page <= n; page += 1) {
          assert.equal(normalizeViewerPage(page, n, 'double', pairing), leaderOf(page, rows), `${pairing} ${n}p page ${page}`);
        }
      }
    }
  });

  it('pages forward and back row by row, including the last odd page', () => {
    for (const pairing of ['alone', 'paired']) {
      for (const n of [6, 7]) {
        const leaders = drawnRows(n, pairing).map((r) => r[0]);
        let state = createViewerInteractionState({ page: 1, pageCount: n, mode: 'double', pairing });
        const forward = [state.page];
        for (let i = 0; i < leaders.length + 1; i += 1) {
          const t = reduceViewerInteraction(state, { type: 'key', key: 'PageDown' });
          assert.equal(t.preventDefault, true);
          state = t.state;
          forward.push(state.page);
        }
        assert.deepEqual(forward, [...leaders, leaders.at(-1), leaders.at(-1)].slice(0, forward.length), `${pairing} ${n}p forward`);
        const backward = [state.page];
        for (let i = 0; i < leaders.length; i += 1) {
          state = reduceViewerInteraction(state, { type: 'key', key: 'PageUp' }).state;
          backward.push(state.page);
        }
        assert.deepEqual(backward, [...leaders].reverse().concat([1]).slice(0, backward.length), `${pairing} ${n}p backward`);
      }
    }
  });

  it('lands on the row that holds the current page when pairing switches', () => {
    const cases = [
      ['alone', 2, 'paired', 1], // (2,3) -> (1,2)
      ['alone', 4, 'paired', 3], // (4,5) -> (3,4)
      ['paired', 3, 'alone', 2], // (3,4) -> (2,3)
      ['paired', 7, 'alone', 6], // (7)   -> (6,7)
      ['paired', 1, 'alone', 1]  // (1,2) -> (1)
    ];
    for (const [from, page, to, expected] of cases) {
      const state = createViewerInteractionState({ page, pageCount: 7, mode: 'double', pairing: from });
      const next = reduceViewerInteraction(state, { type: 'setPairing', pairing: to }).state;
      assert.equal(next.pairing, to);
      assert.equal(next.page, expected, `${from} ${page} -> ${to}`);
      assert.equal(next.page, leaderOf(page, drawnRows(7, to)));
    }
  });
});
