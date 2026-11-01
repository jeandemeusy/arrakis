'use client';

import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { type DashboardVariable } from '../api';
import { type DraftWidget } from './widget-data';

/**
 * What a tile shows beyond its chart: a title and note of its own, what a
 * click on it sets, and when it is shown at all. Edited in the side drawer.
 */
export function TileSettings({
  widget,
  variables,
  onChange,
  onRemove,
}: {
  widget: DraftWidget;
  variables: DashboardVariable[];
  onChange: (widget: DraftWidget) => void;
  onRemove: () => void;
}) {
  const textVars = variables.filter(
    (variable) => variable.type === 'text' || variable.type === 'select',
  );
  const options = widget.options;
  const set = (patch: Partial<DraftWidget['options']>) => {
    const next = { ...options, ...patch };
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      if (next[key] === undefined || next[key] === '') delete next[key];
    }
    onChange({ ...widget, options: next });
  };
  const columns = widget.visualization?.config.encoding
    ? [
        ...new Set(
          [
            widget.visualization.config.encoding.x,
            widget.visualization.config.encoding.series,
            widget.visualization.config.encoding.row,
            ...(widget.visualization.config.options.columns ?? []),
          ].filter((name): name is string => Boolean(name)),
        ),
      ]
    : [];

  return (
    <div className="drawer-body">
      {widget.visualization && (
        <p className="drawer-source">
          <span>
            {widget.visualization.title}
            <small>{widget.visualization.queryTitle}</small>
          </span>
          <Link
            href={`/queries/${widget.visualization.query}?tab=charts&chart=${widget.visualization.id}`}
          >
            Open chart
          </Link>
        </p>
      )}
      <p className="drawer-size">
        {widget.width}/12 wide · {widget.height}px high
        <small>Drag the tile&apos;s corner to resize it.</small>
      </p>
      <label className="studio-field">
        <span>Title (defaults to the chart&apos;s)</span>
        <input
          value={options.title ?? ''}
          placeholder={widget.visualization?.title}
          onChange={(event) => set({ title: event.target.value })}
        />
      </label>
      <label className="studio-field">
        <span>Note under the chart</span>
        <input
          value={options.note ?? ''}
          onChange={(event) => set({ note: event.target.value })}
        />
      </label>
      <fieldset className="link-fields">
        <legend>Clicking a row or bar sets</legend>
        <select
          className="studio-input"
          aria-label="Variable to set"
          value={options.link?.var ?? ''}
          onChange={(event) =>
            set({
              link: event.target.value
                ? {
                    column: options.link?.column ?? columns[0] ?? '',
                    var: event.target.value,
                    dashboard: options.link?.dashboard,
                  }
                : undefined,
            })
          }
        >
          <option value="">nothing</option>
          {textVars.map((variable) => (
            <option key={variable.name} value={variable.name}>
              {variable.label}
            </option>
          ))}
        </select>
        {options.link && (
          <>
            <span>to its</span>
            <input
              aria-label="Column"
              className="studio-input mono"
              list={`columns-${widget.id}`}
              value={options.link.column}
              onChange={(event) =>
                options.link &&
                set({
                  link: { ...options.link, column: event.target.value },
                })
              }
            />
            <datalist id={`columns-${widget.id}`}>
              {columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </datalist>
            <span>on dashboard</span>
            <input
              aria-label="Target dashboard"
              className="studio-input mono"
              placeholder="this one"
              value={options.link.dashboard ?? ''}
              onChange={(event) =>
                options.link &&
                set({
                  link: {
                    ...options.link,
                    dashboard: event.target.value || undefined,
                  },
                })
              }
            />
          </>
        )}
      </fieldset>
      <label className="studio-field">
        <span>Only show when this variable is set</span>
        <select
          value={options.requires ?? ''}
          onChange={(event) =>
            set({ requires: event.target.value || undefined })
          }
        >
          <option value="">always show</option>
          {variables.map((variable) => (
            <option key={variable.name} value={variable.name}>
              {variable.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="studio-button danger" onClick={onRemove}>
        <Trash2 size={13} aria-hidden="true" /> Remove from dashboard
      </button>
    </div>
  );
}
