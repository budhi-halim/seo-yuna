/** The shared, dependency-free catalog contract for the browser and the importer. */
// GitHub's Contents API supports files up to 100 MB. Use decimal bytes so this
// boundary also stays below GitHub's 100 MiB repository-file ceiling.
export const MAX_IMPORT_BYTES = 100_000_000;
export const MAX_CATALOG_BYTES = MAX_IMPORT_BYTES;
export const MAX_ID_LENGTH = 160;
export const MAX_NAME_LENGTH = 240;
export const MAX_PROMPT_LENGTH = 40_000;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THEME_KEYS = ['id', 'name', 'variations'];
const VARIATION_KEYS = ['id', 'name', 'prompt'];

export class CatalogError extends Error {
  constructor(message, { code = 'invalid_catalog', path = 'catalog' } = {}) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.path = path;
  }
}

function reject(message, path, code = 'invalid_catalog') {
  throw new CatalogError(message, { code, path });
}

/** Count UTF-8 without allocating another copy; stop after maximum is exceeded. */
export function utf8ByteLength(text, maximum = Infinity) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3; // TextEncoder replaces each unpaired surrogate with U+FFFD.
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

/** A caller may impose a smaller budget, but cannot bypass the provider limit. */
export function importByteLimit(maximumBytes = MAX_IMPORT_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_IMPORT_BYTES) {
    throw new RangeError('The JSON byte budget must be between 1 and 100,000,000 bytes.');
  }
  return maximumBytes;
}

function jsonStringBytes(text, maximum) {
  let bytes = 2; // The opening and closing quotes.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

/**
 * Measure a validated catalog before allocating its serialized representation.
 * Compact mode matches JSON.stringify(catalog). Pretty mode matches the stored
 * JSON.stringify(catalog, null, 2) + '\n', including its final newline.
 * A bounded measurement can return early once the maximum is exceeded.
 */
export function measureCatalogBytes(catalog, { pretty = false, maximum = Infinity } = {}) {
  let bytes = pretty ? 1 : 0;
  function visit(value, depth) {
    if (typeof value === 'string') {
      bytes += jsonStringBytes(value, maximum - bytes);
      return;
    }
    const array = Array.isArray(value);
    const entries = array ? value : Object.keys(value);
    bytes += 2; // The brackets or braces.
    for (let index = 0; index < entries.length && bytes <= maximum; index += 1) {
      if (index) bytes += 1;
      if (pretty) bytes += 1 + (depth + 1) * 2;
      if (array) visit(entries[index], depth + 1);
      else {
        const key = entries[index];
        bytes += jsonStringBytes(key, maximum - bytes) + (pretty ? 2 : 1);
        if (bytes <= maximum) visit(value[key], depth + 1);
      }
    }
    if (pretty && entries.length) bytes += 1 + depth * 2;
  }
  visit(catalog, 0);
  return bytes;
}

function record(value, keys, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(path + ' must be an object.', path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject(path + ' must be a plain object.', path);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => !keys.includes(key))) {
    reject(path + ' contains an unknown field.', path, 'unknown_field');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      reject(path + '.' + key + ' is required as a plain value.', path + '.' + key);
    }
  }
}

function identifier(value, path) {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    reject(
      path + ' must contain lowercase letters or digits separated by single hyphens, with at most 160 characters.',
      path,
      'invalid_id',
    );
  }
}

function nonemptyText(value, maximum, path) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    reject(path + ' must be nonempty text with at most ' + maximum + ' characters.', path, 'invalid_text');
  }
}

/**
 * Validate the exact source schema, without normalizing any name or prompt.
 * Empty arrays and legacy themes with fewer than eight variations remain valid.
 * Returns the original value so callers can retain the original parsed catalog.
 */
export function validateCatalog(value) {
  if (!Array.isArray(value)) reject('The catalog must be a JSON array of themes.', 'catalog');
  const themes = new Set();
  const variations = new Set();
  Array.from(value).forEach((theme, themeIndex) => {
    const themePath = 'catalog[' + themeIndex + ']';
    record(theme, THEME_KEYS, themePath);
    identifier(theme.id, themePath + '.id');
    nonemptyText(theme.name, MAX_NAME_LENGTH, themePath + '.name');
    if (themes.has(theme.id)) {
      reject('The catalog contains a repeated theme ID.', themePath + '.id', 'duplicate_theme_id');
    }
    themes.add(theme.id);
    if (!Array.isArray(theme.variations)) {
      reject(themePath + '.variations must be an array.', themePath + '.variations');
    }
    Array.from(theme.variations).forEach((variation, variationIndex) => {
      const variationPath = themePath + '.variations[' + variationIndex + ']';
      record(variation, VARIATION_KEYS, variationPath);
      identifier(variation.id, variationPath + '.id');
      nonemptyText(variation.name, MAX_NAME_LENGTH, variationPath + '.name');
      nonemptyText(variation.prompt, MAX_PROMPT_LENGTH, variationPath + '.prompt');
      if (variations.has(variation.id)) {
        reject('Variation IDs must be unique across the entire catalog.', variationPath + '.id', 'duplicate_variation_id');
      }
      variations.add(variation.id);
    });
  });
  return value;
}

/** Parse an upload, with the application limit measured in UTF-8 bytes. */
export function parseCatalog(text, { maximumBytes = MAX_IMPORT_BYTES } = {}) {
  const maximum = importByteLimit(maximumBytes);
  if (typeof text !== 'string') reject('The JSON upload must be text.', 'catalog', 'invalid_json');
  if (text.length > maximum || utf8ByteLength(text, maximum) > maximum) {
    reject('The JSON upload exceeds the ' + maximum.toLocaleString('en-US') + ' UTF-8 byte budget (100 MB GitHub maximum).', 'catalog', 'import_too_large');
  }
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    reject('The upload is not valid JSON.', 'catalog', 'invalid_json');
  }
  return validateCatalog(value);
}

function copyVariation(variation) {
  return { id: variation.id, name: variation.name, prompt: variation.prompt };
}

function copyTheme(theme) {
  return { id: theme.id, name: theme.name, variations: theme.variations.map(copyVariation) };
}

/**
 * Append only. Neither input is mutated, even if a conflict is found late.
 * An existing ID may be repeated only with exactly the same original content.
 */
export function mergeCatalog(current, incoming) {
  return mergeCatalogBatches(current, [incoming]);
}

/**
 * Merge a stream of independently valid catalogs using one set of indexes.
 * All copied state stays local until success; a failure never changes an input.
 * Conflicts include batchIndex so file import can identify the offending file.
 */
export function mergeCatalogBatches(current, batches) {
  validateCatalog(current);
  const catalog = current.map(copyTheme);
  const themes = new Map(catalog.map((theme) => [theme.id, theme]));
  const variations = new Map();
  for (const theme of catalog) {
    for (const variation of theme.variations) {
      variations.set(variation.id, { themeId: theme.id, variation });
    }
  }
  let addedThemes = 0;
  let addedVariations = 0;
  let duplicateVariations = 0;
  const originalThemeIds = new Set(themes.keys());
  const extendedThemeIds = new Set();

  let batchIndex = 0;
  for (const incoming of batches) {
    try {
      validateCatalog(incoming);
      incoming.forEach((incomingTheme, themeIndex) => {
        const themePath = 'catalog[' + themeIndex + ']';
        let destination = themes.get(incomingTheme.id);
        if (destination && destination.name !== incomingTheme.name) {
          reject('An existing theme ID has a different name. Existing themes cannot be overwritten.', themePath + '.name', 'theme_conflict');
        }
        if (!destination) {
          destination = { id: incomingTheme.id, name: incomingTheme.name, variations: [] };
          themes.set(destination.id, destination);
          catalog.push(destination);
          addedThemes += 1;
        }
        let additionsToTheme = 0;
        incomingTheme.variations.forEach((incomingVariation, variationIndex) => {
          const variationPath = themePath + '.variations[' + variationIndex + ']';
          const existing = variations.get(incomingVariation.id);
          if (existing) {
            if (existing.themeId !== incomingTheme.id) {
              reject('An existing variation ID belongs to a different theme.', variationPath + '.id', 'variation_theme_conflict');
            }
            if (existing.variation.name !== incomingVariation.name || existing.variation.prompt !== incomingVariation.prompt) {
              reject('An existing variation ID has different content. Existing variations cannot be overwritten.', variationPath, 'variation_conflict');
            }
            duplicateVariations += 1;
            return;
          }
          const variation = copyVariation(incomingVariation);
          destination.variations.push(variation);
          variations.set(variation.id, { themeId: destination.id, variation });
          addedVariations += 1;
          additionsToTheme += 1;
        });
        if (originalThemeIds.has(incomingTheme.id) && additionsToTheme > 0) extendedThemeIds.add(incomingTheme.id);
      });
    } catch (error) {
      if (error instanceof CatalogError) error.batchIndex = batchIndex;
      throw error;
    }
    batchIndex += 1;
  }

  return {
    catalog,
    addedThemes,
    addedVariations,
    duplicateVariations,
    extendedThemes: extendedThemeIds.size,
    changed: addedThemes > 0 || addedVariations > 0,
  };
}
