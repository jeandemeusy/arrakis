import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bind,
  compile,
  isRelation,
  type FragmentSource,
} from '../lib/query/compile';
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

  it('fills the data source and lists, and refuses to let them be declared', async () => {
    const lists = async (name: string) => (name === 'exits' ? 'bytes' : null);
    const compiled = await compile(
      'SELECT {{source}}, {{network}}, cardinality({{list:exits}}), cardinality({{exits}})',
      [],
      none,
      lists,
    );
    assert.deepEqual(compiled.system.sort(), ['network', 'source']);
    assert.deepEqual(compiled.lists, ['exits']);
    // `{{exits}}` is the list of that name: one slot for both.
    assert.match(compiled.text, /\$3::bytea\[\]\).*\$3::bytea\[\]/s);
    const { values } = bind(
      compiled,
      {},
      { network: 'jura', lists: { exits: [Buffer.alloc(20)] } },
    );
    assert.equal(values.length, 3);
    assert.throws(() => bind(compiled, {}, { network: 'jura' }), /list exits/);
    await assert.rejects(
      compile('SELECT {{list:nope}}', [], none, lists),
      /no list "nope"/,
    );
    for (const name of ['exits', 'source', 'network'])
      assert.throws(
        () => parseDefinitions([{ name, type: 'text' }]),
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

describe('fragments with arguments', () => {
  const resolve = fragments({
    hex: `'0x' || encode({{$value}}, 'hex')`,
    scaled: `{{$amount}} / 10 ^ {{$decimals = 18}}`,
    label: `{{> hex($bytes)}} || ':' || {{$suffix = 'x'}}`,
    rows: 'SELECT * FROM t WHERE n > {{$above = 0}}',
  });

  it('inlines an expression fragment where a value goes', async () => {
    const compiled = await compile(
      'SELECT {{> hex(r.payer)}} AS payer FROM r',
      [],
      resolve,
    );
    assert.equal(
      compiled.text,
      "SELECT (\n'0x' || encode((r.payer), 'hex')\n) AS payer FROM r",
    );
    assert.deepEqual(compiled.fragments, [{ slug: 'hex', versionId: 'v-hex' }]);
  });

  it('takes arguments by position or by name, with defaults', async () => {
    const positional = await compile('SELECT {{> scaled(x)}}', [], resolve);
    assert.match(positional.text, /\(x\) \/ 10 \^ \(18\)/);
    const named = await compile(
      'SELECT {{> scaled(decimals => 6, amount => f(a, b))}}',
      [],
      resolve,
    );
    assert.match(named.text, /\(f\(a, b\)\) \/ 10 \^ \(6\)/);
  });

  it('forwards an argument into a nested fragment', async () => {
    const compiled = await compile("SELECT {{> label(k, 'y')}}", [], resolve);
    assert.match(compiled.text, /encode\(\(k\), 'hex'\)/);
    assert.match(compiled.text, /':' \|\| \('y'\)/);
  });

  it('gives a query fragment its arguments too', async () => {
    const compiled = await compile(
      'SELECT * FROM {{> rows(5)}} AS r',
      [],
      resolve,
    );
    assert.match(compiled.text, /WHERE n > \(5\)/);
  });

  it('runs an expression fragment alone as one value, arguments empty', async () => {
    const compiled = await compile(
      `'0x' || encode({{$value}}, 'hex')`,
      [],
      none,
    );
    assert.equal(
      compiled.text,
      "SELECT ('0x' || encode((NULL), 'hex')) AS value",
    );
  });

  it('says what is wrong with a call', async () => {
    await assert.rejects(
      compile('SELECT {{> hex(a, b)}}', [], resolve),
      /hex takes 1 argument, given 2/,
    );
    await assert.rejects(
      compile('SELECT {{> hex(bytes => a)}}', [], resolve),
      /hex has no argument "bytes"; it takes value/,
    );
    await assert.rejects(
      compile('SELECT {{> hex()}}', [], resolve),
      /needs an argument "value"/,
    );
    await assert.rejects(
      compile('SELECT {{> hex({{network}})}}', [], resolve),
      /cannot contain a placeholder/,
    );
  });
});

describe('a fragment run alone', () => {
  it('passes empty arguments on to the fragments it calls', async () => {
    const compiled = await compile(
      `{{> hex($bytes)}} || ':'`,
      [],
      fragments({ hex: `'0x' || encode({{$value}}, 'hex')` }),
    );
    assert.match(
      compiled.text,
      /^SELECT \(\(\n'0x' \|\| encode\(\(NULL\), 'hex'\)\n\) \|\| ':'\) AS value$/,
    );
  });

  it('tells a value from a relation', () => {
    assert.equal(isRelation('SELECT 1'), true);
    assert.equal(
      isRelation('-- note\nWITH a AS (SELECT 1) SELECT * FROM a'),
      true,
    );
    assert.equal(isRelation('(SELECT 1) UNION (SELECT 2)'), true);
    assert.equal(isRelation("'0x' || encode(x, 'hex')"), false);
    assert.equal(
      isRelation('(\n  SELECT SUM(i) FROM generate_series(0, 7) AS i\n)'),
      false,
    );
    assert.equal(isRelation("(SELECT ')') "), false);
  });
});
