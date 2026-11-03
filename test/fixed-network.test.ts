import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVariables } from '../lib/viz/store';
import { networkOf, resolveVariables } from '../lib/viz/dashboard-data';

describe('fixed dashboard data sources', () => {
  it('keeps the configured source even if a viewer supplies another', () => {
    const previous = process.env.DATA_SOURCES;
    process.env.DATA_SOURCES = JSON.stringify([
      { id: 'gnosis', databaseUrl: 'postgres://localhost/gnosis' },
      { id: 'other', databaseUrl: 'postgres://localhost/other' },
    ]);
    try {
      const variables = parseVariables([
        { name: 'network', type: 'network', default: 'gnosis', fixed: true },
      ]);
      const values = resolveVariables(variables, { network: 'other' });
      assert.equal(networkOf(variables, values), 'gnosis');
      assert.throws(() => parseVariables([{ name: 'network', type: 'network', fixed: true }]));
    } finally {
      if (previous === undefined) delete process.env.DATA_SOURCES;
      else process.env.DATA_SOURCES = previous;
    }
  });
});
