/**
 * Step compilation details that need no database: which window a range step
 * reads and which unit an `auto` bucket picks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSql,
  niceSize,
  rangeCount,
  rangeDays,
} from '../lib/viz/transform';
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

describe('windows and bins over a number column', () => {
  const blocks = {
    sql: 'SELECT * FROM t',
    columns: [
      { name: 'block', type: 'bigint' as const },
      { name: 'head', type: 'bigint' as const },
      { name: 'gigabytes', type: 'float' as const },
    ],
  };

  it('counts a window back from the newest value, or from an anchor column', () => {
    const latest = buildSql(blocks, [{ op: 'range', column: 'block' }], {
      range: '500000',
    });
    assert.match(latest.sql, /"block" > \(SELECT max\("block"\)/);
    assert.deepEqual(latest.values, [500000]);
    const anchored = buildSql(
      blocks,
      [{ op: 'range', column: 'block', window: '1000', anchorColumn: 'head' }],
      {},
    );
    assert.match(anchored.sql, /"block" > "head" - \$1::numeric/);
    assert.deepEqual(anchored.values, [1000]);
  });

  it('refuses a date window over a number column', () => {
    assert.throws(
      () =>
        buildSql(blocks, [{ op: 'range', column: 'block' }], { range: '7d' }),
      /whole count/,
    );
  });

  it('bins to about forty round widths over the window, or a fixed size', () => {
    const width = (range: string) =>
      buildSql(
        blocks,
        [{ op: 'bucket', column: 'block', unit: 'auto', as: 'period' }],
        { range },
      ).values[0];
    assert.equal(width('100000'), 5000);
    assert.equal(width('500000'), 20000);
    assert.equal(width('2000000'), 50000);
    const fixed = buildSql(
      blocks,
      [{ op: 'bucket', column: 'block', unit: 'auto', size: 100, as: 'bin' }],
      {},
    );
    assert.deepEqual(fixed.values, [100]);
    assert.match(fixed.sql, /::bigint AS "bin"/);
  });

  it('reads counts and rounds widths', () => {
    assert.equal(rangeCount('all'), null);
    assert.equal(rangeCount('500000'), 500000);
    assert.throws(() => rangeCount('31d'));
    assert.equal(niceSize(12_500), 20_000);
    assert.equal(niceSize(2_500), 5_000);
    assert.equal(niceSize(2_000), 2_000);
    assert.equal(niceSize(0.3), 1);
  });
});

describe('dashboard variables', () => {
  it('keeps the visibility choice and defaults to showing the label', () => {
    const [hidden, shown, defaulted] = parseVariables([
      { name: 'hidden', type: 'text', showLabel: false },
      { name: 'shown', type: 'text', showLabel: true },
      { name: 'defaulted', type: 'text' },
    ]);
    assert.equal(hidden.showLabel, false);
    assert.equal(shown.showLabel, undefined);
    assert.equal(defaulted.showLabel, undefined);
    assert.throws(
      () => parseVariables([{ name: 'bad', type: 'text', showLabel: 'false' }]),
      /showLabel/,
    );
  });
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
