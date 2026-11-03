import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatTableText, formatValue } from '../app/viz/format';

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

describe('table identifiers', () => {
  it('keeps explicitly configured text whole unless condensation is selected', () => {
    const address = '0x1234567890123456789012345678901234567890';
    assert.equal(formatTableText(address, { text: true }), address);
    assert.equal(formatTableText(address, { text: true, condensed: true }), '0x1234…7890');
    assert.equal(formatTableText(address), '0x1234…7890');
  });
});
