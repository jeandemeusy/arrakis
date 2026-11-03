import assert from 'node:assert/strict';
import { it } from 'node:test';
import { sortTableRows } from '../app/viz/table-sort';

it('sorts all loaded rows, retaining exact large integers and placing nulls last', () => {
  const rows = [['9007199254740993'], [null], ['9007199254740992'], ['2']];
  assert.deepEqual(
    sortTableRows(rows, 0, 'bigint', 'asc').map((row) => row[0]),
    ['2', '9007199254740992', '9007199254740993', null],
  );
  assert.deepEqual(
    sortTableRows(rows, 0, 'bigint', 'desc').map((row) => row[0]),
    ['9007199254740993', '9007199254740992', '2', null],
  );
  assert.equal(rows[0][0], '9007199254740993');
});
