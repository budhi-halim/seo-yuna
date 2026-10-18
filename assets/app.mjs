import { MAX_IMPORT_BYTES, MAX_CATALOG_BYTES, measureCatalogBytes, parseCatalog, validateCatalog, mergeCatalog } from './catalog.mjs';
import { REPOSITORY_URL, runUrl, describeRun } from './github.mjs';
import { OwnerClient } from './owner-client.mjs';
import { VAULT_STORAGE_KEY } from './credential-vault.mjs';
import { createShortcutHandler, wrapIndex } from './shortcuts.mjs';
import { readReceipts, writeReceipts } from './receipts.mjs';
import { sortFiles, buildFileBatch } from './import-batch.mjs';
import { searchNumberedEntries } from './selector-search.mjs';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const selectionKey = 'seo-yuna:selection:v1';
let storage;
try { storage = window.localStorage; } catch { storage = null; }
let catalog = [];
let themeIndex = 0;
let variationIndex = 0;
let activeView = 'prompts';
let inputMode = 'paste';
let fileText = '';
let fileBatch = null;
let fileError = '';
let fileReadVersion = 0;
let validation = null;
let busy = false;
const client = new OwnerClient({ storage });
let accessBusy = false;
let accessMessage = '';
let accessMessageState = 'info';
let accessReady = false;
let accessGeneration = 0;
let receipts = readReceipts(storage);
let selectedReceiptId = receipts[0]?.requestId ?? null;
let storageAvailable = true;
let toastTimer;
let pollTimer;
let polling = false;
let githubRetryAt = 0;
let pollCursor = 0;
let copySequence = 0;
let catalogLoadGeneration = 0;
const receiptRefreshes = new Map();
const variationMemory = new Map();
let rememberedSelection = {};
try { rememberedSelection = JSON.parse(storage?.getItem(selectionKey) ?? '{}') ?? {}; } catch { /* Start at the first entry. */ }

const shortcuts = createShortcutHandler({
  getContext: () => ({ enabled: activeView === 'prompts' && catalog.length > 0 && !document.querySelector('dialog[open]'), themeId: catalog[themeIndex]?.id ?? '' }),
  onTheme: direction => moveTheme(direction),
  onVariation: direction => moveVariation(direction),
  onCopyTheme: withNumber => copyTheme(withNumber),
  onCopyPrompt: () => copyPrompt(),
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  $('toast').classList.add('is-visible');
  toastTimer = setTimeout(() => {
    $('toast').classList.remove('is-visible');
    $('toast').hidden = true;
  }, 3000);
}

function respectGitHubRetry(error) {
  const seconds = error?.retryAfterSeconds;
  if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400) {
    githubRetryAt = Math.max(githubRetryAt, Date.now() + seconds * 1000);
  }
}

function setView(view) {
  if (!['prompts', 'import', 'activity'].includes(view)) view = 'prompts';
  activeView = view;
  shortcuts.reset();
  all('[data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  for (const name of ['prompts', 'import', 'activity']) $(`view-${name}`).hidden = name !== view;
  history.replaceState(null, '', `#${view}`);
  if (view === 'activity') renderActivity();
}

function saveSelection() {
  const theme = catalog[themeIndex];
  const variation = theme?.variations[variationIndex];
  if (theme && variation) variationMemory.set(theme.id, variation.id);
  try { storage?.setItem(selectionKey, JSON.stringify({ themeId: theme?.id, variationId: variation?.id })); } catch { /* Selection persistence is optional. */ }
}

function renderSelectionSearch(kind) {
  const theme = catalog[themeIndex];
  const entries = kind === 'theme' ? catalog : theme?.variations ?? [];
  const currentId = kind === 'theme' ? theme?.id : theme?.variations[variationIndex]?.id;
  const input = $(`${kind}-search`);
  const select = $(`${kind}-select`);
  const result = searchNumberedEntries(entries, input.value, currentId);
  const options = [];
  if (result.retained) {
    const current = element('optgroup');
    current.label = `Current ${kind}`;
    current.append(new Option(result.retained.label, result.retained.id));
    options.push(current);
  }
  const matches = result.matches.map(choice => new Option(choice.label, choice.id));
  if (result.retained && matches.length) {
    const group = element('optgroup');
    group.label = `Matching ${kind}s`;
    group.append(...matches);
    options.push(group);
  } else options.push(...matches);
  if (!options.length) options.push(new Option(`No ${kind}s yet`, ''));
  select.replaceChildren(...options);
  select.value = currentId ?? '';
  input.disabled = !entries.length;
  $(`clear-${kind}-search`).hidden = !input.value;
  const status = $(`${kind}-search-status`);
  const count = result.matches.length;
  status.textContent = result.active
    ? `${count ? `${count} match${count === 1 ? '' : 'es'}` : 'No matches'}${result.retained ? ` · Current ${kind} kept` : ''}`
    : '';
  status.classList.toggle('visually-hidden', !result.active);
  status.dataset.state = count ? 'matches' : 'empty';
}

function clearSelectionSearch(kind) {
  $(`${kind}-search`).value = '';
  shortcuts.reset();
  renderSelectionSearch(kind);
  $(`${kind}-search`).focus({ preventScroll: true });
}

function renderSelection() {
  const theme = catalog[themeIndex];
  const variation = theme?.variations[variationIndex];
  renderSelectionSearch('theme');
  renderSelectionSearch('variation');
  $('current-theme-name').textContent = theme?.name ?? 'Your collection';
  $('current-variation-name').textContent = variation?.name ?? 'No variation selected';
  $('prompt-output').textContent = variation?.prompt ?? 'This theme has no variations yet.';
  $('prompt-output').parentElement.scrollTop = 0;
  $('selection-count').textContent = theme ? `Theme ${themeIndex + 1} / ${catalog.length} · Variation ${variation ? variationIndex + 1 : 0} / ${theme.variations.length}` : 'No themes yet';
  for (const id of ['prev-theme', 'next-theme', 'copy-theme', 'copy-theme-name', 'theme-select']) $(id).disabled = !theme;
  for (const id of ['prev-variation', 'next-variation', 'copy-variation', 'copy-prompt', 'variation-select']) $(id).disabled = !variation;
  shortcuts.resetCopyGesture();
  saveSelection();
}

function useCatalog(next) {
  const oldThemeId = catalog[themeIndex]?.id ?? rememberedSelection.themeId;
  const oldVariationId = catalog[themeIndex]?.variations[variationIndex]?.id ?? rememberedSelection.variationId;
  catalog = validateCatalog(next);
  themeIndex = Math.max(0, catalog.findIndex(theme => theme.id === oldThemeId));
  variationIndex = Math.max(0, (catalog[themeIndex]?.variations ?? []).findIndex(variation => variation.id === oldVariationId));
  if (catalog[themeIndex]?.id !== oldThemeId) $('variation-search').value = '';
  $('theme-count').textContent = String(catalog.length);
  $('total-prompts').textContent = String(catalog.reduce((total, theme) => total + theme.variations.length, 0));
  renderSelection();
}

async function loadPublishedCatalog() {
  const generation = ++catalogLoadGeneration;
  const response = await fetch(`./data.json?fresh=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('The collection could not be loaded. Refresh the page to try again.');
  const next = await response.json();
  if (generation === catalogLoadGeneration) useCatalog(next);
}

function chooseTheme(index) {
  if (!Number.isInteger(index) || index < 0 || index >= catalog.length) return;
  if (index !== themeIndex) $('variation-search').value = '';
  saveSelection();
  themeIndex = index;
  const theme = catalog[themeIndex];
  variationIndex = Math.max(0, (theme?.variations ?? []).findIndex(item => item.id === variationMemory.get(theme.id)));
  renderSelection();
}
function moveTheme(direction) { if (catalog.length) chooseTheme(wrapIndex(themeIndex, direction, catalog.length)); }
function moveVariation(direction) {
  variationIndex = wrapIndex(variationIndex, direction, catalog[themeIndex]?.variations.length ?? 0);
  renderSelection();
}

function copyValue(text, label) {
  if (!text) return;
  const sequence = ++copySequence;
  let result;
  try {
    // Called directly by the click/keydown handler to retain browser user activation.
    if (navigator.clipboard?.writeText) result = navigator.clipboard.writeText(text);
    else {
      const focus = document.activeElement;
      const buffer = element('textarea', 'clipboard-buffer');
      buffer.value = text;
      buffer.setAttribute('aria-hidden', 'true');
      buffer.tabIndex = -1;
      document.body.append(buffer);
      buffer.select();
      const copied = document.execCommand('copy');
      buffer.remove();
      focus?.focus({ preventScroll: true });
      if (!copied) throw new Error('Clipboard unavailable');
      result = Promise.resolve();
    }
  } catch { result = Promise.reject(new Error('Clipboard unavailable')); }
  result.then(() => { if (sequence === copySequence) toast(`${label} copied`); })
    .catch(() => { if (sequence === copySequence) toast('Clipboard access was blocked. Select the text and copy it manually.'); });
}
function copyTheme(withNumber = true) {
  const theme = catalog[themeIndex];
  if (theme) copyValue(withNumber ? `${themeIndex + 1}. ${theme.name}` : theme.name, withNumber ? 'Numbered theme' : 'Theme name');
}
function copyPrompt() { copyValue(catalog[themeIndex]?.variations[variationIndex]?.prompt, 'Prompt'); }

function updateButtons() {
  const source = inputMode === 'file' ? fileText : $('json-input').value;
  $('submit-button').disabled = busy || accessBusy || !client.connected || !validation || validation.source !== source;
  $('validate-button').disabled = busy || !source.trim();
  for (const id of ['json-input', 'json-file', 'clear-file', 'open-connect', 'disconnect-button']) $(id).disabled = busy;
  all('[data-input-mode]').forEach(button => { button.disabled = busy; });
  updateAccessControls();
}

function setBusy(value) { busy = value; updateButtons(); }

function resetValidation() {
  validation = null;
  $('validation-output').replaceChildren(element('p', 'validation-note', 'Validate your batch to preview what will be appended.'));
  updateButtons();
}

function setInputMode(mode) {
  inputMode = mode;
  all('[data-input-mode]').forEach(button => {
    const selected = button.dataset.inputMode === mode;
    button.setAttribute('aria-selected', String(selected));
    button.classList.toggle('is-active', selected);
    button.tabIndex = selected ? 0 : -1;
  });
  $('input-paste').hidden = mode !== 'paste';
  $('input-file').hidden = mode !== 'file';
  resetValidation();
  if (mode === 'file' && fileError) $('validation-output').replaceChildren(element('p', 'validation-error', fileError));
}

function renderValidation(result, incoming) {
  const catalogBytes = measureCatalogBytes(result.catalog, { pretty: true, maximum: MAX_CATALOG_BYTES });
  if (catalogBytes > MAX_CATALOG_BYTES) throw new Error('The updated collection would exceed 100 MB. GitHub requires the complete data.json to stay within this size.');
  const title = element('p', 'validation-summary', result.changed ? 'Valid JSON · ready to append' : 'Valid JSON · these entries are already in the collection');
  const counts = element('dl', 'validation-counts');
  const fileDuplicates = inputMode === 'file' ? fileBatch?.duplicateVariationsAcrossFiles ?? 0 : 0;
  for (const [label, value] of [['New themes', result.addedThemes], ['New prompts', result.addedVariations], ['Themes extended', result.extendedThemes], ['Duplicates skipped', result.duplicateVariations + fileDuplicates]]) {
    const group = element('div');
    group.append(element('dt', '', label), element('dd', '', String(value)));
    counts.append(group);
  }
  const fileNote = inputMode === 'file' && fileBatch ? `${fileBatch.files.length} file${fileBatch.files.length === 1 ? '' : 's'} combined in the order shown. ` : '';
  const note = element('p', 'validation-note', `${fileNote}${incoming.length} theme${incoming.length === 1 ? '' : 's'} in this batch. Collection after import: ${formatBytes(catalogBytes)} / 100 MB. GitHub checks the latest collection again before saving. Existing prompts keep their order and wording.`);
  $('validation-output').replaceChildren(title, counts, note);
}

function validateInput() {
  try {
    const source = inputMode === 'file' ? fileText : $('json-input').value;
    const incoming = parseCatalog(source);
    if (!incoming.length || !incoming.some(theme => theme.variations.length)) throw new Error('Add at least one theme containing a variation before submitting.');
    const result = mergeCatalog(catalog, incoming);
    validation = { source, incoming, result };
    renderValidation(result, incoming);
    updateButtons();
    return validation;
  } catch (error) {
    validation = null;
    $('validation-output').replaceChildren(element('p', 'validation-error', error.message));
    updateButtons();
    return null;
  }
}

function formatBytes(bytes) {
  const megabytes = bytes >= 1_000_000;
  return `${(bytes / (megabytes ? 1_000_000 : 1000)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${megabytes ? 'MB' : 'kB'}`;
}

function renderFiles(files) {
  $('file-details').hidden = !files.length;
  $('file-name').textContent = `${files.length} JSON file${files.length === 1 ? '' : 's'}`;
  $('file-size').textContent = `${formatBytes(files.reduce((total, file) => total + (file.bytes ?? file.size), 0))} total`;
  $('file-list').replaceChildren(...files.map((file, index) => {
    const row = element('li', 'file-list-item');
    const metrics = file.themes === undefined ? formatBytes(file.size) : `${formatBytes(file.bytes)} · ${file.themes} theme${file.themes === 1 ? '' : 's'} · ${file.variations} prompt${file.variations === 1 ? '' : 's'}`;
    row.append(element('span', 'file-order', String(index + 1)), element('span', 'file-list-name', file.name), element('span', 'file-list-metrics', metrics));
    return row;
  }));
}

async function acceptFiles(files) {
  if (!files?.length || busy) return;
  const readVersion = ++fileReadVersion;
  fileText = '';
  fileBatch = null;
  fileError = '';
  setInputMode('file');
  try {
    const ordered = sortFiles(files);
    renderFiles(ordered);
    if (ordered.some(file => !/\.json$/i.test(file.name))) throw new Error('Choose files with the .json extension.');
    if (ordered.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) throw new Error('The selected files together exceed 100 MB. Select fewer files or split the batch.');
    $('validation-output').replaceChildren(element('p', 'validation-note', 'Reading and checking every file…'));
    const contents = [];
    for (let index = 0; index < ordered.length; index += 1) {
      if (readVersion !== fileReadVersion) return;
      const file = ordered[index];
      if (inputMode === 'file') $('validation-output').replaceChildren(element('p', 'validation-note', `Reading file ${index + 1} of ${ordered.length}: ${file.name}`));
      try {
        const bytes = await file.arrayBuffer();
        // Reject damaged encodings instead of silently replacing prompt characters.
        contents.push({ name: file.name, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) });
      } catch { throw new Error(`File ${JSON.stringify(file.name)} could not be read as UTF-8. Save it as UTF-8 JSON and try again.`); }
    }
    if (readVersion !== fileReadVersion) return;
    if (inputMode === 'file') $('validation-output').replaceChildren(element('p', 'validation-note', 'Checking and combining the files in filename order…'));
    await new Promise(resolve => setTimeout(resolve, 0));
    if (readVersion !== fileReadVersion) return;
    fileBatch = buildFileBatch(contents);
    fileText = fileBatch.source;
    renderFiles(fileBatch.files);
    if (inputMode === 'file') validateInput();
  } catch (error) {
    if (readVersion !== fileReadVersion) return;
    fileError = error.message || 'These files could not be read.';
    if (inputMode === 'file') $('validation-output').replaceChildren(element('p', 'validation-error', fileError));
  }
  if (readVersion === fileReadVersion) updateButtons();
}

function showSubmission(status) {
  $('submission-status').hidden = false;
  $('submission-status').dataset.state = status.state;
  $('submission-title').textContent = status.title;
  $('submission-detail').textContent = status.detail;
  $('submission-progress').value = status.progress ?? 0;
  $('submission-progress').setAttribute('aria-label', status.title);
  $('safe-to-close').dataset.safe = String(status.safe === true);
  $('safe-to-close').textContent = status.safe ? 'Safe to close · GitHub handles the rest' : 'Keep this page open · acceptance is not confirmed';
  if (status.state === 'rejected') $('safe-to-close').textContent = 'Not submitted · keep your JSON to try again';
  if (status.state === 'unknown') $('safe-to-close').textContent = 'Acceptance unknown · check Activity before retrying';
  if (status.terminal && status.safe) $('safe-to-close').textContent = status.state === 'published' ? 'Safe to close · publication complete' : 'Safe to close · check the result above';
  const links = $('submission-links');
  links.replaceChildren();
  if (status.requestId) {
    const link = element('a', 'text-link', status.runId ? 'View GitHub run ↗' : 'View GitHub Actions ↗');
    link.href = runUrl(status.runId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    links.append(link);
  }
  if (!storageAvailable && status.safe) links.append(element('p', 'validation-note', 'This browser could not save Activity. Keep the GitHub run link to return to this submission.'));
}

function saveReceipt(record, isNew = false) {
  if (isNew) receipts.unshift(record);
  receipts = receipts.slice(0, 120);
  storageAvailable = writeReceipts(storage, receipts);
  renderActivity();
  if (record.requestId === selectedReceiptId) showSubmission(record);
}

async function digestText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function dispatchRecord(record) {
  selectedReceiptId = record.requestId;
  Object.assign(record, { state: 'submitting', title: 'Submitting to GitHub', detail: 'The upload is stored. Waiting for GitHub to accept the workflow.', safe: false, terminal: false, progress: 20 });
  saveReceipt(record, true);
  try {
    const result = await client.dispatch(record);
    Object.assign(record, { runId: result.runId, state: 'accepted', title: 'Accepted by GitHub', detail: 'Your batch is queued for validation, merging, and publication. You can close this page now.', progress: 30, safe: true, terminal: false });
    saveReceipt(record);
    validation = null;
    toast('Batch accepted · safe to close');
  } catch (error) {
    respectGitHubRetry(error);
    Object.assign(record, { state: error.uncertain ? 'unknown' : 'rejected', title: error.uncertain ? 'Acceptance not confirmed' : 'Not submitted', detail: error.message, progress: 20, safe: false, terminal: !error.uncertain });
    saveReceipt(record);
  }
  schedulePoll(1000);
}

async function submitInput() {
  if (busy) return;
  if (!client.connected) { openAccess(); return; }
  const batch = validateInput();
  if (!batch) return;
  setBusy(true);
  selectedReceiptId = null;
  showSubmission({ state: 'validating', title: 'Checking the latest collection', detail: 'Confirming this batch against data.json on GitHub before uploading.', progress: 5, safe: false });
  try {
    const latest = validateCatalog(JSON.parse(await client.readCanonical()));
    const result = mergeCatalog(latest, batch.incoming);
    renderValidation(result, batch.incoming);
    showSubmission({ state: 'uploading', title: 'Uploading your batch', detail: 'Sending the JSON to seo-yuna. Keep this page open until GitHub accepts it.', progress: 12, safe: false });
    const digest = await digestText(batch.source);
    const blobSha = await client.stageBlob(batch.source);
    await dispatchRecord({ requestId: crypto.randomUUID(), blobSha, digest, createdAt: new Date().toISOString(), runId: null,
      themeCount: batch.incoming.length, variationCount: batch.incoming.reduce((total, theme) => total + theme.variations.length, 0) });
  } catch (error) {
    respectGitHubRetry(error);
    showSubmission({ state: 'rejected', title: 'Not submitted', detail: error.message || 'The batch could not be submitted. Validate it and try again.', safe: false, progress: 0 });
  } finally { setBusy(false); }
}

async function retryReceipt(previous) {
  if (busy) return;
  if (!client.connected) { openAccess(); return; }
  setBusy(true);
  try {
    // Explicit user retry only. Recheck an unknown outcome before dispatching again.
    if (previous.state === 'unknown' || previous.state === 'submitting') {
      await refreshReceipt(previous);
      if (previous.safe) { toast('The existing submission was found.'); return; }
    }
    setView('import');
    await dispatchRecord({ requestId: crypto.randomUUID(), blobSha: previous.blobSha, digest: previous.digest,
      createdAt: new Date().toISOString(), runId: null, themeCount: previous.themeCount, variationCount: previous.variationCount });
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

function refreshReceipt(record) {
  if (receiptRefreshes.has(record.requestId)) return receiptRefreshes.get(record.requestId);
  const pending = performReceiptRefresh(record).finally(() => receiptRefreshes.delete(record.requestId));
  receiptRefreshes.set(record.requestId, pending);
  return pending;
}

async function performReceiptRefresh(record) {
  try {
    if (Date.now() < githubRetryAt) throw new Error(`GitHub asked to wait ${Math.ceil((githubRetryAt - Date.now()) / 1000)} seconds before checking again.`);
    let run;
    if (!record.runId) {
      run = await client.findRun(record.requestId, record.createdAt);
      record.checkedAt = new Date().toISOString();
      if (!run) {
        record.detail = record.safe ? 'GitHub accepted the submission. Its run details are not available yet; check again shortly.' : 'No matching run is visible yet. Check again before retrying. An explicit retry safely skips any identical entries already saved.';
        saveReceipt(record);
        return;
      }
      record.runId = run.id;
    } else run = await client.readRun(record.runId);
    let jobs = [];
    if (run.status === 'in_progress' || (run.status === 'completed' && run.conclusion !== 'success')) {
      try { jobs = (await client.readJobs(record.runId)).jobs ?? []; } catch { /* The run link remains authoritative if job details are unavailable. */ }
    }
    const wasPublished = record.state === 'published';
    Object.assign(record, describeRun(run, jobs), { checkedAt: new Date().toISOString() });
    saveReceipt(record);
    if (record.state === 'published' && !wasPublished) {
      try { await loadPublishedCatalog(); toast('Published collection refreshed'); }
      catch { toast('Publication finished. Refresh the page to load the updated collection.'); }
    }
  } catch (error) {
    respectGitHubRetry(error);
    // A failed status check cannot revoke an earlier acceptance or claim a workflow failure.
    record.detail = `${error.message} ${record.safe ? 'GitHub already accepted this batch; closing the page will not stop it.' : 'Acceptance is still unconfirmed.'}`;
    record.checkedAt = new Date().toISOString();
    saveReceipt(record);
    throw error;
  }
}

function pendingReceipts() {
  return receipts.filter(record => !record.terminal && (record.safe || Date.now() - Date.parse(record.createdAt) < 15 * 60000));
}

function schedulePoll(delay = client.connected ? 15000 : 180000) {
  clearTimeout(pollTimer);
  if (document.hidden || !pendingReceipts().length) return;
  pollTimer = setTimeout(pollOnce, Math.max(delay, githubRetryAt - Date.now()));
}

async function pollOnce() {
  if (polling || busy || document.hidden) { schedulePoll(); return; }
  const pending = pendingReceipts();
  if (!pending.length) return;
  polling = true;
  try { await refreshReceipt(pending[pollCursor++ % pending.length]); } catch { /* Inline status explains connection errors. */ }
  finally { polling = false; schedulePoll(); }
}

function renderActivity() {
  const list = $('activity-list');
  if (!receipts.length) {
    list.replaceChildren(element('div', 'empty-state', 'Your submissions will appear here. Activity is remembered in this browser; all workflow runs are also available on GitHub.'));
    return;
  }
  list.replaceChildren(...receipts.map(record => {
    const card = element('article', 'activity-card');
    const header = element('div', 'activity-card__header');
    const title = element('h3', 'activity-title', `${record.themeCount} theme${record.themeCount === 1 ? '' : 's'} · ${record.variationCount} prompt${record.variationCount === 1 ? '' : 's'}`);
    const badge = element('span', 'status-badge', record.title);
    badge.dataset.state = record.state;
    header.append(title, badge);
    const time = element('p', 'activity-time', new Date(record.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    const detail = element('p', 'activity-detail', record.detail);
    const safe = element('p', 'validation-note', record.safe ? 'Safe to close. GitHub processing is independent of this page.' : 'Acceptance has not been confirmed.');
    const actions = element('div', 'activity-actions');
    const link = element('a', 'text-link', record.runId ? 'View run ↗' : 'GitHub Actions ↗');
    link.href = runUrl(record.runId); link.target = '_blank'; link.rel = 'noopener noreferrer';
    actions.append(link);
    if (record.state !== 'published') {
      const refresh = element('button', 'button button--small button--secondary', 'Check status');
      refresh.type = 'button';
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try { await refreshReceipt(record); } catch (error) { toast(error.message); }
        finally { refresh.disabled = false; schedulePoll(); }
      });
      actions.append(refresh);
    }
    if (['failed', 'saved', 'rejected', 'unknown'].includes(record.state)) {
      const retry = element('button', 'button button--small button--secondary', record.state === 'saved' ? 'Retry publication' : 'Retry submission');
      retry.type = 'button'; retry.disabled = busy;
      retry.addEventListener('click', () => retryReceipt(record));
      actions.append(retry);
    }
    card.append(header, time, detail, safe, actions);
    return card;
  }));
}

function clearAccessInputs() {
  for (const id of ['access-token', 'access-username', 'access-password', 'access-password-confirm']) $(id).value = '';
  $('show-access-password').checked = false;
  $('access-password').type = 'password';
  $('access-password-confirm').type = 'password';
}

function updateAccessControls() {
  const configured = client.configured;
  const connected = client.connected;
  const unavailable = accessReady && !client.storageAvailable;
  const waiting = busy || accessBusy || !accessReady;
  const setup = !configured;
  const status = $('connection-status');
  const panel = $('access-panel');

  $('open-connect').disabled = waiting;
  $('access-button-label').textContent = 'Owner access';
  $('connect-title').textContent = connected ? 'Owner access' : configured ? 'Log in' : 'Set up owner access';
  $('access-panel-title').textContent = connected ? 'Connected as budhi-halim' : configured ? 'Your local login' : 'Set up this browser';
  $('connect-description').textContent = connected
    ? 'You can submit prompt updates from this page.'
    : configured
      ? 'Enter the two strings you chose when setting up this browser.'
      : 'Connect this browser once, then use your own username and password to log in.';
  $('access-panel-description').textContent = connected
    ? 'Your GitHub token is unlocked for this tab. Log out or close the tab to lock it again.'
    : configured
      ? 'Your username and password unlock the saved GitHub token on this device. They are not sent to GitHub.'
      : 'A GitHub token connects this browser to seo-yuna. Your chosen username and password keep it encrypted on this device.';
  $('token-setup-guide').hidden = !setup || connected || unavailable;
  $('token-field').hidden = !setup;
  $('password-confirm-field').hidden = !setup;
  $('owner-login-form').hidden = connected || unavailable;
  $('access-token').required = setup && !connected;
  $('access-password-confirm').required = setup && !connected;
  $('access-password').minLength = setup ? 12 : 1;
  $('login-field-help').textContent = setup
    ? 'Choose your own username and a password of at least 12 characters, preferably several unrelated words. Both are case-sensitive and stay on this device.'
    : 'Both strings are case-sensitive. Use the exact spaces and characters you chose during setup.';
  for (const input of all('#owner-login-form input')) input.disabled = waiting || connected || unavailable;
  $('disconnect-button').hidden = !connected;
  $('disconnect-button').disabled = waiting;
  $('connect-button').hidden = connected || unavailable;
  $('connect-button').disabled = waiting;
  $('connect-button-label').textContent = accessBusy ? (setup ? 'Connecting…' : 'Logging in…') : setup ? 'Save & log in' : 'Log in';
  $('connect-button').title = setup ? 'Verify GitHub access and encrypt the token in this browser' : 'Unlock this browser’s saved GitHub token';
  $('reset-access').hidden = unavailable || (!configured && !client.storageError);
  $('forget-button').disabled = waiting;
  $('submit-note').textContent = connected
    ? 'The validated batch is sent directly to GitHub. This collection is public.'
    : 'Log in through Owner access to submit. This prompt collection is public.';

  if (waiting && accessBusy) {
    status.textContent = 'Checking access…';
    status.dataset.state = 'pending';
    panel.dataset.state = 'pending';
  } else if (connected) {
    status.textContent = 'budhi-halim';
    status.dataset.state = 'connected';
    panel.dataset.state = 'ready';
  } else if (unavailable || (!configured && client.storageError)) {
    status.textContent = 'Access unavailable';
    status.dataset.state = 'error';
    panel.dataset.state = 'error';
  } else {
    status.textContent = configured ? 'Logged out' : 'Setup required';
    status.dataset.state = 'disconnected';
    panel.dataset.state = 'pending';
  }
  $('account-access-note').textContent = 'Setup is saved in this browser. You will need a token again after clearing site data, changing browsers, or replacing an expired token.';
  $('connection-message').textContent = accessMessage || client.storageError || (connected ? 'Owner access is ready. Close this panel to continue your import.' : '');
  $('connection-message').dataset.state = accessMessage ? accessMessageState : client.storageError ? 'error' : connected ? 'success' : 'info';
}

async function initializeOwnerAccess(message = '') {
  const generation = ++accessGeneration;
  accessBusy = true;
  accessMessage = '';
  accessMessageState = 'info';
  updateButtons();
  try {
    await client.initialize();
    if (generation === accessGeneration) accessMessage = message;
  } catch {
    if (generation === accessGeneration) {
      accessMessage = 'This browser’s saved connection could not be read. Check that site storage is available.';
      accessMessageState = 'error';
    }
  } finally {
    if (generation === accessGeneration) {
      accessReady = true;
      accessBusy = false;
      updateButtons();
    }
  }
}

function openAccess() {
  shortcuts.reset();
  accessMessage = '';
  accessMessageState = 'info';
  updateAccessControls();
  if (!$('connect-dialog').open) $('connect-dialog').showModal();
  if (!client.connected && client.storageAvailable) {
    $(client.configured ? 'access-username' : 'access-token').focus({ preventScroll: true });
  }
}

async function submitCredentials(event) {
  event.preventDefault();
  if (busy || accessBusy || !accessReady || client.connected || !client.storageAvailable) return;
  if (!$('owner-login-form').reportValidity()) return;
  const setup = !client.configured;
  if (setup && [...$('access-password').value].length < 12) {
    accessMessage = 'Choose a password with at least 12 characters, preferably several unrelated words.';
    accessMessageState = 'error';
    updateAccessControls();
    $('access-password').focus();
    return;
  }
  if (setup && $('access-password').value !== $('access-password-confirm').value) {
    accessMessage = 'The password and confirmation do not match.';
    accessMessageState = 'error';
    updateAccessControls();
    $('access-password-confirm').focus();
    return;
  }
  const generation = ++accessGeneration;
  accessBusy = true;
  accessMessage = setup ? 'Checking GitHub access and saving this browser’s encrypted connection…' : 'Unlocking locally and checking GitHub access…';
  accessMessageState = 'info';
  updateButtons();
  try {
    // Call with current field values; clear the form while the operation is pending.
    const operation = setup
      ? client.configure($('access-username').value, $('access-password').value, $('access-token').value)
      : client.unlock($('access-username').value, $('access-password').value);
    clearAccessInputs();
    await operation;
    if (generation !== accessGeneration) return;
    accessMessage = setup ? 'Connection saved in this browser. You are logged in as budhi-halim.' : 'Logged in as budhi-halim. You can submit your JSON now.';
    accessMessageState = 'success';
    githubRetryAt = 0;
    $('reset-access').open = false;
    toast('Owner access ready');
    schedulePoll(1000);
  } catch (error) {
    if (generation !== accessGeneration) return;
    respectGitHubRetry(error);
    accessMessage = error.message || 'Login could not be completed. Check your details and try again.';
    accessMessageState = 'error';
  } finally {
    if (generation === accessGeneration) {
      accessBusy = false;
      updateButtons();
      if (!client.connected) $(client.configured ? 'access-username' : 'access-token').focus({ preventScroll: true });
    }
  }
}

function signOutOwner() {
  if (busy || accessBusy) return;
  accessGeneration += 1;
  client.disconnect();
  clearAccessInputs();
  accessMessage = 'Logged out. Your encrypted connection is saved for the next login.';
  accessMessageState = 'info';
  updateButtons();
  schedulePoll();
  $('access-username').focus({ preventScroll: true });
}

async function forgetOwner() {
  if (busy || accessBusy) return;
  const generation = ++accessGeneration;
  accessBusy = true;
  updateButtons();
  clearAccessInputs();
  try {
    await client.forget();
    if (generation !== accessGeneration) return;
    accessMessage = 'Saved connection removed from this browser. Set up a token and new login to reconnect.';
    accessMessageState = 'info';
    $('reset-access').open = false;
  } catch (error) {
    if (generation === accessGeneration) {
      accessMessage = error.message || 'The saved connection could not be removed.';
      accessMessageState = 'error';
    }
  } finally {
    if (generation === accessGeneration) {
      accessBusy = false;
      updateButtons();
    }
  }
}

function closeAccess() {
  if (accessBusy) {
    accessGeneration += 1;
    client.disconnect();
    accessBusy = false;
    accessMessage = '';
  }
  clearAccessInputs();
  shortcuts.reset();
  updateButtons();
}

all('[data-view]').forEach(button => {
  button.addEventListener('click', () => setView(button.dataset.view));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = all('[data-view]');
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : wrapIndex(tabs.indexOf(button), event.key === 'ArrowRight' ? 1 : -1, tabs.length);
    setView(tabs[index].dataset.view); tabs[index].focus();
  });
});
$('prev-theme').addEventListener('click', () => moveTheme(-1));
$('next-theme').addEventListener('click', () => moveTheme(1));
$('prev-variation').addEventListener('click', () => moveVariation(-1));
$('next-variation').addEventListener('click', () => moveVariation(1));
$('theme-select').addEventListener('change', event => chooseTheme(catalog.findIndex(theme => theme.id === event.target.value)));
$('variation-select').addEventListener('change', event => {
  const next = catalog[themeIndex]?.variations.findIndex(variation => variation.id === event.target.value) ?? -1;
  if (next < 0) return;
  variationIndex = next;
  renderSelection();
});
for (const kind of ['theme', 'variation']) {
  $(`${kind}-search`).addEventListener('input', () => { shortcuts.reset(); renderSelectionSearch(kind); });
  $(`${kind}-search`).addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && event.target.value) { event.preventDefault(); clearSelectionSearch(kind); }
    else if (['Enter', 'ArrowDown'].includes(event.key) && !$(`${kind}-select`).disabled) {
      event.preventDefault();
      $(`${kind}-select`).focus({ preventScroll: true });
    }
  });
  $(`clear-${kind}-search`).addEventListener('click', () => clearSelectionSearch(kind));
}
$('copy-theme').addEventListener('click', () => copyTheme(true));
$('copy-theme-name').addEventListener('click', () => copyTheme(false));
$('copy-variation').addEventListener('click', () => copyValue(catalog[themeIndex]?.variations[variationIndex]?.name, 'Variation name'));
$('copy-prompt').addEventListener('click', copyPrompt);
document.addEventListener('keydown', event => shortcuts.handle(event));
document.addEventListener('keyup', event => shortcuts.release(event));
document.addEventListener('focusin', () => shortcuts.reset());
document.addEventListener('pointerdown', () => shortcuts.reset());
document.addEventListener('compositionstart', () => shortcuts.reset());
window.addEventListener('blur', () => shortcuts.reset());
all('[data-input-mode]').forEach(button => {
  button.addEventListener('click', () => setInputMode(button.dataset.inputMode));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
    event.preventDefault();
    const tabs = all('[data-input-mode]');
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : wrapIndex(tabs.indexOf(button), event.key === 'ArrowRight' ? 1 : -1, tabs.length);
    setInputMode(tabs[index].dataset.inputMode); tabs[index].focus();
  });
});
$('json-input').addEventListener('input', resetValidation);
$('json-file').addEventListener('change', event => acceptFiles(event.target.files));
$('clear-file').addEventListener('click', () => {
  fileReadVersion += 1; fileText = ''; fileBatch = null; fileError = ''; $('json-file').value = ''; renderFiles([]); resetValidation();
});
$('drop-zone').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); $('json-file').click(); }
});
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); if (!busy) $('drop-zone').classList.add('is-dragging'); });
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.remove('is-dragging'); });
$('drop-zone').addEventListener('drop', event => { if (!busy) acceptFiles(event.dataTransfer.files); });
$('validate-button').addEventListener('click', validateInput);
$('submit-button').addEventListener('click', submitInput);
$('open-connect').addEventListener('click', openAccess);
$('owner-login-form').addEventListener('submit', submitCredentials);
$('forget-button').addEventListener('click', forgetOwner);
$('show-access-password').addEventListener('change', event => {
  for (const id of ['access-password', 'access-password-confirm']) $(id).type = event.target.checked ? 'text' : 'password';
});
$('disconnect-button').addEventListener('click', signOutOwner);
$('close-connect').addEventListener('click', () => $('connect-dialog').close());
$('connect-dialog').addEventListener('close', closeAccess);
$('repository-link').href = REPOSITORY_URL;
$('open-shortcuts').addEventListener('click', () => { shortcuts.reset(); $('shortcuts-dialog').showModal(); });
$('close-shortcuts').addEventListener('click', () => $('shortcuts-dialog').close());
$('refresh-activity').addEventListener('click', async () => {
  if (polling) return;
  polling = true; $('refresh-activity').disabled = true;
  const candidates = receipts.filter(record => record.state !== 'published').slice(0, 10);
  try { for (const record of candidates) await refreshReceipt(record); }
  catch (error) { toast(error.message); }
  finally { polling = false; $('refresh-activity').disabled = false; schedulePoll(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { shortcuts.reset(); clearTimeout(pollTimer); }
  else {
    schedulePoll(1000);
  }
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
window.addEventListener('pagehide', () => {
  shortcuts.reset(); accessGeneration += 1; client.disconnect(); clearAccessInputs(); clearTimeout(pollTimer);
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { accessBusy = false; void initializeOwnerAccess('Log in again to submit updates.'); }
});
window.addEventListener('storage', event => {
  if (event.storageArea !== storage || (event.key !== VAULT_STORAGE_KEY && event.key !== null)) return;
  client.disconnect();
  clearAccessInputs();
  void initializeOwnerAccess('This browser’s saved connection changed in another tab. Log in again to submit updates.');
});

setView(location.hash.slice(1));
setInputMode('paste');
updateAccessControls();
renderActivity();
if (receipts[0]) showSubmission(receipts[0]);
const accountCheck = initializeOwnerAccess();
try { await loadPublishedCatalog(); }
catch (error) { $('prompt-output').textContent = error.message || 'The collection could not be loaded. Refresh this page to try again.'; }
await accountCheck;
updateButtons();
schedulePoll(1000);
