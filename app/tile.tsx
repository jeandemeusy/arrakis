'use client';

import {
  cloneElement,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Download, Maximize, Search, X } from 'lucide-react';

const PAPER = '#fffdf8';
const INK = '#17191c';
const MUTED = '#6a6760';
const SANS = 'Arial, Helvetica, sans-serif';

/** One legend entry, shared by the rendered legend and the exported image. */
export type LegendEntry = { color: string; label: string; dashed?: boolean };

export function ChartLegend({ items }: { items: LegendEntry[] }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span key={item.label}>
          <i
            style={
              item.dashed
                ? { borderTop: `2px dashed ${item.color}`, background: 'none' }
                : { background: item.color }
            }
          />
          {item.label}
        </span>
      ))}
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
  for (const [key, value] of Object.entries(extra)) node.setAttribute(key, value);
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
async function rasterise(svg: SVGSVGElement, width: number, height: number, name: string) {
  const scale = Math.min(4, Math.max(2, Math.ceil(globalThis.devicePixelRatio || 1) * 2));
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
  legend: LegendEntry[] = [],
) {
  const source = frame?.querySelector('svg');
  if (!source) return;

  const { width, height } = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.fontFamily = SANS;

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
  out.append(svgRect(0, 0, totalWidth, totalHeight, PAPER));
  out.append(
    svgText(title, pad, pad + 12, 'Georgia, serif', INK, { 'font-size': '17' }),
  );

  legend.forEach((item, index) => {
    const x = pad + (index % perRow) * 190;
    const y = pad + 34 + Math.floor(index / perRow) * 20;
    out.append(svgRect(x, y - 1, 20, 2, item.color));
    out.append(
      svgText(item.label, x + 28, y + 4, SANS, MUTED, { 'font-size': '12' }),
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
async function exportFigure(title: string, figure: string, note: string) {
  const width = 520;
  const height = 240;
  const pad = 34;

  const out = document.createElementNS(SVG_NS, 'svg');
  out.setAttribute('xmlns', SVG_NS);
  out.setAttribute('viewBox', `0 0 ${width} ${height}`);
  out.append(svgRect(0, 0, width, height, PAPER));
  out.append(
    svgText(title.toUpperCase(), pad, pad, SANS, MUTED, {
      'font-size': '10',
      'letter-spacing': '1.4',
    }),
  );
  out.append(
    svgText(figure, pad, pad + 92, 'Georgia, serif', INK, { 'font-size': '68' }),
  );
  if (note) {
    out.append(
      svgText(note, pad, height - pad, SANS, MUTED, { 'font-size': '12' }),
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
  const open = expanded === id;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  // Read the ref inside the handler, never while rendering.
  const isNumber = figure !== undefined;
  const canDownload = Boolean(chart || rows || isNumber);
  const download = () => {
    if (chart) void exportChart(frame.current, title, legend);
    else if (isNumber) void exportFigure(title, figure, noteText ?? '');
    else if (rows) exportCsv(rows(), title);
  };

  const body = (
    <div className="chart-frame" ref={frame}>
      {chart ?? children}
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
          <span>{title}</span>
          <strong>{figure}</strong>
          {note}
        </>
      ) : (
        <>
          <div className="chart-title">
            <div>
              {eyebrow && <span>{eyebrow}</span>}
              <h3>{title}</h3>
            </div>
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
          {note}
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
            {isNumber ? (
              <div className="modal-number">
                <strong>{figure}</strong>
              </div>
            ) : chart ? (
              cloneElement(chart, { height: 560 })
            ) : (
              children
            )}
            {note}
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
