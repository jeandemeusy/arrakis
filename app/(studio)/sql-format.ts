/**
 * Formats SQL for reading: one clause per line, one select item per line,
 * subqueries and CTE bodies indented, keywords in capitals.
 *
 * Written for this repository rather than taken from a package. It only ever
 * changes whitespace and the case of keywords: strings, quoted names,
 * comments, numbers, `{{placeholders}}` and every other token come out as
 * they went in, in the same order, so a formatted query means the same thing.
 * Formatting twice gives the same text as formatting once.
 */

type Kind =
  | 'word'
  | 'keyword'
  | 'string'
  | 'quoted'
  | 'number'
  | 'placeholder'
  | 'line-comment'
  | 'block-comment'
  | 'open'
  | 'close'
  | 'comma'
  | 'semicolon'
  | 'dot'
  | 'cast'
  | 'operator';

export type Token = {
  kind: Kind;
  text: string;
  /** A line break came before it in the source: a comment keeps its line. */
  newlineBefore: boolean;
};

/**
 * Written in capitals. Words that also make likely column names (`first`,
 * `range`, `rows`, `window`…) are left as written.
 */
const KEYWORDS = new Set(
  `all and any array as asc between by case cast cross current_date
   current_timestamp desc distinct else end except exists false filter
   following for from full group having ilike in inner intersect interval is
   join lateral left like limit natural not null nulls offset on or order
   outer over partition preceding recursive right select then true unbounded
   union using values when where with within`
    .split(/\s+/)
    .filter(Boolean),
);

/** Start a line of their own, at the clause's indent. */
const CLAUSES = new Set([
  'select',
  'from',
  'where',
  'group by',
  'order by',
  'having',
  'limit',
  'offset',
  'union',
  'union all',
  'intersect',
  'intersect all',
  'except',
  'except all',
  'values',
  'with',
  'with recursive',
]);

const JOINS = new Set([
  'join',
  'inner join',
  'left join',
  'left outer join',
  'right join',
  'right outer join',
  'full join',
  'full outer join',
  'cross join',
  'natural join',
  'join lateral',
  'left join lateral',
  'cross join lateral',
]);

/** After these, a comma ends a line: their items are listed one per line. */
const LISTS = new Set([
  'select',
  'group by',
  'order by',
  'with',
  'with recursive',
]);

/** Keywords written straight against their parenthesis: `ANY(…)`. */
const CALLS = new Set(['any', 'cast', 'array']);

const TOKEN =
  /(\{\{[\s\S]*?\}\})|(--[^\n]*)|(\/\*[\s\S]*?\*\/)|((?:[EeBbXxUu]&?)?'(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\7\$)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_$]*)|(::)|(\()|(\))|(,)|(;)|(\.)|(\s+)|([^\sA-Za-z0-9_(),;.'"]+)/y;

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let newlineBefore = true;
  const push = (kind: Kind, text: string) => {
    out.push({ kind, text, newlineBefore });
    newlineBefore = false;
  };
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < sql.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(sql);
    if (!match) {
      // Nothing matched (an unclosed quote): keep the rest as it is.
      push('operator', sql.slice(at));
      break;
    }
    const [text] = match;
    if (match[1]) push('placeholder', text);
    else if (match[2]) push('line-comment', text);
    else if (match[3]) push('block-comment', text);
    else if (match[4] || match[6]) push('string', text);
    else if (match[5]) push('quoted', text);
    else if (match[8]) push('number', text);
    else if (match[9])
      push(KEYWORDS.has(text.toLowerCase()) ? 'keyword' : 'word', text);
    else if (match[10]) push('cast', text);
    else if (match[11]) push('open', text);
    else if (match[12]) push('close', text);
    else if (match[13]) push('comma', text);
    else if (match[14]) push('semicolon', text);
    else if (match[15]) push('dot', text);
    else if (match[16]) {
      if (text.includes('\n')) newlineBefore = true;
    } else push('operator', text);
  }
  return out;
}

const lower = (token: Token | undefined) => token?.text.toLowerCase() ?? '';

const isComment = (token: Token | undefined) =>
  token?.kind === 'line-comment' || token?.kind === 'block-comment';

/** The clause or join phrase starting at `at` (`left outer join`), if any. */
function phraseAt(tokens: Token[], at: number): [string, number] {
  const words: string[] = [];
  for (let i = at; i < tokens.length && words.length < 4; i++) {
    if (tokens[i].kind !== 'keyword') break;
    words.push(lower(tokens[i]));
  }
  for (let length = words.length; length > 0; length--) {
    const phrase = words.slice(0, length).join(' ');
    if (CLAUSES.has(phrase) || JOINS.has(phrase)) return [phrase, length];
  }
  return ['', 0];
}

/** The next token that is not a comment. */
function nextCode(tokens: Token[], from: number): Token | undefined {
  for (let i = from; i < tokens.length; i++)
    if (!isComment(tokens[i])) return tokens[i];
  return undefined;
}

/**
 * Whether the list a clause starts has more than one item: a comma at its own
 * depth before the next clause, closing parenthesis or semicolon.
 */
function manyItems(tokens: Token[], from: number): boolean {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'open') depth++;
    else if (token.kind === 'close') {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0) {
      if (token.kind === 'comma') return true;
      if (token.kind === 'semicolon') return false;
      if (token.kind === 'keyword' && phraseAt(tokens, i)[0]) return false;
    }
  }
  return false;
}

type Frame = {
  /** Indent of the clause keywords at this level. */
  base: number;
  /** A parenthesis holding a query, laid out on lines of its own. */
  block: boolean;
  /** The clause being written at this level, for its commas and ANDs. */
  clause: string;
  /** A BETWEEN waiting for its AND, which stays on the line. */
  between: boolean;
  /** CASEs open at this level: the indent of their WHENs. */
  cases: number[];
};

export function formatSql(sql: string, unit = '  '): string {
  const tokens = tokenize(sql);
  const lines: string[] = [];
  let line = '';
  let indent = 0;
  /** No space before the next token: after a unary minus, say. */
  let glue = false;
  const stack: Frame[] = [
    { base: 0, block: true, clause: '', between: false, cases: [] },
  ];

  const newline = (level: number) => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    line = unit.repeat(Math.max(0, level));
    indent = Math.max(0, level);
  };
  const write = (text: string, space = true) => {
    if (
      space &&
      !glue &&
      line.trim() &&
      !/[\s([]$/.test(line) &&
      !line.endsWith('::') &&
      !line.endsWith('.')
    )
      line += ' ';
    line += text;
    glue = false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    const frame = stack[stack.length - 1];
    const word = lower(token);
    const text =
      token.kind === 'keyword' ||
      ((word === 'first' || word === 'last') && lower(previous) === 'nulls')
        ? token.text.toUpperCase()
        : token.text;

    if (token.kind === 'keyword') {
      if (frame.block) {
        const [phrase, length] = phraseAt(tokens, i);
        // WITH and VALUES only open a statement, not `WITH ORDINALITY`.
        const opens =
          phrase &&
          !(
            (phrase.startsWith('with') || phrase === 'values') &&
            frame.clause !== '' &&
            !frame.clause.startsWith('with')
          );
        if (opens) {
          newline(frame.base);
          write(
            tokens
              .slice(i, i + length)
              .map((entry) => entry.text.toUpperCase())
              .join(' '),
            false,
          );
          frame.clause = phrase;
          frame.between = false;
          i += length - 1;
          const following = lower(nextCode(tokens, i + 1));
          if (
            LISTS.has(phrase) &&
            following !== 'distinct' &&
            manyItems(tokens, i + 1)
          )
            newline(frame.base + 1);
          continue;
        }
      }
      if (word === 'between') frame.between = true;
      if (
        (word === 'and' || word === 'or') &&
        frame.block &&
        !frame.cases.length &&
        /where|having|join/.test(frame.clause)
      ) {
        if (word === 'and' && frame.between) {
          frame.between = false;
        } else {
          newline(frame.base + 1);
          write(text, false);
          continue;
        }
      }
      if (word === 'on' && frame.block && JOINS.has(frame.clause)) {
        newline(frame.base + 1);
        write(text, false);
        continue;
      }
      if (word === 'case') {
        write(text);
        frame.cases.push(indent + 1);
        continue;
      }
      if ((word === 'when' || word === 'else') && frame.cases.length) {
        newline(frame.cases[frame.cases.length - 1]);
        write(text, false);
        continue;
      }
      if (word === 'end' && frame.cases.length) {
        newline(frame.cases.pop()! - 1);
        write(text, false);
        continue;
      }
      if (
        word === 'distinct' &&
        lower(previous) === 'select' &&
        frame.block &&
        LISTS.has(frame.clause)
      ) {
        write(text);
        // SELECT DISTINCT ON (…) keeps its list on the line; a plain
        // DISTINCT starts the select list on the next.
        if (lower(nextCode(tokens, i + 1)) !== 'on' && manyItems(tokens, i + 1))
          newline(frame.base + 1);
        continue;
      }
    }

    switch (token.kind) {
      case 'open': {
        const query = ['select', 'with', 'values'].includes(
          lower(nextCode(tokens, i + 1)),
        );
        const call =
          previous !== undefined &&
          (previous.kind === 'word' ||
            previous.kind === 'quoted' ||
            previous.kind === 'placeholder' ||
            (previous.kind === 'keyword' && CALLS.has(lower(previous))));
        write(text, !call);
        if (query) {
          const base = indent + 1;
          stack.push({
            base,
            block: true,
            clause: '',
            between: false,
            cases: [],
          });
          newline(base);
        } else {
          stack.push({
            base: frame.base,
            block: false,
            clause: frame.clause,
            between: false,
            cases: [],
          });
        }
        continue;
      }
      case 'close': {
        const closing = stack.length > 1 ? stack.pop()! : frame;
        if (closing.block) newline(closing.base - 1);
        line += text;
        continue;
      }
      case 'comma': {
        line += text;
        if (frame.block && LISTS.has(frame.clause) && !frame.cases.length)
          newline(frame.base + 1);
        continue;
      }
      case 'semicolon': {
        line += text;
        newline(0);
        lines.push('');
        stack.length = 1;
        stack[0].clause = '';
        stack[0].cases = [];
        continue;
      }
      case 'dot':
      case 'cast':
        line += text;
        continue;
      case 'line-comment':
      case 'block-comment': {
        if (token.newlineBefore || !lines.length || line.trim()) {
          // On a line of its own, or after code on this line.
          if (token.newlineBefore && line.trim()) newline(indent);
          write(text);
        } else {
          // It followed code that a comma or clause has since ended: it goes
          // back at the end of that line.
          lines[lines.length - 1] += ` ${text}`;
        }
        if (token.kind === 'line-comment') newline(indent);
        continue;
      }
      case 'operator': {
        const bracket =
          token.text.startsWith('[') || token.text.startsWith(']');
        const unary =
          (token.text === '-' || token.text === '+') &&
          (previous === undefined ||
            ['operator', 'open', 'comma', 'keyword', 'cast'].includes(
              previous.kind,
            ));
        write(text, !bracket);
        if (unary || token.text.endsWith('[')) glue = true;
        continue;
      }
      default:
        write(text);
    }
  }
  newline(0);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `${lines.join('\n')}\n`;
}

/**
 * Every token but whitespace, unquoted words in one case (as Postgres reads
 * them): what formatting keeps.
 */
export function significant(sql: string): string[] {
  return tokenize(sql).map((token) =>
    token.kind === 'keyword' || token.kind === 'word'
      ? token.text.toLowerCase()
      : token.text,
  );
}
