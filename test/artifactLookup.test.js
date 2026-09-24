import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { findArtifactByShortName } from '../lib/artifactLookup.js';

test('resolves a content short name exactly after an OCCS-style broad search', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/CommunicationContent/v1/CommunicationContentConfigRec');
    assert.match(url.searchParams.get('whr'), /create-test-2/);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      HasMore: false,
      Items: [
        { CommunicationContentConfigRec: { CommunicationContentConfigUuid: 'EXACT', CommunicationContentConfigInfo: { ShortName: 'create-test-2' } } },
        { CommunicationContentConfigRec: { CommunicationContentConfigUuid: 'SIMILAR', CommunicationContentConfigInfo: { ShortName: 'create-test-20' } } },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const content = await findArtifactByShortName(
      { baseUrl: `http://127.0.0.1:${port}`, token: 'test' },
      '/api/CommunicationContent/v1/CommunicationContentConfigRec',
      'CommunicationContentConfigInfo.ShortName',
      'create-test-2',
      (item) => ({ shortName: item.CommunicationContentConfigRec?.CommunicationContentConfigInfo?.ShortName }),
    );
    assert.equal(content.CommunicationContentConfigRec.CommunicationContentConfigUuid, 'EXACT');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
