/**
 * Step compilation details that need no database: which window a range step
 * reads and which unit an `auto` bucket picks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSql, rangeDays } from '../lib/viz/transform';
import { parseVariables } from '../lib/viz/store';

const base = {
  sql: 'SELECT * FROM t',
  columns: [
    { name: 'day', type: 'date' as const },
    { name: 'gigabytes', type: 'float' as const },
  ],
};

describe('range and bucket steps', () => {
  it('reads a fixed window over the range variable', () => {
    const built = buildSql(
      base,
      [{ op: 'range', column: 'day', window: '31d', anchor: 'now' }],
      { range: '7d' },
    );
    assert.deepEqual(built.values, ['31 days']);
  });

  it('skips a range step on "all"', () => {
    const built = buildSql(base, [{ op: 'range', column: 'day' }], {
      range: 'all',
    });
    assert.deepEqual(built.values, []);
  });

  it('buckets by day up to a month and by week beyond', () => {
    const unit = (range: string) =>
      /date_trunc\('(\w+)'/.exec(
        buildSql(
          base,
          [{ op: 'bucket', column: 'day', unit: 'auto', as: 'period' }],
          { range },
        ).sql,
      )?.[1];
    assert.equal(unit('7d'), 'day');
    assert.equal(unit('31d'), 'day');
    assert.equal(unit('90d'), 'week');
    assert.equal(unit('all'), 'week');
  });

  it('measures ranges in days', () => {
    assert.equal(rangeDays('31d'), 31);
    assert.equal(rangeDays('2w'), 14);
    assert.equal(rangeDays('12h'), 0.5);
    assert.equal(rangeDays('all'), null);
  });
});

describe('dashboard variables', () => {
  it('keeps labels only for options that exist', () => {
    const [range] = parseVariables([
      {
        name: 'range',
        type: 'range',
        options: ['7d', '31d', 'all'],
        labels: { '31d': 'Last 30 days', '90d': 'Last 90 days', all: '' },
      },
    ]);
    assert.deepEqual(range.labels, { '31d': 'Last 30 days' });
  });
});
