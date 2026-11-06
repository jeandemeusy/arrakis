'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, CircleHelp } from 'lucide-react';

import { topic, type GuideTopicId } from './guide/topics';

/**
 * A small "?" beside a control: says in a sentence or two what it does, and
 * links to the guide's section on it (in a new tab, so a draft stays put).
 */
const WIDTH = 280;

export function HelpTip({ topic: id }: { topic: GuideTopicId }) {
  const entry = topic(id);
  // Where the popover goes, fixed to the viewport so no scrolling panel clips
  // it; null while closed.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const setOpen = (next: boolean) => {
    if (!next) return setAt(null);
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - WIDTH - 8)),
    });
  };
  const root = useRef<HTMLSpanElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setAt(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAt(null);
    };
    const onScroll = () => setAt(null);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={root}>
      <button
        type="button"
        className="help-tip-button"
        aria-label={`Help: ${entry.title}`}
        aria-expanded={open}
        aria-controls={popId}
        title={entry.title}
        onClick={() => setOpen(!open)}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {open && (
        <span
          id={popId}
          className="help-pop"
          style={{ top: at.top, left: at.left, width: WIDTH }}
        >
          <strong>{entry.title}</strong>
          <span>{entry.summary}</span>
          <Link href={`/guide#${entry.id}`} target="_blank" rel="noopener">
            More in the guide <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
        </span>
      )}
    </span>
  );
}
