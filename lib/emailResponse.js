/** A transport-level 2xx can still contain a rejected Communication detail. */
export function validateEmailResponse(body, httpStatus) {
  const reasons = new Set();
  const ids = new Set();
  let failed = false;
  let manualReview = false;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if ((normalized === 'success' || normalized === 'ok') && item === false) failed = true;
      if (normalized === 'consolidatedresponsestatus' && /^(error|failed|failure|rejected|invalid)$/i.test(String(item))) failed = true;
      if (normalized === 'consolidatedmanualreviewrequiredind' && (item === true || /^(true|y|yes)$/i.test(String(item)))) manualReview = true;
      if ((normalized === 'error' || normalized === 'failurereason') && typeof item === 'string' && item.trim()) {
        reasons.add(item.trim()); failed = true;
      }
      if (normalized === 'executionid' && typeof item === 'string') ids.add(item);
      if (normalized === 'error' && item?.message) { reasons.add(String(item.message)); failed = true; }
      visit(item);
    }
  }
  visit(body);
  if (!failed && !manualReview && body && typeof body === 'object') return;
  if (!body || typeof body !== 'object') reasons.add('Comms returned no readable result; acceptance is unconfirmed.');
  if (!reasons.size && body?.message) reasons.add(String(body.message));
  if (!reasons.size) reasons.add(manualReview ? 'Comms requires manual review.' : 'Comms reported an error processing the email.');
  let message = `Email request failed: ${[...reasons].join('; ')}`;
  if (manualReview && !message.toLowerCase().includes('manual review')) message += ' Manual review required.';
  if (ids.size) message += ` Execution ID: ${[...ids].join(', ')}.`;
  message += ` (HTTP ${httpStatus}.)`;
  const error = new Error(message);
  error.name = 'EmailBusinessError';
  throw error;
}
