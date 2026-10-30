#!/usr/bin/env node
// Prints a hash for ARRAKIS_EDITOR_PASSWORD_HASH.
//
//   npm run hash-password            prompts, without echoing
//   echo -n 'secret' | npm run hash-password
//
// The format must match lib/auth/password.ts:
//   scrypt:<log2 N>:<r>:<p>:<salt, base64url>:<key, base64url>
//
// No `$` anywhere: Next's env loader expands `$…` in .env files, even inside
// single quotes, which would corrupt the hash.

import { randomBytes, scrypt } from 'node:crypto';
import { stdin, stdout, stderr } from 'node:process';

const LOG_N = 15;
const R = 8;
const P = 1;

async function readPassword() {
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  stderr.write('Password: ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let password = '';
  return new Promise((resolve, reject) => {
    stdin.on('data', (key) => {
      for (const char of key) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write('\n');
          resolve(password);
          return;
        }
        if (char === '\u007f') password = password.slice(0, -1);
        else password += char;
      }
    });
  });
}

const password = await readPassword();
if (password.length < 12) {
  stderr.write('Use at least 12 characters.\n');
  process.exit(1);
}
const salt = randomBytes(16);
const N = 2 ** LOG_N;
const key = await new Promise((resolve, reject) =>
  scrypt(
    password.normalize('NFKC'),
    salt,
    32,
    { N, r: R, p: P, maxmem: 256 * N * R },
    (error, derived) => (error ? reject(error) : resolve(derived)),
  ),
);
stdout.write(
  `scrypt:${LOG_N}:${R}:${P}:${salt.toString('base64url')}:${key.toString('base64url')}\n`,
);
