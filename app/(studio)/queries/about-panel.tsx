'use client';

import Link from 'next/link';
import {
  Database,
  LayoutDashboard,
  Puzzle,
  Table2,
  Workflow,
} from 'lucide-react';
import { type Dependent, type QueryVersion } from '../api';
import { ago } from '../time';
import { type Draft } from './workbench-draft';
import { HelpTip } from '../help-tip';

const TIMEOUT_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Default (30 s preview, 2 min stored)', value: null },
  { label: '10 seconds', value: 10 },
  { label: '30 seconds', value: 30 },
  { label: '1 minute', value: 60 },
  { label: '2 minutes', value: 120 },
  { label: '5 minutes', value: 300 },
  { label: '10 minutes', value: 600 },
];

const ROW_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Default (up to 5 million)', value: null },
  { label: '1,000', value: 1_000 },
  { label: '10,000', value: 10_000 },
  { label: '100,000', value: 100_000 },
  { label: '1,000,000', value: 1_000_000 },
];

/**
 * The side panel: description, run limits, what the query reads, what reads
 * it, the dashboards it feeds and its recent history.
 */
export function AboutPanel({
  draft,
  readOnly,
  editor,
  onUpdate,
  tables,
  usedFragments,
  dependents,
  dashboards,
  versions,
  onOpenVersion,
}: {
  draft: Draft;
  readOnly: boolean;
  editor: boolean;
  onUpdate: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  tables: string[];
  usedFragments: string[];
  /** What reads this fragment; null for a query. */
  dependents: Dependent[] | null;
  /** The dashboards its charts are on; null when it stores no result. */
  dashboards: Array<{ slug: string; title: string; charts: number }> | null;
  versions: QueryVersion[];
  onOpenVersion: (version: number) => void;
}) {
  return (
    <aside className="workbench-about" aria-label="About this query">
      <div className="about-head">
        <h2>About this query</h2>
        <Link
          className="about-lineage"
          href={`/lineage?focus=${encodeURIComponent(`${draft.kind}:${draft.slug}`)}`}
          title="What it reads, and what reads it"
        >
          <Workflow size={13} aria-hidden="true" />
          Lineage
        </Link>
      </div>
      <section>
        <h3>Description</h3>
        {readOnly ? (
          <p className={draft.description ? '' : 'studio-muted'}>
            {draft.description || 'No description.'}
          </p>
        ) : (
          <textarea
            className="studio-input"
            rows={3}
            value={draft.description}
            placeholder="What this query answers"
            onChange={(event) => onUpdate('description', event.target.value)}
          />
        )}
      </section>
      {editor && (
        <section>
          <h3>
            Run limits <HelpTip topic="limits" />
          </h3>
          <label className="about-field">
            <span>Time limit</span>
            <select
              className="studio-input"
              value={draft.timeoutSeconds ?? ''}
              disabled={readOnly}
              onChange={(event) =>
                onUpdate(
                  'timeoutSeconds',
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            >
              {TIMEOUT_OPTIONS.map((option) => (
                <option key={option.label} value={option.value ?? ''}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {draft.kind === 'query' && (
            <label className="about-field">
              <span>Rows kept</span>
              <select
                className="studio-input"
                value={draft.rowLimit ?? ''}
                disabled={readOnly}
                onChange={(event) =>
                  onUpdate(
                    'rowLimit',
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
              >
                {ROW_OPTIONS.map((option) => (
                  <option key={option.label} value={option.value ?? ''}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="studio-muted about-hint">
            A run that takes longer is stopped; rows past the cap are left out
            and the result says it was cut. The server&apos;s own ceilings still
            apply.
          </p>
        </section>
      )}
      <section>
        <h3>
          Data sources{' '}
          <span className="count">{tables.length + usedFragments.length}</span>
        </h3>
        <ul className="about-list">
          {tables.map((name) => (
            <li key={name}>
              <Table2 size={13} aria-hidden="true" />
              <code>{name}</code>
            </li>
          ))}
          {usedFragments.map((name) => (
            <li key={name}>
              <Puzzle size={13} aria-hidden="true" />
              <Link href={`/queries/${name}`}>
                <code>{name}</code>
              </Link>
            </li>
          ))}
          {!tables.length && !usedFragments.length && (
            <li className="studio-muted">
              {editor ? 'No tables named yet.' : 'Listed for editors.'}
            </li>
          )}
        </ul>
      </section>
      {dependents && (
        <section>
          <h3>
            Used by <span className="count">{dependents.length}</span>
          </h3>
          <ul className="about-list">
            {dependents.map((entry) => (
              <li key={entry.slug}>
                {entry.kind === 'fragment' ? (
                  <Puzzle size={13} aria-hidden="true" />
                ) : (
                  <Database size={13} aria-hidden="true" />
                )}
                <Link href={`/queries/${entry.slug}`}>{entry.slug}</Link>
                <small>
                  {entry.direct ? '' : 'through a fragment'}
                  {entry.charts > 0 &&
                    `${entry.direct ? '' : ' · '}${entry.charts} chart${entry.charts === 1 ? '' : 's'}`}
                </small>
              </li>
            ))}
            {!dependents.length && (
              <li className="studio-muted">Not used by any query yet.</li>
            )}
          </ul>
        </section>
      )}
      {dashboards && (
        <section>
          <h3>
            Dashboards <span className="count">{dashboards.length}</span>
          </h3>
          <ul className="about-list">
            {dashboards.map((entry) => (
              <li key={entry.slug}>
                <LayoutDashboard size={13} aria-hidden="true" />
                <Link href={`/dashboards/${entry.slug}`}>{entry.title}</Link>
                <small>
                  {entry.charts} chart{entry.charts === 1 ? '' : 's'}
                </small>
              </li>
            ))}
            {!dashboards.length && (
              <li className="studio-muted">On no dashboard yet.</li>
            )}
          </ul>
        </section>
      )}
      {versions.length > 0 && (
        <section>
          <h3>
            History <span className="count">{versions.length}</span>
          </h3>
          <ol className="about-list">
            {versions.slice(0, 5).map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  className="studio-link"
                  onClick={() => onOpenVersion(version.version)}
                >
                  v{version.version}
                </button>
                <span className="about-note">{version.note || 'No note'}</span>
                <small>{ago(version.createdAt)}</small>
              </li>
            ))}
          </ol>
        </section>
      )}
    </aside>
  );
}
