'use client';

import { GripVertical, Settings2, Trash2 } from 'lucide-react';

/**
 * The few controls a tile has while editing, floating over its top-right
 * corner: a grip to drag it elsewhere (or move it with the arrow keys), its
 * settings, and remove.
 */
export function TileToolbar({
  label,
  selected,
  onDragStart,
  onDragEnd,
  onMove,
  onSettings,
  onRemove,
}: {
  label: string;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove?: (by: -1 | 1) => void;
  onSettings?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="tile-toolbar">
      <button
        type="button"
        className="tile-tool grip"
        draggable
        aria-label={`Move ${label}: drag, or use the arrow keys`}
        title="Drag to move"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', label);
          const cell = (event.target as Element).closest(
            '.dashboard-cell, .dashboard-heading',
          );
          if (cell) event.dataTransfer.setDragImage(cell, 24, 24);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (!onMove) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            onMove(-1);
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            onMove(1);
          }
        }}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      {onSettings && (
        <button
          type="button"
          className="tile-tool"
          aria-label={`Settings of ${label}`}
          aria-pressed={selected}
          title="Settings"
          onClick={onSettings}
        >
          <Settings2 size={14} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="tile-tool danger"
        aria-label={`Remove ${label}`}
        title="Remove"
        onClick={onRemove}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
