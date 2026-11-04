import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { adminUrl } from './support';
import { compile } from '../lib/query/compile';

// Exercise the bundle's actual SQL on Transfer-shaped data, including an event
// where the same address is both sender and recipient.
test('token address history reconstructs balances and counts events', { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' }, async () => {
  const bundle = JSON.parse(await readFile('examples/bundles/hopr-tokens.json', 'utf8'));
  const client = new pg.Client({ connectionString: adminUrl ?? undefined });
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE mock_transfers(token text, block bigint, sender bytea, recipient bytea, amount numeric)');
    const address = 'ab'.repeat(20);
    const other = '22'.repeat(20);
    const zero = '00'.repeat(20);
    for (const [token, block, sender, recipient, amount] of [
      ['xHOPR', 1, zero, address, 10],
      ['xHOPR', 2, address, other, 3],
      ['xHOPR', 2, address, address, 5],
      ['xHOPR', 3, address, zero, 2],
      ['wxHOPR', 4, zero, address, 7],
    ]) {
      await client.query("INSERT INTO mock_transfers VALUES ($1, $2, decode($3, 'hex'), decode($4, 'hex'), $5)", [token, block, sender, recipient, amount]);
    }
    const query = bundle.queries.find((entry: { slug: string }) => entry.slug === 'hopr-token-address-activity');
    await client.query(`CREATE TEMP TABLE address_result AS ${query.sql.replace('{{> hopr-token-transfers}}', '(SELECT * FROM mock_transfers)')}`);
    const chart = async (key: string) => {
      const entry = bundle.charts.find((item: { key: string }) => item.key === `hopr-tokens/${key}`);
      const sql: string = entry.config.sql.replaceAll('{{result}}', 'address_result').replaceAll('{{address}}', '$1::text');
      return (await client.query<Record<string, unknown>>(sql, [`0x${address.toUpperCase()}`])).rows;
    };
    assert.deepEqual((await chart('address-balance')).map((row) => [row.token, Number(row.balance)]), [['wxHOPR', 7], ['xHOPR', 5]]);
    assert.deepEqual((await chart('address-history')).map((row) => [row.token, Number(row.block), Number(row.balance)]), [['xHOPR', 1, 10], ['xHOPR', 2, 7], ['xHOPR', 3, 5], ['wxHOPR', 4, 7], ['xHOPR', 4, 5]]);
    assert.equal(Number((await chart('address-transfers'))[0].transfers), 5);
    assert.equal(Number((await chart('address-first-holding'))[0].block), 1);
    assert.equal(Number((await chart('address-last-activity'))[0].block), 4);

    // The real Transfer fragment must decode the full uint256 range exactly,
    // including words whose highest bit makes PostgreSQL's bigint negative.
    await client.query(`CREATE TEMP TABLE log (
      address bytea, block_number bigint, tx_index bigint, log_index bigint,
      transaction_hash bytea, topics bytea, data bytea, removed boolean
    )`);
    const contract = 'd057604a14982fe8d88c5fc25aac3267ea142a08';
    const signature = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const amounts = ['00'.repeat(32), '00'.repeat(31) + '01', '80'.repeat(32), 'ff'.repeat(32)];
    for (const [index, hex] of amounts.entries()) {
      await client.query(`INSERT INTO log VALUES (
        decode($1, 'hex'), 1, $2, 0, decode(repeat('00', 32), 'hex'),
        decode($3 || repeat('00', 64), 'hex'), decode($4, 'hex'), false
      )`, [contract, index, signature, hex]);
    }
    const fragment = bundle.queries.find((entry: { slug: string }) => entry.slug === 'hopr-token-transfers');
    const compiled = await compile(fragment.sql, [], async () => null);
    const decoded = await client.query<{ amount: string }>(`SELECT amount FROM (${compiled.text}) t ORDER BY tx_index`);
    for (let index = 0; index < amounts.length; index++) {
      const same = await client.query<{ equal: boolean }>(
        'SELECT $1::numeric * 1000000000000000000::numeric = $2::numeric AS equal',
        [decoded.rows[index].amount, BigInt(`0x${amounts[index]}`).toString()],
      );
      assert.equal(same.rows[0].equal, true, `decode ${amounts[index]}: ${decoded.rows[index].amount}`);
    }
  } finally {
    await client.end();
  }
});
