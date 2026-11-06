import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inlineMarkdown, markdownBlocks, safeTextLink } from '../lib/viz/markdown';

describe('dashboard text tiles', () => {
  it('parses paragraphs, headings and lists', () => {
    assert.deepEqual(markdownBlocks('# Heading\n\nFirst line\nsecond line\n\n- One\n- Two'), [
      { kind: 'heading', lines: ['Heading'], level: 1 },
      { kind: 'paragraph', lines: ['First line', 'second line'] },
      { kind: 'list', lines: ['One', 'Two'] },
    ]);
  });
  it('supports emphasis, code and safe links without rendering HTML', () => {
    assert.deepEqual(inlineMarkdown('**bold** *em* `code` [go](/dashboards/demo) <script>'), [
      { kind: 'strong', text: 'bold' }, { kind: 'text', text: ' ' },
      { kind: 'em', text: 'em' }, { kind: 'text', text: ' ' },
      { kind: 'code', text: 'code' }, { kind: 'text', text: ' ' },
      { kind: 'link', text: 'go', href: '/dashboards/demo' },
      { kind: 'text', text: ' <script>' },
    ]);
    for (const link of ['javascript:alert(1)', '//evil.test', '/\\evil.test', 'data:text/html,test']) assert.equal(safeTextLink(link), false);
    assert.deepEqual(inlineMarkdown('[unsafe](javascript:alert)'), [{ kind: 'text', text: 'unsafe' }]);
  });
});
