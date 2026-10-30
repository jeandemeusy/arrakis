'use client';

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { highlight } from './sql-highlight';

/**
 * A SQL editor without an editor dependency.
 *
 * A transparent <textarea> lies exactly over a highlighted <pre>: the browser
 * does the typing, selection, IME and accessibility, and the <pre> only paints
 * colours under it. Both share one font, size, line height and padding, and
 * scroll together. On top of that sit what makes it an editor rather than a
 * text box: line numbers, auto-indent, Tab/Shift+Tab, line comments, its own
 * undo history (so programmatic insertions stay undoable), Cmd/Ctrl+Enter to
 * run, Cmd/Ctrl+S to save, and completion of keywords, tables, columns,
 * fragments and placeholders.
 *
 * Tab indents. Press Escape first to let Tab move focus out instead.
 */

export type Completion = {
  label: string;
  kind:
    | 'keyword'
    | 'function'
    | 'table'
    | 'column'
    | 'fragment'
    | 'placeholder';
  detail?: string;
  /** What to insert, if not the label; `|` marks where the caret lands. */
  insert?: string;
};

export type SqlEditorHandle = {
  /** Inserts text at the caret, replacing any selection, and focuses. */
  insert: (text: string) => void;
};

type Props = {
  ref?: React.Ref<SqlEditorHandle>;
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  onSave?: () => void;
  readOnly?: boolean;
  completions?: Completion[];
  /** Columns per table name, for completion after `table.`. */
  columns?: Map<string, string[]>;
  label: string;
  height?: number;
};

const LINE_HEIGHT = 20;
const PADDING = 12;
const INDENT = '  ';
const MAX_ITEMS = 12;
const COALESCE_MS = 700;

type Snapshot = { value: string; start: number; end: number };
type Menu = {
  items: Completion[];
  index: number;
  from: number;
  to: number;
  top: number;
  left: number;
};

const KIND_ORDER: Record<Completion['kind'], number> = {
  placeholder: 0,
  fragment: 1,
  column: 2,
  table: 3,
  function: 4,
  keyword: 5,
};

function lineStart(text: string, position: number): number {
  return text.lastIndexOf('\n', position - 1) + 1;
}

export function SqlEditor({
  ref,
  value,
  onChange,
  onRun,
  onSave,
  readOnly = false,
  completions = [],
  columns,
  label,
  height = 320,
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const history = useRef<{ entries: Snapshot[]; index: number; at: number }>({
    entries: [],
    index: -1,
    at: 0,
  });
  const pendingSelection = useRef<[number, number] | null>(null);
  const escaped = useRef(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [charWidth, setCharWidth] = useState(8);

  const tokens = useMemo(() => highlight(value), [value]);
  const lines = useMemo(() => value.split('\n').length, [value]);

  useLayoutEffect(() => {
    if (probe.current) {
      setCharWidth(probe.current.getBoundingClientRect().width / 20 || 8);
    }
  }, []);

  // Changes made from outside (loading a version, inserting from the sidebar)
  // join the history, so Cmd+Z can take them back.
  useEffect(() => {
    const record = history.current;
    if (record.entries[record.index]?.value === value) return;
    const field = textarea.current;
    record.entries = record.entries.slice(0, record.index + 1);
    record.entries.push({
      value,
      start: field?.selectionStart ?? value.length,
      end: field?.selectionEnd ?? value.length,
    });
    record.index = record.entries.length - 1;
    record.at = 0;
  }, [value]);

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const field = textarea.current;
    if (!selection || !field) return;
    pendingSelection.current = null;
    field.setSelectionRange(selection[0], selection[1]);
  });

  const syncScroll = useCallback(() => {
    const field = textarea.current;
    if (!field) return;
    if (painted.current) {
      painted.current.scrollTop = field.scrollTop;
      painted.current.scrollLeft = field.scrollLeft;
    }
    if (gutter.current) {
      gutter.current.style.transform = `translateY(${-field.scrollTop}px)`;
    }
  }, []);

  /** Every edit goes through here: it records history and moves the caret. */
  const edit = useCallback(
    (next: string, start: number, end: number, typing: boolean) => {
      const record = history.current;
      const now = Date.now();
      const coalesce =
        typing &&
        now - record.at < COALESCE_MS &&
        record.index === record.entries.length - 1 &&
        record.index > 0;
      record.entries = record.entries.slice(0, record.index + 1);
      if (coalesce) record.entries[record.index] = { value: next, start, end };
      else record.entries.push({ value: next, start, end });
      record.index = record.entries.length - 1;
      record.at = typing ? now : 0;
      pendingSelection.current = [start, end];
      onChange(next);
    },
    [onChange],
  );

  const travel = useCallback(
    (step: -1 | 1) => {
      const record = history.current;
      const target = record.index + step;
      if (target < 0 || target >= record.entries.length) return;
      // Undo restores the state before the edit, caret included.
      record.index = target;
      record.at = 0;
      const snapshot = record.entries[target];
      pendingSelection.current = [snapshot.start, snapshot.end];
      onChange(snapshot.value);
    },
    [onChange],
  );

  const suggest = useCallback(
    (text: string, caret: number) => {
      const field = textarea.current;
      if (!field || readOnly) return setMenu(null);
      let from = caret;
      const before = text.slice(lineStart(text, caret), caret);
      const open = before.lastIndexOf('{{');
      const insidePlaceholder = open >= 0 && before.indexOf('}}', open) < 0;
      let items: Completion[];
      if (insidePlaceholder) {
        from = lineStart(text, caret) + open + 2;
        const prefix = text.slice(from, caret).trim().toLowerCase();
        items = completions.filter(
          (item) =>
            (item.kind === 'placeholder' || item.kind === 'fragment') &&
            item.label.toLowerCase().includes(prefix),
        );
      } else {
        from = caret;
        while (from > 0 && /[A-Za-z0-9_]/.test(text[from - 1])) from -= 1;
        const prefix = text.slice(from, caret).toLowerCase();
        if (text[from - 1] === '.') {
          let qualifierStart = from - 1;
          while (
            qualifierStart > 0 &&
            /[A-Za-z0-9_]/.test(text[qualifierStart - 1])
          ) {
            qualifierStart -= 1;
          }
          const qualifier = text.slice(qualifierStart, from - 1);
          const own = columns?.get(qualifier);
          const pool = own ?? [
            ...new Set([...(columns?.values() ?? [])].flat()),
          ];
          items = pool
            .filter((name) => name.toLowerCase().startsWith(prefix))
            .map((name) => ({ label: name, kind: 'column' as const }));
        } else if (prefix.length >= 1) {
          items = completions.filter(
            (item) =>
              item.kind !== 'placeholder' &&
              item.kind !== 'fragment' &&
              item.label.toLowerCase().startsWith(prefix) &&
              item.label.toLowerCase() !== prefix,
          );
        } else {
          items = [];
        }
      }
      items = [...items]
        .sort(
          (a, b) =>
            KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
            a.label.localeCompare(b.label),
        )
        .slice(0, MAX_ITEMS);
      if (!items.length) return setMenu(null);
      const line = text.slice(0, caret).split('\n').length - 1;
      const column = caret - lineStart(text, caret);
      setMenu({
        items,
        index: 0,
        from,
        to: caret,
        top: PADDING + (line + 1) * LINE_HEIGHT - field.scrollTop + 2,
        left: Math.max(0, PADDING + column * charWidth - field.scrollLeft - 8),
      });
    },
    [charWidth, columns, completions, readOnly],
  );

  const accept = useCallback(
    (item: Completion) => {
      if (!menu) return;
      const raw = item.insert ?? item.label;
      const caretAt = raw.indexOf('|');
      const insert = raw.replace('|', '');
      let to = menu.to;
      // Completing inside {{…}}: replace up to and including an existing }}.
      if (item.kind === 'placeholder' || item.kind === 'fragment') {
        const close = value.indexOf('}}', menu.to);
        const lineEnd = value.indexOf('\n', menu.to);
        if (close >= 0 && (lineEnd < 0 || close < lineEnd)) to = close + 2;
      }
      const next = value.slice(0, menu.from) + insert + value.slice(to);
      const caret = menu.from + (caretAt >= 0 ? caretAt : insert.length);
      setMenu(null);
      edit(next, caret, caret, false);
    },
    [edit, menu, value],
  );

  useImperativeHandle(
    ref,
    () => ({
      insert(text: string) {
        const field = textarea.current;
        if (!field || readOnly) return;
        const start = field.selectionStart;
        const end = field.selectionEnd;
        field.focus();
        edit(
          value.slice(0, start) + text + value.slice(end),
          start + text.length,
          start + text.length,
          false,
        );
      },
    }),
    [edit, readOnly, value],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    const { selectionStart: start, selectionEnd: end } = field;

    if (menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenu({
          ...menu,
          index: (menu.index + step + menu.items.length) % menu.items.length,
        });
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !mod) {
        event.preventDefault();
        accept(menu.items[menu.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(null);
        return;
      }
    }

    if (mod && event.key === 'Enter') {
      event.preventDefault();
      onRun?.();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (readOnly) return;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      travel(event.shiftKey ? 1 : -1);
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      travel(1);
      return;
    }
    if (event.key === 'Escape') {
      escaped.current = true;
      return;
    }
    if (event.key === 'Tab') {
      if (escaped.current) {
        escaped.current = false;
        return;
      }
      event.preventDefault();
      const first = lineStart(value, start);
      const multiline = value.slice(start, end).includes('\n');
      if (!event.shiftKey && !multiline) {
        edit(
          value.slice(0, start) + INDENT + value.slice(end),
          start + INDENT.length,
          start + INDENT.length,
          false,
        );
        return;
      }
      const block = value.slice(first, end);
      const changed = block
        .split('\n')
        .map((line) =>
          event.shiftKey
            ? line.startsWith(INDENT)
              ? line.slice(INDENT.length)
              : line.replace(/^ /, '')
            : INDENT + line,
        )
        .join('\n');
      const delta = changed.length - block.length;
      const firstDelta = event.shiftKey
        ? -Math.min(INDENT.length, block.match(/^ */)?.[0].length ?? 0)
        : INDENT.length;
      edit(
        value.slice(0, first) + changed + value.slice(end),
        Math.max(first, start + firstDelta),
        end + delta,
        false,
      );
      return;
    }
    escaped.current = false;
    if (mod && event.key === '/') {
      event.preventDefault();
      const first = lineStart(value, start);
      const block = value.slice(first, end);
      const all = block.split('\n');
      const commented = all.every(
        (line) => /^\s*--/.test(line) || !line.trim(),
      );
      const changed = all
        .map((line) =>
          commented
            ? line.replace(/^(\s*)-- ?/, '$1')
            : line.trim()
              ? `-- ${line}`
              : line,
        )
        .join('\n');
      edit(
        value.slice(0, first) + changed + value.slice(end),
        first,
        first + changed.length,
        false,
      );
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const indent =
        value.slice(lineStart(value, start), start).match(/^\s*/)?.[0] ?? '';
      const insert = `\n${indent}`;
      edit(
        value.slice(0, start) + insert + value.slice(end),
        start + insert.length,
        start + insert.length,
        false,
      );
    }
  };

  const onInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    edit(field.value, field.selectionStart, field.selectionEnd, true);
    suggest(field.value, field.selectionStart);
  };

  const editorStyle = {
    '--sql-line-height': `${LINE_HEIGHT}px`,
    '--sql-padding': `${PADDING}px`,
    height,
  } as React.CSSProperties;

  return (
    <div className="sql-editor" style={editorStyle}>
      <span ref={probe} className="sql-probe" aria-hidden="true">
        {'M'.repeat(20)}
      </span>
      <div className="sql-gutter" aria-hidden="true">
        <div ref={gutter}>
          {Array.from({ length: lines }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
      </div>
      <div className="sql-surface">
        <pre ref={painted} className="sql-paint" aria-hidden="true">
          <code>
            {tokens.map((token, index) =>
              token.kind === 'plain' ? (
                token.text
              ) : (
                <span key={index} className={`sql-${token.kind}`}>
                  {token.text}
                </span>
              ),
            )}
            {'\n'}
          </code>
        </pre>
        <textarea
          ref={textarea}
          className="sql-input"
          aria-label={label}
          value={value}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onScroll={() => {
            syncScroll();
            if (menu) setMenu(null);
          }}
          onBlur={() => setMenu(null)}
          onClick={() => setMenu(null)}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          aria-autocomplete="list"
          aria-describedby="sql-completion-status"
        />
        {/* The menu is drawn for the eye; the highlighted suggestion is
            announced here, and chosen with Enter or Tab from the textarea. */}
        <output
          id="sql-completion-status"
          className="sr-only"
          aria-live="polite"
        >
          {menu
            ? `${menu.items[menu.index].label}, ${menu.items[menu.index].detail ?? menu.items[menu.index].kind}. ${menu.index + 1} of ${menu.items.length}.`
            : ''}
        </output>
        {menu && (
          <ul className="sql-menu" style={{ top: menu.top, left: menu.left }}>
            {menu.items.map((item, index) => (
              <li key={`${item.kind}:${item.label}`}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={index === menu.index ? 'active' : undefined}
                  // mousedown, not click: a click would blur the textarea
                  // first and close the menu before the choice registered.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    accept(item);
                  }}
                >
                  <span>{item.label}</span>
                  <small>{item.detail ?? item.kind}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
