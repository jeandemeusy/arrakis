'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Globe,
  Link2,
  Lock,
  Share2,
} from 'lucide-react';

import type { Visibility } from './api';

/**
 * Share: a link to the page, and who it opens for.
 *
 * Sharing is the visibility the item already has, made plain: a private
 * dashboard or query opens for editors only; *anyone with the link* is the
 * unlisted visibility (it opens for anyone, and is listed nowhere); public is
 * listed too. An editor changes it here, and it applies at once. The link can
 * carry the view as it is on screen — a dashboard's filters, a query's chart.
 */

const ACCESS: Array<{
  value: Visibility;
  icon: typeof Lock;
  title: string;
  hint: string;
}> = [
  { value: 'private', icon: Lock, title: 'Editors only', hint: 'Private' },
  {
    value: 'unlisted',
    icon: Link2,
    title: 'Anyone with the link',
    hint: 'Listed nowhere',
  },
  { value: 'public', icon: Globe, title: 'Everyone', hint: 'Listed publicly' },
];

export function ShareButton({
  what,
  visibility,
  path,
  plainPath,
  viewLabel,
  canEdit,
  onVisibility,
  bundleHref,
}: {
  what: 'dashboard' | 'query';
  visibility: Visibility;
  /** The address of the view on screen, read when the dialog opens. */
  path: () => string;
  /** The address of the item itself. */
  plainPath: string;
  /** What the view adds, when it adds anything: "the filters as they are". */
  viewLabel?: string;
  canEdit: boolean;
  onVisibility?: (next: Visibility) => Promise<void>;
  /** Where to download it as a bundle, for another Arrakis; editors only. */
  bundleHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const [withView, setWithView] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState<Visibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const differs = view !== null && view !== plainPath && Boolean(viewLabel);
  const link = `${origin}${differs && withView ? view : plainPath}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // No clipboard (an insecure origin): select it for Cmd/Ctrl+C instead.
      field.current?.select();
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const change = async (next: Visibility) => {
    if (!onVisibility || next === visibility) return;
    setSaving(next);
    setError(null);
    try {
      await onVisibility(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="share menu-anchor" ref={root}>
      <button
        type="button"
        className="studio-button"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setView(path());
            setCopied(false);
            setError(null);
          }
          setOpen(!open);
        }}
      >
        <Share2 size={13} aria-hidden="true" /> Share
      </button>
      {open && (
        <div className="share-pop" aria-label={`Share this ${what}`}>
          <h3>Share this {what}</h3>
          {canEdit ? (
            <fieldset className="share-access">
              <legend>Who can open the link</legend>
              {ACCESS.map(({ value, icon: Icon, title, hint }) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`share-${what}`}
                    value={value}
                    checked={visibility === value}
                    disabled={saving !== null}
                    onChange={() => void change(value)}
                  />
                  <Icon size={14} aria-hidden="true" />
                  <span>
                    {title}
                    <small>{saving === value ? 'Saving…' : hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="studio-muted">
              {visibility === 'public'
                ? 'Anyone can open it.'
                : 'Anyone with the link can open it.'}
            </p>
          )}
          {visibility === 'private' && (
            <p className="share-note">
              Only editors can open it while it is private.
            </p>
          )}
          {error && <p className="studio-error">{error}</p>}
          <div className="share-link">
            <input
              ref={field}
              className="studio-input mono"
              readOnly
              value={link}
              aria-label="Link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="studio-button primary"
              onClick={() => void copy()}
            >
              {copied ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                <Copy size={13} aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {differs && (
            <label className="share-view">
              <input
                type="checkbox"
                checked={withView}
                onChange={(event) => setWithView(event.target.checked)}
              />
              <span>With {viewLabel}</span>
            </label>
          )}
          {bundleHref && (
            <div className="share-bundle">
              <p className="studio-muted">
                For another Arrakis: the {what}, its charts and their queries,
                as one file to import there.
              </p>
              <a className="studio-button" href={bundleHref} download>
                <Download size={13} aria-hidden="true" /> Download as a bundle
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
