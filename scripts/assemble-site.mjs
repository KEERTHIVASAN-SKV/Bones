// Assembles the site that GitHub Pages serves: every built app under _site/<app>/, plus a landing page.
// Usage: node scripts/assemble-site.mjs      (after building each app; the Pages workflow does that)
//
// An app is any folder apps/<name> that has a dist/ directory. The landing page links only to apps that
// were actually built, so a missing app is never advertised. Fails (exit 1) if nothing was built.
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, '_site');

/** What each app is called on the landing page, and which of its pages to link. */
const APPS = {
  'cursed-checklist': {
    title: 'Cursed Checklist',
    text: 'A collaborative to-do list. Open it in two or three windows, and open the control page once to run the coordinator.',
    pages: [['control.html', 'Control page (the coordinator)']],
  },
  'graveyard-whiteboard': {
    title: 'Graveyard Whiteboard',
    text: 'A collaborative drawing board.',
    pages: [['control.html', 'Control page (the coordinator)']],
  },
};

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const built = [];
for (const name of readdirSync(join(root, 'apps')).sort()) {
  const dist = join(root, 'apps', name, 'dist');
  if (!existsSync(join(dist, 'index.html'))) continue;
  cpSync(dist, join(out, name), { recursive: true });
  built.push(name);
}

if (built.length === 0) {
  console.error('assemble-site: no app has a dist/index.html; build the apps first');
  process.exit(1);
}

const items = built
  .map((name) => {
    const info = APPS[name] ?? { title: name, text: '', pages: [] };
    const extra = info.pages
      .filter(([file]) => existsSync(join(out, name, file)))
      .map(([file, label]) => ` · <a href="${encodeURI(name)}/${encodeURI(file)}">${escapeHtml(label)}</a>`)
      .join('');
    return `    <li><a href="${encodeURI(name)}/">${escapeHtml(info.title)}</a>${extra}<br />${escapeHtml(info.text)}</li>`;
  })
  .join('\n');

writeFileSync(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bones</title>
  </head>
  <body>
    <h1>Bones</h1>
    <p>An educational CRDT kernel with a garbage-collection demo. It is not production-ready and does not replace Yjs, Automerge or Loro.</p>
    <ul>
${items}
    </ul>
    <p>Tabs sync through BroadcastChannel, so they must be windows of the same browser.</p>
  </body>
</html>
`
);
// GitHub Pages would otherwise run Jekyll over the files.
writeFileSync(join(out, '.nojekyll'), '');

console.log(`assemble-site: ${built.join(', ')} -> _site/`);
