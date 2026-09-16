'use client';

import {
  cloneElement,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AlertTriangle, Download, Maximize, Search, X } from 'lucide-react';

import type { PanelStatus } from '@/lib/snapshot';
import type { Palette } from './chart-theme';
import { usePalette } from './style';

/** One legend entry, shared by the rendered legend and the exported image. */
export type LegendEntry = {
  color: string;
  label: string;
  dashed?: boolean;
  /** A key can visually declare the axis its series reads against. */
  align?: 'left' | 'right';
};

/*
 * The series colour is handed to CSS as a custom property rather than as a
 * finished `background`, so the stylesheet decides what shape a swatch is: a
 * rule in the editorial style, a block in the heavy one. Setting `background`
 * inline would have pinned that decision here, and a style that draws swatches
 * as outlined blocks could then only blank them out, losing the colour that is
 * the whole point of a key.
 */
export function ChartLegend({ items }: { items: LegendEntry[] }) {
  const left = items.filter((item) => item.align !== 'right');
  const right = items.filter((item) => item.align === 'right');
  const group = (entries: LegendEntry[]) =>
    entries.map((item) => (
      <span key={item.label} className="legend-item">
        <i
          className={item.dashed ? 'dashed' : undefined}
          style={{ '--swatch': item.color } as CSSProperties}
        />
        {item.label}
      </span>
    ));
  return (
    <div className="legend">
      <div className="legend-group">{group(left)}</div>
      {right.length > 0 && <div className="legend-group right">{group(right)}</div>}
    </div>
  );
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgText(
  text: string,
  x: number,
  y: number,
  font: string,
  fill: string,
  extra: Record<string, string> = {},
) {
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('x', String(x));
  node.setAttribute('y', String(y));
  node.setAttribute('font-family', font);
  node.setAttribute('fill', fill);
  for (const [key, value] of Object.entries(extra))
    node.setAttribute(key, value);
  node.textContent = text;
  return node;
}

function svgRect(x: number, y: number, w: number, h: number, fill: string) {
  const node = document.createElementNS(SVG_NS, 'rect');
  node.setAttribute('x', String(x));
  node.setAttribute('y', String(y));
  node.setAttribute('width', String(w));
  node.setAttribute('height', String(h));
  node.setAttribute('fill', fill);
  return node;
}

/**
 * Rasterises a composed SVG to a PNG.
 *
 * The size is set on the SVG itself rather than by scaling the canvas context. It
 * matters: a browser rasterises an SVG at the size the element declares, so
 * drawing it small and scaling the canvas up enlarges a finished bitmap and the
 * result is soft. Declaring the full pixel size makes the browser re-render the
 * vector at that size, which is what makes the export sharp.
 */
async function rasterise(
  svg: SVGSVGElement,
  width: number,
  height: number,
  name: string,
) {
  const scale = Math.min(
    4,
    Math.max(2, Math.ceil(globalThis.devicePixelRatio || 1) * 2),
  );
  svg.setAttribute('width', String(width * scale));
  svg.setAttribute('height', String(height * scale));

  const markup = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('could not rasterise'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (blob) save(blob, `${name}.png`);
}

/**
 * Exports a chart as a PNG.
 *
 * The chart is already vector, so this composes a slightly larger SVG carrying the
 * background, title and legend, then rasterises that at several device pixels per
 * CSS pixel. One thing does not survive the copy — an SVG carries no cascade from
 * the page — so the font is declared on the clone, or every label renders as the
 * default serif.
 */
export async function exportChart(
  frame: HTMLElement | null,
  title: string,
  palette: Palette,
  legend: LegendEntry[] = [],
) {
  const source = frame?.querySelector('svg');
  if (!source) return;
  const faces = palette.faces;

  const { width, height } = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.fontFamily = faces.sans;

  const pad = 24;
  const perRow = Math.max(1, Math.floor(width / 190));
  const legendRows = legend.length ? Math.ceil(legend.length / perRow) : 0;
  const head = 34 + (legendRows ? legendRows * 20 + 8 : 0);

  const totalWidth = width + pad * 2;
  const totalHeight = height + pad * 2 + head;
  const out = document.createElementNS(SVG_NS, 'svg');
  out.setAttribute('xmlns', SVG_NS);
  // The viewBox stays in logical units; `rasterise` sets the pixel size.
  out.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`);
  out.append(svgRect(0, 0, totalWidth, totalHeight, palette.surface));
  out.append(
    svgText(title, pad, pad + 12, faces.display, palette.ink, {
      'font-size': '17',
    }),
  );

  legend.forEach((item, index) => {
    const x = pad + (index % perRow) * 190;
    const y = pad + 34 + Math.floor(index / perRow) * 20;
    // A style that outlines its marks gets a block; one that does not, a rule.
    const swatch = palette.barStroke
      ? svgRect(x, y - 6, 20, 12, item.color)
      : svgRect(x, y - 1, 20, 2, item.color);
    if (palette.barStroke) {
      swatch.setAttribute('stroke', palette.barStroke);
      swatch.setAttribute('stroke-width', String(palette.barStrokeWidth));
    }
    out.append(swatch);
    out.append(
      svgText(item.label, x + 28, y + 4, faces.sans, palette.muted, {
        'font-size': '12',
      }),
    );
  });

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('transform', `translate(${pad}, ${pad + head})`);
  group.append(clone);
  out.append(group);

  await rasterise(out, totalWidth, totalHeight, slug(title));
}

/**
 * Exports a number tile as a PNG.
 *
 * A number tile is a label, a figure and a note, so the image reproduces them with
 * the same faces and colours the page uses rather than rasterising the DOM.
 */
async function exportFigure(
  title: string,
  figure: string,
  note: string,
  palette: Palette,
) {
  const faces = palette.faces;
  const width = 520;
  const height = 240;
  const pad = 34;

  const out = document.createElementNS(SVG_NS, 'svg');
  out.setAttribute('xmlns', SVG_NS);
  out.setAttribute('viewBox', `0 0 ${width} ${height}`);
  out.append(svgRect(0, 0, width, height, palette.surface));
  out.append(
    svgText(title.toUpperCase(), pad, pad, faces.sans, palette.muted, {
      'font-size': '10',
      'letter-spacing': '1.4',
    }),
  );
  out.append(
    svgText(figure, pad, pad + 92, faces.display, palette.ink, {
      'font-size': '68',
    }),
  );
  if (note) {
    out.append(
      svgText(note, pad, height - pad, faces.sans, palette.muted, {
        'font-size': '12',
      }),
    );
  }

  await rasterise(out, width, height, slug(title));
}

/** Serialises rows to CSV. Data panels export their data, not a picture of it. */
export function exportCsv(rows: string[][], title: string) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) =>
          /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell,
        )
        .join(','),
    )
    .join('\n');
  save(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `${slug(title)}.csv`,
  );
}

export type TileProps = {
  id: string;
  title: string;
  eyebrow?: string;
  badge?: ReactNode;
  /** Row count shown beside the search, as a table's own summary of itself. */
  rowCount?: number;
  /** Filter box under the table, for the table variants. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /**
   * Whether the data behind this tile arrived.
   *
   * A tile with nothing in it says nothing about why. `failed` replaces the body
   * with the reason so an outage is never mistaken for a quiet week; `partial`
   * leaves the figures up — they are real — and flags what is missing from them.
   */
  status?: PanelStatus;
  legend?: LegendEntry[];
  /**
   * Whether the legend belongs in the card header. Off for the relayer charts,
   * which share one key below the pair rather than repeating it twice — but the
   * data is still carried, so the dialog and the export can use it.
   */
  showLegend?: boolean;
  /** Plain-text note, drawn into the exported image of a number tile. */
  noteText?: string;
  note?: ReactNode;
  /** Rendered under the body: pagers and the like. */
  footer?: ReactNode;
  className?: string;
  /** Number variant. */
  figure?: string;
  /** Chart variant: cloned at a taller height when enlarged, exported as PNG. */
  chart?: ReactElement<{ height?: number }>;
  /** Exported as CSV when supplied, for the number and table variants. */
  rows?: () => string[][];
  children?: ReactNode;
  expanded: string | null;
  onExpand: (id: string | null) => void;
};

/**
 * The one panel every figure on the page is built from.
 *
 * A number, a chart and a table are variants of the same tile rather than three
 * separate layouts: each gets the same header, the same legend slot, and the same
 * pair of controls to enlarge it and to export it. What "export" produces depends
 * on the variant — a chart is a picture, everything else is its data — but where
 * the control lives and what it looks like does not.
 */
export function Tile({
  id,
  title,
  eyebrow,
  badge,
  rowCount,
  search,
  status,
  legend,
  showLegend = true,
  note,
  noteText,
  footer,
  className,
  figure,
  chart,
  rows,
  children,
  expanded,
  onExpand,
}: TileProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const palette = usePalette();
  const open = expanded === id;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  // Read the ref inside the handler, never while rendering.
  const isNumber = figure !== undefined;
  const broken = status?.state === 'failed';
  // Nothing to export from a tile whose query never returned.
  const canDownload = Boolean(chart || rows || isNumber) && !broken;
  const download = () => {
    if (chart) void exportChart(frame.current, title, palette, legend);
    else if (isNumber)
      void exportFigure(title, figure, noteText ?? '', palette);
    else if (rows) exportCsv(rows(), title);
  };

  const unavailable = (
    <div className="tile-unavailable">
      <AlertTriangle size={18} aria-hidden="true" />
      <p>{status?.reason ?? 'This panel could not be loaded.'}</p>
    </div>
  );

  const flag = status && status.state !== 'ok' && (
    <span
      className={`tile-flag ${status.state}`}
      title={status.reason ?? undefined}
    >
      <AlertTriangle size={11} aria-hidden="true" />
      {status.state === 'failed' ? 'unavailable' : 'partial'}
    </span>
  );

  const body = (
    <div className="chart-frame" ref={frame}>
      {broken ? unavailable : (chart ?? children)}
    </div>
  );

  // A table has a footer strip, so the controls join it and cannot overlap the
  // pager. A chart has none, so they float over its bottom-right corner.
  const hasFoot = Boolean(search || footer || rowCount !== undefined);
  const actions = (
    <div className="chart-actions">
      {canDownload && (
        <button
          type="button"
          onClick={download}
          aria-label={`Download ${title}`}
          title={`Download ${title}`}
        >
          <Download size={14} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        onClick={() => onExpand(id)}
        aria-label={`Enlarge ${title}`}
        title={`Enlarge ${title}`}
      >
        <Maximize size={14} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div className={`chart-card ${className ?? ''}`}>
      {isNumber ? (
        <>
          <span>
            {title}
            {flag}
          </span>
          <strong>{figure}</strong>
          {broken ? (
            <p className="metric-unavailable">{status?.reason}</p>
          ) : (
            note
          )}
        </>
      ) : (
        <>
          <div className="chart-title">
            <div>
              {eyebrow && <span>{eyebrow}</span>}
              <h3>{title}</h3>
            </div>
            {flag}
            {badge}
          </div>
          {body}
          {showLegend && legend && legend.length > 0 && (
            <div className="tile-legend">
              <ChartLegend items={legend} />
            </div>
          )}
          {(search || footer || rowCount !== undefined) && (
            <div className="tile-foot">
              {rowCount !== undefined && (
                <span className="tile-rows">
                  {new Intl.NumberFormat('en-US').format(rowCount)} rows
                </span>
              )}
              {search && (
                <label className="tile-search">
                  <Search size={13} aria-hidden="true" />
                  <span className="sr-only">Search {title}</span>
                  <input
                    type="search"
                    value={search.value}
                    placeholder={search.placeholder ?? 'Search…'}
                    onChange={(event) => search.onChange(event.target.value)}
                  />
                </label>
              )}
              <div className="tile-foot-end">
                {footer}
                {actions}
              </div>
            </div>
          )}
          {!broken && note}
        </>
      )}

      {!hasFoot && actions}
      <dialog
        ref={dialog}
        className="modal"
        aria-label={title}
        onClose={() => onExpand(null)}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            type="button"
            onClick={() => onExpand(null)}
            aria-label="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Mounted only while open, so the page does not carry a hidden second
            copy of every chart and table. */}
        {open && (
          <div className="modal-body">
            {broken ? (
              unavailable
            ) : isNumber ? (
              <div className="modal-number">
                <strong>{figure}</strong>
              </div>
            ) : chart ? (
              cloneElement(chart, { height: 560 })
            ) : (
              children
            )}
            {!broken && note}
            {legend && legend.length > 0 && (
              <div className="modal-legend">
                <ChartLegend items={legend} />
              </div>
            )}
          </div>
        )}
      </dialog>
    </div>
  );
}
