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
  writeJson(path.join(cache, 'styles', 'content-style', 'style.json'), {
    CommunicationStyleConfigRec: {
      CommunicationStyleConfigUuid: 'style-1',
      CommunicationStyleConfigInfo: {
        ShortName: 'content style',
        CommunicationStyleConfigStyleAttribute: { Items: [
          { StyleAttributeName: 'Color', StyleAttributeValue: '#123456' },
          { StyleAttributeName: 'Font-size', StyleAttributeValue: '12px' },
        ] },
      },
    },
  });
  for (const [name, blob] of [
    ['parent content', '<p>Preview sample $&</p><figure class="table"><table><tbody><tr><td>&lt;comms-data&gt;$Data{&#34;Id&#34;:&#34;amount&#34;,&#34;Type&#34;:&#34;Decimal&#34;,&#34;Format&#34;:&#34;#,##0.00&#34;}&lt;/comms-data&gt;</td><td>&lt;comms-cond&gt;$Cond{&#34;Condition&#34;:&#34;showAmount&#34;,&#34;Text&#34;:&#34;Total&#34;}&lt;/comms-cond&gt;</td></tr></tbody></table></figure><script>window.previewInjected=true</script>$Cond{"Content":"child content","Condition":"use child"}'],
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
    if (name === 'parent content') writeJson(path.join(versionDir, '1.0_expanded.json'), {
      CommunicationContentVersionStyles: { Items: [{
        CommunicationStyleConfigCommunicationContentVersionConfigRelRec: {
          CommunicationStyleConfigCommunicationContentVersionConfigRelInfo: { CommunicationStyleConfigUuid: 'style-1', StyleClassName: 'content-class' },
        },
      }] },
    });
    fs.writeFileSync(path.join(versionDir, 'content.blob'), blob);
  }

  await mockupCommand('test-document', { cache, output });
  const dom = new JSDOM(fs.readFileSync(output, 'utf8'), { runScripts: 'dangerously' });
  const { document } = dom.window;
  assert.equal(document.scripts.length, 1, 'Generated mockups should run only the current inspector script.');
  document.querySelector('#content-preview-dialog').showModal = function () { this.open = true; };
  assert.equal(dom.window.previewInjected, undefined);

  click(document, '[data-node="layout-0"]');
  assert.equal(document.querySelector('#detail .content-title [data-canonical="copy"]')?.getAttribute('aria-label'), 'Copy layout name');
  assert.equal(document.querySelector('#detail .document-version')?.textContent, 'Ver: 1.0 · Document version description');
  assert.equal(document.querySelector('#detail [data-canonical="version"]'), null);
  click(document, '[data-canonical="contents"]');
  assert.equal(document.querySelector('[data-canonical="copy"][data-value="parent%20content"]')?.getAttribute('aria-label'), 'Copy parent content');
  click(document, '[data-canonical="content"][data-value="parent%20content"]');
  assert.equal(document.querySelector('#content-detail .content-title [data-canonical="copy"]')?.getAttribute('aria-label'), 'Copy parent content');
  assert.equal(document.querySelector('#content-detail .content-version')?.textContent, 'Ver: 1.0 · Parent version description');
  assert.equal(document.querySelector('#content-detail [data-canonical="content-version"]'), null);
  assert.equal(document.querySelector('#content-detail [data-canonical="back"]')?.textContent, '← parent layout');
  assert.equal(document.querySelector('#content-detail h3:last-of-type')?.textContent, 'Styles');
  assert.equal(document.querySelector('#content-panel .empty')?.textContent, 'Choose a field or style in Content details');
  assert.equal(document.querySelector('#content-detail [data-canonical="content-style"]')?.textContent, 'content style');
  click(document, '#content-detail [data-canonical="content-style"]');
  assert.equal(document.querySelector('#content-panel h2')?.textContent, 'content style');
  assert.deepEqual([...document.querySelectorAll('#content-panel li')].map(item => item.textContent), ['Color: #123456', 'Font-size: 12px']);
  const previewButton = document.querySelector('#content-detail .content-title [data-canonical="preview"]');
  assert.equal(previewButton?.previousElementSibling?.dataset.canonical, 'copy');
  assert.equal(previewButton?.getAttribute('aria-label'), 'Preview HTML');
  assert.ok(previewButton?.querySelector('svg'));
  click(document, '#content-detail [data-canonical="preview"]');
  assert.equal(document.querySelector('#content-preview-dialog').open, true);
  assert.equal(document.querySelector('#content-preview-title')?.textContent, 'parent content');
  assert.match(document.querySelector('#content-preview-frame')?.srcdoc || '', /<p>Preview sample \$&<\/p>/);
  const previewDocument = new JSDOM(document.querySelector('#content-preview-frame').srcdoc).window.document;
  assert.deepEqual([...previewDocument.querySelectorAll('table td')].map(cell => cell.textContent), ['amount', 'Total']);
  assert.match(previewDocument.querySelector('.preview-token')?.getAttribute('title') || '', /Field: amount · Type: Decimal · Format: #,##0\.00/);
  assert.equal(previewDocument.querySelector('.preview-conditional')?.getAttribute('title'), 'showAmount');
  assert.match(previewDocument.querySelector('style')?.textContent || '', /table\{[^}]*table-layout:fixed/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /th,td\{[^}]*border:1px solid/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /th,td\{[^}]*width:auto!important/);
  assert.equal(document.querySelector('#content-preview-frame')?.getAttribute('sandbox'), '');
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
  assert.equal(document.querySelector('#content-detail [data-canonical="preview"]'), null);
  assert.match(document.querySelector('#content-detail')?.textContent || '', /No styles found\./);
  assert.equal(document.querySelector('#content-detail [data-canonical="copy"][data-value="child%20content"]')?.getAttribute('aria-label'), 'Copy child content');
  assert.equal(document.querySelector('#content-detail [data-canonical="back"]')?.textContent, '← parent content');
  click(document, '#content-detail [data-canonical="back"]');
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent content');

  click(document, '#content-detail [data-canonical="back"]');
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent layout');
  assert.match(document.querySelector('#content-detail')?.textContent || '', /parent content/);
});
