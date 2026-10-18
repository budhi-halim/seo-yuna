export const RECEIPTS_KEY = 'seo-yuna:imports:v1';
const STATES = new Set(['submitting', 'unknown', 'accepted', 'queued', 'running', 'publishing', 'published', 'saved', 'failed', 'rejected']);

// An explicit allow-list keeps tokens and imported prompt text out of browser storage.
export function publicReceipt(record) {
  if (!record || !/^[A-Za-z0-9_-]{1,100}$/.test(record.requestId ?? '') ||
      !/^[a-f0-9]{40}$/.test(record.blobSha ?? '') || !/^[a-f0-9]{64}$/.test(record.digest ?? '') ||
      !Number.isFinite(Date.parse(record.createdAt))) return null;
  const number = (value, maximum) => Math.max(0, Math.min(maximum, Number(value) || 0));
  const runId = Number(record.runId);
  return {
    requestId: record.requestId, blobSha: record.blobSha, digest: record.digest,
    createdAt: new Date(record.createdAt).toISOString(),
    runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
    state: STATES.has(record.state) ? record.state : 'unknown',
    title: String(record.title ?? 'Checking submission').slice(0, 100),
    detail: String(record.detail ?? '').slice(0, 800),
    progress: number(record.progress, 100), safe: record.safe === true,
    terminal: record.terminal === true,
    themeCount: number(record.themeCount, 100000), variationCount: number(record.variationCount, 1000000),
    checkedAt: Number.isFinite(Date.parse(record.checkedAt)) ? new Date(record.checkedAt).toISOString() : null,
  };
}

export function readReceipts(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(RECEIPTS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(publicReceipt).filter(Boolean).slice(0, 120).map(record => record.state === 'submitting'
      ? { ...record, state: 'unknown', title: 'Checking acceptance', detail: 'This page closed before acceptance was confirmed. Check GitHub for the matching run before retrying.', safe: false, terminal: false }
      : record);
  } catch { return []; }
}

export function writeReceipts(storage, records) {
  try {
    storage.setItem(RECEIPTS_KEY, JSON.stringify(records.map(publicReceipt).filter(Boolean).slice(0, 120)));
    return true;
  } catch { return false; }
}
