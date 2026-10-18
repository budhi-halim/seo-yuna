import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy this repository's product source into a prepared Sites Vinext checkout.
// Credentials are runtime secrets and are never inputs or outputs of this tool.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || destination === repository) throw new Error('Provide the separate, prepared owner-server checkout.');
const manifest = JSON.parse(await readFile(path.join(destination, '.openai/hosting.json'), 'utf8'));
if (!manifest.project_id || manifest.d1 !== 'DB' || manifest.static) {
  throw new Error('The owner checkout must be a registered server Site with the DB binding.');
}
async function copy(from, to) {
  const target = path.join(destination, to);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(repository, from), target);
}
await copy('index.html', 'public/studio.html');
await copy('rulebook.txt', 'public/rulebook.txt');
for (const entry of await readdir(path.join(repository, 'assets'), { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(mjs|css|svg)$/.test(entry.name)) throw new Error('Unexpected studio asset.');
  await copy(`assets/${entry.name}`, `assets/${entry.name}`);
  await copy(`assets/${entry.name}`, `public/assets/${entry.name}`);
}
for (const entry of await readdir(path.join(repository, 'owner'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) await copy(`owner/${entry.name}`, `owner/${entry.name}`);
}
await copy('owner/sites-route.ts', 'app/api/owner/[...path]/route.ts');
await copy('owner/sites-data-route.ts', 'app/data.json/route.ts');
await copy('owner/sites-schema.ts', 'db/schema.ts');
console.log('Owner studio, server modules, route adapters, and schema source synchronized.');
