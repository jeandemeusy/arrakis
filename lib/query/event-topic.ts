import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { badRequest } from '../api/errors';
import { segments } from './scan';

/** Check canonical ABI types without accepting parameter names or aliases. */
function canonicalSignature(signature: string): boolean {
  if (signature.length > 1024) return false;
  const head = /^[A-Za-z_$][A-Za-z0-9_$]*\(/.exec(signature);
  if (!head) return false;
  let at = head[0].length;
  const type = (): boolean => {
    if (signature[at] === '(') {
      at++;
      if (!types() || signature[at++] !== ')') return false;
    } else {
      const match = /^[a-z][a-z0-9]*/.exec(signature.slice(at));
      if (!match) return false;
      const word = match[0];
      at += word.length;
      const integer = /^(?:u?int)(\d+)$/.exec(word);
      const bytes = /^bytes(\d+)$/.exec(word);
      const fixed = /^(?:u?fixed)(\d+)x(\d+)$/.exec(word);
      if (integer) {
        const bits = Number(integer[1]);
        if (bits < 8 || bits > 256 || bits % 8 || String(bits) !== integer[1])
          return false;
      } else if (bytes) {
        const length = Number(bytes[1]);
        if (length < 1 || length > 32 || String(length) !== bytes[1])
          return false;
      } else if (fixed) {
        const bits = Number(fixed[1]),
          decimals = Number(fixed[2]);
        if (
          bits < 8 ||
          bits > 256 ||
          bits % 8 ||
          decimals < 1 ||
          decimals > 80 ||
          String(bits) !== fixed[1] ||
          String(decimals) !== fixed[2]
        )
          return false;
      } else if (
        !['address', 'bool', 'string', 'bytes', 'function'].includes(word)
      )
        return false;
    }
    while (signature[at] === '[') {
      const array = /^\[(?:[1-9][0-9]*)?\]/.exec(signature.slice(at));
      if (!array) return false;
      at += array[0].length;
    }
    return true;
  };
  const types = (): boolean => {
    if (signature[at] === ')') return true;
    if (!type()) return false;
    while (signature[at] === ',') {
      at++;
      if (!type()) return false;
    }
    return true;
  };
  return types() && signature[at] === ')' && at === signature.length - 1;
}

/** Expand literal event_topic calls in SQL code, including fragment arguments. */
export function expandEventTopics(sql: string): string {
  const code: boolean[] = [];
  for (const segment of segments(sql))
    for (let i = 0; i < segment.text.length; i++) code.push(segment.code);
  const pattern = /event_topic\s*\(/gi;
  let out = '',
    cursor = 0;
  for (const match of sql.matchAll(pattern)) {
    const start = match.index;
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(sql[previous])) previous--;
    if (
      !code[start] ||
      (start > 0 && /[\w$\u0080-\uffff]/.test(sql[start - 1])) ||
      sql[previous] === '.'
    )
      continue;
    const call = /^event_topic\s*\(\s*'([^']*)'\s*\)/i.exec(sql.slice(start));
    if (!call || !canonicalSignature(call[1])) {
      throw badRequest(
        "event_topic requires one canonical event signature literal, such as event_topic('Transfer(address,address,uint256)')",
      );
    }
    out +=
      sql.slice(cursor, start) +
      `'\\x${bytesToHex(keccak_256(call[1]))}'::bytea`;
    cursor = start + call[0].length;
  }
  return out + sql.slice(cursor);
}
