/** Rows are one pixel high, including the space after each grid item. */
export function gridRows(height: number, gap: number, step = 1): number {
  return Math.max(step, Math.ceil((height + gap - 0.001) / step) * step);
}

/** Actual tile height for a whole number of grid cells, with one gutter. */
export function gridTileHeight(
  height: number,
  gap: number,
  step: number,
  minHeight = 0,
): number {
  const cells = Math.max(
    1,
    Math.ceil((minHeight + gap) / step),
    Math.round((height + gap) / step),
  );
  return cells * step - gap;
}

/** Match the responsive widths of the dashboard's twelve-column grid. */
export function responsiveSpan(width: number, viewport: number): number {
  if (viewport <= 560) return 12;
  if (viewport <= 900) {
    if (width >= 5) return 12;
    if (width >= 3) return 6;
  }
  return width;
}

export type GridBox = {
  id: string;
  column: number;
  row: number;
  width: number;
  height: number;
};

/** Remove vertical intervals occupied by no tile, retaining horizontal holes. */
export function compactGridBoxes(boxes: GridBox[]): GridBox[] {
  const intervals = boxes
    .map((box) => ({ start: box.row, end: box.row + box.height }))
    .sort((a, b) => a.start - b.start);
  const gaps: Array<{ end: number; size: number }> = [];
  let occupiedEnd = 0;
  for (const interval of intervals) {
    if (interval.start > occupiedEnd)
      gaps.push({ end: interval.start, size: interval.start - occupiedEnd });
    occupiedEnd = Math.max(occupiedEnd, interval.end);
  }
  return boxes.map((box) => ({
    ...box,
    row:
      box.row -
      gaps.reduce((sum, gap) => sum + (gap.end <= box.row ? gap.size : 0), 0),
  }));
}

/** Snap a dragged tile to adjacent edges or to the small vertical grid. */
export function snapGridRow(row: number, step: number): number {
  return Math.max(0, Math.round(row / step) * step);
}

/** Start a fresh tile grid below each full-width section heading. */
export function snapSectionRow(
  row: number,
  step: number,
  boxes: GridBox[],
  headingIds: Set<string>,
  movingId: string,
): number {
  const origin = boxes.reduce(
    (closest, box) =>
      box.id !== movingId &&
      headingIds.has(box.id) &&
      box.row + box.height <= row
        ? Math.max(closest, box.row + box.height)
        : closest,
    0,
  );
  return origin + snapGridRow(row - origin, step);
}

/** Preserve saved positions where possible, making room for content that grew. */
export function resolveGridBoxes(boxes: GridBox[]): GridBox[] {
  const placed: GridBox[] = [];
  for (const box of [...boxes].sort((a, b) => a.row - b.row)) {
    const next = { ...box };
    for (;;) {
      const blockers = placed.filter(
        (other) =>
          next.column < other.column + other.width &&
          other.column < next.column + next.width &&
          next.row < other.row + other.height &&
          other.row < next.row + next.height,
      );
      if (!blockers.length) break;
      next.row = Math.max(...blockers.map((other) => other.row + other.height));
    }
    placed.push(next);
  }
  return placed;
}

/** Move an item and make room by pushing intersecting items down. */
export function moveGridBox(
  boxes: GridBox[],
  id: string,
  column: number,
  row: number,
): GridBox[] {
  const next = boxes.map((box) => ({ ...box }));
  const moving = next.find((box) => box.id === id);
  if (!moving) return next;
  moving.column = Math.max(0, Math.min(12 - moving.width, column));
  moving.row = Math.max(0, row);
  const queue = [moving];
  while (queue.length) {
    const placed = queue.shift()!;
    for (const other of next) {
      if (other === placed || other === moving) continue;
      if (
        placed.column < other.column + other.width &&
        other.column < placed.column + placed.width &&
        placed.row < other.row + other.height &&
        other.row < placed.row + placed.height
      ) {
        other.row = placed.row + placed.height;
        queue.push(other);
      }
    }
  }
  return next;
}
