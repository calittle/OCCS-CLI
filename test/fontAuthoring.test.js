import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCreateFontPayload } from '../lib/fonts.js';
import { buildContentFileMultipart } from '../lib/contents.js';

test('builds the HAR-derived minimal font shell before binary upload', () => {
  assert.deepEqual(buildCreateFontPayload({ shortName: 'TEST-Font', name: 'Test Font' }), {
    CommunicationFontConfigInfo: {
      Name: 'Test Font', ShortName: 'TEST-Font', Desc: 'none', FontFamily: 'none',
      FontScalable: false, FontSize: 0, FontStyle: 'none',
    },
  });
});

test('builds a single multipart file part for image content', () => {
  const { boundary, body } = buildContentFileMultipart(fileURLToPath(new URL('./fixtures/blob.bin', import.meta.url)));
  const text = body.toString('utf8');
  assert.match(text, new RegExp(`--${boundary}`));
  assert.match(text, /name=""; filename="blob.bin"/);
  assert.match(text, /Content-Type: application\/octet-stream/);
});
