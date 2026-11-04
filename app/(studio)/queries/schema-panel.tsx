'use client';

import { useMemo, useState } from 'react';
import { type QuerySummary, type SchemaTable } from '../api';
import { HelpTip } from '../help-tip';

/** The tables of the data source, the fragments and the built-ins, each inserted at the cursor. */
export function SchemaPanel({
  schema,
  status,
  fragments,
  lists,
  onInsert,
}: {
  schema: SchemaTable[];
  status: 'loading' | 'ready' | 'error';
  fragments: QuerySummary[];
  /** The lists a query can read, by name. */
  lists: Array<{ name: string; type: string }>;
  onInsert: (text: string) => void;
}) {
  const [schemaFilter, setSchemaFilter] = useState('');
  const visibleTables = useMemo(() => {
    const needle = schemaFilter.trim().toLowerCase();
    if (!needle) return schema;
    return schema.filter(
      (table) =>
        table.name.toLowerCase().includes(needle) ||
        table.schema.toLowerCase().includes(needle) ||
        table.description?.toLowerCase().includes(needle) ||
        table.columns.some((column) =>
          column.name.toLowerCase().includes(needle) || column.type.toLowerCase().includes(needle) || column.description?.toLowerCase().includes(needle),
        ),
    );
  }, [schema, schemaFilter]);
  return (
    <aside className="workbench-side" aria-label="Schema">
      <h2>Schema</h2>
      <input
        className="studio-input"
        type="search"
        placeholder="Filter tables and columns"
        value={schemaFilter}
        onChange={(event) => setSchemaFilter(event.target.value)}
        aria-label="Filter tables and columns"
      />
      <div className="schema-list">
        {visibleTables.map((table) => (
          <details
            key={`${table.schema}.${table.name}`}
            open={Boolean(schemaFilter.trim())}
          >
            <summary>
              <button
                type="button"
                className="schema-name"
                onClick={() => onInsert(table.schema === 'public' ? table.name : `${table.schema}.${table.name}`)}
                title="Insert at cursor"
              >
                {table.name}
              </button>
              {table.kind === 'view' && <small>view</small>}
            </summary>
            {table.schema !== 'public' && <p className="schema-description">{table.schema}</p>}
            {table.description && <p className="schema-description">{table.description}</p>}
            <ul>
              {table.columns.map((column) => (
                <li key={column.name}>
                  <div><button
                    type="button"
                    onClick={() => onInsert(column.name)}
                    title="Insert at cursor"
                  >
                    {column.name}
                  </button>
                  <small className="schema-type">{column.type}</small>
                  {column.description && <p className="schema-description">{column.description}</p>}</div>
                </li>
              ))}
            </ul>
          </details>
        ))}
        {status === 'loading' && <p className="studio-muted">Loading the schema…</p>}
        {status === 'error' && <p className="studio-muted">Could not load the schema for this data source.</p>}
        {status === 'ready' && !visibleTables.length && <p className="studio-muted">{schemaFilter ? 'No matching tables or columns.' : 'No readable tables or views.'}</p>}
      </div>
      <h2>
        Fragments <HelpTip topic="fragments" />
      </h2>
      <ul className="fragment-list">
        {fragments.map((fragment) => {
          const call = fragment.arguments?.length
            ? `{{> ${fragment.slug}(${fragment.arguments.join(', ')})}}`
            : `{{> ${fragment.slug}}}`;
          return (
            <li key={fragment.slug}>
              <button
                type="button"
                onClick={() => onInsert(call)}
                title={`${fragment.title}${fragment.expression ? ' — a value: use it where an expression goes' : ' — a table: use it after FROM or JOIN'}`}
              >
                {call}
              </button>
              {fragment.expression && <small>value</small>}
            </li>
          );
        })}
        {!fragments.length && (
          <li className="studio-muted">
            None yet. Save a query as a fragment to reuse it.
          </li>
        )}
      </ul>
      <h2>Built in</h2>
      <ul className="fragment-list">
        <li>
          <button
            type="button"
            title="The id of the data source the run reads"
            onClick={() => onInsert('{{source}}')}
          >
            {'{{source}}'}
          </button>
        </li>
      </ul>
      <h2>Lists</h2>
      <ul className="fragment-list">
        {lists.map((list) => (
          <li key={list.name}>
            <div className="list-placeholders">
              <button
                type="button"
                title={`An array of ${list.type}, as kept under Settings → Lists`}
                onClick={() => onInsert(`{{list:${list.name}:values}}`)}
              >
                {`{{list:${list.name}:values}}`}
              </button>
              <button
                type="button"
                title="The labels of the list entries, aligned with the values array"
                onClick={() => onInsert(`{{list:${list.name}:names}}`)}
              >
                {`{{list:${list.name}:names}}`}
              </button>
            </div>
            <small>{list.type}</small>
          </li>
        ))}
        {!lists.length && (
          <li className="studio-muted">
            None yet. Keep values a query reads under Settings → Lists.
          </li>
        )}
      </ul>
    </aside>
  );
}
