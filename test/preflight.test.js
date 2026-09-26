import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDocumentLayoutDependencies,
  collectPackageDocumentDependencies,
  collectRegistryChanges,
  collectStandaloneAssetChanges,
  describeRegistryRecord,
  describeRegistryOperation,
} from '../lib/preflight.js';

test('collects document config dependencies from package detail', () => {
  const payload = {
    CommunicationPackageVersionDocuments: [{
      CommunicationPackageVersionConfigCommunicationDocumentConfigRelRec: {
        CommunicationPackageVersionConfigCommunicationDocumentConfigRelInfo: {
          CommunicationPackageVersionConfigUuid: 'PACKAGE_VERSION_UUID',
          CommunicationDocumentConfigUuid: 'DOCUMENT_CONFIG_UUID',
        },
        Status: { Items: [{ StatusCode: 'In Progress' }] },
      },
      ShortName: 'CO-G1-CO7_ENGY_FIT',
      ConfigIdShortName: '2026-09-25',
      ConfigIdStatus: 'Open',
    }],
  };

  assert.deepEqual(collectPackageDocumentDependencies(payload), [{
    packageVersionRecUuid: 'PACKAGE_VERSION_UUID',
    documentConfigUuid: 'DOCUMENT_CONFIG_UUID',
    documentName: 'CO-G1-CO7_ENGY_FIT',
    ownerShortName: '2026-09-25',
    ownerStatus: 'Open',
    relationStatusCode: 'In Progress',
  }]);
});

test('deduplicates package document relationships found through nested detail', () => {
  const relation = {
    CommunicationPackageVersionConfigCommunicationDocumentConfigRelRec: {
      CommunicationPackageVersionConfigCommunicationDocumentConfigRelInfo: {
        CommunicationPackageVersionConfigUuid: 'PACKAGE_VERSION_UUID',
        CommunicationDocumentConfigUuid: 'DOCUMENT_CONFIG_UUID',
      },
    },
  };

  assert.equal(collectPackageDocumentDependencies({ first: relation, second: relation }).length, 1);
});

test('collects layouts from document detail', () => {
  const payload = {
    CommunicationDocumentVersionLayouts: [{
      CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec: {
        CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo: {
          CommunicationLayoutConfigUuid: 'LAYOUT_CONFIG_UUID',
        },
        Status: { Items: [{ StatusCode: 'In Progress' }] },
      },
      CommunicationLayoutConfigRec: {
        CommunicationLayoutConfigInfo: { ShortName: 'CO-G1-CO7 layout' },
      },
      ConfigIdShortName: '2026-06-02-1700',
      ConfigIdStatus: 'Open',
    }],
  };

  assert.deepEqual(collectDocumentLayoutDependencies(payload), [{
    configUuid: 'LAYOUT_CONFIG_UUID',
    name: 'CO-G1-CO7 layout',
    ownerShortName: '2026-06-02-1700',
    ownerStatus: 'Open',
    relationStatusCode: 'In Progress',
  }]);
});

test('collects standalone font and style registry changes, including deletes', () => {
  const payload = {
    ConfigurationDomainRegistryRec: [{
      Items: [
        { TopRecName: 'CommunicationFontConfigRec', RecUuid: 'FONT_UUID', Operation: 'DELETE' },
        { TopRecName: 'CommunicationStyleConfigRec', RecUuid: 'STYLE_UUID', Operation: 'UPDATE' },
      ],
    }],
  };

  assert.deepEqual(collectStandaloneAssetChanges(payload), [
    { type: 'Font', topRecName: 'CommunicationFontConfigRec', recUuid: 'FONT_UUID', operation: 'DELETE' },
    { type: 'Style', topRecName: 'CommunicationStyleConfigRec', recUuid: 'STYLE_UUID', operation: 'UPDATE' },
  ]);
  assert.deepEqual(collectRegistryChanges(payload), [
    { topRecName: 'CommunicationFontConfigRec', recUuid: 'FONT_UUID', operation: 'DELETE' },
    { topRecName: 'CommunicationStyleConfigRec', recUuid: 'STYLE_UUID', operation: 'UPDATE' },
  ]);
});

test('uses plain-language labels for registry resource and relationship records', () => {
  assert.equal(describeRegistryRecord('CommunicationPackageConfigRec'), 'Package');
  assert.equal(describeRegistryRecord('CommunicationPackageVersionConfigRec'), 'Package version');
  assert.equal(
    describeRegistryRecord('CommunicationEmailVersionConfigCommunicationPackageConfigRelRec'),
    'Email version → package association',
  );
  assert.equal(
    describeRegistryRecord('CommunicationLayoutConfigCommunicationStyleConfigRelRec'),
    'Layout → style association',
  );
});

test('renders object and association operations with distinct verbs', () => {
  assert.equal(describeRegistryOperation('CREATE', 'CommunicationStyleConfigRec'), 'CREATE');
  assert.equal(describeRegistryOperation('UPDATE_REPLACE', 'CommunicationStyleConfigRec'), 'UPDATE');
  assert.equal(describeRegistryOperation('CREATE', 'CommunicationLayoutConfigCommunicationStyleConfigRelRec'), 'ASSOCIATE');
  assert.equal(describeRegistryOperation('DELETE', 'CommunicationLayoutConfigCommunicationStyleConfigRelRec'), 'DEASSOCIATE');
  assert.equal(describeRegistryOperation('UPDATE_REPLACE', 'CommunicationLayoutConfigCommunicationStyleConfigRelRec'), 'UPDATE_ASSOCIATION');
});
