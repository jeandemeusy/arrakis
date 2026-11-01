/**
 * The simple chart editor's model: what a builder compiles to. Its results
 * against real data are covered by the parity suite, which runs the bundled
 * charts — most of them builders — against the old page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileBuilder, parseBuilder } from '../lib/viz/builder';
import { finalizeConfig } from '../lib/viz/config';

describe('chart builder', () => {
  it('compiles a split time series and derives its axes', () => {
    const { steps, encoding, options } = compileBuilder('bar', {
      filters: [{ column: 'kind', operator: '=', value: { literal: 'a' } }],
      window: { column: 'day' },
      groups: [{ column: 'at', unit: 'auto' }],
      split: { column: 'direction', order: 'za' },
      measures: [{ fn: 'sum', columns: ['gb'], as: 'gb', format: 'gigabytes' }],
    });
    assert.deepEqual(
      steps.map((step) => step.op),
      ['filter', 'range', 'bucket', 'aggregate', 'sort'],
    );
    assert.deepEqual(encoding, { x: 'period', y: ['gb'], series: 'direction' });
    assert.equal(options.format, 'gigabytes');
    assert.equal(options.seriesOrder, 'rows');
    assert.deepEqual(steps.at(-1), {
      op: 'sort',
      by: [{ column: 'period' }, { column: 'direction', desc: true }],
    });
  });

  it('applies the window after a trailing count, so it can read back', () => {
    const { steps } = compileBuilder('line', {
      window: { column: 'day', from: '2026-01-01' },
      groups: [{ column: 'day' }],
      rolling: 31,
      measures: [{ fn: 'count_distinct', columns: ['client'], as: 'users' }],
    });
    assert.deepEqual(
      steps.map((step) => step.op),
      ['rolling', 'filter', 'range', 'sort'],
    );
  });

  it('ignores what a number tile cannot draw', () => {
    const { steps, encoding } = compileBuilder('number', {
      groups: [{ column: 'day' }],
      split: { column: 'x' },
      measures: [
        { fn: 'count', as: 'n' },
        { fn: 'sum', columns: ['t'], as: 't' },
      ],
    });
    assert.deepEqual(steps, [
      {
        op: 'aggregate',
        groupBy: [],
        measures: [
          { fn: 'count', as: 'n' },
          { fn: 'sum', columns: ['t'], as: 't' },
        ],
      },
    ]);
    assert.deepEqual(encoding, { y: ['n'], note: 't' });
  });

  it('ranks, shares and lists the columns of a grouped table', () => {
    const { steps, options } = compileBuilder('table', {
      groups: [{ column: 'relay' }],
      measures: [
        { fn: 'count', as: 'n' },
        { fn: 'sum', columns: ['gb'], as: 'gb', label: 'volume' },
      ],
      share: { of: 'n' },
      rank: { by: 'gb' },
    });
    assert.deepEqual(options.columns, ['rank', 'relay', 'n', 'gb', 'share']);
    assert.deepEqual(options.labels, { gb: 'volume' });
    assert.equal(options.formats?.share, 'percent');
    assert.equal(steps.at(-1)?.op, 'sort');
  });

  it('shows a table of rows as they are', () => {
    const { steps } = compileBuilder('table', {
      sort: [{ column: 'at', desc: true }],
      limit: 50,
    });
    assert.deepEqual(
      steps.map((step) => step.op),
      ['sort', 'limit'],
    );
  });

  it('asks for a measure on anything but a table', () => {
    assert.throws(() => compileBuilder('bar', { groups: [{ column: 'day' }] }));
  });

  it('keeps the headers a chart set itself', () => {
    const config = finalizeConfig('table', {
      steps: [],
      encoding: {},
      options: { columns: ['at'], labels: { at: 'when' } },
      builder: { sort: [{ column: 'at' }] },
    });
    assert.deepEqual(config.options.labels, { at: 'when' });
    assert.deepEqual(config.options.columns, ['at']);
  });

  it('rejects malformed input and drops empty parts', () => {
    assert.throws(() =>
      parseBuilder({ groups: [{ column: 'x', unit: 'decade' }] }),
    );
    assert.throws(() =>
      parseBuilder({ window: { column: 'd', from: 'yesterday' } }),
    );
    assert.deepEqual(
      parseBuilder({ filters: [], measures: [{ fn: 'count', as: 'n' }] }),
      {
        measures: [{ fn: 'count', as: 'n' }],
      },
    );
  });
});
