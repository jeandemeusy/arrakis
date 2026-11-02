import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatValue } from '../app/viz/format';

describe('formatValue', () => {
  it('preserves low non-zero decimal values with scientific notation', () => {
    assert.equal(formatValue('0.00000123', 'decimal'), '1.23E-6');
    assert.equal(formatValue('0.00000123', 'number'), '1.23E-6');
  });

  it('preserves low non-zero token values converted from wei', () => {
    assert.equal(formatValue('1230000000000', 'token'), '1.23E-6');
  });

  it('continues to render true zero as zero', () => {
    assert.equal(formatValue('0', 'decimal'), '0');
    assert.equal(formatValue('0', 'token'), '0');
  });
});
