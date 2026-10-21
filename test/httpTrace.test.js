import assert from 'node:assert/strict';
import test from 'node:test';
import { HTTP_TRACE_PREFIX, sanitizeHttpValue, tracedHttp, maskEmailAddress } from '../lib/httpTrace.js';

function capture(t, enabled = '1') {
  const previous = process.env.OCCS_HTTP_DEBUG;
  process.env.OCCS_HTTP_DEBUG = enabled;
  const write = process.stderr.write;
  const lines = [];
  process.stderr.write = function (value) { lines.push(String(value)); return true; };
  t.after(() => {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.OCCS_HTTP_DEBUG; else process.env.OCCS_HTTP_DEBUG = previous;
  });
  return lines;
}

test('sanitizes nested and JSON-encoded mapped data but keeps routing fields', () => {
  const value = sanitizeHttpValue({
    headers: { Authorization: 'Bearer TOKEN', 'Set-Cookie': 'session=COOKIE' },
    CommunicationInfo: {
      CommunicationConfigUuid: 'COMM-ID', CommunicationUserDefinedTransactionType: 'RealTime_Email',
      CommunicationData: JSON.stringify({ sendDetail: { deliveryInfo: { contactValue: 'customer@example.test', firstName: 'Alice' }, accountId: 12345 } }),
    },
    AssemblyRenderOutput: 'BASE64-CUSTOMER-DOCUMENT',
  });
  const text = JSON.stringify(value);
  for (const secret of ['TOKEN', 'COOKIE', 'customer@example.test', 'Alice', '12345', 'BASE64-CUSTOMER-DOCUMENT']) assert.equal(text.includes(secret), false);
  assert.equal(value.CommunicationInfo.CommunicationConfigUuid, 'COMM-ID');
  assert.equal(JSON.parse(value.CommunicationInfo.CommunicationData).sendDetail.accountId, '[masked: number, 5 chars]');
});

test('emits correlated request and successful JSON response without modifying them', async t => {
  const lines = capture(t);
  const data = { success: true, executionId: 'EXEC-ID' };
  const response = { status: 200, headers: { 'set-cookie': 'SECRET' }, data: Buffer.from(JSON.stringify(data)) };
  const config = { method: 'POST', url: 'https://user:password@example.invalid/api/Communication?token=URL-SECRET', headers: { Authorization: 'Bearer HEADER-SECRET' }, data: { test: true } };
  const result = await tracedHttp(config, async () => response);
  assert.equal(result, response);
  assert.equal(config.headers.Authorization, 'Bearer HEADER-SECRET');
  const events = lines.map(line => JSON.parse(line.slice(HTTP_TRACE_PREFIX.length)));
  assert.equal(events.length, 2);
  assert.equal(events[0].id, events[1].id);
  assert.equal(events[0].method, 'POST');
  assert.equal(events[1].status, 200);
  assert.deepEqual(events[1].body, data);
  assert.equal(lines.join('').includes('SECRET'), false);
  assert.equal(lines.join('').includes('user:password'), false);
  const signed = sanitizeHttpValue('See https://example.invalid/p/PRIVATE-PAR/n/ns/b/bucket/o/test?signature=SIGNED-SECRET');
  assert.equal(signed.includes('PRIVATE-PAR'), false);
  assert.equal(signed.includes('SIGNED-SECRET'), false);
});

test('dumps HTTP errors and network errors without exposing Axios request internals', async t => {
  const lines = capture(t);
  const error = Object.assign(new Error('API failure for customer@example.test'), {
    response: { status: 400, headers: {}, data: { messageCode: 'SFD0671', message: 'BucketNotFound', contactValue: 'secret-contact' } },
    config: { password: 'AXIOS-SECRET' },
  });
  await assert.rejects(tracedHttp({ url: 'https://example.invalid/api' }, async () => { throw error; }), e => e === error);
  const response = JSON.parse(lines[1].slice(HTTP_TRACE_PREFIX.length));
  assert.equal(response.status, 400);
  assert.equal(response.body.messageCode, 'SFD0671');
  assert.equal(lines.join('').includes('secret-contact'), false);
  assert.equal(lines.join('').includes('AXIOS-SECRET'), false);
  assert.equal(lines.join('').includes('customer@example.test'), false);
  const network = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
  await assert.rejects(tracedHttp({ url: 'https://example.invalid' }, async () => { throw network; }));
  const failure = JSON.parse(lines.at(-1).slice(HTTP_TRACE_PREFIX.length));
  assert.equal(failure.status, null);
  assert.equal(failure.error.code, 'ECONNREFUSED');
});

test('is silent with debug off and summarizes binary or oversized bodies', async t => {
  const lines = capture(t, '0');
  await tracedHttp({}, async () => ({ status: 200 }));
  assert.equal(lines.length, 0);
  assert.match(sanitizeHttpValue(Buffer.from('<html>PRIVATE</html>')), /omitted: non-JSON body/);
  assert.match(sanitizeHttpValue(Buffer.alloc(300000)), /exceeds 256 KiB/);
});

test('addresses retain diagnostic prefixes/domains and empty or malformed values are explicit', () => {
  assert.equal(maskEmailAddress('customer@example.test'), 'cu***@example.test');
  assert.equal(maskEmailAddress('cu***@example.test'), 'cu***@example.test');
  assert.equal(maskEmailAddress(''), '[empty address]');
  assert.equal(maskEmailAddress(null), null);
  assert.match(maskEmailAddress('not-an-address'), /invalid address: 14 chars.*no @/);
  assert.match(maskEmailAddress('a@'), /invalid address.*contains @/);
  const raw = { CommunicationData: JSON.stringify({ sendDetail: {
    deliveryInfo: { contactValue: 'customer@example.test', templateName: 'CO-G10-CO63', deliveryType: 'EMAI', firstName: 'Alice' },
    templateParm: [{ key: 'SEND_AT_VALUE', value: '12' }],
  } }) };
  const masked = sanitizeHttpValue(raw);
  const data = JSON.parse(masked.CommunicationData).sendDetail;
  assert.equal(data.deliveryInfo.contactValue, 'cu***@example.test');
  assert.equal(data.deliveryInfo.templateName, 'CO-G10-CO63');
  assert.equal(data.deliveryInfo.deliveryType, 'EMAI');
  assert.equal(data.templateParm[0].key, 'SEND_AT_VALUE');
  assert.equal(data.templateParm[0].value, '[masked: string, 2 chars]');
  assert.equal(JSON.stringify(masked).includes('Alice'), false);
  assert.deepEqual(sanitizeHttpValue(masked), masked, 'The Activity layer must not erase already masked context');
});
