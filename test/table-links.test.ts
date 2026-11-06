import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tableLink } from '../lib/viz/links';

describe('table links', () => {
  it('encodes values from any row column for dashboard and external links', () => {
    const row = { id: 'a/b?x=1', network: 'one & two', zero: 0 };
    assert.deepEqual(tableLink('/dashboards/detail?id={{id}}&network={{network}}&zero={{zero}}', row), {
      href: '/dashboards/detail?id=a%2Fb%3Fx%3D1&network=one%20%26%20two&zero=0', external: false,
    });
    assert.deepEqual(tableLink('https://example.com/{{id}}', row), { href: 'https://example.com/a%2Fb%3Fx%3D1', external: true });
  });
  it('rejects unsafe destinations and missing or non-scalar row values', () => {
    for (const url of ['javascript:alert(1)', '//example.com', '/\\example.com', 'https://{{host}}/x', 'https://user@example.com', '/x/{{missing}}', '/x/{{empty}}', '/x/{{object}}', '/x/{{bad']) {
      assert.equal(tableLink(url, { host: 'example.com', empty: null, object: {} }), null, url);
    }
  });
});
