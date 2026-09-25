import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mockupCommand } from '../lib/mockup.js';

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

const click = (document, selector) => {
  const element = document.querySelector(selector);
  assert.ok(element, `Expected ${selector} to exist.`);
  element.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
};

test('Content-details back links return through their actual parent objects', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-mockup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  const output = path.join(root, 'inspector.html');

  writeJson(path.join(cache, 'documents', 'test-document', 'versions', '1.0.json'), {
    CommunicationDocumentConfigRec: { CommunicationDocumentConfigInfo: { ShortName: 'test document' } },
    CommunicationDocumentVersionConfigRec: { CommunicationDocumentVersionConfigInfo: { ShortName: '1.0', Desc: 'Document version description' } },
    CommunicationDocumentVersionLayouts: [{
      CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec: {
        CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo: { CommunicationLayoutConfigUuid: 'layout-1', LayoutAlwaysTriggerInd: true },
      },
    }],
  });
  writeJson(path.join(cache, 'layouts', 'parent-layout', 'layout.json'), {
    CommunicationLayoutConfigRec: {
      CommunicationLayoutConfigUuid: 'layout-1',
      CommunicationLayoutConfigInfo: { ShortName: 'parent layout', LayoutType: 'Block' },
    },
    CommunicationLayoutContents: [{
      ShortName: 'parent content',
      CommunicationLayoutConfigCommunicationContentConfigRelRec: {
        CommunicationLayoutConfigCommunicationContentConfigRelInfo: { ContentAlwaysTriggerInd: true },
      },
    }],
  });
  for (const [name, blob] of [
    ['parent content', '$Cond{"Content":"child content","Condition":"use child"}'],
    ['child content', ''],
  ]) {
    writeJson(path.join(cache, 'contents', name, 'content.json'), {
      CommunicationContentConfigRec: { CommunicationContentConfigInfo: { ShortName: name } },
    });
    const versionDir = path.join(cache, 'contents', name, 'versions', '1.0');
    fs.mkdirSync(versionDir, { recursive: true });
    writeJson(path.join(versionDir, '1.0.json'), {
      CommunicationContentVersionConfigInfo: { ShortName: '1.0', Desc: name === 'parent content' ? 'Parent version description' : '' },
    });
    fs.writeFileSync(path.join(versionDir, 'content.blob'), blob);
  }

  await mockupCommand('test-document', { cache, output });
  const dom = new JSDOM(fs.readFileSync(output, 'utf8'), { runScripts: 'dangerously' });
  const { document } = dom.window;

  click(document, '[data-node="layout-0"]');
  assert.equal(document.querySelector('#detail .document-version')?.textContent, 'Ver: 1.0 · Document version description');
  assert.equal(document.querySelector('#detail [data-canonical="version"]'), null);
  click(document, '[data-canonical="contents"]');
  assert.equal(document.querySelector('[data-canonical="copy"][data-value="parent%20content"]')?.getAttribute('aria-label'), 'Copy parent content');
  click(document, '[data-canonical="content"][data-value="parent%20content"]');
  assert.equal(document.querySelector('#content-detail .content-title [data-canonical="copy"]')?.getAttribute('aria-label'), 'Copy parent content');
  assert.equal(document.querySelector('#content-detail .content-version')?.textContent, 'Ver: 1.0 · Parent version description');
  assert.equal(document.querySelector('#content-detail [data-canonical="content-version"]'), null);
  assert.equal(document.querySelector('#content-detail [data-canonical="back"]')?.textContent, '← parent layout');
  const condition = document.querySelector('#content-detail [data-canonical="condition"]');
  assert.equal(condition?.getAttribute('aria-expanded'), 'false');
  assert.equal(condition?.nextElementSibling?.hidden, true);
  assert.equal(dom.window.getComputedStyle(condition?.nextElementSibling).display, 'none');
  click(document, '#content-detail [data-canonical="condition"]');
  assert.equal(condition?.getAttribute('aria-expanded'), 'true');
  assert.equal(condition?.nextElementSibling?.hidden, false);
  assert.equal(dom.window.getComputedStyle(condition?.nextElementSibling).display, 'block');
  assert.match(condition?.nextElementSibling?.textContent || '', /use child/);

  click(document, '[data-canonical="content"][data-value="child%20content"]');
  assert.equal(document.querySelector('#content-detail [data-canonical="copy"][data-value="child%20content"]')?.getAttribute('aria-label'), 'Copy child content');
  assert.equal(document.querySelector('#content-detail [data-canonical="back"]')?.textContent, '← parent content');
  click(document, '#content-detail [data-canonical="back"]');
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent content');

  click(document, '#content-detail [data-canonical="back"]');
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent layout');
  assert.match(document.querySelector('#content-detail')?.textContent || '', /parent content/);
});
