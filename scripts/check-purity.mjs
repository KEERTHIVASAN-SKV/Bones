// Kernel purity guard (Kiro hook + manual use).
// Fails if kernel/src contains non-deterministic or environment-dependent APIs.
// Usage: node scripts/check-purity.mjs
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url))); // canonical drive-letter case
const srcDir = join(root, 'kernel', 'src');

const FORBIDDEN = [
  [/\bDate\.now\b/, 'Date.now()'],
  [/\bnew Date\b/, 'new Date()'],
  [/\bperformance\.now\b/, 'performance.now()'],
  [/\bMath\.random\b/, 'Math.random()'],
  [/\bcrypto\.(randomUUID|getRandomValues)\b/, 'crypto randomness'],
  [/\blocaleCompare\b/, 'localeCompare (use code-unit comparison)'],
  [/\bconsole\./, 'console.* (kernel code must not log)'],
  [/\bdocument\./, 'DOM: document'],
  [/\bwindow\./, 'DOM: window'],
  [/\b(setTimeout|setInterval|setImmediate|requestAnimationFrame)\b/, 'timers'],
  [/\b(fetch|XMLHttpRequest|WebSocket|BroadcastChannel|EventSource)\b/, 'network'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'browser storage'],
  [/\bprocess\.(env|argv|hrtime)\b/, 'process environment'],
  [/from\s+['"](node:)?(fs|net|http|https|child_process|os|crypto)['"]/, 'Node I/O module import'],
];

/** Remove comments so rules written in JSDoc ("no Date.now()") are not flagged. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (m, p1) => p1);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

if (!existsSync(srcDir)) {
  console.log('check-purity: kernel/src not found, nothing to check');
  process.exit(0);
}

const violations = [];
for (const file of walk(srcDir)) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const [re, label] of FORBIDDEN) {
      if (re.test(line)) violations.push(`${relative(root, file).split(sep).join('/')}:${i + 1}: ${label}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Kernel purity violations (see .kiro/steering/tech.md, "Determinism Rules"):');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('check-purity: kernel/src is pure');
