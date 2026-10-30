import { segments } from '@/lib/query/scan';

/**
 * Tokens for highlighting SQL.
 *
 * Built on the same scanner the server compiles with, so the editor colours a
 * placeholder exactly when the compiler will treat it as one — inside a string
 * or a comment it is neither.
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'function'
  | 'number'
  | 'string'
  | 'identifier'
  | 'comment'
  | 'placeholder';

export type Token = { text: string; kind: TokenKind };

export const KEYWORDS = [
  'ALL',
  'AND',
  'ANY',
  'ARRAY',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'COALESCE',
  'CROSS',
  'CURRENT_DATE',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'EXCEPT',
  'EXISTS',
  'FALSE',
  'FILTER',
  'FIRST',
  'FOLLOWING',
  'FOR',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'ILIKE',
  'IN',
  'INNER',
  'INTERSECT',
  'INTERVAL',
  'IS',
  'JOIN',
  'LAG',
  'LAST',
  'LATERAL',
  'LEAD',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NOT',
  'NULL',
  'NULLIF',
  'NULLS',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'OVER',
  'PARTITION',
  'PRECEDING',
  'RANGE',
  'RECURSIVE',
  'RIGHT',
  'ROWS',
  'SELECT',
  'THEN',
  'TRUE',
  'UNBOUNDED',
  'UNION',
  'USING',
  'VALUES',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
  'WITHIN',
];

export const FUNCTIONS = [
  'avg',
  'bool_and',
  'bool_or',
  'cardinality',
  'count',
  'date_trunc',
  'decode',
  'dense_rank',
  'encode',
  'extract',
  'first_value',
  'generate_series',
  'get_byte',
  'greatest',
  'last_value',
  'least',
  'length',
  'lower',
  'max',
  'min',
  'now',
  'octet_length',
  'percentile_cont',
  'rank',
  'round',
  'row_number',
  'string_agg',
  'array_agg',
  'substring',
  'sum',
  'to_char',
  'to_hex',
  'to_timestamp',
  'upper',
  'width_bucket',
];

const KEYWORD_SET = new Set(KEYWORDS);
const FUNCTION_SET = new Set(FUNCTIONS);

const CODE_TOKEN =
  /(\{\{[\s\S]*?\}\})|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|([^A-Za-z0-9_{]+|\{)/g;

function codeTokens(text: string, out: Token[]) {
  for (const match of text.matchAll(CODE_TOKEN)) {
    const [whole, placeholder, number, word, call, other] = match;
    if (placeholder) out.push({ text: placeholder, kind: 'placeholder' });
    else if (number) out.push({ text: number, kind: 'number' });
    else if (word) {
      const upper = word.toUpperCase();
      const kind: TokenKind = KEYWORD_SET.has(upper)
        ? 'keyword'
        : call && FUNCTION_SET.has(word.toLowerCase())
          ? 'function'
          : 'plain';
      out.push({ text: word, kind });
      if (call) out.push({ text: call, kind: 'plain' });
    } else out.push({ text: other ?? whole, kind: 'plain' });
  }
}

export function highlight(sql: string): Token[] {
  const out: Token[] = [];
  for (const segment of segments(sql)) {
    if (segment.code) {
      codeTokens(segment.text, out);
      continue;
    }
    const first = segment.text[0];
    const kind: TokenKind =
      first === '-' || first === '/'
        ? 'comment'
        : first === '"'
          ? 'identifier'
          : 'string';
    out.push({ text: segment.text, kind });
  }
  return out;
}
