/**
 * Splits SQL into code and everything that is not code.
 *
 * Template placeholders, statement separators and positional parameters only
 * mean something in code: `'{{x}}'` is a string, `-- ;` is a comment. This
 * scanner follows PostgreSQL's lexical rules closely enough to tell them apart:
 * quoted strings (including E'' escapes), quoted identifiers, line comments,
 * nested block comments and dollar-quoted bodies.
 */

export type Segment = { code: boolean; text: string };

const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function segments(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = '';
  let index = 0;

  const flushCode = () => {
    if (code) out.push({ code: true, text: code });
    code = '';
  };
  const literal = (end: number) => {
    flushCode();
    out.push({ code: false, text: sql.slice(index, end) });
    index = end;
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    const previous = index > 0 ? sql[index - 1] : '';

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      literal(end < 0 ? sql.length : end);
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
        } else if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      literal(cursor);
      continue;
    }
    if (char === "'") {
      // E'…' strings honour backslash escapes; standard strings do not.
      const escaped =
        (previous === 'E' || previous === 'e') &&
        !(index > 1 && IDENTIFIER_CHAR.test(sql[index - 2]));
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (escaped && sql[cursor] === '\\') {
          cursor += 2;
        } else if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") cursor += 2;
          else {
            cursor += 1;
            break;
          }
        } else {
          cursor += 1;
        }
      }
      literal(Math.min(cursor, sql.length));
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === '"') {
          if (sql[cursor + 1] === '"') cursor += 2;
          else {
            cursor += 1;
            break;
          }
        } else {
          cursor += 1;
        }
      }
      literal(Math.min(cursor, sql.length));
      continue;
    }
    if (char === '$' && !(previous && IDENTIFIER_CHAR.test(previous))) {
      const match = DOLLAR_TAG.exec(sql.slice(index));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, index + tag.length);
        literal(close < 0 ? sql.length : close + tag.length);
        continue;
      }
    }
    code += char;
    index += 1;
  }
  flushCode();
  return out;
}
