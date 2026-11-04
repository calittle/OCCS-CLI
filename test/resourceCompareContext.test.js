import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareSnapshots, renderComparisonMarkdown } from '../lib/resourceCompare.js';
import { ResourceReader } from '../lib/resourceCompareSources.js';

const ids = { layout: '11111111111111111111111111111111', style: '22222222222222222222222222222222', content: '33333333333333333333333333333333', next: '44444444444444444444444444444444' };
const snapshot = (record, extra = {}) => ({ type: 'document', name: 'Bill', version: '1.0', source: 'Test', record, issues: [], artifacts: [], ...extra });
const layout = (position, always = true) => ({
  CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec: {
    CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo: { CommunicationLayoutConfigUuid: ids.layout, LayoutRelIndex: position, LayoutPlacement: 'Header', LayoutAlwaysTriggerInd: always } },
  CommunicationLayoutConfigRec: { CommunicationLayoutConfigUuid: ids.layout, CommunicationLayoutConfigInfo: { ShortName: 'Account summary', Desc: 'Customer account header' } },
});

test('document report names the layout, placement and actual inclusion change instead of exposing UUIDs', () => {
  const report = compareSnapshots(snapshot({ CommunicationDocumentVersionLayouts: [layout(1)] }), snapshot({ CommunicationDocumentVersionLayouts: [layout(3, false)] }));
  const md = renderComparisonMarkdown(report);
  assert.match(md, /Layout “Account summary” moved within Document “Bill”/);
  assert.match(md, /position 3; placement Header/);
  assert.match(md, /Always included when its parent is included/);
  assert.match(md, /Conditional inclusion/);
  assert.doesNotMatch(md, /11111111111111111111111111111111|CommunicationDocumentVersionConfig|\$\./);
  assert.match(JSON.stringify(report.changes), /LayoutRelIndex/);
  const technical = renderComparisonMarkdown(report, { includeTechnical: true });
  assert.match(technical, /Technical evidence/);
  assert.match(technical, /CommunicationDocumentVersion/);
});

test('style property changes explain the attribute and named style, not the array slot', () => {
  const record = value => ({ CommunicationContentVersionStyles: [{
    CommunicationStyleConfigRec: { CommunicationStyleConfigUuid: ids.style, CommunicationStyleConfigInfo: {
      ShortName: 'Heading', CommunicationStyleConfigStyleAttribute: { HasMore: false, Layers: 0, TotalResults: 1,
        Items: [{ StyleAttributeName: 'Font-family', StyleAttributeValue: value }] } } },
  }] });
  const report = compareSnapshots(snapshot(record('Arial'), { type: 'content', name: 'BillHeader' }), snapshot(record('MingLiU'), { type: 'content', name: 'BillHeader' }));
  const md = renderComparisonMarkdown(report);
  assert.match(md, /Font-family changed for Style “Heading”/);
  assert.match(md, /Arial/);
  assert.match(md, /MingLiU/);
  assert.doesNotMatch(md, /StyleAttributeValue|Items\[|22222222222222222222222222222222/);
});

test('HTML report separates text, field binding and formatting without repeating the entire body', () => {
  const content = html => snapshot({}, { type: 'content', name: 'BillHeader', artifacts: [{ label: 'Content body 1', bytes: Buffer.from(html), text: true, html: true }] });
  const report = compareSnapshots(content('<p>Amount due: <comms-data>$Data{"Id":"Balance"}</comms-data></p>'),
    content('<p class="highlight">Total due: <comms-data>$Data{"Id":"TotalDue"}</comms-data></p>'));
  const md = renderComparisonMarkdown(report);
  assert.match(md, /Authored text changed/);
  assert.match(md, /Field binding changed in Paragraph 1/);
  assert.match(md, /Field: Balance/);
  assert.match(md, /Field: TotalDue/);
  assert.match(md, /Paragraph 1: style class changed/);
  assert.doesNotMatch(md, /<comms-data>|textAndPayloads|Artifacts\\\[|\.markup/);
  assert.equal(report.insights.length, 3);
  const crlf = compareSnapshots(content('<p>Same</p>\r\n'), content('<p>Same</p>\n'));
  assert.equal(crlf.result, 'equivalent');
  assert.equal(crlf.insights.length, 0);
});

test('conditions, loop names and fields inside a loop retain their business context', () => {
  const html = (condition, loop, field) => `<p><comms-cond>$Cond${JSON.stringify({ Condition: condition, Text: 'Discount applies' })}</comms-cond></p><p><comms-loop><comms-data>$Data{"Id":"${loop}"}</comms-data><comms-data>$Data{"Id":"${field}"}</comms-data></comms-loop></p>`;
  const body = text => snapshot({}, { type: 'content', artifacts: [{ label: 'Body', text: true, html: true, bytes: Buffer.from(text) }] });
  const report = compareSnapshots(body(html('Balance > 0', 'Charges', 'Amount')), body(html('Balance > 100', 'BillLines', 'NetAmount')));
  const md = renderComparisonMarkdown(report);
  assert.match(md, /Conditional content changed/);
  assert.match(md, /Balance &gt; 100/);
  assert.match(md, /Repeated section changed/);
  assert.match(md, /BillLines/);
  assert.match(md, /NetAmount/);
});

test('API wrapper and configuration chatter does not become functional or lifecycle noise', () => {
  const record = (config, attributes) => ({ CommunicationStyleConfigRec: { ConfigId: config, ConfigIdShortName: `dev${config}`, ConfigIdStatus: 'Closed',
    Status: { HasMore: false, Layers: 0, Links: [{ href: `api/${config}` }], Items: [{ StatusCode: 'Active', EffDtTm: '2026-01-01', ConfigId: config }] },
    CommunicationStyleConfigInfo: { ShortName: 'Heading', CommunicationStyleConfigStyleAttribute: attributes } } });
  const attrs = [{ StyleAttributeName: 'Font-family', StyleAttributeValue: 'Arial' }, { StyleAttributeName: 'Font-size', StyleAttributeValue: '12pt' }];
  const report = compareSnapshots(snapshot(record('1', { HasMore: false, TotalResults: 2, Layers: 0, Items: attrs })), snapshot(record('2', [...attrs].reverse())));
  assert.equal(report.result, 'equivalent');
  assert.equal(report.insights.length, 0);
  assert.equal(report.metadataInsights.length, 0);
});

test('declared positions outrank API response order; duplicate placements retain their position context', () => {
  const one = layout(1), two = layout(2);
  const unchanged = compareSnapshots(snapshot({ CommunicationDocumentVersionLayouts: [one, two] }), snapshot({ CommunicationDocumentVersionLayouts: [two, one] }));
  assert.equal(unchanged.result, 'equivalent');
  const changed = structuredClone(two);
  changed.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo.LayoutPlacement = 'Footer';
  const report = compareSnapshots(snapshot({ CommunicationDocumentVersionLayouts: [one, two] }), snapshot({ CommunicationDocumentVersionLayouts: [one, changed] }));
  assert.match(renderComparisonMarkdown(report), /position 2; placement Footer/);
});

test('cache reference-only associations resolve names from sibling metadata, with no remote lookup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-context-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (relative, data) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  save('layouts/Body/Body.json', { CommunicationLayoutConfigRec: { CommunicationLayoutConfigUuid: ids.layout, CommunicationLayoutConfigInfo: { ShortName: 'Body' } },
    CommunicationLayoutContents: [{ ShortName: 'Account details', CommunicationLayoutConfigCommunicationContentConfigRelRec: {
      CommunicationLayoutConfigCommunicationContentConfigRelInfo: { CommunicationContentConfigUuid: ids.content, ContentRelIndex: 1, CommunicationLayoutConfigUuid: ids.layout } } }],
    CommunicationLayoutStyles: [{ CommunicationLayoutConfigCommunicationStyleConfigRelRec: {
      CommunicationLayoutConfigCommunicationStyleConfigRelInfo: { CommunicationStyleConfigUuid: ids.style, StyleRelIndex: 1, StyleClassName: 'heading' } } }] });
  save('styles/Heading/Heading.json', { CommunicationStyleConfigRec: { CommunicationStyleConfigUuid: ids.style, CommunicationStyleConfigInfo: { ShortName: 'Heading', Name: 'Large bill heading' } } });
  const reader = await new ResourceReader('layout', 'Body', { cache: root, apiGet: () => assert.fail('Offline lookup must stay offline') }).open();
  const result = await reader.snapshot();
  assert.equal(result.referenceNames[ids.style].name, 'Heading');
  assert.equal(result.referenceNames[ids.content].name, 'Account details');
});

test('missing labels explain uncertainty instead of printing identifiers or inventing a name', () => {
  const before = snapshot({ Ref: { CommunicationStyleConfigUuid: ids.style } });
  const after = snapshot({ Ref: { CommunicationStyleConfigUuid: ids.next } });
  const md = renderComparisonMarkdown(compareSnapshots(before, after));
  assert.match(md, /Style reference changed/);
  assert.match(md, /names could not be resolved/);
  assert.doesNotMatch(md, /22222222222222222222222222222222|44444444444444444444444444444444/);
});

test('live lookup enriches a missing style name without changing the comparison definition', async () => {
  const record = { CommunicationLayoutConfigRec: { CommunicationLayoutConfigUuid: ids.layout, CommunicationLayoutConfigInfo: { ShortName: 'Body' } },
    CommunicationLayoutStyles: [{ CommunicationLayoutConfigCommunicationStyleConfigRelRec: {
      CommunicationLayoutConfigCommunicationStyleConfigRelInfo: { CommunicationStyleConfigUuid: ids.style, StyleRelIndex: 1 } } }] };
  const calls = [];
  const reader = await new ResourceReader('layout', 'Body', { session: { baseUrl: 'https://example.test' },
    lookup: async () => ({ CommunicationLayoutConfigRec: { CommunicationLayoutConfigUuid: ids.layout } }),
    apiGet: async (_session, endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith(`CommunicationLayoutMasterConfig/${ids.layout}`)) return record;
      assert.ok(endpoint.endsWith(`CommunicationStyleConfigRec/${ids.style}`));
      return { CommunicationStyleConfigUuid: ids.style, CommunicationStyleConfigInfo: { ShortName: 'Heading' } };
    },
  }).open();
  const value = await reader.snapshot();
  assert.equal(value.referenceNames[ids.style].name, 'Heading');
  assert.equal(value.record, record);
  assert.equal(calls.length, 2);
});

test('new fields retain mapping context and nested layout names do not overwrite parent names', () => {
  const before = snapshot({ AssemblyTemplate: { Documents: [{ '$$Id': 'Invoice', Layouts: [{ '$$Id': 'Charges', Contents: [{ '$$Id': 'Rows', Iteration: { Name: 'ChargeRows', Fields: [] } }] }] }] } });
  const after = structuredClone(before);
  after.record.AssemblyTemplate.Documents[0].Layouts[0].Contents[0].Iteration.Fields.push({ Name: 'Total', Path: '$.amount', Mandatory: true });
  const md = renderComparisonMarkdown(compareSnapshots(before, after));
  assert.match(md, /Iteration “ChargeRows”/);
  assert.match(md, /Data path: \$\.amount/);
  assert.match(md, /Required: Yes/);
});
