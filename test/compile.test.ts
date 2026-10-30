import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bind, compile, type FragmentSource } from '../lib/query/compile';
import { parseDefinitions } from '../lib/query/params';
import { segments } from '../lib/query/scan';

const none = async () => null;

function fragments(map: Record<string, string>) {
  return async (slug: string): Promise<FragmentSource | null> =>
    slug in map
      ? { slug, versionId: `v-${slug}`, sql: map[slug], parameters: [] }
      : null;
}

describe('scan', () => {
  it('separates strings, identifiers, comments and dollar quotes from code', () => {
    const sql = `select 'a''{{x}}', "{{y}}", E'\\'{{z}}' /* {{c /* nested */ }} */ -- {{d}}
      , $tag$ {{e}} $tag$, $$ {{f}} $$, {{g}}`;
    const code = segments(sql)
      .filter((segment) => segment.code)
      .map((segment) => segment.text)
      .join('');
    assert.ok(code.includes('{{g}}'));
    for (const hidden of [
      '{{x}}',
      '{{y}}',
      '{{z}}',
      '{{c',
      '{{d}}',
      '{{e}}',
      '{{f}}',
    ]) {
      assert.ok(!code.includes(hidden), `${hidden} should not be code`);
    }
  });
});

describe('compile', () => {
  it('binds declared parameters with casts and reuses one slot per name', async () => {
    const parameters = parseDefinitions([
      { name: 'since', type: 'date', default: '2026-01-01' },
      { name: 'who', type: 'address' },
    ]);
    const compiled = await compile(
      'SELECT * FROM t WHERE d >= {{since}} AND a = {{who}} OR b = {{who}}',
      parameters,
      none,
    );
    assert.equal(
      compiled.text,
      'SELECT * FROM t WHERE d >= $1::date AND a = $2::bytea OR b = $2::bytea',
    );
    const { values, resolved } = bind(
      compiled,
      { who: '0x00000000000000000000000000000000000000AB' },
      { network: 'jura' },
    );
    assert.equal(values[0], '2026-01-01');
    assert.ok(Buffer.isBuffer(values[1]));
    assert.equal((values[1] as Buffer).toString('hex').slice(-2), 'ab');
    assert.deepEqual(Object.keys(resolved).sort(), ['since', 'who']);
  });

  it('ignores placeholders in strings and comments', async () => {
    const compiled = await compile(
      "SELECT '{{nope}}' AS a -- {{nope}}\n",
      [],
      none,
    );
    assert.equal(compiled.slots.length, 0);
    assert.ok(compiled.text.includes("'{{nope}}'"));
  });

  it('fills system parameters and refuses to let them be declared', async () => {
    const compiled = await compile(
      'SELECT {{network}}, cardinality({{exits}})',
      [],
      none,
    );
    assert.deepEqual(compiled.system.sort(), ['exits', 'network']);
    const { values } = bind(
      compiled,
      {},
      { network: 'jura', exits: [Buffer.alloc(20)] },
    );
    assert.equal(values.length, 2);
    assert.throws(
      () => parseDefinitions([{ name: 'exits', type: 'text' }]),
      /reserved/,
    );
  });

  it('rejects a second statement, positional parameters and unknown names', async () => {
    await assert.rejects(
      compile('SELECT 1; SELECT 2', [], none),
      /single statement/,
    );
    await assert.rejects(compile('SELECT $1', [], none), /positional/);
    await assert.rejects(
      compile('SELECT {{missing}}', [], none),
      /not declared/,
    );
    await assert.rejects(
      compile('SELECT {{ bad thing }}', [], none),
      /unrecognized/,
    );
    await assert.rejects(compile('SELECT {{x', [], none), /unclosed/);
  });

  it('allows trailing semicolons and comments', async () => {
    const compiled = await compile('SELECT 1;  -- done\n;', [], none);
    assert.ok(!compiled.text.includes(';'));
  });

  it('inlines fragments as subqueries, with their parameters in scope', async () => {
    const resolve = async (slug: string): Promise<FragmentSource | null> =>
      slug === 'clients'
        ? {
            slug,
            versionId: 'v1',
            sql: 'SELECT id FROM account WHERE published_block > {{after}};',
            parameters: parseDefinitions([
              { name: 'after', type: 'integer', default: 5 },
            ]),
          }
        : null;
    const compiled = await compile(
      'SELECT count(*) FROM {{> clients}} AS c',
      [],
      resolve,
    );
    assert.match(
      compiled.text,
      /FROM \(\nSELECT id FROM account WHERE published_block > \$1::bigint\n\) AS c/,
    );
    assert.deepEqual(compiled.fragments, [
      { slug: 'clients', versionId: 'v1' },
    ]);
    const { values } = bind(compiled, {}, { network: 'jura' });
    assert.deepEqual(values, ['5']);
  });

  it('detects fragment cycles and unknown fragments', async () => {
    const resolve = fragments({
      a: 'SELECT * FROM {{> b}} x',
      b: 'SELECT * FROM {{> a}} y',
    });
    await assert.rejects(
      compile('SELECT * FROM {{> a}} z', [], resolve),
      /cycle/,
    );
    await assert.rejects(
      compile('SELECT * FROM {{> nope}} z', [], resolve),
      /Unknown fragment/,
    );
  });

  it('expands block_time() over two clock slots', async () => {
    const compiled = await compile(
      'SELECT {{block_time(published_block)}} AS at, {{block_time(1)}} FROM account',
      [],
      none,
    );
    assert.equal(compiled.usesClock, true);
    assert.equal(compiled.slots.length, 2);
    assert.throws(() => bind(compiled, {}, { network: 'jura' }), /block clock/);
  });

  it('validates parameter values', async () => {
    const parameters = parseDefinitions([
      { name: 'kind', type: 'enum', options: ['a', 'b'] },
      { name: 'n', type: 'integer' },
      { name: 'list', type: 'address[]' },
    ]);
    const compiled = await compile(
      'SELECT {{kind}}, {{n}}, {{list}}',
      parameters,
      none,
    );
    assert.throws(
      () => bind(compiled, { kind: 'c', n: 1, list: [] }, { network: 'x' }),
      /must be one of/,
    );
    assert.throws(
      () => bind(compiled, { kind: 'a', n: 'one', list: [] }, { network: 'x' }),
      /integer/,
    );
    assert.throws(
      () => bind(compiled, { kind: 'a', n: 1, list: '0x12' }, { network: 'x' }),
      /address/,
    );
    assert.throws(
      () =>
        bind(
          compiled,
          { kind: 'a', n: 1, list: [], extra: 1 },
          { network: 'x' },
        ),
      /Unknown parameter/,
    );
    const { values } = bind(
      compiled,
      { kind: 'a', n: '12', list: `0x${'11'.repeat(20)},0x${'22'.repeat(20)}` },
      { network: 'x' },
    );
    assert.equal((values[2] as Buffer[]).length, 2);
  });
});
