import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEmailResponse } from '../lib/emailResponse.js';

const rejected = {
  CommunicationRec: { CommunicationUuid: 'COMM-INSTANCE' },
  CommunicationDetailRec: { CommunicationDetailInfo: {
    ConsolidatedStandardResponse: { ConsolidatedResponseStatus: 'Error', ConsolidatedManualReviewRequiredInd: true },
  } },
  Messages: [{ ExecutionId: 'EXECUTION-ID' }, { Error: 'Does not contain a valid address.' }],
};

test('HTTP 201 with the captured invalid-address business result is a failure', () => {
  assert.throws(() => validateEmailResponse(rejected, 201), error => {
    assert.equal(error.name, 'EmailBusinessError');
    assert.match(error.message, /Does not contain a valid address/);
    assert.match(error.message, /Manual review required/);
    assert.match(error.message, /EXECUTION-ID/);
    assert.match(error.message, /HTTP 201/);
    return true;
  });
});

test('manual review, error messages, explicit failure and unreadable results are not accepted', () => {
  for (const body of [
    { ConsolidatedStandardResponse: { ConsolidatedManualReviewRequiredInd: true } },
    { Messages: [{ Error: 'Invalid recipient' }] },
    { success: false, message: 'Rejected' },
    { ok: false, error: { message: 'Rejected' } },
    null,
  ]) assert.throws(() => validateEmailResponse(body, 200), { name: 'EmailBusinessError' });
});

test('acceptance and pending non-error results are not claimed as delivery', () => {
  assert.doesNotThrow(() => validateEmailResponse({ success: true }, 201));
  assert.doesNotThrow(() => validateEmailResponse({ CommunicationRec: { CommunicationUuid: 'CREATED' },
    ConsolidatedStandardResponse: { ConsolidatedResponseStatus: 'Pending', ConsolidatedManualReviewRequiredInd: false } }, 201));
});
