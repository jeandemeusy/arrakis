// Lets `node --test` run the TypeScript sources directly: resolves the `@/`
// alias and extensionless relative imports the way the bundler does. Node
// strips the types itself.
import { existsSync, statSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function candidate(base) {
  for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
    const file = base + suffix;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  // Next aliases this guard itself; outside Next there is no server/client
  // split to guard, so it resolves to nothing.
  if (specifier === 'server-only') {
    return { url: 'data:text/javascript,', shortCircuit: true };
  }
  let base = null;
  if (specifier.startsWith('@/')) base = path.join(root, specifier.slice(2));
  else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith('file:')
  ) {
    base = path.resolve(
      path.dirname(fileURLToPath(context.parentURL)),
      specifier,
    );
  }
  if (base) {
    const file = candidate(base);
    if (file) return next(pathToFileURL(file).href, context);
  }
  return next(specifier, context);
}

if (!globalThis.__arrakisLoader) {
  globalThis.__arrakisLoader = true;
  register(import.meta.url);
}
