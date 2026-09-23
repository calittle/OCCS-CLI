import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContentBlobMultipart,
  buildCreateContentPayload,
  buildCreateVersionPayload,
  buildVersionMasterUpdatePayload,
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

test('uses a single binary blob part and preserves OCCS markup verbatim', () => {
  const html = '<p>&lt;comms-data&gt;$Data{"Id":"field"}&lt;/comms-data&gt;</p>';
  const { boundary, body } = buildContentBlobMultipart(html);
  const wire = body.toString('utf8');
  assert.match(boundary, /^----occs-cli-/);
  assert.match(wire, /filename="blob"/);
  assert.ok(wire.includes(html));
  assert.match(wire, new RegExp(`--${boundary}--\\r\\n$`));
});
