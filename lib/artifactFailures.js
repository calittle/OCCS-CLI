import { get } from './api.js';

export function createArtifactFailureReport() {
  const failures = [];
  return {
    add(endpoint, error) {
      failures.push({ endpoint, status: error?.response?.status || 'request' });
    },
    print() {
      if (!failures.length) return;
      const groups = new Map();
      for (const failure of failures) {
        const group = groups.get(failure.status) || [];
        group.push(failure.endpoint);
        groups.set(failure.status, group);
      }
      console.warn(`\n⚠ Artifact download failures (${failures.length}):`);
      for (const [status, endpoints] of groups) {
        console.warn(`  ${status} (${endpoints.length})`);
        for (const endpoint of endpoints) console.warn(`    - ${endpoint}`);
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
    if (ignoreNotFound && status === 404) return undefined;
    console.warn(`⚠ Skipped artifact (${status}): ${endpoint}`);
    report?.add(endpoint, error);
    return null;
  }
}
