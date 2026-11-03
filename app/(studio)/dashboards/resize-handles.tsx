'use client';

import { useRef, useState } from 'react';
import { gridTileHeight } from '@/lib/viz/dashboard-grid';

/** Heights are stored in pixels, from 80 to 1200. */
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1200;

const snapHeight = (height: number) =>
  Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)));

type Edge = 'corner' | 'right' | 'bottom';

/**
 * Grips on a tile being edited: drag the corner to resize both ways, an edge
 * for one. Both dimensions snap to the same square grid. The tile follows
 * live, with its size shown while dragging.
 */
export function ResizeHandles({
  width,
  height,
  rows,
  gridStep,
  onResize,
}: {
  width: number;
  height: number;
  rows: number;
  gridStep: number;
  onResize: (size: { width: number; height: number }) => void;
}) {
  const grip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Edge | null>(null);
  const start = useRef<{
    x: number;
    y: number;
    height: number;
    left: number;
    column: number;
    gap: number;
    outerHeight: number;
  } | null>(null);

  const begin = (edge: Edge) => (event: React.PointerEvent) => {
    const cell = grip.current?.closest<HTMLElement>('.dashboard-cell');
    const grid = cell?.parentElement;
    if (!cell || !grid) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture(event.pointerId);
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const box = grid.getBoundingClientRect();
    start.current = {
      x: event.clientX,
      y: event.clientY,
      height,
      left: cell.getBoundingClientRect().left,
      column: (box.width - gap * 11) / 12,
      gap,
      outerHeight: cell.getBoundingClientRect().height,
    };
    setDragging(edge);
  };

  const move = (event: React.PointerEvent) => {
    const from = start.current;
    if (!dragging || !from) return;
    let next = { width, height };
    if (dragging !== 'bottom') {
      // As many columns as reach the pointer, counting the gaps between them.
      const span = Math.round(
        (event.clientX - from.left + from.gap) / (from.column + from.gap),
      );
      next = { ...next, width: Math.min(12, Math.max(1, span)) };
    }
    if (dragging !== 'right') {
      const outerHeight = gridTileHeight(
        from.outerHeight + event.clientY - from.y,
        from.gap,
        gridStep,
      );
      next = {
        ...next,
        height: snapHeight(from.height + outerHeight - from.outerHeight),
      };
    }
    if (next.width !== width || next.height !== height) onResize(next);
  };

  const end = () => {
    start.current = null;
    setDragging(null);
  };

  const keys = (edge: Edge) => (event: React.KeyboardEvent) => {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = step[event.key];
    if (!delta) return;
    event.preventDefault();
    onResize({
      width:
        edge === 'bottom' ? width : Math.min(12, Math.max(1, width + delta[0])),
      height:
        edge === 'right'
          ? height
          : snapHeight(height + delta[1] * gridStep * (event.shiftKey ? 3 : 1)),
    });
  };

  const handle = (edge: Edge, label: string) => (
    <button
      type="button"
      className={`resize-handle ${edge}`}
      aria-label={`${label} (${width}/12 wide, ${rows} grid rows high)`}
      title={label}
      onPointerDown={begin(edge)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={keys(edge)}
    />
  );

  return (
    <div className={`resize-grips ${dragging ? 'dragging' : ''}`} ref={grip}>
      {handle('right', 'Width: drag, or arrow keys')}
      {handle('bottom', 'Height: drag, or arrow keys')}
      {handle('corner', 'Size: drag, or arrow keys')}
      {dragging && (
        <output className="resize-size">
          {width}/12 · {rows} rows
        </output>
      )}
    </div>
  );
}
