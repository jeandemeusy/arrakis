'use client';

import { useEffect, useRef, useState } from 'react';
import { GripVertical, RotateCcw, X } from 'lucide-react';

import {
  FORMATS,
  type AxisOptions,
  type Format,
  type Options,
  type SeriesStyle,
  type VisualizationType,
} from '@/lib/viz/config';

import type { DrawnSeries } from '../../viz/series';
import { usePalette } from '../../style';

/**
 * How a chart is drawn, as Dune lays it out: panels of options under the
 * chart (the chart itself, each axis) and a table of its series, each with
 * its colour, name, mark and axis. Everything here edits `options` only; what
 * the chart shows is the data form's business.
 */

export const CARTESIAN: VisualizationType[] = ['line', 'area', 'bar'];

const FORMAT_LABELS: Record<Format, string> = {
  number: '1,234',
  compact: '1.2K',
  decimal: '1,234.56',
  percent: '12.3%',
  gigabytes: '1.2 GB',
  token: '÷ 10¹⁸ (token)',
};

type Set = (patch: Partial<Options>) => void;

function Row({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="opt-row" title={hint}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="opt-row opt-check" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** Text that only reports when it is left, so typing never rerenders the chart per key. */
function Text({
  value,
  placeholder,
  onCommit,
  type = 'text',
}: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  type?: 'text' | 'number';
}) {
  const [draft, setDraft] = useState(value);
  // A new value from outside (another chart opened, a reset) replaces the draft.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

function FormatSelect({
  value,
  fallback,
  onChange,
}: {
  value: Format | undefined;
  fallback: string;
  onChange: (value: Format | undefined) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(event) =>
        onChange((event.target.value || undefined) as Format | undefined)
      }
    >
      <option value="">{fallback}</option>
      {FORMATS.map((format) => (
        <option key={format} value={format}>
          {FORMAT_LABELS[format]}
        </option>
      ))}
    </select>
  );
}

/** Options of the chart as a whole. */
export function ChartPanel({
  type,
  options,
  split,
  set,
}: {
  type: VisualizationType;
  options: Options;
  /** Whether the chart has more than one series. */
  split: boolean;
  set: Set;
}) {
  const cartesian = CARTESIAN.includes(type);
  return (
    <section className="opt-panel">
      <h4>Chart options</h4>
      {type === 'number' && (
        <Row label="Text under the figure">
          <Text
            value={options.caption ?? ''}
            onCommit={(caption) => set({ caption: caption || undefined })}
          />
        </Row>
      )}
      {type === 'table' && (
        <Row label="Rows per page">
          <input
            type="number"
            min={5}
            max={500}
            value={options.pageSize ?? 10}
            onChange={(event) => set({ pageSize: Number(event.target.value) })}
          />
        </Row>
      )}
      {cartesian && (
        <>
          <Check
            label="Show chart legend"
            checked={options.legend ?? split}
            onChange={(legend) => set({ legend })}
          />
          <Check
            label="Enable stacking"
            checked={Boolean(options.stacked) || Boolean(options.normalize)}
            disabled={Boolean(options.normalize) || type === 'line'}
            hint={
              type === 'line'
                ? 'Lines are not stacked; set the series to bars or areas.'
                : undefined
            }
            onChange={(stacked) => set({ stacked: stacked || undefined })}
          />
          <Check
            label="Normalize to percentage"
            checked={Boolean(options.normalize)}
            hint="Each point stacked to 100%: shares rather than amounts."
            onChange={(normalize) => set({ normalize: normalize || undefined })}
          />
          <Check
            label="Show total in tooltip"
            checked={Boolean(options.tooltipTotal)}
            onChange={(tooltipTotal) =>
              set({ tooltipTotal: tooltipTotal || undefined })
            }
          />
          <Check
            label="Show data labels"
            checked={Boolean(options.dataLabels)}
            onChange={(dataLabels) =>
              set({ dataLabels: dataLabels || undefined })
            }
          />
          {type !== 'bar' && (
            <Check
              label="Draw lines as steps"
              checked={Boolean(options.step)}
              onChange={(step) => set({ step: step || undefined })}
            />
          )}
        </>
      )}
      {type === 'pie' && (
        <>
          <Check
            label="Draw as a ring"
            checked={Boolean(options.donut)}
            hint="A donut, with the total in its middle."
            onChange={(donut) => set({ donut: donut || undefined })}
          />
          <Check
            label="Label slices with their share"
            checked={Boolean(options.dataLabels)}
            onChange={(dataLabels) =>
              set({ dataLabels: dataLabels || undefined })
            }
          />
        </>
      )}
      {(cartesian || type === 'pie') && (
        <Row label="Legend position">
          <select
            value={options.legendPosition ?? 'auto'}
            onChange={(event) =>
              set({
                legendPosition: event.target.value as Options['legendPosition'],
              })
            }
          >
            <option value="auto">Auto</option>
            <option value="side">Right of chart</option>
            <option value="below">Below chart</option>
          </select>
        </Row>
      )}
      {(cartesian || type === 'share' || type === 'pie') && (
        <Check
          label="Keep series colours stable"
          checked={Boolean(options.stableColors)}
          hint="Colour each series by its name, so it keeps its colour across charts and as others come and go."
          onChange={(stableColors) =>
            set({ stableColors: stableColors || undefined })
          }
        />
      )}
    </section>
  );
}

function axisPatch(
  axis: AxisOptions | undefined,
  patch: Partial<AxisOptions>,
): AxisOptions | undefined {
  const next: AxisOptions = { ...axis, ...patch };
  for (const key of Object.keys(next) as Array<keyof AxisOptions>) {
    if (next[key] === undefined || next[key] === '' || next[key] === false)
      delete next[key];
  }
  // `zero` is on unless turned off: store only the off.
  if (patch.zero === true) delete next.zero;
  if (patch.zero === false) next.zero = false;
  return Object.keys(next).length ? next : undefined;
}

const number = (text: string) =>
  text.trim() === '' || !Number.isFinite(Number(text))
    ? undefined
    : Number(text);

/** The category axis. */
export function XAxisPanel({ options, set }: { options: Options; set: Set }) {
  const axis = options.xAxis;
  const patch = (value: Partial<AxisOptions>) =>
    set({ xAxis: axisPatch(axis, value) });
  return (
    <section className="opt-panel">
      <h4>X-axis options</h4>
      <Row label="Axis title">
        <Text
          value={axis?.title ?? ''}
          placeholder="None"
          onCommit={(title) => patch({ title: title || undefined })}
        />
      </Row>
      <Check
        label="Reverse values"
        checked={Boolean(axis?.reverse)}
        onChange={(reverse) => patch({ reverse })}
      />
      <Check
        label="Time range selector"
        checked={Boolean(axis?.brush)}
        hint="A slider under the chart to zoom into part of the range."
        onChange={(brush) => patch({ brush })}
      />
    </section>
  );
}

/** A values axis: the left one, or the right one some series are set to. */
export function YAxisPanel({
  side,
  options,
  set,
}: {
  side: 'left' | 'right';
  options: Options;
  set: Set;
}) {
  const key = side === 'left' ? 'yAxis' : 'rightAxis';
  const axis = options[key];
  const patch = (value: Partial<AxisOptions>) =>
    set({ [key]: axisPatch(axis, value) });
  const percent = side === 'left' && Boolean(options.normalize);
  return (
    <section className="opt-panel">
      <h4>{side === 'left' ? 'Y-axis options' : 'Right y-axis options'}</h4>
      <Row label="Axis title">
        <Text
          value={axis?.title ?? ''}
          placeholder="None"
          onCommit={(title) => patch({ title: title || undefined })}
        />
      </Row>
      <Check
        label="Logarithmic"
        checked={Boolean(axis?.log)}
        disabled={percent}
        onChange={(log) => patch({ log })}
      />
      <Check
        label="Include 0"
        checked={axis?.zero !== false && !axis?.log}
        disabled={percent || Boolean(axis?.log)}
        onChange={(zero) => patch({ zero })}
      />
      <Row label="Minimum">
        <Text
          type="number"
          value={axis?.min === undefined ? '' : String(axis.min)}
          placeholder="Auto"
          onCommit={(text) => patch({ min: number(text) })}
        />
      </Row>
      <Row label="Maximum">
        <Text
          type="number"
          value={axis?.max === undefined ? '' : String(axis.max)}
          placeholder="Auto"
          onCommit={(text) => patch({ max: number(text) })}
        />
      </Row>
      <Row label="Tick format">
        <FormatSelect
          value={axis?.format}
          fallback={percent ? 'Percent' : 'As the values'}
          onChange={(format) => patch({ format })}
        />
      </Row>
    </section>
  );
}

/** A series' colour: the palette's swatches, any colour, or back to the default. */
function ColorPick({
  entry,
  onChange,
}: {
  entry: DrawnSeries;
  onChange: (color: string | undefined) => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!frame.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const hex = /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color : '#888888';
  return (
    <div className="color-pick" ref={frame}>
      <button
        type="button"
        className="color-swatch"
        style={{ background: entry.color }}
        aria-label={`Colour of ${entry.label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      <code>{entry.picked ? entry.color : 'auto'}</code>
      {entry.picked && (
        <button
          type="button"
          className="studio-icon-button bare"
          aria-label="Back to the default colour"
          title="Back to the default colour"
          onClick={() => onChange(undefined)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div className="color-pop">
          <div className="color-grid">
            {palette.categorical.map((color) => (
              <button
                key={color}
                type="button"
                style={{ background: color }}
                aria-label={color}
                aria-pressed={entry.picked && entry.color === color}
                onClick={() => {
                  onChange(color);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <label className="color-custom">
            <input
              type="color"
              value={hex}
              onChange={(event) => onChange(event.target.value)}
            />
            <span>Any colour</span>
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * The series table: one row per series as the chart draws it, in order. Drag
 * a row to reorder; names, colours, marks and axes are saved by series key,
 * so they follow a series however the data changes.
 */
export function SeriesTable({
  type,
  series,
  options,
  set,
}: {
  type: VisualizationType;
  series: DrawnSeries[];
  options: Options;
  set: Set;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const cartesian = CARTESIAN.includes(type);
  const style = (key: string, patch: Partial<SeriesStyle>) => {
    const next: SeriesStyle = { ...options.series?.[key], ...patch };
    for (const name of Object.keys(next) as Array<keyof SeriesStyle>) {
      if (next[name] === undefined || next[name] === false) delete next[name];
    }
    const all = { ...options.series };
    if (Object.keys(next).length) all[key] = next;
    else delete all[key];
    set({ series: Object.keys(all).length ? all : undefined });
  };
  const move = (key: string, to: number) => {
    const keys = series.map((entry) => entry.key).filter((k) => k !== key);
    keys.splice(Math.max(0, Math.min(to, keys.length)), 0, key);
    set({ order: keys });
  };
  const picked = series.some((entry) => entry.picked);
  if (!series.length) return null;
  return (
    <section className="opt-panel opt-series">
      <header>
        <h4>Series</h4>
        <div>
          {options.order?.length ? (
            <button
              type="button"
              className="studio-link"
              onClick={() => set({ order: undefined })}
            >
              Restore order
            </button>
          ) : null}
          <button
            type="button"
            className="studio-link"
            disabled={!picked}
            onClick={() => {
              const all: Record<string, SeriesStyle> = {};
              for (const [key, value] of Object.entries(options.series ?? {})) {
                const { color: _color, ...rest } = value;
                if (Object.keys(rest).length) all[key] = rest;
              }
              set({ series: Object.keys(all).length ? all : undefined });
            }}
          >
            <RotateCcw size={12} aria-hidden="true" /> Restore colours
          </button>
        </div>
      </header>
      {/* A long split (every relay, say) scrolls rather than stretching the page. */}
      <div className="opt-series-scroll">
        <table>
          <thead>
            <tr>
              <th aria-label="Order" />
              <th>Series</th>
              {cartesian && <th>Chart type</th>}
              {cartesian && <th>Axis</th>}
              <th>Colour</th>
              <th>Shown</th>
            </tr>
          </thead>
          <tbody>
            {series.map((entry, at) => (
              <tr
                key={entry.key}
                className={dragging === entry.key ? 'dragging' : undefined}
                onDragOver={(event) => {
                  if (dragging) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging && dragging !== entry.key) move(dragging, at);
                  setDragging(null);
                }}
              >
                <td>
                  <button
                    type="button"
                    className="drag-handle"
                    draggable
                    aria-label={`Move ${entry.label}; arrow keys move it up or down`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging(entry.key);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' && at > 0) {
                        event.preventDefault();
                        move(entry.key, at - 1);
                      } else if (
                        event.key === 'ArrowDown' &&
                        at < series.length - 1
                      ) {
                        event.preventDefault();
                        move(entry.key, at + 1);
                      }
                    }}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                  </button>
                </td>
                <td>
                  <Text
                    value={options.series?.[entry.key]?.label ?? ''}
                    placeholder={entry.label}
                    onCommit={(label) =>
                      style(entry.key, { label: label.trim() || undefined })
                    }
                  />
                </td>
                {cartesian && (
                  <td>
                    <select
                      value={options.series?.[entry.key]?.mark ?? ''}
                      aria-label={`How ${entry.label} is drawn`}
                      onChange={(event) =>
                        style(entry.key, {
                          mark: (event.target.value || undefined) as
                            | SeriesStyle['mark']
                            | undefined,
                        })
                      }
                    >
                      <option value="">Default</option>
                      <option value="bar">Column</option>
                      <option value="line">Line</option>
                      <option value="area">Area</option>
                    </select>
                  </td>
                )}
                {cartesian && (
                  <td>
                    <select
                      value={entry.axis}
                      aria-label={`Axis of ${entry.label}`}
                      onChange={(event) =>
                        style(entry.key, {
                          axis:
                            event.target.value === 'right'
                              ? 'right'
                              : undefined,
                        })
                      }
                    >
                      <option value="left">Left</option>
                      <option value="right">Right</option>
                    </select>
                  </td>
                )}
                <td>
                  <ColorPick
                    entry={entry}
                    onChange={(color) => style(entry.key, { color })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!entry.hidden}
                    aria-label={`Show ${entry.label}`}
                    onChange={(event) =>
                      style(entry.key, { hidden: !event.target.checked })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
