/** The shared, dependency-free catalog contract for the browser and the importer. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
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
export function parseCatalog(text) {
  if (typeof text !== 'string') reject('The JSON upload must be text.', 'catalog', 'invalid_json');
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    reject('The JSON upload exceeds the 5 MiB limit.', 'catalog', 'import_too_large');
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
  validateCatalog(current);
  validateCatalog(incoming);
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
  let extendedThemes = 0;

  incoming.forEach((incomingTheme, themeIndex) => {
    const themePath = 'catalog[' + themeIndex + ']';
    let destination = themes.get(incomingTheme.id);
    const existed = Boolean(destination);
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
    if (existed && additionsToTheme > 0) extendedThemes += 1;
  });

  return {
    catalog,
    addedThemes,
    addedVariations,
    duplicateVariations,
    extendedThemes,
    changed: addedThemes > 0 || addedVariations > 0,
  };
}
