import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEmailRecipientOverride } from '../lib/emailRecipients.js';

test('notification recipient override preserves data and leaves source unchanged', () => {
  const input = {sendDetail: {deliveryInfo: {contactValue: 'original@example.test', deliveryType: 'EMAI', templateName: 'test'}, templateParm: [{key: 'name', value: 'Example'}]}, other: [1]};
  const original = structuredClone(input);
  const result = applyEmailRecipientOverride(input, ['test@example.test']);
  assert.equal(result.sendDetail.deliveryInfo.contactValue, 'test@example.test');
  result.sendDetail.deliveryInfo.contactValue = 'original@example.test';
  assert.deepEqual(result, original);
  assert.deepEqual(input, original);
  assert.equal(Object.hasOwn(result, 'billPrint'), false);
});

test('notification recipient override requires a delivery object and one address', () => {
  for (const sendDetail of [null, [], {}, {deliveryInfo: []}, {deliveryInfo: 'invalid'}]) {
    assert.throws(() => applyEmailRecipientOverride({sendDetail}, ['test@example.test']), /sendDetail.deliveryInfo/);
  }
  assert.throws(() => applyEmailRecipientOverride({sendDetail: {deliveryInfo: {}}}, ['a@example.test', 'b@example.test']), /exactly one/);
});

test('no override preserves existing notification recipient', () => {
  const input = {sendDetail: {deliveryInfo: {contactValue: 'original@example.test'}}};
  assert.strictEqual(applyEmailRecipientOverride(input, []), input);
});

test('ebill override still supports multiple recipients and preserves sender', () => {
  const input = {billPrint: {billDetails: {cmElements: {eBill: {senderEmail: 'sender@example.test'}}}}};
  const result = applyEmailRecipientOverride(input, ['a@example.test', 'b@example.test']);
  assert.deepEqual(result.billPrint.billDetails.cmElements.eBill, {senderEmail: 'sender@example.test', recipientEmails: [{email: 'a@example.test'}, {email: 'b@example.test'}]});
  assert.equal(input.billPrint.billDetails.cmElements.eBill.recipientEmails, undefined);
  assert.throws(() => applyEmailRecipientOverride({}, ['a@example.test']), /billPrint/);
});
