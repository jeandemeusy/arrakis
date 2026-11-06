import assert from 'node:assert/strict';
import { test } from 'node:test';
import { valueInputs } from '../lib/viz/value-inputs';
import type { VisualizationConfig } from '../lib/viz/config';

test('traces ungrouped aggregates and direct values without claiming unsupported lineage', () => {
  const config: VisualizationConfig = {
    encoding: { y: ['total'] },
    options: {},
    steps: [
      {
        op: 'filter',
        column: 'kind',
        operator: '=',
        value: { literal: 'paid' },
      },
      {
        op: 'aggregate',
        groupBy: [],
        measures: [{ fn: 'sum', columns: ['amount'], as: 'total' }],
      },
    ],
  };
  assert.deepEqual(valueInputs(config), {
    supported: true,
    scope: 'aggregate',
    steps: [config.steps[0]],
  });
  assert.deepEqual(valueInputs({ ...config, steps: [config.steps[0]] }), {
    supported: true,
    scope: 'first-row',
    steps: [config.steps[0]],
  });
  assert.equal(valueInputs({ ...config, sql: 'SELECT 1' }).supported, false);
  assert.equal(
    valueInputs({
      ...config,
      steps: [{ op: 'aggregate', groupBy: ['kind'], measures: [] }],
    }).supported,
    false,
  );
  assert.equal(
    valueInputs({
      ...config,
      steps: [{ op: 'rolling', time: 'day', days: 7, measures: [] }],
    }).supported,
    false,
  );
  assert.equal(
    valueInputs({ ...config, steps: [{ op: 'range', column: 'at', anchor: 'now' }, config.steps[1]] }).supported,
    false,
  );
});
