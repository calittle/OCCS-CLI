export const DEFAULT_REQUEST_TIMEOUT_MS = 360000;

let defaultRequestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

export function resolveRequestTimeoutMs(value = undefined) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultRequestTimeoutMs;
  }

  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid --timeout value. Provide a positive number of milliseconds (for example 360000).');
  }
  return Math.floor(timeout);
}

export function setDefaultRequestTimeoutMs(value = undefined) {
  defaultRequestTimeoutMs = resolveRequestTimeoutMs(value);
  return defaultRequestTimeoutMs;
}
