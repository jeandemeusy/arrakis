'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type DashboardVariable } from '../api';
import { type DraftWidget } from './widget-data';

/**
 * What a tile shows beyond its chart: a title and note of its own, what a
 * click on it sets, and when it is shown at all. Edited in the side drawer.
 */
export function TileSettings({
  widget,
  dashboardSlug,
  variables,
  onChange,
  onRemove,
}: {
  widget: DraftWidget;
  dashboardSlug: string;
  variables: DashboardVariable[];
  onChange: (widget: DraftWidget) => void;
  onRemove: () => void;
}) {
  const [dashboards, setDashboards] = useState<Array<{ slug: string; title: string; variables: DashboardVariable[] }>>([]);
  const [target, setTarget] = useState(widget.options.link?.dashboard ?? '');
  useEffect(() => {
    let live = true;
    api<{ dashboards: Array<{ slug: string; title: string; variables: DashboardVariable[] }> }>('/api/v1/dashboards')
      .then((result) => { if (live) setDashboards(result.dashboards); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const destination = widget.options.link ? (widget.options.link.dashboard ?? '') : target;
  const targetVariables = destination ? dashboards.find((dashboard) => dashboard.slug === destination)?.variables ?? [] : variables;
  const textVars = targetVariables.filter(
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
        {widget.width}/12 wide
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
        <legend>Clicking a row or bar</legend>
        <label>Open dashboard <select className="studio-input" value={destination} onChange={(event) => {
          const destination = event.target.value;
          setTarget(destination);
          const available = destination ? dashboards.find((dashboard) => dashboard.slug === destination)?.variables ?? [] : variables;
          const valid = available.some((variable) => variable.name === options.link?.var && (variable.type === 'text' || variable.type === 'select'));
          if (options.link) set({ link: valid ? { ...options.link, dashboard: destination || undefined } : undefined });
        }}><option value="">This dashboard</option>{dashboards.filter((dashboard) => dashboard.slug !== dashboardSlug).map((dashboard) => <option key={dashboard.slug} value={dashboard.slug}>{dashboard.title}</option>)}</select></label>
        <span>Set variable</span>
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
                    dashboard: destination || undefined,
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
