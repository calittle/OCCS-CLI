import { paginate } from './api.js';

// CCS supports `lk` filtering on ShortName.  Keep the exact-name check here:
// `lk` is deliberately broad enough to tolerate CCS's search behavior, but a
// targeted download must never silently select a similarly named artifact.
export async function findArtifactByShortName(session, endpoint, shortNamePath, requestedName, summarize, opts = {}) {
  const name = String(requestedName || '').trim();
  if (!name) throw new Error('A short name is required.');

  const records = await paginate(
    session,
    endpoint,
    {
      depth: true,
      summary: true,
      totalResults: true,
      whr: JSON.stringify({ a: [{ t: [shortNamePath, 'lk', `%${name}%`] }] }),
    },
    opts.limit || 49,
    opts.verbose,
    { timeout: opts.timeout }
  );
  const matches = records.filter((item) => String(summarize(item).shortName || '').toLowerCase() === name.toLowerCase());

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Artifact short name is ambiguous: ${name}`);

  const candidates = records.map((item) => summarize(item).shortName).filter(Boolean);
  const hint = candidates.length ? ` Matching names: ${candidates.join(', ')}.` : '';
  throw new Error(`Artifact not found with short name: ${name}.${hint}`);
}

// Older CCS responses occasionally omit Status. Treat those records as usable;
// when CCS does provide status history, only an explicitly Active version is
// included by a targeted get command.
export function activeVersions(entries, recordKey) {
  return (entries || []).filter((entry) => {
    const record = entry?.[recordKey] || entry || {};
    const statuses = record.Status?.Items || record.Status || [];
    const values = Array.isArray(statuses) ? statuses : [statuses];
    return values.length === 0 || values.some((status) => String(status?.StatusCode || status?.Code || status).toLowerCase() === 'active');
  });
}
