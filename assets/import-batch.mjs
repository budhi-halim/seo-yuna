import {
  MAX_IMPORT_BYTES, importByteLimit, parseCatalog, mergeCatalogBatches, measureCatalogBytes, utf8ByteLength,
} from './catalog.mjs';

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
export function buildFileBatch(files, { maximumBytes = MAX_IMPORT_BYTES } = {}) {
  const maximum = importByteLimit(maximumBytes);
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

  const summaries = [];
  let totalBytes = 0;

  // Yield one parsed file at a time. The shared merge maintains its indexes, so
  // appending hundreds of files does not repeatedly clone the growing catalog.
  function* catalogs() {
    for (const file of ordered) {
      try {
        const parsed = parseCatalog(file.text, { maximumBytes: maximum });
        const bytes = utf8ByteLength(file.text);
        totalBytes += bytes;
        if (totalBytes > maximum) {
          throw new ImportBatchError('The selected files together exceed the ' + maximum.toLocaleString('en-US') + ' UTF-8 byte batch budget (100 MB GitHub maximum). Select fewer files or split the batch.', { code: 'batch_too_large' });
        }
        const variations = parsed.reduce((count, theme) => count + theme.variations.length, 0);
        if (!parsed.length || !variations) {
          throw new ImportBatchError('Each file must contain at least one theme with a variation.', { code: 'empty_file' });
        }
        summaries.push({ name: file.name, bytes, themes: parsed.length, variations });
        yield parsed;
      } catch (error) {
        throw forFile(file.name, error);
      }
    }
  }
  let result;
  try {
    result = mergeCatalogBatches([], catalogs());
  } catch (error) {
    if (Number.isInteger(error.batchIndex)) throw forFile(ordered[error.batchIndex].name, error);
    throw error;
  }
  const incoming = result.catalog;
  if (measureCatalogBytes(incoming, { maximum }) > maximum) {
    throw new ImportBatchError('The combined JSON payload exceeds the ' + maximum.toLocaleString('en-US') + ' UTF-8 byte batch budget (100 MB GitHub maximum). Select fewer files or split the batch.', { code: 'payload_too_large' });
  }
  const source = JSON.stringify(incoming);
  return { source, incoming, files: summaries, duplicateVariationsAcrossFiles: result.duplicateVariations };
}
