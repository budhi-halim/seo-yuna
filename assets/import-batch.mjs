import { MAX_IMPORT_BYTES, parseCatalog, mergeCatalog } from './catalog.mjs';

/** A batch failure is always plain text; the caller must render it as text. */
export class ImportBatchError extends Error {
  constructor(message, { code = 'invalid_file_batch', filename = null, path = null } = {}) {
    super(message);
    this.name = 'ImportBatchError';
    this.code = code;
    this.filename = filename;
    this.path = path;
  }
}

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function numericRun(value) {
  return value.replace(/^0+/, '') || '0';
}

function compareNames(left, right) {
  const leftParts = left.toLowerCase().match(/[0-9]+|[^0-9]+/g);
  const rightParts = right.toLowerCase().match(/[0-9]+|[^0-9]+/g);
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    let difference;
    if (/^[0-9]/.test(leftPart) && /^[0-9]/.test(rightPart)) {
      // Compare arbitrary-length integers without floating-point conversion.
      const leftNumber = numericRun(leftPart);
      const rightNumber = numericRun(rightPart);
      difference = leftNumber.length - rightNumber.length || lexical(leftNumber, rightNumber);
    } else {
      difference = lexical(leftPart, rightPart);
    }
    if (difference) return difference;
  }
  // Only break case/zero-padding ties after every natural component ties.
  return leftParts.length - rightParts.length || lexical(left, right);
}

/**
 * Return a new array in deterministic, locale-independent natural name order.
 * Text compares without case; digit runs compare numerically; full original
 * names provide the final lexical tie-break. File-like objects are not changed.
 */
export function sortFiles(files) {
  if (files === null || files === undefined || typeof files[Symbol.iterator] !== 'function') {
    throw new ImportBatchError('Choose JSON files to create a batch.');
  }
  const entries = Array.from(files, file => {
    if (file === null || typeof file !== 'object' || typeof file.name !== 'string' || !file.name.length) {
      throw new ImportBatchError('Every selected file must have a nonempty filename.', { code: 'invalid_filename' });
    }
    return { file, name: file.name };
  });
  entries.sort((left, right) => compareNames(left.name, right.name));
  return entries.map(entry => entry.file);
}

function forFile(filename, error) {
  return new ImportBatchError(`File ${JSON.stringify(filename)}: ${error.message}`, {
    code: error.code ?? 'invalid_file_batch',
    filename,
    path: error.path ?? null,
  });
}

/**
 * Parse every selected file separately, then append in filename order.
 * No partial batch is returned: any invalid file, conflict, or size failure
 * rejects the entire operation. The result is one valid JSON array for upload.
 */
export function buildFileBatch(files) {
  const ordered = sortFiles(files);
  if (!ordered.length) throw new ImportBatchError('Choose at least one JSON file.');

  const names = new Set();
  for (const file of ordered) {
    if (names.has(file.name)) {
      throw forFile(file.name, new ImportBatchError('This filename is selected more than once. Rename the files so their order is unambiguous.', { code: 'duplicate_filename' }));
    }
    names.add(file.name);
    if (!/\.json$/i.test(file.name)) {
      throw forFile(file.name, new ImportBatchError('Choose a file with the .json extension.', { code: 'invalid_extension' }));
    }
  }

  const encoder = new TextEncoder();
  const summaries = [];
  let incoming = [];
  let totalBytes = 0;
  let duplicateVariationsAcrossFiles = 0;

  for (const file of ordered) {
    try {
      const parsed = parseCatalog(file.text);
      const bytes = encoder.encode(file.text).byteLength;
      totalBytes += bytes;
      if (totalBytes > MAX_IMPORT_BYTES) {
        throw new ImportBatchError('The selected files together exceed the 5 MiB batch limit. Select fewer files or split the batch.', { code: 'batch_too_large' });
      }
      const variations = parsed.reduce((count, theme) => count + theme.variations.length, 0);
      if (!parsed.length || !variations) {
        throw new ImportBatchError('Each file must contain at least one theme with a variation.', { code: 'empty_file' });
      }
      const merged = mergeCatalog(incoming, parsed);
      incoming = merged.catalog;
      duplicateVariationsAcrossFiles += merged.duplicateVariations;
      summaries.push({ name: file.name, bytes, themes: parsed.length, variations });
    } catch (error) {
      throw forFile(file.name, error);
    }
  }

  const source = JSON.stringify(incoming);
  if (encoder.encode(source).byteLength > MAX_IMPORT_BYTES) {
    throw new ImportBatchError('The combined JSON payload exceeds the 5 MiB batch limit. Select fewer files or split the batch.', { code: 'payload_too_large' });
  }
  return { source, incoming, files: summaries, duplicateVariationsAcrossFiles };
}
