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
  onPointerStart,
  onPointerMove,
  onPointerEnd,
  onPointerCancel,
  onMove,
  onSettings,
  onRemove,
}: {
  label: string;
  selected: boolean;
  onPointerStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerEnd: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onMove?: (direction: 'left' | 'right' | 'up' | 'down') => void;
  onSettings?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="tile-toolbar">
      <button
        type="button"
        className="tile-tool grip"
        aria-label={`Move ${label}: drag, or use the arrow keys`}
        title="Drag to move"
        onPointerDown={onPointerStart}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerCancel}
        onKeyDown={(event) => {
          if (!onMove) return;
          const direction = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            ArrowUp: 'up',
            ArrowDown: 'down',
          }[event.key] as 'left' | 'right' | 'up' | 'down' | undefined;
          if (!direction) return;
          event.preventDefault();
          onMove(direction);
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
