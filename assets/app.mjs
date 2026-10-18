import { MAX_IMPORT_BYTES, parseCatalog, validateCatalog, mergeCatalog } from './catalog.mjs';
import { GitHubClient, REPOSITORY_URL, runUrl, describeRun } from './github.mjs';
import { createShortcutHandler, wrapIndex } from './shortcuts.mjs';
import { readReceipts, writeReceipts } from './receipts.mjs';
import { sortFiles, buildFileBatch } from './import-batch.mjs';

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
let client = new GitHubClient();
let receipts = readReceipts(storage);
let selectedReceiptId = receipts[0]?.requestId ?? null;
let storageAvailable = true;
let toastTimer;
let pollTimer;
let polling = false;
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

function renderSelection() {
  const theme = catalog[themeIndex];
  const variation = theme?.variations[variationIndex];
  $('theme-select').value = theme?.id ?? '';
  const choices = (theme?.variations ?? []).map((entry, index) => new Option(`${index + 1}. ${entry.name}`, entry.id));
  $('variation-select').replaceChildren(...choices);
  $('variation-select').value = variation?.id ?? '';
  $('current-theme-name').textContent = theme?.name ?? 'Your collection';
  $('current-variation-name').textContent = variation?.name ?? 'No variation selected';
  $('prompt-output').textContent = variation?.prompt ?? 'This theme has no variations yet.';
  $('prompt-output').parentElement.scrollTop = 0;
  $('selection-count').textContent = theme ? `Theme ${themeIndex + 1} / ${catalog.length} · Variation ${variation ? variationIndex + 1 : 0} / ${theme.variations.length}` : 'No themes yet';
  for (const id of ['prev-theme', 'next-theme', 'copy-theme', 'copy-theme-name', 'theme-select']) $(id).disabled = !theme;
  for (const id of ['prev-variation', 'next-variation', 'copy-variation', 'copy-prompt', 'variation-select']) $(id).disabled = !variation;
  shortcuts.reset();
  saveSelection();
}

function useCatalog(next) {
  const oldThemeId = catalog[themeIndex]?.id ?? rememberedSelection.themeId;
  const oldVariationId = catalog[themeIndex]?.variations[variationIndex]?.id ?? rememberedSelection.variationId;
  catalog = validateCatalog(next);
  themeIndex = Math.max(0, catalog.findIndex(theme => theme.id === oldThemeId));
  variationIndex = Math.max(0, (catalog[themeIndex]?.variations ?? []).findIndex(variation => variation.id === oldVariationId));
  $('theme-select').replaceChildren(...catalog.map((theme, index) => new Option(`${index + 1}. ${theme.name}`, theme.id)));
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
  $('submit-button').disabled = busy || !client.connected || !validation || validation.source !== source;
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
  const title = element('p', 'validation-summary', result.changed ? 'Valid JSON · ready to append' : 'Valid JSON · these entries are already in the collection');
  const counts = element('dl', 'validation-counts');
  const fileDuplicates = inputMode === 'file' ? fileBatch?.duplicateVariationsAcrossFiles ?? 0 : 0;
  for (const [label, value] of [['New themes', result.addedThemes], ['New prompts', result.addedVariations], ['Themes extended', result.extendedThemes], ['Duplicates skipped', result.duplicateVariations + fileDuplicates]]) {
    const group = element('div');
    group.append(element('dt', '', label), element('dd', '', String(value)));
    counts.append(group);
  }
  const fileNote = inputMode === 'file' && fileBatch ? `${fileBatch.files.length} file${fileBatch.files.length === 1 ? '' : 's'} combined in the order shown. ` : '';
  const note = element('p', 'validation-note', `${fileNote}${incoming.length} theme${incoming.length === 1 ? '' : 's'} in this batch. GitHub checks the latest collection again before saving. Existing prompts keep their order and wording.`);
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
  return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
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
    if (ordered.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) throw new Error('The selected files together exceed 5 MiB. Select fewer files or split the batch.');
    $('validation-output').replaceChildren(element('p', 'validation-note', 'Reading and checking every file…'));
    const contents = await Promise.all(ordered.map(async file => {
      try {
        const bytes = await file.arrayBuffer();
        // Reject damaged encodings instead of silently replacing prompt characters.
        return { name: file.name, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
      } catch { throw new Error(`File ${JSON.stringify(file.name)} could not be read as UTF-8. Save it as UTF-8 JSON and try again.`); }
    }));
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
  pollTimer = setTimeout(pollOnce, delay);
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

// Imports remain closed until the selected account provider and trusted backend
// are provisioned. A browser flag or an application password cannot grant access.
function updateAccessControls() {
  $('connect-button').disabled = true;
  $('connect-button-label').textContent = 'Owner sign-in setup pending';
  $('setup-button').hidden = true;
  $('disconnect-button').hidden = true;
}

function openAccess() {
  shortcuts.reset();
  updateAccessControls();
  $('connection-message').textContent = 'Owner sign-in is not configured yet. You can browse, copy, and validate JSON; submitting is disabled until account access is connected.';
  $('connect-dialog').showModal();
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
  variationIndex = catalog[themeIndex].variations.findIndex(variation => variation.id === event.target.value);
  renderSelection();
});
$('copy-theme').addEventListener('click', () => copyTheme(true));
$('copy-theme-name').addEventListener('click', () => copyTheme(false));
$('copy-variation').addEventListener('click', () => copyValue(catalog[themeIndex]?.variations[variationIndex]?.name, 'Variation name'));
$('copy-prompt').addEventListener('click', copyPrompt);
document.addEventListener('keydown', event => shortcuts.handle(event));
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
$('close-connect').addEventListener('click', () => $('connect-dialog').close());
$('connect-dialog').addEventListener('close', () => shortcuts.reset());
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
  if (document.hidden) clearTimeout(pollTimer);
  else schedulePoll(1000);
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
window.addEventListener('pagehide', () => { client.disconnect(); clearTimeout(pollTimer); });

setView(location.hash.slice(1));
setInputMode('paste');
updateAccessControls();
renderActivity();
if (receipts[0]) showSubmission(receipts[0]);
try { await loadPublishedCatalog(); }
catch (error) { $('prompt-output').textContent = error.message || 'The collection could not be loaded. Refresh this page to try again.'; }
updateButtons();
schedulePoll(1000);
