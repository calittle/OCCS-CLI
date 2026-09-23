import assert from 'node:assert/strict';
import test from 'node:test';
import { selectOpenConfigId } from '../lib/configs.js';

const openConfigs = [
  {
    ConfigurationId: '90',
    ConfigurationUuid: 'CONFIG-90',
    ConfigurationInfo: { ShortName: '_andy', Name: 'Andy test configuration', Desc: 'Test' },
    ConfigurationStatus: { Items: [{ ConfigurationStatusCode: 'Open', EffDtTm: '2026-09-23T00:00:00.000000Z' }] },
  },
];

test('resolves an open ConfigId by its UI short name', () => {
  assert.deepEqual(selectOpenConfigId(openConfigs, '_AnDy'), {
    input: '_AnDy',
    resolved: '90',
    id: '90',
    uuid: 'CONFIG-90',
    shortName: '_andy',
    name: 'Andy test configuration',
    description: 'Test',
    status: 'Open',
    effectiveAt: '2026-09-23T00:00:00.000000Z',
  });
});

test('reports an ambiguous ConfigId instead of choosing one arbitrarily', () => {
  const duplicate = {
    ...openConfigs[0],
    ConfigurationId: '91',
    ConfigurationUuid: 'CONFIG-91',
  };
  assert.throws(() => selectOpenConfigId([...openConfigs, duplicate], '_andy'), {
    message: 'ConfigId is ambiguous: _andy',
  });
});
