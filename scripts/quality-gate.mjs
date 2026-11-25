// Kernel quality gate (Kiro Stop hook + manual use + CI): purity, typecheck (src + tests), lint, tests.
// Prints nothing but a one-line summary when everything passes; prints the failing step's output otherwise.
//
// Usage:
//   node scripts/quality-gate.mjs          manual and CI runs: a failure prints to stderr and exits 1
//   node scripts/quality-gate.mjs --hook   Kiro Stop hook: a failure is printed to stdout and the
//                                          process exits 0
//
// Why --hook exists: Kiro treats any non-zero exit of a hook as an error and starts another agent
// turn to deal with it. A failure the agent cannot fix would then repeat on every Stop. With
// --hook the failure report is still added to the agent's context (exit 0 forwards stdout), but
// it cannot trigger a new turn by itself.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Canonicalize the path (drive-letter case on Windows). Kiro may start hooks with a lowercase
// drive ("c:\..."); Vitest then loads two copies of itself (c:/ and C:/) and every test file
// fails with "No test suite found".
const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const kernel = join(root, 'kernel');
const hookMode = process.argv.includes('--hook');

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
    const report = `quality-gate FAILED at step: ${name}\n${(r.stdout ?? '') + (r.stderr ?? '')}`;
    if (hookMode) {
      console.log(report); // stdout + exit 0: reported to the agent, but cannot start a new turn by itself
      process.exit(0);
    }
    console.error(report);
    process.exit(1);
  }
}
console.log('quality-gate: purity, typecheck, lint, tests all pass');
