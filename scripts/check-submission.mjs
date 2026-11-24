// Submission-rule guard (Kiro SessionStart hook + manual use).
// Checks the Devpost / Skeleton Crew requirements that are easy to break by accident.
// Usage: node scripts/check-submission.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const has = (p) => existsSync(join(root, p));
const problems = [];

for (const p of [
  'LICENSE',
  '.kiro/specs/crdt-kernel/requirements.md',
  '.kiro/specs/crdt-kernel/design.md',
  '.kiro/specs/crdt-kernel/tasks.md',
  '.kiro/steering/tech.md',
  '.kiro/steering/product.md',
  'apps/graveyard-whiteboard/package.json',
  'apps/cursed-checklist/package.json',
  'coordinator/package.json',
  'kernel/package.json',
]) {
  if (!has(p)) problems.push(`missing: ${p}`);
}

const hooksDir = join(root, '.kiro', 'hooks');
if (!existsSync(hooksDir)) problems.push('missing: .kiro/hooks (Devpost wants specs, hooks and steering)');

if (has('LICENSE') && !/MIT License/.test(readFileSync(join(root, 'LICENSE'), 'utf8'))) {
  problems.push('LICENSE does not look like the MIT licence');
}

// .kiro must never be gitignored (git is the source of truth for this check).
const ignored = spawnSync('git', ['check-ignore', '-q', '.kiro/specs/crdt-kernel/design.md'], { cwd: root });
if (ignored.status === 0) problems.push('.kiro is gitignored; Devpost requires it to be committed');

if (problems.length > 0) {
  console.error('Submission check FAILED:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('check-submission: LICENSE, .kiro (specs, steering, hooks), apps/*, coordinator, kernel all present; .kiro is not gitignored');
