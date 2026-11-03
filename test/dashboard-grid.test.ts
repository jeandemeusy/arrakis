import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactGridBoxes,
  gridRows,
  gridTileHeight,
  moveGridBox,
  responsiveSpan,
  resolveGridBoxes,
  snapGridRow,
  snapSectionRow,
} from '../lib/viz/dashboard-grid';

describe('dashboard grid sizing', () => {
  it('uses the same responsive spans for layout and dragging', () => {
    assert.equal(responsiveSpan(4, 901), 4);
    assert.equal(responsiveSpan(4, 900), 6);
    assert.equal(responsiveSpan(2, 749), 2);
    assert.equal(responsiveSpan(6, 749), 12);
    assert.equal(responsiveSpan(2, 560), 12);
  });
  it('counts exactly one gap between vertically stacked tiles', () => {
    for (const gap of [4, 10, 14, 18]) {
      const shortHeight = gridTileHeight(300, gap, 76);
      const tallHeight = gridTileHeight(shortHeight * 2 + gap, gap, 76);
      assert.equal(tallHeight, shortHeight * 2 + gap);
      assert.equal(
        gridRows(tallHeight, gap, 76),
        gridRows(shortHeight, gap, 76) * 2,
      );
    }
  });

  it('rounds fractional content up to the next complete grid cell', () => {
    assert.equal(gridRows(300.25, 14), 315);
    assert.equal(gridRows(200, 8, 57), 228);
  });

  it('moves a tile into empty space without compacting other tiles', () => {
    const boxes = [
      { id: 'first', column: 0, row: 0, width: 3, height: 208 },
      { id: 'move', column: 3, row: 0, width: 3, height: 208 },
      { id: 'tall', column: 6, row: 0, width: 6, height: 416 },
      { id: 'heading', column: 0, row: 416, width: 12, height: 80 },
    ];
    const moved = moveGridBox(boxes, 'move', 0, 208);
    assert.deepEqual(
      moved.find((box) => box.id === 'move'),
      { ...boxes[1], column: 0, row: 208 },
    );
    assert.deepEqual(
      moved.find((box) => box.id === 'tall'),
      boxes[2],
    );
    assert.deepEqual(
      moved.find((box) => box.id === 'heading'),
      boxes[3],
    );
    assert.deepEqual(boxes[1], {
      id: 'move',
      column: 3,
      row: 0,
      width: 3,
      height: 208,
    });
  });

  it('pushes collisions down without overlapping, including a following section', () => {
    const boxes = [
      { id: 'move', column: 0, row: 0, width: 3, height: 208 },
      { id: 'heading', column: 0, row: 208, width: 12, height: 80 },
      { id: 'chart', column: 0, row: 288, width: 6, height: 300 },
    ];
    const moved = moveGridBox(boxes, 'move', 0, 208);
    assert.equal(moved[1].row, 416);
    assert.equal(moved[2].row, 496);
  });

  it('makes room when saved content grows while keeping deliberate empty space', () => {
    const result = resolveGridBoxes([
      { id: 'heading', column: 0, row: 0, width: 12, height: 120 },
      { id: 'left', column: 0, row: 100, width: 6, height: 100 },
      { id: 'right', column: 6, row: 300, width: 6, height: 100 },
    ]);
    assert.equal(result.find((box) => box.id === 'left')?.row, 120);
    assert.equal(result.find((box) => box.id === 'right')?.row, 300);
  });

  it('removes empty full-width bands while preserving holes alongside a tall tile', () => {
    const boxes = [
      { id: 'tall', column: 6, row: 100, width: 6, height: 408 },
      { id: 'top', column: 0, row: 100, width: 3, height: 208 },
      { id: 'bottom', column: 0, row: 350, width: 3, height: 158 },
      { id: 'heading', column: 0, row: 900, width: 12, height: 80 },
    ];
    const compacted = compactGridBoxes(boxes);
    assert.equal(compacted.find((b) => b.id === 'tall')?.row, 0);
    assert.equal(compacted.find((b) => b.id === 'bottom')?.row, 250);
    assert.equal(compacted.find((b) => b.id === 'heading')?.row, 408);
    assert.equal(boxes[0].row, 100);
  });

  it('snaps positions and tile edges to the same square grid', () => {
    const step = 57;
    const gap = 8;
    assert.equal(snapGridRow(61, step), 57);
    assert.equal(snapGridRow(85, step), 57);
    assert.equal(snapGridRow(87, step), 114);
    const tile = gridTileHeight(200, gap, step, 200);
    assert.equal(tile, 220);
    assert.equal(gridRows(tile, gap, step), step * 4);
    const twoTiles = 2 * tile + gap;
    assert.equal(gridTileHeight(twoTiles, gap, step), twoTiles);
    assert.equal(gridRows(twoTiles, gap, step), step * 8);
  });

  it('starts tile rows immediately after a naturally sized section heading', () => {
    const heading = {
      id: 'heading',
      column: 0,
      row: 200,
      width: 12,
      height: 83,
    };
    const chart = { id: 'chart', column: 0, row: 300, width: 6, height: 200 };
    const boxes = compactGridBoxes([heading, chart]);
    assert.equal(boxes.find((box) => box.id === 'chart')?.row, 83);
    const headings = new Set(['heading']);
    assert.equal(snapSectionRow(89, 100, boxes, headings, 'chart'), 83);
    assert.equal(snapSectionRow(179, 100, boxes, headings, 'chart'), 183);
  });
});
