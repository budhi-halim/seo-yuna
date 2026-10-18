function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Filter original numbered labels without renumbering or changing selection. */
export function searchNumberedEntries(entries, query, selectedId) {
  const normalized = normalize(query);
  // A leading number addresses its exact displayed position: 2 is distinct from 12.
  const numbered = normalized.match(/^(\d+)(?:\.\s*|\s+|$)(.*)$/u);
  const position = numbered ? Number(numbered[1]) : null;
  const terms = (numbered ? numbered[2] : normalized).split(' ').filter(Boolean);
  const choices = entries.map((entry, index) => ({
    id: entry.id,
    index,
    label: `${index + 1}. ${entry.name}`,
  }));
  const matches = choices.filter(choice => (position === null || choice.index + 1 === position) &&
    terms.every(term => normalize(choice.label).includes(term)));
  const current = choices.find(choice => choice.id === selectedId) ?? null;
  return {
    active: normalized.length > 0,
    matches,
    // Keep the real selection visible when the filter does not match it.
    retained: current && !matches.some(choice => choice.id === current.id) ? current : null,
  };
}
