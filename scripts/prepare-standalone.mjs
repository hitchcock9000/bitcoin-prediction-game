/**
 * Completes the `output: 'standalone'` build into something runnable.
 *
 * `next build` traces the server bundle but does not copy the static assets the
 * browser needs, so `node .next/standalone/server.js` serves an unstyled page
 * unless they are copied across first. Next's own Docker examples do this with
 * `cp -r`; doing it in a script keeps the container file and the local
 * verification path identical, and makes the failure mode impossible to hit by
 * forgetting a line.
 *
 * Run after `next build`. Idempotent.
 */
import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(root, '.next', 'standalone');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(standalone))) {
  console.error('[standalone] .next/standalone not found — run `npm run build` first.');
  process.exit(1);
}

await mkdir(path.join(standalone, '.next'), { recursive: true });

const staticSource = path.join(root, '.next', 'static');
if (await exists(staticSource)) {
  await cp(staticSource, path.join(standalone, '.next', 'static'), { recursive: true });
  console.log('[standalone] copied .next/static');
}

const publicSource = path.join(root, 'public');
if (await exists(publicSource)) {
  await cp(publicSource, path.join(standalone, 'public'), { recursive: true });
  console.log('[standalone] copied public/');
}

// The migration runner is not part of the traced server bundle, because it runs
// as a release step rather than on the request path. Copying it means the same
// container can migrate its own database.
await mkdir(path.join(standalone, 'scripts'), { recursive: true });
await cp(path.join(root, 'scripts', 'migrate.mjs'), path.join(standalone, 'scripts', 'migrate.mjs'));
await cp(path.join(root, 'migrations'), path.join(standalone, 'migrations'), { recursive: true });
console.log('[standalone] copied migration runner and migrations');

console.log('[standalone] ready — start with `node .next/standalone/server.js`');
