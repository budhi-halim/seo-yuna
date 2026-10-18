import { readFile, writeFile, appendFile, copyFile, readdir, lstat, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, CatalogError } from '../assets/catalog.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_CATALOG_BYTES = 50 * 1024 * 1024;
const PUBLIC_FILES = ['index.html', 'data.json', 'rulebook.txt'];

async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Public assets must be regular files; symbolic links are not allowed.');
  }
  return info;
}

async function publicAssets(directory, relative = 'assets') {
  const source = path.join(directory, relative);
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The assets folder must be a regular directory.');
  }
  const files = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in public assets.');
    if (entry.isDirectory()) files.push(...await publicAssets(directory, next));
    else if (entry.isFile()) files.push(next);
    else throw new Error('Unsupported public asset type.');
  }
  return files.sort();
}

function resolveBuildSha(directory, env) {
  let sha = env.BUILD_SHA || '';
  if (!sha) {
    try {
      sha = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      if (env.GITHUB_ACTIONS === 'true') throw new Error('The checked-out build commit could not be determined.');
      sha = 'local';
    }
  }
  if (!/^[0-9a-f]{40}$/.test(sha) && !(sha === 'local' && env.GITHUB_ACTIONS !== 'true')) {
    throw new Error('BUILD_SHA must identify the complete checked-out commit.');
  }
  return sha;
}

/** Build an explicit public directory. Source JSON and prompt text stay byte-identical. */
export async function buildSite({ directory = PROJECT_ROOT, env = process.env, log = console.log } = {}) {
  const started = performance.now();
  const root = path.resolve(directory);
  const destination = path.join(root, '_site');
  for (const filename of PUBLIC_FILES) await regularFile(path.join(root, filename));
  const catalogInfo = await lstat(path.join(root, 'data.json'));
  if (catalogInfo.size > MAX_CATALOG_BYTES) throw new Error('The complete catalog exceeds the 50 MiB limit.');
  const bytes = await readFile(path.join(root, 'data.json'));
  let catalog;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    catalog = validateCatalog(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new Error('The stored catalog is not valid UTF-8 JSON.');
  }
  const files = [...PUBLIC_FILES, ...await publicAssets(root)];
  const buildSha = resolveBuildSha(root, env);
  // The only directory removed is this project's generated _site directory.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const relative of files) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target);
  }
  await writeFile(path.join(destination, 'version.txt'), buildSha + '\n', 'utf8');
  const variations = catalog.reduce((total, theme) => total + theme.variations.length, 0);
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT,
      'build_sha=' + buildSha + '\nthemes=' + catalog.length + '\nvariations=' + variations + '\n', 'utf8');
  }
  log('[Build] Prepared ' + (files.length + 1) + ' public files, ' + catalog.length + ' themes and ' + variations
    + ' prompts in ' + ((performance.now() - started) / 1000).toFixed(1) + ' seconds.');
  return { directory: destination, buildSha, themes: catalog.length, variations, files: [...files, 'version.txt'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node tools/build-site.mjs\nCopies index.html, assets, data.json and rulebook.txt into _site. BUILD_SHA optionally supplies its commit marker.');
  } else {
    buildSite().catch((error) => {
      console.error('Build failed: ' + error.message);
      process.exitCode = 1;
    });
  }
}
