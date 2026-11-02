/**
 * How a chart is drawn: the options the editor's panels and series table
 * write, and the series rules the chart and the table share.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paletteOf } from '../app/chart-theme';
import { defaultColors, ordered, pivot, seriesOf } from '../app/viz/series';
import { finalizeConfig, parseConfig, variablesOf } from '../lib/viz/config';

const palette = paletteOf('editorial');

describe('chart options', () => {
  it('keeps the drawing options and drops what is unset', () => {
    const { options } = parseConfig({
      options: {
        legend: false,
        normalize: true,
        tooltipTotal: null,
        stableColors: true,
        series: {
          upstream: {
            label: ' Paid by clients ',
            color: '#AABBCC',
            mark: 'line',
            axis: 'right',
          },
          downstream: { hidden: true },
          empty: { label: '  ' },
        },
        order: ['downstream', 'upstream'],
        yAxis: {
          title: 'GB',
          log: true,
          min: '',
          max: '10',
          format: 'gigabytes',
        },
        xAxis: { reverse: true, brush: false },
        rightAxis: {},
      },
    });
    assert.deepEqual(options, {
      legend: false,
      normalize: true,
      stableColors: true,
      series: {
        upstream: {
          label: 'Paid by clients',
          color: '#aabbcc',
          mark: 'line',
          axis: 'right',
        },
        downstream: { hidden: true },
      },
      order: ['downstream', 'upstream'],
      yAxis: { title: 'GB', log: true, max: 10, format: 'gigabytes' },
      xAxis: { reverse: true, brush: false },
    });
  });

  it('refuses what the renderer cannot draw', () => {
    assert.throws(
      () => parseConfig({ options: { series: { a: { color: 'red' } } } }),
      /#rrggbb/,
    );
    assert.throws(
      () => parseConfig({ options: { series: { a: { mark: 'pie' } } } }),
      /mark/,
    );
    assert.throws(
      () => parseConfig({ options: { series: { a: { axis: 'top' } } } }),
      /axis/,
    );
    assert.throws(
      () => parseConfig({ options: { yAxis: { min: 'low' } } }),
      /number/,
    );
    assert.throws(
      () => parseConfig({ options: { yAxis: { format: 'hex' } } }),
      /format/,
    );
  });

  it('keeps per-column table display choices and rejects invalid widths', () => {
    const { options } = parseConfig({
      options: {
        tableColumns: {
          address: {
            text: true,
            monospace: true,
            condensed: true,
            align: 'center',
            width: 180,
          },
        },
      },
    });
    assert.deepEqual(options.tableColumns, {
      address: {
        text: true,
        monospace: true,
        condensed: true,
        align: 'center',
        width: 180,
      },
    });
    assert.throws(
      () => parseConfig({ options: { tableColumns: { id: { width: 12 } } } }),
      /width/,
    );
  });

  it('survives a builder compiling over the chart', () => {
    const config = finalizeConfig(
      'bar',
      parseConfig({
        builder: {
          groups: [{ column: 'day' }],
          split: { column: 'direction' },
          measures: [{ fn: 'count', as: 'n' }],
        },
        options: {
          series: { upstream: { color: '#123456' } },
          normalize: true,
        },
      }),
    );
    assert.deepEqual(config.options.series, { upstream: { color: '#123456' } });
    assert.equal(config.options.normalize, true);
  });
});

describe('series', () => {
  const columns = [
    { name: 'day', type: 'date' },
    { name: 'direction', type: 'text' },
    { name: 'n', type: 'integer' },
  ];
  const rows = [
    ['2026-10-01', 'upstream', 1],
    ['2026-10-01', 'downstream', 5],
    ['2026-10-02', 'upstream', 2],
  ];
  const encoding = { x: 'day', y: ['n'], series: 'direction' };

  it('orders by total, then by the order the chart names', () => {
    const plain = pivot(columns, rows, encoding, {}, palette, 'bar');
    assert.ok(typeof plain !== 'string');
    assert.deepEqual(
      plain.series.map((entry) => entry.key),
      ['downstream', 'upstream'],
    );
    assert.deepEqual(ordered(['a', 'b', 'c'], ['c', 'gone', 'a']), [
      'c',
      'a',
      'b',
    ]);
  });

  it('applies names, colours, marks, axes and hiding by key', () => {
    const drawn = seriesOf(
      'bar',
      encoding,
      {
        order: ['upstream'],
        series: {
          upstream: {
            label: 'Clients',
            color: '#010203',
            mark: 'line',
            axis: 'right',
          },
          downstream: { hidden: true },
        },
      },
      columns,
      rows,
      palette,
    );
    assert.deepEqual(
      drawn.map(({ key, label, color, picked, mark, axis, hidden }) => ({
        key,
        label,
        color,
        picked,
        mark,
        axis,
        hidden,
      })),
      [
        {
          key: 'upstream',
          label: 'Clients',
          color: '#010203',
          picked: true,
          mark: 'line',
          axis: 'right',
          hidden: false,
        },
        {
          key: 'downstream',
          label: 'downstream',
          color: palette.accent2,
          picked: false,
          mark: 'bar',
          axis: 'left',
          hidden: true,
        },
      ],
    );
  });

  it('gives a series the same colour wherever it appears, when asked', () => {
    const one = defaultColors(['relay-a', 'relay-b'], palette, true);
    const other = defaultColors(
      ['relay-z', 'relay-b', 'relay-a'],
      palette,
      true,
    );
    assert.equal(one[0], other[2]);
    assert.equal(one[1], other[1]);
    // By position otherwise: the first series takes the accent.
    assert.equal(defaultColors(['x'], palette, false)[0], palette.accent);
  });

  it('treats a share chart’s labels as its series, largest first', () => {
    const drawn = seriesOf(
      'share',
      { x: 'direction', y: ['n'] },
      { order: ['upstream'] },
      columns,
      rows,
      palette,
    );
    assert.deepEqual(
      drawn.map((entry) => entry.key),
      ['downstream', 'upstream'],
    );
  });

  it('draws a pie from one label and one value, as a share is', () => {
    const { encoding, options } = finalizeConfig(
      'pie',
      parseConfig({
        builder: {
          groups: [{ column: 'direction' }],
          measures: [{ fn: 'count', as: 'n' }],
        },
        options: { donut: true },
      }),
    );
    assert.deepEqual(encoding, { x: 'direction', y: ['n'] });
    assert.equal(options.donut, true);
    assert.deepEqual(
      seriesOf('pie', encoding, options, columns, rows, palette).map(
        (entry) => entry.key,
      ),
      ['downstream', 'upstream'],
    );
  });
});

describe('palettes', () => {
  it('has a dark editorial palette, and keeps neubrutal light', () => {
    assert.notEqual(
      paletteOf('editorial', 'dark').surface,
      paletteOf('editorial').surface,
    );
    assert.equal(paletteOf('editorial', 'light'), paletteOf('editorial'));
    assert.equal(paletteOf('neubrutal', 'dark'), paletteOf('neubrutal'));
  });
});

describe('the variables a chart reads', () => {
  it('finds them in its steps and its SQL', () => {
    assert.deepEqual(
      [
        ...variablesOf(
          parseConfig({
            steps: [
              { op: 'range', column: 'day' },
              {
                op: 'filter',
                column: 'direction',
                operator: '=',
                value: { var: 'direction' },
              },
              {
                op: 'bucket',
                column: 'day',
                unit: 'auto',
                as: 'week',
                var: 'span',
              },
              { op: 'range', column: 'day', window: '31d' },
            ],
          }),
        ),
      ].sort(),
      ['direction', 'range', 'span'],
    );
    assert.deepEqual(
      [
        ...variablesOf(
          parseConfig({ sql: 'SELECT * FROM {{result}} WHERE c = {{client}}' }),
        ),
      ],
      ['client'],
    );
    // A fixed window reads no variable: the chart is the same at every range.
    assert.equal(
      variablesOf(
        parseConfig({ steps: [{ op: 'range', column: 'day', window: '31d' }] }),
      ).size,
      0,
    );
  });
});
