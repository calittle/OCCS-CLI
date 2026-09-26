import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateDocumentPayload,
  buildDocumentVersionUpdatePayload,
  copyDocumentLayouts,
  copyDocumentStyles,
} from '../lib/documentAuthoring.js';

const company = [{
  CompanyCommunicationDocumentConfigRelRec: {
    CompanyCommunicationDocumentConfigRelInfo: { CompanyUuid: 'company-1', OrgCompanyRole: 'Marketing' },
  },
}];

test('buildCreateDocumentPayload matches the observed document-master create contract', () => {
  const payload = buildCreateDocumentPayload({
    shortName: 'new-doc', description: 'A test', version: '1.0', effectiveDate: '2026-09-26', companies: company,
  });
  assert.equal(payload.CommunicationDocumentConfigRec.CommunicationDocumentConfigInfo.ShortName, 'new-doc');
  assert.equal(payload.CommunicationDocumentVersionConfigRec.CommunicationDocumentVersionConfigInfo.CommunicationDocumentConfigUuid, 'DUMMY');
  assert.deepEqual(payload.CommunicationDocumentVersionLayouts, []);
  assert.equal(payload.CompanyCommunicationDocuments[0].CompanyCommunicationDocumentConfigRelRec.CompanyCommunicationDocumentConfigRelInfo.CommunicationDocumentConfigUuid, 'DUMMY');
  assert.equal('ConfigId' in payload.CompanyCommunicationDocuments[0].CompanyCommunicationDocumentConfigRelRec.CompanyCommunicationDocumentConfigRelInfo, false);
});

test('association copies retain only writable relation fields and retarget the version', () => {
  const layouts = copyDocumentLayouts([{
    CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec: {
      CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo: { CommunicationLayoutConfigUuid: 'layout-1', LayoutRelIndex: 2, LayoutAlwaysTriggerInd: true, LayoutPlacement: 'Header' },
      Status: { Items: [{ StatusCode: 'Active' }] },
      CommunicationDocumentVersionConfigCommunicationLayoutConfigRelUuid: 'old-relation',
    },
  }], 'new-version', '90');
  const styles = copyDocumentStyles([{
    CommunicationDocumentVersionConfigCommunicationStyleConfigRelRec: {
      CommunicationDocumentVersionConfigCommunicationStyleConfigRelInfo: { CommunicationStyleConfigUuid: 'style-1', StyleRelIndex: 3, StyleClassName: 'body' },
      Status: { Items: [{ StatusCode: 'Active' }] },
    },
  }], 'new-version', '90');
  const layoutInfo = layouts[0].CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo;
  const styleInfo = styles[0].CommunicationDocumentVersionConfigCommunicationStyleConfigRelRec.CommunicationDocumentVersionConfigCommunicationStyleConfigRelInfo;
  assert.deepEqual(layoutInfo, { CommunicationLayoutConfigUuid: 'layout-1', LayoutRelIndex: 2, LayoutAlwaysTriggerInd: true, LayoutPlacement: 'Header', CommunicationDocumentVersionConfigUuid: 'new-version', ConfigId: '90' });
  assert.deepEqual(styleInfo, { CommunicationStyleConfigUuid: 'style-1', StyleRelIndex: 3, StyleClassName: 'body', CommunicationDocumentVersionConfigUuid: 'new-version', ConfigId: '90' });
});

test('buildDocumentVersionUpdatePayload flattens status envelopes and strips display fields', () => {
  const created = {
    CommunicationDocumentConfigRec: {
      CommunicationDocumentConfigUuid: 'doc-1', CommunicationDocumentConfigInfo: { ShortName: 'new-doc' },
      Status: { Items: [{ StatusCode: 'In Progress' }, { StatusCode: 'Active' }] },
    },
    CommunicationDocumentVersionConfigRec: {
      CommunicationDocumentVersionConfigUuid: 'version-1', CommunicationDocumentVersionConfigInfo: { ShortName: '1.0', CommunicationDocumentConfigUuid: 'doc-1' },
      Status: { Items: [{ StatusCode: 'In Progress' }, { StatusCode: 'Active' }] },
    },
    CompanyCommunicationDocuments: [{
      CompanyCommunicationDocumentConfigRelRec: {
        CompanyCommunicationDocumentConfigRelUuid: 'company-rel-1',
        CompanyCommunicationDocumentConfigRelInfo: { CompanyUuid: 'company-1', OrgCompanyRole: 'Marketing', CommunicationDocumentConfigUuid: 'doc-1' },
      },
      ShortName: 'Display-only company name',
    }],
  };
  const payload = buildDocumentVersionUpdatePayload({ master: created, configId: '90', layouts: [], styles: [] });
  assert.deepEqual(payload.CommunicationDocumentConfigRec.Status, [{ StatusCode: 'In Progress', ConfigId: '90' }, { StatusCode: 'Active', ConfigId: '90' }]);
  assert.equal(payload.CompanyCommunicationDocuments[0].CompanyCommunicationDocumentConfigRelRec.CompanyCommunicationDocumentConfigRelUuid, 'company-rel-1');
  assert.equal('ShortName' in payload.CompanyCommunicationDocuments[0], false);
  assert.deepEqual(payload.CommunicationDocumentVersionLayouts, []);
  assert.deepEqual(payload.CommunicationDocumentVersionStyles, []);
});
