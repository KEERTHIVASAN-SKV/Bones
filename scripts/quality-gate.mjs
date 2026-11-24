// Kernel quality gate (Kiro Stop hook + manual use): purity, typecheck (src + tests), lint, tests.
// Prints nothing but a one-line summary when everything passes; prints the failing step's output otherwise.
// Usage: node scripts/quality-gate.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const kernel = join(root, 'kernel');

if (!existsSync(join(kernel, 'node_modules'))) {
  console.log('quality-gate: kernel/node_modules missing; run "npm install" in /kernel first (skipped)');
  process.exit(0);
}

const steps = [
  ['purity', process.execPath, [join(root, 'scripts', 'check-purity.mjs')], root],
  ['typecheck', 'npm', ['run', '--silent', 'typecheck'], kernel],
  ['lint', 'npm', ['run', '--silent', 'lint'], kernel],
  ['test', 'npm', ['test', '--silent'], kernel],
];

for (const [name, cmd, args, cwd] of steps) {
  // shell: true so "npm" resolves to npm.cmd on Windows; arguments are fixed literals above.
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: cmd === 'npm' });
  if (r.status !== 0) {
    console.error(`quality-gate FAILED at step: ${name}`);
    console.error((r.stdout ?? '') + (r.stderr ?? ''));
    process.exit(1);
  }
}
console.log('quality-gate: purity, typecheck, lint, tests all pass');
