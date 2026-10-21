import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { emailRoutes, resolveEmailRoute, buildEmailCommunicationBody, emailDistributionRoutes, explicitEmailRoute } from '../lib/emailRouting.js';
import { fetchEmailRoutes } from '../lib/emailRouteCatalog.js';

const master = (parent = 'COMMUNICATION-ID', transaction = 'RealTime_Email') => ({
  CommunicationConfigRec: { CommunicationConfigUuid: parent, CommunicationConfigInfo: { ShortName: 'RealTime_Email' } },
  CommunicationDetails: [{
    CommunicationDetailConfigRec: { CommunicationDetailConfigInfo: {
      CommunicationTransactionType: 'User Defined', CommunicationUserDefinedTransactionType: transaction,
    } },
    CommunicationProcesses: [{ CommunicationServices: [{
      CommunicationServiceConfigRec: { CommunicationServiceConfigInfo: { CommunicationServiceName: 'Email Creation' } },
      CommunicationServiceConfigCommunicationEmailConfigRelRec: {
        CommunicationServiceConfigCommunicationEmailConfigRelInfo: { CommunicationEmailConfigUuid: 'EMAIL-ID' },
      },
    }] }],
  }],
});

test('uses the configured relationship and transaction rather than a matching name or email UUID', () => {
  const route = emailRoutes(master(), 'EMAIL-ID')[0];
  assert.equal(route.communicationConfigUuid, 'COMMUNICATION-ID');
  assert.equal(route.userDefinedTransactionType, 'RealTime_Email');
  assert.deepEqual(buildEmailCommunicationBody(route, '{"test":1}'), {
    CommunicationInfo: {
      CommunicationConfigUuid: 'COMMUNICATION-ID', CommunicationTransactionType: 'User Defined',
      CommunicationUserDefinedTransactionType: 'RealTime_Email', CommunicationData: '{"test":1}',
    },
  });
  assert.deepEqual(emailRoutes(master(), 'UNLINKED-EMAIL'), []);
});

test('does not use inactive or future routes', () => {
  const value = master();
  value.CommunicationDetails[0].CommunicationDetailConfigRec.Status = {
    Items: [{ StatusCode: 'Inactive', EffDtTm: '2020-01-01T00:00:00Z' }],
  };
  assert.deepEqual(emailRoutes(value, 'EMAIL-ID'), []);
  value.CommunicationDetails[0].CommunicationDetailConfigRec.Status.Items = [
    { StatusCode: 'Active', EffDtTm: '2099-01-01T00:00:00Z' },
  ];
  assert.deepEqual(emailRoutes(value, 'EMAIL-ID'), []);
});

test('distribution lookup includes runtime-routed email services without Email UUID relationships', async () => {
  const value = master('21CDDA51E5FC49598D6FF6E7E36F36E4', 'Letter_DA_Email');
  const service = value.CommunicationDetails[0].CommunicationProcesses[0].CommunicationServices[0];
  delete service.CommunicationServiceConfigCommunicationEmailConfigRelRec;
  value.CommunicationConfigRec.CommunicationConfigInfo.ShortName = 'Letters';
  value.CommunicationDetails.push(structuredClone(value.CommunicationDetails[0]));
  value.CommunicationDetails[1].CommunicationDetailConfigRec.CommunicationDetailConfigInfo.CommunicationUserDefinedTransactionType = 'Other_Email';
  assert.equal(emailDistributionRoutes(value).length, 2);
  const result = await fetchEmailRoutes({ baseUrl: 'https://test.invalid/', sessionKey: 'test' }, {}, async (_s, endpoint) =>
    endpoint.endsWith('CommunicationConfigRec') ? { Items: [value.CommunicationConfigRec], HasMore: false } : value);
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0].userDefinedTransactionType, 'Letter_DA_Email');
  service.CommunicationServiceConfigRec.CommunicationServiceConfigInfo.CommunicationServiceName = 'Queue Distribution';
  assert.equal(emailDistributionRoutes(value).length, 1);
  assert.throws(() => explicitEmailRoute({ communicationConfigUuid: 'PARENT' }), /requires/);
});

test('resolver follows paginated Communication lists and refuses missing or ambiguous routes', async () => {
  const calls = [];
  const request = async (_session, endpoint, params, _verbose, options) => {
    calls.push({ endpoint, params, options });
    if (endpoint.endsWith('CommunicationConfigRec')) return {
      Items: [{ CommunicationConfigRec: { CommunicationConfigUuid: params.offset ? 'SECOND' : 'FIRST' } }],
      HasMore: !params.offset,
    };
    return master(endpoint.split('/').at(-1));
  };
  await assert.rejects(resolveEmailRoute({}, 'EMAIL-ID', { timeout: 1234 }, request), /multiple active routes/);
  assert.equal(calls[1].params.offset, 49);
  assert.equal(calls[0].options.timeout, 1234);
  await assert.rejects(resolveEmailRoute({}, 'OTHER', {}, request), /No active Communication route/);
});

function run(args, home, debug = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/occs.js', ...args], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, USERPROFILE: home, OCCS_HTTP_DEBUG: debug ? '1' : '0' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('preview EMAIL sends the resolved parent/transaction only, and never POSTs missing routes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-email-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bodies = [];
  let reads = 0;
  let linked = true;
  let businessError = false;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      assert.equal(request.url, '/api/Communication/v1/CommunicationRec');
      let body = '';
      request.on('data', data => { body += data; });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        response.statusCode = 201;
        response.end(JSON.stringify(businessError ? {
          CommunicationDetailRec: { CommunicationDetailInfo: { ConsolidatedStandardResponse: {
            ConsolidatedResponseStatus: 'Error', ConsolidatedManualReviewRequiredInd: true,
          } } },
          Messages: [{ ExecutionId: 'EXECUTION-REJECTED' }, { Error: 'Does not contain a valid address.' }],
        } : { success: true }));
      });
      return;
    }
    reads += 1;
    if (request.url.startsWith('/api/Communication/v1/CommunicationMasterConfig/')) {
      const value = master();
      if (!linked || !request.url.endsWith('/COMMUNICATION-ID')) value.CommunicationDetails = [];
      value.UnrelatedMetadata = 'x'.repeat(20000);
      response.end(JSON.stringify(value));
    } else response.end(JSON.stringify({ Items: Array.from({ length: 36 }, (_, index) => ({ CommunicationConfigRec: { CommunicationConfigUuid: index ? `OTHER-${index}` : 'COMMUNICATION-ID' } })), HasMore: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(home, '.occs-session.json'), JSON.stringify({
    customer: 'test', region: 'local', tenancy: 'non-prod', token: 'test-only', baseUrl: `http://127.0.0.1:${server.address().port}`,
  }));
  const input = path.join(home, 'input.json');
  fs.writeFileSync(input, JSON.stringify({ billPrint: { billDetails: { cmElements: {} } } }));
  const args = ['preview', '--input', input, '--render-type', 'EMAIL', '--email-config-uuid', 'EMAIL-ID',
    '--recipient', 'test@example.test', '--send-email', '--verbose'];
  const sent = await run(args, home, true);
  assert.equal(sent.code, 0, sent.stdout + sent.stderr);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].CommunicationInfo.CommunicationConfigUuid, 'COMMUNICATION-ID');
  assert.equal(bodies[0].CommunicationInfo.CommunicationUserDefinedTransactionType, 'RealTime_Email');
  assert.equal(JSON.parse(bodies[0].CommunicationInfo.CommunicationData).billPrint.billDetails.cmElements.eBill.recipientEmails[0].email, 'test@example.test');
  assert.match(sent.stdout, /Communication config UUID: COMMUNICATION-ID/);
  const traces = sent.stderr.split('\n').filter(line => line.startsWith('@OCCS_HTTP@')).map(line => JSON.parse(line.slice('@OCCS_HTTP@'.length)));
  const requestTrace = traces.find(event => event.type === 'request' && event.method === 'POST');
  assert.equal(requestTrace.body.CommunicationInfo.CommunicationConfigUuid, 'COMMUNICATION-ID');
  assert.equal(JSON.parse(requestTrace.body.CommunicationInfo.CommunicationData).billPrint.billDetails.cmElements.eBill.recipientEmails[0].email, 'te***@example.test');
  assert.equal(traces.find(event => event.type === 'response' && event.id === requestTrace.id).status, 201);
  assert.equal(sent.stderr.includes('test-only'), false);
  assert.equal(sent.stderr.includes('test@example.test'), false);

  assert.equal(traces.length, 2, 'Only the actual POST request and response should be dumped');
  assert.match(sent.stdout, /checked 36 configurations/);
  assert.ok(sent.stderr.length < 25000, `Unexpected diagnostic volume: ${sent.stderr.length}`);
  businessError = true;
  const rejected = await run(args, home, true);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /Does not contain a valid address/);
  assert.match(rejected.stderr, /Manual review required/);
  assert.match(rejected.stderr, /EXECUTION-REJECTED/);
  assert.doesNotMatch(rejected.stdout, /Email request accepted/);
  assert.equal(bodies.length, 2, 'A rejected 201 result must not trigger a second POST');
  linked = false;
  const failed = await run(args, home);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /No active Communication route/);
  assert.equal(bodies.length, 2);
  businessError = false;
  const directArgs = args.filter((value, index) => value !== '--email-config-uuid' && args[index - 1] !== '--email-config-uuid');
  const readsBeforeDirectSend = reads;
  const direct = await run([...directArgs,
    '--communication-config-uuid', '21CDDA51E5FC49598D6FF6E7E36F36E4',
    '--communication-transaction-type', 'User Defined',
    '--communication-user-defined-transaction-type', 'Letter_DA_Email'], home, true);
  assert.equal(direct.code, 0, direct.stdout + direct.stderr);
  assert.equal(bodies.length, 3);
  assert.equal(reads, readsBeforeDirectSend, 'Explicit route must not perform discovery GETs');
  assert.equal(bodies[2].CommunicationInfo.CommunicationConfigUuid, '21CDDA51E5FC49598D6FF6E7E36F36E4');
  assert.equal(bodies[2].CommunicationInfo.CommunicationTransactionType, 'User Defined');
  assert.equal(bodies[2].CommunicationInfo.CommunicationUserDefinedTransactionType, 'Letter_DA_Email');
  assert.doesNotMatch(direct.stdout, /Resolving|checked 36/);
  const directTraces = direct.stderr.split('\n').filter(line => line.startsWith('@OCCS_HTTP@')).map(line => JSON.parse(line.slice('@OCCS_HTTP@'.length)));
  assert.equal(directTraces.length, 2);
  assert.equal(directTraces[0].method, 'POST');
});
