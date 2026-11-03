'use client';

import { memo } from 'react';
import { WidgetTile, type WidgetPayload } from '../../viz/widget-tile';
import { type DashboardWidget } from '../api';
import { useSession } from '../session';
import { type DraftWidget, useWidgetData } from './widget-data';

export type TileLink = NonNullable<DashboardWidget['options']['link']>;

type VisualizationWidgetProps = {
  widget: DraftWidget;
  payload: WidgetPayload | null;
  network: string;
  vars: Record<string, string | undefined>;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  /** Follows the widget's link with a clicked row; stable across renders. */
  onLink?: (link: TileLink, row: Record<string, unknown>) => void;
  /** Its query is being run, or its chart recomputed for new variables. */
  busy?: 'running' | 'updating';
  sources?: string;
};

/**
 * A chart tile on the dashboard. Memoised: a tile redraws only when its own
 * data, its widget or its busy state changes, so switching a variable that
 * three charts read redraws three charts, not thirty.
 */
export const VisualizationWidget = memo(
  VisualizationWidgetTile,
  (before, after) =>
    before.widget === after.widget &&
    before.payload === after.payload &&
    before.network === after.network &&
    before.busy === after.busy &&
    before.sources === after.sources &&
    Boolean(before.onLink) === Boolean(after.onLink) &&
    (before.expanded === before.widget.id) ===
      (after.expanded === after.widget.id) &&
    // Only a tile fetching its own data (while editing) reads the variables.
    (after.payload !== null || before.vars === after.vars),
);

function VisualizationWidgetTile({
  widget,
  payload,
  network,
  vars,
  expanded,
  onExpand,
  onLink,
  busy,
  sources,
}: VisualizationWidgetProps) {
  const link = widget.options.link;
  const onSelect =
    link && onLink
      ? (row: Record<string, unknown>) => onLink(link, row)
      : undefined;
  const own = useWidgetData(
    widget.visualization?.id ?? null,
    network,
    vars,
    payload !== null,
    sources,
  );
  const { user } = useSession();
  const visualization = widget.visualization;
  if (!visualization) {
    return (
      <WidgetTile
        id={widget.id}
        title={widget.options.title ?? 'Removed chart'}
        spec={{ type: 'table', encoding: {}, options: {} }}
        payload={{
          state: 'error',
          error: { status: 404, message: 'This chart was removed.' },
        }}
        width={12}
        height={widget.height}
        expanded={expanded}
        onExpand={onExpand}
      />
    );
  }
  return (
    <WidgetTile
      id={widget.id}
      title={widget.options.title ?? visualization.title}
      spec={{
        type: visualization.type,
        encoding: visualization.config.encoding,
        options: visualization.config.options,
      }}
      payload={payload ?? own}
      subtitle={visualization.queryTitle}
      busy={busy}
      width={12}
      height={widget.height}
      note={widget.options.note}
      expanded={expanded}
      onExpand={onExpand}
      onSelect={onSelect}
      // Every figure leads to the query it is computed from — unless that
      // query is private and the viewer could not open it anyway.
      source={
        visualization.queryVisibility !== 'private' || user
          ? {
              href: `/queries/${visualization.query}?tab=charts&chart=${visualization.id}`,
              label: `Open the query behind this: ${visualization.queryTitle}`,
            }
          : undefined
      }
    />
  );
}
