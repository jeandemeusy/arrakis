/** A deliberately small Markdown subset for dashboard text tiles. HTML is text. */
export type Inline = { kind: 'text' | 'strong' | 'em' | 'code' | 'link'; text: string; href?: string };
export type Block = { kind: 'paragraph' | 'heading' | 'list'; lines: string[]; level?: number };

export function safeTextLink(value: string): boolean {
  if (value.includes('\\') || value.split('').some((char) => char.charCodeAt(0) <= 32)) return false;
  return (value.startsWith('/') && !value.startsWith('//')) || /^https?:\/\//i.test(value);
}

export function inlineMarkdown(text: string): Inline[] {
  const tokens: Inline[] = [];
  const pattern = /\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/g;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > previous) tokens.push({ kind: 'text', text: text.slice(previous, at) });
    if (match[1] !== undefined) tokens.push(safeTextLink(match[2]) ? { kind: 'link', text: match[1], href: match[2] } : { kind: 'text', text: match[1] });
    else if (match[3] !== undefined) tokens.push({ kind: 'strong', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ kind: 'em', text: match[4] });
    else tokens.push({ kind: 'code', text: match[5] });
    previous = at + match[0].length;
  }
  if (previous < text.length) tokens.push({ kind: 'text', text: text.slice(previous) });
  return tokens;
}

export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { blocks.push({ kind: 'paragraph', lines: [] }); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const item = /^[-*]\s+(.+)$/.exec(line);
    const previous = blocks.at(-1);
    if (heading) blocks.push({ kind: 'heading', lines: [heading[2]], level: heading[1].length });
    else if (item) {
      if (previous?.kind === 'list') previous.lines.push(item[1]);
      else blocks.push({ kind: 'list', lines: [item[1]] });
    } else if (previous?.kind === 'paragraph') previous.lines.push(line);
    else blocks.push({ kind: 'paragraph', lines: [line] });
  }
  return blocks.filter((block) => block.lines.length > 0);
}
