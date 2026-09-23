import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContentBlobMultipart,
  buildCopiedVersionStyles,
  buildCreateContentPayload,
  buildCreateVersionPayload,
  buildVersionMasterUpdatePayload,
  contentCommandErrorSummary,
  normalizeContentHtml,
  resolveSourceContentVersion,
} from '../lib/contents.js';

test('builds the HAR-derived payload for a new content item and first version', () => {
  const payload = buildCreateContentPayload({
    shortName: 'create_test',
    description: '',
    effectiveDate: '2026-09-23',
  });
  assert.deepEqual(payload, {
    CommunicationContentConfigRec: {
      CommunicationContentConfigInfo: { Name: 'create_test', ShortName: 'create_test', Desc: '', ContentType: 'Text' },
      Status: [{ StatusCode: 'Active', EffDtTm: '2026-09-23T00:00:00.000000Z' }],
    },
    CommunicationContentVersionConfigRec: {
      CommunicationContentVersionConfigInfo: {
        ShortName: '1.0', Desc: '', Language: 'en-US',
        CommunicationContentVersionConfigData: [{ StyleClassName: [] }],
        CommunicationContentConfigUuid: 'DUMMY',
      },
      Status: [{ StatusCode: 'Active', EffDtTm: '2026-09-23T00:00:00.000000Z' }],
    },
    CommunicationContentVersionStyles: [],
  });
});

test('uses the observed en-US language default rather than accepting a caller override', () => {
  const firstVersion = buildCreateContentPayload({
    shortName: 'content', effectiveDate: '2026-09-23', language: 'fr-FR',
  });
  const laterVersion = buildCreateVersionPayload({
    contentUuid: 'CONTENT', version: '2.0', effectiveDate: '2026-09-24', language: 'fr-FR',
  });
  assert.equal(firstVersion.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.Language, 'en-US');
  assert.equal(laterVersion.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.Language, 'en-US');
});

test('builds a later-version payload and the follow-up editable-master update', () => {
  const create = buildCreateVersionPayload({ contentUuid: 'CONTENT', version: '2.0', effectiveDate: '2026-09-24', configId: '90' });
  assert.equal(create.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.CommunicationContentConfigUuid, 'CONTENT');
  assert.equal(create.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.ConfigId, '90');

  const update = buildVersionMasterUpdatePayload({
    createdVersion: { CommunicationContentVersionConfigRec: create.CommunicationContentVersionConfigRec, CommunicationContentVersionStyles: [] },
    contentRecord: {
      CommunicationContentConfigInfo: { Name: 'create_test', ShortName: 'create_test', Desc: '', ContentType: 'Text' },
      Status: [{ StatusCode: 'Active', EffDtTm: '2026-09-23T00:00:00.000000Z' }],
      CommunicationContentConfigUuid: 'CONTENT',
    },
    configId: '90',
    inProgressDate: '2026-09-23',
  });
  assert.deepEqual(update.CommunicationContentVersionConfigRec.Status, [
    { StatusCode: 'In Progress', EffDtTm: '2026-09-23T00:00:00.000000Z', ConfigId: '90' },
    { StatusCode: 'Active', EffDtTm: '2026-09-24T00:00:00.000000Z', ConfigId: '90' },
  ]);
  assert.equal(update.CommunicationContentConfigRec.CommunicationContentConfigInfo.ConfigId, '90');
});

test('flattens OCCS collection envelopes before updating a new version master', () => {
  const update = buildVersionMasterUpdatePayload({
    createdVersion: {
      CommunicationContentVersionConfigRec: {
        CommunicationContentVersionConfigInfo: {
          ShortName: '2.0', Language: 'en-US',
          CommunicationContentVersionConfigData: { Items: [{ StyleClassName: [], ConfigId: '90' }] },
        },
        Status: { Items: [
          { StatusCode: 'In Progress', EffDtTm: '2026-09-23T00:00:00.000000Z', ConfigId: '90' },
          { StatusCode: 'Active', EffDtTm: '2026-09-24T00:00:00.000000Z', ConfigId: '90' },
        ] },
      },
      CommunicationContentVersionStyles: { Items: [] },
    },
    contentRecord: {
      CommunicationContentConfigInfo: { Name: 'create-test-2', ShortName: 'create-test-2', ContentType: 'Text' },
      Status: { Items: [{ StatusCode: 'Active', EffDtTm: '2026-09-23T00:00:00.000000Z', ConfigId: '90' }] },
    },
    configId: '90',
    inProgressDate: '2026-09-23',
  });
  assert.deepEqual(update.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.CommunicationContentVersionConfigData, [
    { StyleClassName: [], ConfigId: '90' },
  ]);
  assert.deepEqual(update.CommunicationContentVersionConfigRec.Status, [
    { StatusCode: 'In Progress', EffDtTm: '2026-09-23T00:00:00.000000Z', ConfigId: '90' },
    { StatusCode: 'Active', EffDtTm: '2026-09-24T00:00:00.000000Z', ConfigId: '90' },
  ]);
  assert.deepEqual(update.CommunicationContentVersionStyles, []);
});

test('copies source version style relationships using the DUMMY target required by OCCS', () => {
  const copied = buildCopiedVersionStyles([{
    CommunicationStyleConfigCommunicationContentVersionConfigRelRec: {
      CommunicationStyleConfigCommunicationContentVersionConfigRelInfo: {
        CommunicationStyleConfigUuid: 'STYLE', StyleRelIndex: 1, StyleClassName: 'notice', CommunicationContentVersionConfigUuid: 'SOURCE', ConfigId: '90',
      },
    },
  }], '90');
  assert.deepEqual(copied, [{
    CommunicationStyleConfigCommunicationContentVersionConfigRelRec: {
      CommunicationStyleConfigCommunicationContentVersionConfigRelInfo: {
        CommunicationStyleConfigUuid: 'STYLE', StyleRelIndex: 1, StyleClassName: 'notice', CommunicationContentVersionConfigUuid: 'DUMMY', ConfigId: '90',
      },
    },
  }]);
});

test('resolves a requested source version from the content master', () => {
  const record = resolveSourceContentVersion({
    CommunicationContentMasterVersions: [
      { CommunicationContentVersionConfigRec: { CommunicationContentVersionConfigUuid: 'ONE', CommunicationContentVersionConfigInfo: { ShortName: '1.0' } } },
      { CommunicationContentVersionConfigRec: { CommunicationContentVersionConfigUuid: 'TWO', CommunicationContentVersionConfigInfo: { ShortName: '2.0' } } },
    ],
  }, '2.0');
  assert.equal(record.CommunicationContentVersionConfigUuid, 'TWO');
});

test('uses a single binary blob part and preserves OCCS markup verbatim', () => {
  const html = '<p>&lt;comms-data&gt;$Data{"Id":"field"}&lt;/comms-data&gt;</p>';
  const { boundary, body } = buildContentBlobMultipart(html);
  const wire = body.toString('utf8');
  assert.match(boundary, /^----occs-cli-/);
  assert.match(wire, /filename="blob"/);
  assert.ok(wire.includes(html));
  assert.match(wire, new RegExp(`--${boundary}--\\r\\n$`));
});

test('normalizes semantic emphasis to the italic markup persisted by the Comms editor', () => {
  const html = '<p><em>italic</em>, <EM class="accent">also italic</EM></p>';
  assert.equal(normalizeContentHtml(html), '<p><i>italic</i>, <i class="accent">also italic</i></p>');
  assert.match(buildContentBlobMultipart(html).body.toString('utf8'), /<i>italic<\/i>/);
});

test('reports only OCCS error fields and excludes unsafe Axios request details', () => {
  const summary = contentCommandErrorSummary({
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      headers: { executionid: 'execution-123' },
      data: { message: 'A version already exists with the provided name.' },
      config: { headers: { Authorization: 'Bearer should-not-appear' } },
    },
  });
  assert.deepEqual(summary, {
    message: 'A version already exists with the provided name.',
    status: 400,
    executionId: 'execution-123',
  });
  assert.doesNotMatch(JSON.stringify(summary), /Authorization|Bearer/);
});
