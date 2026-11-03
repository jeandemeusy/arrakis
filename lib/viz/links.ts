/** Resolve a table link without allowing row values to change its origin or scheme. */
export function tableLink(template: string, row: Record<string, unknown>): { href: string; external: boolean } | null {
  const source = template.trim();
  if (!source || source.includes('\\') || source.split('').some((char) => char.charCodeAt(0) <= 32)) return null;
  const external = /^https?:\/\//i.test(source);
  if (!external && (!source.startsWith('/') || source.startsWith('//'))) return null;
  if (external) {
    const authority = source.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    if (!authority || /[{}@]/.test(authority)) return null;
  }
  let missing = false;
  const href = source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name: string) => {
    const value = row[name];
    if (!Object.hasOwn(row, name) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'bigint')) {
      missing = true;
      return '';
    }
    return encodeURIComponent(String(value));
  });
  if (missing || /[{}]/.test(href)) return null;
  try {
    const parsed = new URL(href, 'https://arrakis.invalid');
    if (external && !['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!external && parsed.origin !== 'https://arrakis.invalid') return null;
    return { href, external };
  } catch {
    return null;
  }
}
