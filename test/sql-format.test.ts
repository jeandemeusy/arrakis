import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { formatSql, significant } from '../app/(studio)/sql-format';

const example = path.join(
  import.meta.dirname,
  '..',
  'examples',
  'bundles',
  'gnosis-vpn.json',
);

describe('formatSql', () => {
  it('lays clauses, lists, joins and subqueries out on their own lines', () => {
    assert.equal(
      formatSql(
        'select a, count(*) as n from t left join u on u.id = t.id and u.ok where x between 1 and 2 and y in (select y from v) group by a order by n desc nulls last limit 5',
      ),
      [
        'SELECT',
        '  a,',
        '  count(*) AS n',
        'FROM t',
        'LEFT JOIN u',
        '  ON u.id = t.id',
        '  AND u.ok',
        'WHERE x BETWEEN 1 AND 2',
        '  AND y IN (',
        '    SELECT y',
        '    FROM v',
        '  )',
        'GROUP BY a',
        'ORDER BY n DESC NULLS LAST',
        'LIMIT 5',
        '',
      ].join('\n'),
    );
  });

  it('leaves strings, quoted names, placeholders and comments as written', () => {
    const sql =
      `select 'from where' as "Select", {{> frag(a => 'x')}} , {{name}} -- keep me\n` +
      `from t /* and this */ where e'\\n' = $$ select $$`;
    const formatted = formatSql(sql);
    for (const piece of [
      "'from where'",
      '"Select"',
      "{{> frag(a => 'x')}}",
      '{{name}}',
      '-- keep me',
      '/* and this */',
      "e'\\n'",
      '$$ select $$',
    ])
      assert.ok(formatted.includes(piece), piece);
  });

  it('writes CASE with a line per branch, and keeps unary minus and casts tight', () => {
    assert.equal(
      formatSql(
        "select case when x > 0 then 'up' else 'down' end, -1, a::int[], arr[2] from t",
      ),
      [
        'SELECT',
        '  CASE',
        "    WHEN x > 0 THEN 'up'",
        "    ELSE 'down'",
        '  END,',
        '  -1,',
        '  a::int[],',
        '  arr[2]',
        'FROM t',
        '',
      ].join('\n'),
    );
  });

  it('changes only whitespace and case, and is stable, on every query of the example bundle', async () => {
    const { queries } = JSON.parse(await readFile(example, 'utf8')) as {
      queries: Array<{ slug: string; sql: string }>;
    };
    assert.ok(queries.length > 5);
    for (const { slug, sql } of queries) {
      const once = formatSql(sql);
      assert.deepEqual(significant(once), significant(sql), slug);
      assert.equal(formatSql(once), once, slug);
    }
  });
});
