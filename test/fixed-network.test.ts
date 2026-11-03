import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVariables } from '../lib/viz/store';
import {
  dashboardTargets,
  isSet,
  networkOf,
  resolveVariables,
} from '../lib/viz/dashboard-data';

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
      assert.throws(() =>
        parseVariables([{ name: 'network', type: 'network', fixed: true }]),
      );
    } finally {
      if (previous === undefined) delete process.env.DATA_SOURCES;
      else process.env.DATA_SOURCES = previous;
    }
  });
});

describe('dashboard source restrictions', () => {
  it('limits all, direct selections, and single-source checks to allowed sources', () => {
    const previous = process.env.DATA_SOURCES;
    process.env.DATA_SOURCES = JSON.stringify([
      { id: 'gnosis', databaseUrl: 'postgres://localhost/gnosis' },
      { id: 'jura', databaseUrl: 'postgres://localhost/jura' },
      { id: 'palu', databaseUrl: 'postgres://localhost/palu' },
    ]);
    try {
      const vars = parseVariables([
        {
          name: 'network',
          type: 'network',
          default: 'all',
          networks: ['jura', 'palu'],
        },
      ]);
      const all = resolveVariables(vars, { network: 'all' });
      assert.deepEqual(
        dashboardTargets(vars, all).map((target) => target.id),
        ['jura', 'palu'],
      );
      assert.equal(isSet(vars, 'network', all), false);
      assert.equal(
        resolveVariables(vars, { network: 'gnosis' }).network,
        'all',
      );
      assert.deepEqual(
        dashboardTargets(vars, resolveVariables(vars, { network: 'palu' })).map(
          (target) => target.id,
        ),
        ['palu'],
      );
      const single = parseVariables([
        {
          name: 'network',
          type: 'network',
          default: 'all',
          networks: ['palu'],
        },
      ]);
      const selected = resolveVariables(single, { network: 'all' });
      assert.equal(selected.network, 'palu');
      assert.equal(isSet(single, 'network', selected), true);
      const legacy = parseVariables([{ name: 'network', type: 'network' }]);
      assert.equal(resolveVariables(legacy, {}).network, undefined);
      assert.equal(
        resolveVariables(legacy, { network: 'gnosis' }).network,
        'gnosis',
      );
      const noStack = parseVariables([
        {
          name: 'network',
          type: 'network',
          default: 'all',
          stack: false,
          networks: ['jura', 'palu'],
        },
      ]);
      assert.equal(resolveVariables(noStack, {}).network, 'jura');
      const missing = parseVariables([
        { name: 'network', type: 'network', networks: ['missing'] },
      ]);
      assert.throws(
        () => resolveVariables(missing, {}),
        /No allowed data sources/,
      );
      assert.throws(
        () =>
          parseVariables([{ name: 'network', type: 'network', networks: [] }]),
        /at least one/,
      );
      assert.throws(
        () =>
          parseVariables([
            {
              name: 'network',
              type: 'network',
              networks: ['jura'],
              default: 'gnosis',
            },
          ]),
        /allowed data sources/,
      );
    } finally {
      if (previous === undefined) delete process.env.DATA_SOURCES;
      else process.env.DATA_SOURCES = previous;
    }
  });
});
