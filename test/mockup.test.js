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
    ['parent content', '<p>Preview sample $&</p><figure class="table" style="float:left;height:20px"><table style="float:left;height:20px"><tbody><tr><td>&lt;comms-data&gt;$Data{&#34;Id&#34;:&#34;parent field&#34;,&#34;Type&#34;:&#34;Decimal&#34;,&#34;Format&#34;:&#34;#,##0.00&#34;}&lt;/comms-data&gt;</td><td>&lt;comms-cond&gt;$Cond{&#34;Condition&#34;:&#34;showAmount&#34;,&#34;Text&#34;:&#34;Total&#34;}&lt;/comms-cond&gt;</td></tr></tbody></table></figure><p>&lt;comms-cond&gt;$Cond{&#34;Condition&#34;:&#34;use child&#34;,&#34;Content&#34;:&#34;child content&#34;}&lt;/comms-cond&gt;</p><p>&lt;comms-cond&gt;$Cond{&#34;Text&#34;:&#34;ConditionalContent&#34;}&lt;/comms-cond&gt;</p><script>window.previewInjected=true</script>$Cond{"Content":"child content","Condition":"use child"}'],
    ['child content', '$Data{"Id":"child field"}'],
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
  fs.appendFileSync(path.join(cache, 'contents', 'parent content', 'versions', '1.0', 'content.blob'),
    '<p>&lt;comms-cond&gt;$Cond{&#34;Condition&#34;:&#34;isEnglishBill empty false &amp;&amp; &#39;&lt;comms-data&gt;$Data{&#34;Id&#34;:&#34;parent field&#34;}&lt;/comms-data&gt;&#39; !&#61; &#39;&#39;&#34;,&#34;Text&#34;:&#34;&lt;comms-data&gt;$Data{&#34;Id&#34;:&#34;parent field&#34;}&lt;/comms-data&gt;&#34;}&lt;/comms-cond&gt;</p>' +
    '<p><strong>&lt;comms-data&gt;$Data {&#34;Id&#34;:&#34;DC14&#34;,&#34;Type&#34;:&#34;Date&#34;,&#34;Format&#34;:&#34;dd-MM-yy&#34;}&lt;/comms-data&gt;</strong></p>' +
    '<p>&lt;comms-cond&gt;$Cond{&#34;Condition&#34;:&#34;GRIDPAGENUMBER ==1 &amp;&amp; parent field empty false&#34;,&#34;Text&#34;:&#34;&lt;comms-data&gt;$Data {&#34;Id&#34;:&#34;parent field&#34;,&#34;Type&#34;:&#34;Text&#34;,&#34;Format&#34;:&#34;plain&#34;}&lt;/comms-data&gt; remainder&#34;}&lt;/comms-cond&gt;</p>');

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
  const listPreview = document.querySelector('#content-detail li [data-canonical="preview"]');
  assert.equal(listPreview?.getAttribute('aria-label'), 'Preview HTML for parent content');
  assert.equal(listPreview?.dataset.value, 'parent%20content');
  click(document, '#content-detail li [data-canonical="preview"]');
  assert.equal(document.querySelector('#content-preview-dialog').open, true);
  assert.equal(document.querySelector('#content-preview-title')?.textContent, 'parent content');
  assert.match(document.querySelector('#content-preview-frame')?.srcdoc || '', /<p>Preview sample \$&<\/p>/);
  assert.equal(document.querySelector('#content-detail .path')?.textContent, 'Content details › Contents');
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
  assert.deepEqual([...previewDocument.querySelectorAll('table td')].map(cell => cell.textContent), ['parent field', 'Cond']);
  assert.match(previewDocument.querySelector('.preview-token')?.getAttribute('title') || '', /Field: parent field · Type: Decimal · Format: #,##0\.00/);
  const dateChip = previewDocument.querySelector('strong .preview-token');
  assert.equal(dateChip?.textContent, 'DC14');
  assert.equal(dateChip?.getAttribute('title'), 'Field: DC14 · Type: Date · Format: dd-MM-yy');
  assert.doesNotMatch(previewDocument.body.textContent, /\$Data\s*\{|<comms-data>/);
  assert.ok(document.querySelector('#content-detail [data-canonical="field"][data-value="DC14"]'));
  const conditionalChip = previewDocument.querySelector('.preview-conditional');
  assert.equal(conditionalChip?.getAttribute('title'), 'Condition: showAmount');
  assert.equal(conditionalChip?.getAttribute('href'), '#preview-condition-1');
  assert.equal(conditionalChip?.getAttribute('aria-label'), 'Show conditional details');
  assert.equal(previewDocument.querySelector('#preview-condition-1')?.textContent, 'Cond 1Condition: showAmountText: Total');
  assert.equal(previewDocument.querySelectorAll('.preview-conditional').length, 5);
  assert.equal(previewDocument.querySelectorAll('.preview-conditional')[1]?.getAttribute('href'), '#preview-condition-2');
  assert.equal(previewDocument.querySelector('#preview-condition-2')?.textContent, 'Cond 2Condition: use childContent: child content');
  assert.equal(previewDocument.querySelectorAll('.preview-conditional')[2]?.getAttribute('title'), 'Select to view conditional details');
  assert.equal(previewDocument.querySelector('#preview-condition-3')?.textContent, 'Cond 3Text: ConditionalContent');
  assert.equal(previewDocument.querySelectorAll('.preview-conditional')[3]?.getAttribute('href'), '#preview-condition-4');
  assert.match(previewDocument.querySelector('#preview-condition-4')?.textContent || '', /Condition: isEnglishBill empty false && '\[parent field\]' != ''/);
  assert.match(previewDocument.querySelector('#preview-condition-4')?.textContent || '', /Text: \[parent field\]/);
  assert.equal(previewDocument.querySelector('#preview-condition-5')?.textContent, 'Cond 5Condition: GRIDPAGENUMBER ==1 && parent field empty falseText: [parent field · Type: Text · Format: plain] remainder');
  assert.doesNotMatch(previewDocument.body.textContent, /No condition or content was recorded/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /\.preview-condition-detail\.selected\{display:block/);
  assert.equal(previewDocument.body.lastElementChild?.className, 'preview-conditions');
  assert.equal(previewDocument.body.firstElementChild?.className, 'preview-markup');
  assert.ok(previewDocument.querySelector('.preview-markup table'));
  assert.equal(previewDocument.querySelector('.preview-conditions')?.closest('.preview-markup'), null);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /\.preview-markup\{display:flow-root/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /figure\.table\{[^}]*height:auto!important/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /table\{[^}]*float:none!important/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /\.preview-conditions\{clear:both/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /table\{[^}]*table-layout:fixed/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /th,td\{[^}]*border:1px solid/);
  assert.match(previewDocument.querySelector('style')?.textContent || '', /th,td\{[^}]*width:auto!important/);
  assert.equal(document.querySelector('#content-preview-frame')?.getAttribute('sandbox'), 'allow-same-origin');
  const condition = document.querySelector('#content-detail [data-canonical="condition"]');
  assert.equal(condition?.getAttribute('aria-expanded'), 'false');
  assert.equal(condition?.nextElementSibling?.hidden, true);
  assert.equal(dom.window.getComputedStyle(condition?.nextElementSibling).display, 'none');
  click(document, '#content-detail [data-canonical="condition"]');
  assert.equal(condition?.getAttribute('aria-expanded'), 'true');
  assert.equal(condition?.nextElementSibling?.hidden, false);
  assert.equal(dom.window.getComputedStyle(condition?.nextElementSibling).display, 'block');
  assert.match(condition?.nextElementSibling?.textContent || '', /use child/);
  assert.match(document.querySelector('#content-detail')?.textContent || '', /parent field/);
  assert.doesNotMatch(document.querySelector('#content-detail')?.textContent || '', /child field/);

  const conditionalPreview = document.querySelector('#content-detail li [data-canonical="preview"][data-value="child%20content"]');
  assert.equal(conditionalPreview?.getAttribute('aria-label'), 'Preview HTML for child content');
  click(document, '#content-detail li [data-canonical="preview"][data-value="child%20content"]');
  assert.equal(document.querySelector('#content-preview-title')?.textContent, 'child content');
  assert.match(document.querySelector('#content-preview-frame')?.srcdoc || '', /child field/);
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent content');

  click(document, '[data-canonical="content"][data-value="child%20content"]');
  assert.ok(document.querySelector('#content-detail [data-canonical="preview"]'));
  assert.match(document.querySelector('#content-detail')?.textContent || '', /No styles found\./);
  assert.equal(document.querySelector('#content-detail [data-canonical="copy"][data-value="child%20content"]')?.getAttribute('aria-label'), 'Copy child content');
  assert.match(document.querySelector('#content-detail')?.textContent || '', /child field/);
  assert.equal(document.querySelector('#content-detail [data-canonical="back"]')?.textContent, '← parent content');
  click(document, '#content-detail [data-canonical="back"]');
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent content');

  click(document, '#content-detail [data-canonical="back"]');
  assert.equal(document.querySelector('#content-detail h2')?.textContent, 'parent layout');
  assert.match(document.querySelector('#content-detail')?.textContent || '', /parent content/);

  // Missing package/AT definitions must never be described as top-level fields.
  click(document, '[data-canonical="content"][data-value="parent%20content"]');
  assert.equal(document.querySelector('#content-detail .field-warning')?.textContent, 'Definition not found');
  click(document, '[data-canonical="field"]');
  assert.match(document.querySelector('#content-panel').textContent, /Field definition was not found in the Assembly Template/);
  assert.doesNotMatch(document.querySelector('#content-panel').textContent, /Top-level field definition/);

  writeJson(path.join(cache, 'packages', 'test-package', 'versions', '1.0', 'AssemblyTemplate.json'), {
    Fields: [{ Name: 'parent field', Path: '$.parent' }, { Name: 'DC14', Path: '$.billDate' }],
    Documents: [{ $$Id: 'test document', Condition: '$[?(@.amount < 100 && @.kind == \"bill\")]', Layouts: [
      { $$Id: 'parent layout', Contents: [
        { $$Id: 'parent content', Iteration: { $$Id: 'rows', Path: '$.rows', Fields: [{ Name: 'inherited field', Path: '$.inherited' }] } },
        { $$Id: 'child content', Iteration: { $$Id: 'child rows', Path: '$.children', Fields: [{ Name: 'child field', Path: '$.child' }, { Name: 'pathless field' }] } },
      ] },
      { $$Id: 'unrelated layout', Contents: [{ $$Id: 'child content', Iteration: { Fields: [{ Name: 'missing field', Path: '$.unrelated' }] } }] },
    ] }],
  });
  fs.appendFileSync(path.join(cache, 'contents', 'child content', 'versions', '1.0', 'content.blob'), '$Data{"Id":"missing field"}$Data{"Id":"inherited field"}$Data{"Id":"pathless field"}$Data{"Id":"child rows"}$Data{"Id":"PackagePageNum"}$Data{"Id":"PackagePageCount"}$Data{"Id":"GRIDPAGENUMBER"}');
  await mockupCommand('test-document', { cache, output, package: 'test-package' });
  const resolvedDom = new JSDOM(fs.readFileSync(output, 'utf8'), { runScripts: 'dangerously' });
  t.after(() => { dom.window.close(); resolvedDom.window.close(); });
  const resolved = resolvedDom.window.document;
  assert.ok(resolved.querySelector('[data-node="layout-0"] > .warning-icon:not(.configuration-warning)'));
  assert.equal(resolved.querySelector('[data-node="document"] > .warning-icon:not(.configuration-warning)'), null);
  click(resolved, '[data-node="document"]');
  assert.equal(resolved.querySelector('#detail .warning-icon:not(.configuration-warning)'), null);
  assert.equal(resolved.querySelector('#content-detail .package-version').textContent, 'Ver: 1.0');
  assert.equal(resolved.querySelector('#content-detail .chip:not(button)'), null);
  const packageDialog = resolved.querySelector('#package-dialog');
  packageDialog.showModal = function () { this.open = true; };
  click(resolved, '#content-detail [data-canonical="package-condition"]');
  assert.equal(packageDialog.open, true);
  assert.equal(resolved.querySelector('#package-condition').textContent, '$[?(@.amount < 100 && @.kind == "bill")]');
  assert.equal(packageDialog.querySelector('h2').textContent, 'AT Document Trigger:');
  assert.equal(packageDialog.querySelector('#package-summary, .path'), null);
  assert.equal(packageDialog.querySelector('button').textContent, '×');
  assert.equal(packageDialog.querySelector('button').getAttribute('aria-label'), 'Close document trigger');
  assert.equal(packageDialog.querySelector('form').getAttribute('method'), 'dialog');
  assert.equal(resolved.querySelector('#detail [data-canonical="condition"]'), null);
  assert.doesNotMatch(resolved.querySelector('#detail').textContent, /Condition:/);
  assert.equal(resolved.querySelector('#content-detail .inspector-row').textContent, 'Condition: conditional');
  assert.doesNotMatch(resolved.querySelector('#content-detail').textContent, /Document condition|Open full condition|This Assembly Template expression/);

  click(resolved, '[data-canonical="layouts"]');
  assert.ok(resolved.querySelector('[data-canonical="layout"][data-value="layout-0"] + .warning-icon:not(.configuration-warning)'));
  click(resolved, '[data-node="layout-0"]');
  assert.ok(resolved.querySelector('[data-canonical="contents"] + .warning-icon:not(.configuration-warning)'));
  assert.equal(resolved.querySelector('[data-canonical="layouts"] + .warning-icon:not(.configuration-warning)'), null);
  click(resolved, '[data-canonical="contents"]');
  assert.ok(resolved.querySelector('[data-canonical="content"][data-value="parent%20content"] + .warning-icon:not(.configuration-warning)'));
  click(resolved, '[data-canonical="content"][data-value="parent%20content"]');
  assert.ok(resolved.querySelector('[data-canonical="content"][data-value="child%20content"] + .warning-icon:not(.configuration-warning)'));
  assert.equal(resolved.querySelector('#content-detail .field-warning'), null);
  click(resolved, '[data-canonical="field"]');
  assert.match(resolved.querySelector('#content-panel').textContent, /Top-level field definition/);
  assert.match(resolved.querySelector('#content-panel').textContent, /\$\.parent/);
  assert.doesNotMatch(resolved.querySelector('#content-panel').textContent, /Parent content/);
  click(resolved, '[data-canonical="content"][data-value="child%20content"]');
  assert.equal(resolved.querySelectorAll('#content-detail .field-warning').length, 1);
  assert.equal(resolved.querySelector('#content-detail .field-warning').previousElementSibling.textContent, 'missing field');
  for (const [field, parent, fieldPath] of [['child field', 'child content', '$.child'], ['inherited field', 'parent content', '$.inherited']]) {
    click(resolved, '[data-canonical="field"][data-value="'+encodeURIComponent(field)+'"]');
    const panel = resolved.querySelector('#content-panel');
    assert.ok(panel.textContent.includes(fieldPath));
    assert.ok(panel.textContent.includes('Parent content'+parent));
    assert.ok(panel.textContent.includes('Parent layoutparent layout'));
    assert.doesNotMatch(panel.textContent, /Top-level field definition/);
  }
  click(resolved, '[data-canonical="field"][data-value="child%20rows"]');
  assert.equal(resolved.querySelector('[data-canonical="field"][data-value="child%20rows"]').nextElementSibling, null);
  assert.match(resolved.querySelector('#content-panel').textContent, /Iterator reference defined in the Assembly Template/);
  assert.match(resolved.querySelector('#content-panel').textContent, /\$\.children/);
  assert.match(resolved.querySelector('#content-panel').textContent, /Parent contentchild content/);
  assert.match(resolved.querySelector('#content-panel').textContent, /Parent layoutparent layout/);
  assert.doesNotMatch(resolved.querySelector('#content-panel').textContent, /Field path|not found|Top-level/);
  click(resolved, '[data-canonical="field"][data-value="missing%20field"]');
  assert.match(resolved.querySelector('#content-panel').textContent, /associated iteration\/layout/);
  assert.doesNotMatch(resolved.querySelector('#content-panel').textContent, /Top-level field definition|\$\.unrelated/);

  // Once every field resolves, no parent should retain a warning. A conditional
  // cycle must terminate, and inherited fields must not produce false warnings.
  const assemblyFile = path.join(cache, 'packages', 'test-package', 'versions', '1.0', 'AssemblyTemplate.json');
  const assembly = JSON.parse(fs.readFileSync(assemblyFile, 'utf8'));
  assembly.Fields.push({ Name: 'missing field', Path: '$.nowDefined' });
  writeJson(assemblyFile, assembly);
  fs.appendFileSync(path.join(cache, 'contents', 'child content', 'versions', '1.0', 'content.blob'), '$Cond{"Content":"parent content","Condition":"cycle"}');
  await mockupCommand('test-document', { cache, output, package: 'test-package' });
  const healthyDom = new JSDOM(fs.readFileSync(output, 'utf8'), { runScripts: 'dangerously' });
  t.after(() => healthyDom.window.close());
  const healthy = healthyDom.window.document;
  assert.equal(healthy.querySelector('.warning-icon:not(.configuration-warning)'), null);
  click(healthy, '[data-node="layout-0"]');
  click(healthy, '[data-canonical="contents"]');
  click(healthy, '[data-canonical="content"][data-value="parent%20content"]');
  assert.equal(healthy.querySelector('.warning-icon:not(.configuration-warning)'), null);
  click(healthy, '[data-canonical="content"][data-value="child%20content"]');
  assert.equal(healthy.querySelector('.warning-icon:not(.configuration-warning), .field-warning'), null);
  assert.equal(healthy.querySelectorAll('#content-detail .system-field').length, 3);
  for (const name of ['PackagePageNum', 'PackagePageCount', 'GRIDPAGENUMBER']) {
    const field = healthy.querySelector('[data-canonical="field"][data-value="'+name+'"]');
    assert.equal(field.nextElementSibling.textContent, 'System-generated');
    click(healthy, '[data-canonical="field"][data-value="'+name+'"]');
    assert.match(healthy.querySelector('#content-panel').textContent, /System-generated field/);
    assert.match(healthy.querySelector('#content-panel').textContent, /No definition .* is required/);
    assert.doesNotMatch(healthy.querySelector('#content-panel').textContent, /not found|Top-level field definition/);
  }


  // Never-triggered content suppresses its own and nested warnings, including
  // parent indicators. The same rule applies to an entire disabled layout.
  assembly.Fields = [];
  assembly.Documents[0].Layouts = [];
  writeJson(assemblyFile, assembly);
  const layoutFile = path.join(cache, 'layouts', 'parent-layout', 'layout.json');
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  layout.CommunicationLayoutContents[0].CommunicationLayoutConfigCommunicationContentConfigRelRec.CommunicationLayoutConfigCommunicationContentConfigRelInfo.ContentAlwaysTriggerInd = false;
  writeJson(layoutFile, layout);
  for (const disabled of ['content', 'layout']) {
    if (disabled === 'layout') {
      layout.CommunicationLayoutContents[0].CommunicationLayoutConfigCommunicationContentConfigRelRec.CommunicationLayoutConfigCommunicationContentConfigRelInfo.ContentAlwaysTriggerInd = true;
      writeJson(layoutFile, layout);
      const documentFile = path.join(cache, 'documents', 'test-document', 'versions', '1.0.json');
      const doc = JSON.parse(fs.readFileSync(documentFile, 'utf8'));
      doc.CommunicationDocumentVersionLayouts[0].CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo.LayoutAlwaysTriggerInd = false;
      writeJson(documentFile, doc);
    }
    await mockupCommand('test-document', { cache, output, package: 'test-package' });
    const inactiveDom = new JSDOM(fs.readFileSync(output, 'utf8'), { runScripts: 'dangerously' });
    t.after(() => inactiveDom.window.close());
    const inactive = inactiveDom.window.document;
    assert.equal(inactive.querySelector('.warning-icon:not(.configuration-warning)'), null, disabled);
    click(inactive, '[data-node="layout-0"]');
    click(inactive, '[data-canonical="contents"]');
    assert.equal(inactive.querySelector('.warning-icon:not(.configuration-warning)'), null, disabled);
    click(inactive, '[data-canonical="content"][data-value="parent%20content"]');
    assert.equal(inactive.querySelector('.warning-icon:not(.configuration-warning), .field-warning'), null, disabled);
    click(inactive, '[data-canonical="field"]');
    assert.match(inactive.querySelector('#content-panel').textContent, /never triggered/);
    click(inactive, '[data-canonical="content"][data-value="child%20content"]');
    assert.equal(inactive.querySelector('.warning-icon:not(.configuration-warning), .field-warning'), null, disabled);
  }

});

test('AT configuration warnings expose blocked references and alternate placements in the selected version', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-config-warning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache'), output = path.join(root, 'inspector.html');
  const contentRel = (name, always = false) => ({
    ShortName: name,
    CommunicationLayoutConfigCommunicationContentConfigRelRec: {
      CommunicationLayoutConfigCommunicationContentConfigRelInfo: { ContentAlwaysTriggerInd: always },
    },
  });
  const childRel = (uuid, always = true) => ({
    CommunicationLayoutConfigCommunicationLayoutConfigRelRec: {
      CommunicationLayoutConfigCommunicationLayoutConfigRelInfo: { RelCommunicationLayoutConfigUuid: uuid, LayoutAlwaysTriggerInd: always },
    },
  });
  const layout = (uuid, name, contents = [], children = []) => writeJson(path.join(cache, 'layouts', uuid, 'layout.json'), {
    CommunicationLayoutConfigRec: { CommunicationLayoutConfigUuid: uuid, CommunicationLayoutConfigInfo: { ShortName: name, LayoutType: 'Block' } },
    CommunicationLayoutContents: contents, CommunicationLayoutLayouts: children,
  });
  const document = uuid => ({
    CommunicationDocumentConfigRec: { CommunicationDocumentConfigInfo: { ShortName: 'Manual Backcharge' } },
    CommunicationDocumentVersionLayouts: [{
      CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec: {
        CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo: { CommunicationLayoutConfigUuid: uuid, LayoutAlwaysTriggerInd: true },
      },
    }],
  });
  layout('body', 'body', [], [childRel('sidebar'), childRel('disabled', false), childRel('conditioned', false)]);
  layout('sidebar', 'sidebar messages area', [contentRel('next bill notice'), contentRel('unused')]);
  layout('disabled', 'sidebar messages no mtrs', [], [childRel('late')]);
  layout('late', 'late_payment', [contentRel('next bill notice')]);
  layout('conditioned', 'conditioned layout', [contentRel('conditioned content')]);
  layout('old', 'old layout', [contentRel('old content')]);
  writeJson(path.join(cache, 'documents', 'Manual Backcharge', 'versions', '1.0.json'), document('old'));
  writeJson(path.join(cache, 'documents', 'Manual Backcharge', 'versions', '3.0.json'), document('body'));
  const assemblyFile = path.join(cache, 'packages', 'CLP_bills', 'versions', '1.0', 'AssemblyTemplate.json');
  const assembly = { Documents: [{ $$Id: 'Manual Backcharge', Layouts: [
    { $$Id: 'late_payment', Contents: [{ $$Id: 'next bill notice' }] },
    { $$Id: 'old layout', Contents: [{ $$Id: 'old content' }] },
    { $$Id: 'conditioned layout', Condition: 'some condition', Contents: [{ $$Id: 'conditioned content' }] },
  ] }] };
  writeJson(assemblyFile, assembly);
  const generate = async () => {
    await mockupCommand('Manual Backcharge', { cache, output, package: 'CLP_bills' });
    const html = fs.readFileSync(output, 'utf8');
    const model = JSON.parse(html.match(/const m=(.*?),inspector=document\.querySelector/s)[1]);
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    t.after(() => dom.window.close());
    return { model, document: dom.window.document };
  };
  const result = await generate();
  assert.equal(result.model.document.version, '3.0');
  assert.equal(result.model.configurationWarnings.length, 2);
  const issue = result.model.configurationWarnings.find(issue => issue.content === 'next bill notice');
  assert.deepEqual(issue.blockedBy, ['sidebar messages no mtrs']);
  assert.deepEqual(issue.alternativePaths, ['body → sidebar messages area → next bill notice']);
  assert.match(issue.targetPaths[0], /sidebar messages no mtrs → late_payment → next bill notice/);
  assert.match(result.model.configurationWarnings.find(issue => issue.content === 'old content').message, /absent from this document version/);
  const doc = result.document;
  assert.ok(doc.querySelector('[data-node="document"] > .configuration-warning'));
  click(doc, '[data-node="document"] > .configuration-warning');
  assert.match(doc.querySelector('#content-panel').textContent, /old content/);
  const sidebar = [...doc.querySelectorAll('.region')].find(el => el.querySelector('b')?.textContent === 'sidebar messages area');
  click(doc, '[data-node="'+sidebar.dataset.node+'"]');
  assert.ok(doc.querySelector('#detail [data-canonical="contents"] + .configuration-warning'));
  click(doc, '#detail [data-canonical="contents"]');
  assert.ok(doc.querySelector('[data-canonical="content"][data-value="next%20bill%20notice"] + .configuration-warning'));
  assert.equal(doc.querySelector('[data-canonical="content"][data-value="unused"] + .configuration-warning'), null);
  click(doc, '#content-detail .configuration-warning');
  assert.match(doc.querySelector('#content-panel').textContent, /blocked by an inactive layout/);
  assert.match(doc.querySelector('#content-panel').textContent, /AT reference: late_payment → next bill notice/);
  assert.match(doc.querySelector('#content-panel').textContent, /Alternative placement: body → sidebar messages area/);
  // Configuration warnings survive suppression inside the blocked branch.
  const late = [...doc.querySelectorAll('.region')].find(el => el.querySelector('b')?.textContent === 'late_payment');
  click(doc, '[data-node="'+late.dataset.node+'"]');
  click(doc, '#detail [data-canonical="contents"]');
  assert.ok(doc.querySelector('#content-detail .configuration-warning'));

  // Correcting only the AT removes the mismatch. Unreferenced disabled content
  // remains ordinary inactive content rather than generating false warnings.
  assembly.Documents[0].Layouts = [
    { $$Id: 'sidebar messages area', Contents: [{ $$Id: 'next bill notice' }] },
    assembly.Documents[0].Layouts[2],
  ];
  writeJson(assemblyFile, assembly);
  const fixed = await generate();
  assert.deepEqual(fixed.model.configurationWarnings, []);
  assert.equal(fixed.document.querySelector('.configuration-warning'), null);

  // A second active occurrence of the same target layout makes the reference
  // usable even when another occurrence is underneath an inactive ancestor.
  assembly.Documents[0].Layouts[0].$$Id = 'late_payment';
  writeJson(assemblyFile, assembly);
  layout('body', 'body', [], [childRel('sidebar'), childRel('disabled', false), childRel('late'), childRel('conditioned', false)]);
  assert.deepEqual((await generate()).model.configurationWarnings, []);

  // A missing content pair still flags its existing target layout, even if
  // there is no alternative placement to annotate.
  assembly.Documents[0].Layouts[0] = { $$Id: 'sidebar messages area', Contents: [{ $$Id: 'missing content' }] };
  writeJson(assemblyFile, assembly);
  const missing = await generate();
  assert.equal(missing.model.configurationWarnings.length, 1);
  assert.match(missing.model.configurationWarnings[0].message, /absent from this document version/);
  const missingSidebar = [...missing.document.querySelectorAll('.region')].find(el => el.querySelector('b')?.textContent === 'sidebar messages area');
  assert.ok(missingSidebar.querySelector(':scope > .configuration-warning'));
});
