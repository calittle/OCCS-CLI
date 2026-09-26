import { get } from './api.js';

export function createArtifactFailureReport() {
  const failures = [];
  const ignoredFailures = [];
  return {
    add(endpoint, error) {
      failures.push({ endpoint, status: error?.response?.status || 'request' });
    },
    addIgnored(endpoint, error) {
      ignoredFailures.push({ endpoint, status: error?.response?.status || 'request' });
    },
    print() {
      for (const [label, entries] of [['Artifact download failures', failures], ['Ignored artifact download failures', ignoredFailures]]) {
        if (!entries.length) continue;
        const groups = new Map();
        for (const failure of entries) {
          const group = groups.get(failure.status) || [];
          group.push(failure.endpoint);
          groups.set(failure.status, group);
        }
        console.warn(`\n⚠ ${label} (${entries.length}):`);
        for (const [status, endpoints] of groups) {
          console.warn(`  ${status} (${endpoints.length})`);
          for (const endpoint of endpoints) console.warn(`    - ${endpoint}`);
        }
      }
    },
    get count() { return failures.length; },
  };
}

export async function getArtifact(session, endpoint, params, verbose, report, { ignoreNotFound = false } = {}) {
  try {
    return await get(session, endpoint, params, verbose, { throwOnError: true });
  } catch (error) {
    const status = error.response?.status || 'request';
    // `undefined` distinguishes an intentionally ignored response from a
    // failed request (`null`) without changing existing callers.
    if (ignoreNotFound && status === 404) {
      console.warn(`⚠ Ignored artifact (${status}): ${endpoint}`);
      report?.addIgnored(endpoint, error);
      return undefined;
    }
    console.warn(`⚠ Skipped artifact (${status}): ${endpoint}`);
    report?.add(endpoint, error);
    return null;
  }
}
