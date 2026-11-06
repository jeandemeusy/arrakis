'use client';

import { type QueryVersion } from '../api';
import { diffLines } from '../diff';
import { when } from './workbench-draft';

/** Every saved version, and the selected one diffed against the draft. */
export function VersionsPanel({
  versions,
  selected,
  onSelect,
  draftSql,
  sqlDirty,
  readOnly,
  onLoad,
}: {
  versions: QueryVersion[];
  selected: QueryVersion | null;
  onSelect: (version: number | null) => void;
  draftSql: string;
  sqlDirty: boolean;
  readOnly: boolean;
  onLoad: (version: QueryVersion) => void;
}) {
  const selectedVersion = selected?.version ?? null;
  return (
    <div className="versions">
      <ol className="version-list">
        {versions.map((version) => (
          <li key={version.id}>
            <button
              type="button"
              aria-pressed={selectedVersion === version.version}
              onClick={() =>
                onSelect(
                  selectedVersion === version.version ? null : version.version,
                )
              }
            >
              <strong>v{version.version}</strong>
              <span>{version.note || 'No note'}</span>
              <small>
                {version.createdBy ?? 'unknown'} · {when(version.createdAt)}
              </small>
            </button>
          </li>
        ))}
      </ol>
      {selected && (
        <div className="version-diff">
          <div className="version-diff-head">
            <span>
              v{selected.version} → {sqlDirty ? 'your draft' : 'current'}
            </span>
            {!readOnly && (
              <button
                type="button"
                className="studio-button"
                onClick={() => onLoad(selected)}
              >
                Load into editor
              </button>
            )}
          </div>
          <pre className="diff">
            {diffLines(selected.sql, draftSql).map((line, index) => (
              <span key={index} className={`diff-${line.kind}`}>
                {line.kind === 'added'
                  ? '+ '
                  : line.kind === 'removed'
                    ? '- '
                    : '  '}
                {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
