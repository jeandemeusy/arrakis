'use client';

import { isRelation } from '@/lib/query/scan';

/** Saves the selected SQL as a fragment and puts its call in its place. */
export function ExtractForm({
  text,
  slug,
  title,
  error,
  onSlug,
  onTitle,
  onSubmit,
  onCancel,
}: {
  text: string;
  slug: string;
  title: string;
  error: string | null;
  onSlug: (slug: string) => void;
  onTitle: (title: string) => void;
  onSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form className="extract-form" onSubmit={onSubmit}>
      <p>
        Save the selection as a fragment, used here as{' '}
        <code>{`{{> ${slug || 'slug'}}}`}</code>.{' '}
        {isRelation(text)
          ? 'It is a query, so it stands in for a table.'
          : 'It is an expression, so it stands in for a value; write {{$name}} in it for each argument.'}
      </p>
      <pre>{text.trim().split('\n').slice(0, 6).join('\n')}</pre>
      <div className="extract-fields">
        <input
          className="studio-input mono"
          aria-label="Fragment slug"
          placeholder="slug, e.g. vpn-clients"
          pattern="[a-z0-9][a-z0-9\-]*"
          required
          value={slug}
          onChange={(event) => onSlug(event.target.value)}
        />
        <input
          className="studio-input"
          aria-label="Fragment title"
          placeholder="Title (optional)"
          value={title}
          onChange={(event) => onTitle(event.target.value)}
        />
        <button type="submit" className="studio-button primary">
          Save fragment
        </button>
        <button type="button" className="studio-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="studio-error">{error}</p>}
    </form>
  );
}
