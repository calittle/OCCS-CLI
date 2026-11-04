import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareSnapshots, renderComparisonMarkdown } from '../lib/resourceCompare.js';
import { ResourceReader, RESOURCE_SPECS } from '../lib/resourceCompareSources.js';

const snapshot = (record, extra = {}) => ({ type: 'content', name: 'Example', version: '1.0', source: 'test', record, artifacts: [], issues: [], ...extra });
const active = { Items: [{ StatusCode: 'Active', EffDtTm: '2026-01-01' }] };
const versionRec = (prefix, version, id = version) => ({ [`${prefix}VersionConfigUuid`]: id,
  [`${prefix}VersionConfigInfo`]: { ShortName: version, Desc: `Description ${version}` }, Status: active });

function cacheFixture(t, type = 'content') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-compare-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = RESOURCE_SPECS[type], prefix = spec.prefix;
  const dir = path.join(root, spec.folder, 'Example');
  const save = (relative, value) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const master = { [`${prefix}ConfigRec`]: { [`${prefix}ConfigUuid`]: 'owner', [`${prefix}ConfigInfo`]: { ShortName: 'Example', ContentType: 'HTML' } } };
  if (spec.versions) {
    master[spec.versions] = ['1.0', '2.0'].map(v => ({ [`${prefix}VersionConfigRec`]: versionRec(prefix, v) }));
    save('Example_master.json', master);
    for (const v of ['1.0', '2.0']) {
      const rec = versionRec(prefix, v);
      if (type === 'content') rec[`${prefix}VersionConfigInfo`].CommunicationContentVersionConfigData = { Items: [
        { ContentData: { FileId: `id-${v}`, Location: `body/${v}` }, StyleClassName: ['body'] }] };
      const expanded = { [`${prefix}VersionConfigRec`]: rec, [`${prefix}VersionStyles`]: [] };
      if (type === 'document') save(`versions/${v}.json`, expanded);
      else {
        save(`versions/${v}/${v}.json`, rec);
        save(`versions/${v}/${v}_expanded.json`, expanded);
      }
      if (type === 'content') save(`versions/${v}/id-${v}.blob`, `<p>${v === '1.0' ? 'Before' : 'After'}</p><comms-data>$Data{"Id":"${v === '1.0' ? 'Name' : 'Account'}"}</comms-data>`);
      if (type === 'package') save(`versions/${v}/AssemblyTemplate.json`, { Documents: [{ '$$Id': 'Doc', Condition: v === '1.0' ? '@.a' : '@.b' }] });
    }
  } else save('Example.json', master);
  return { root, dir, save, master };
}

test('semantic matching handles additions, removals, reorder and duplicate placements without data loss', () => {
  const before = snapshot({ Documents: [{ '$$Id': 'A', Condition: 'one' }, { '$$Id': 'B' }, { '$$Id': 'Gone' }] });
  const after = snapshot({ Documents: [{ '$$Id': 'B' }, { '$$Id': 'A', Condition: 'two' }, { '$$Id': 'New' }] });
  const report = compareSnapshots(before, after);
  assert.deepEqual(report.summary, { added: 1, removed: 1, changed: 1, reordered: 1 });
  assert.match(report.changes.find(c => c.kind === 'changed').path, /A/);
  const duplicate = compareSnapshots(snapshot({ Rows: [{ Name: 'same', Value: 1 }, { Name: 'same', Value: 2 }] }),
    snapshot({ Rows: [{ Name: 'same', Value: 1 }, { Name: 'same', Value: 3 }] }));
  assert.equal(duplicate.changes[0].before, 2);
  assert.equal(duplicate.changes[0].after, 3);
});

test('owner identities and transport are ignored, references and authored whitespace are preserved', () => {
  const before = snapshot({ CommunicationContentVersionConfigRec: { CommunicationContentVersionConfigUuid: 'old',
    CommunicationContentVersionConfigInfo: { ShortName: '1', Text: 'a  b', ConfigId: '41', ContentData: { Location: 'token-old' } } },
    Ref: { CommunicationStyleConfigUuid: 'style-a' } }, { ownerIds: ['old'] });
  const after = snapshot({ CommunicationContentVersionConfigRec: { CommunicationContentVersionConfigUuid: 'new',
    CommunicationContentVersionConfigInfo: { ShortName: '2', Text: 'a b', ConfigId: '42', ContentData: { Location: 'token-new' } } },
    Ref: { CommunicationStyleConfigUuid: 'style-b' } }, { ownerIds: ['new'] });
  const report = compareSnapshots(before, after);
  assert.equal(report.changes.length, 2);
  assert.equal(report.metadataChanges.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /token-old|token-new/);
});

test('HTML reports capture field/condition/loop/formatting changes and binary bytes', () => {
  const a = snapshot({}, { artifacts: [{ label: 'body', text: true, html: true, bytes: Buffer.from('<p>A</p><comms-data>$Data{"Id":"A"}</comms-data>') }] });
  const b = snapshot({}, { artifacts: [{ label: 'body', text: true, html: true, bytes: Buffer.from('<p class="bold">B</p><comms-data>$Data{"Id":"B"}</comms-data>') }] });
  const report = compareSnapshots(a, b);
  assert.ok(report.changes.some(c => c.path.includes('fieldBindings')));
  assert.ok(report.changes.some(c => c.path.includes('markup')));
  const binary = compareSnapshots(snapshot({}, { artifacts: [{ label: 'image', bytes: Buffer.from([0, 1]) }] }),
    snapshot({}, { artifacts: [{ label: 'image', bytes: Buffer.from([0, 2]) }] }));
  assert.ok(binary.changes.some(c => c.path.includes('sha256')));
});

test('incomplete data never establishes equivalence; Markdown is stable and fences arbitrary content', () => {
  const report = compareSnapshots(snapshot({ Text: '```\n# unsafe' }, { issues: ['body missing'] }), snapshot({ Text: 'changed' }));
  assert.equal(report.result, 'incomplete');
  assert.equal(report.complete, false);
  const md = renderComparisonMarkdown(report);
  for (const heading of ['Summary', 'Detailed changes', 'Metadata changes', 'Completeness and scope', 'Comparison details']) assert.ok(md.includes(`## ${heading}`));
  assert.ok(renderComparisonMarkdown(report, { includeTechnical: true }).includes('````'));
  assert.ok(!md.includes('Technical evidence'));
  assert.equal(md, renderComparisonMarkdown(report));
  assert.equal(compareSnapshots(snapshot({}), snapshot({})).result, 'equivalent');
});

test('cache reader compares expanded content styles and bodies, including inactive versions', async t => {
  const { root, save, master } = cacheFixture(t);
  master.CommunicationContentMasterVersions[0].CommunicationContentVersionConfigRec.Status = { Items: [{ StatusCode: 'Inactive' }] };
  save('Example_master.json', master);
  const reader = await new ResourceReader('content', 'Example', { cache: root }).open();
  assert.equal(reader.versions().versions.length, 2);
  const before = await reader.snapshot('1.0'), after = await reader.snapshot('2.0');
  const report = compareSnapshots(before, after);
  assert.equal(report.complete, true);
  assert.equal(report.result, 'different');
  assert.ok(report.changes.some(c => c.path.includes('fieldBindings')));
  fs.unlinkSync(path.join(root, 'contents/Example/versions/2.0/id-2.0.blob'));
  const incomplete = compareSnapshots(before, await reader.snapshot('2.0'));
  assert.equal(incomplete.result, 'incomplete');
  assert.ok(!incomplete.changes.some(change => change.kind === 'removed' && change.path.startsWith('Artifacts')));
  await assert.rejects(reader.snapshot('missing'), /Available versions: 1.0, 2.0/);
});

test('readers support every resource type and retain package AT changes', async t => {
  for (const type of ['document', 'package', 'chart', 'layout', 'style', 'font']) {
    const { root } = cacheFixture(t, type);
    const reader = await new ResourceReader(type, 'Example', { cache: root }).open();
    const a = await reader.snapshot(RESOURCE_SPECS[type].versions ? '1.0' : undefined);
    const b = await reader.snapshot(RESOURCE_SPECS[type].versions ? '2.0' : undefined);
    const report = compareSnapshots(a, b);
    if (type === 'package') {
      assert.equal(report.complete, true);
      assert.ok(report.changes.some(change => change.path.includes('Condition')));
    } else if (type !== 'font') assert.equal(report.result, 'equivalent', type);
    else assert.equal(report.result, 'incomplete');
  }
});

test('live source uses explicit version UUIDs, reads all data and never mutates', async () => {
  const prefix = 'CommunicationContent';
  const master = { CommunicationContentConfigRec: { CommunicationContentConfigUuid: 'owner', CommunicationContentConfigInfo: { ContentType: 'HTML' } },
    CommunicationContentMasterVersions: [{ CommunicationContentVersionConfigRec: versionRec(prefix, 'Draft', 'version-id') }] };
  const calls = [];
  const reader = await new ResourceReader('content', 'Example', {
    session: { baseUrl: 'https://example.test', token: 'hidden' },
    lookup: async () => ({ CommunicationContentConfigRec: { CommunicationContentConfigUuid: 'owner' } }),
    apiGet: async (_session, endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith('MasterConfig/owner')) return master;
      return { CommunicationContentVersionConfigRec: { CommunicationContentVersionConfigUuid: 'version-id',
        CommunicationContentVersionConfigInfo: { ShortName: 'Draft', CommunicationContentVersionConfigData: { Items: [
          { ContentData: { Location: 'body/id', FileId: 'blob' } }] } } }, CommunicationContentVersionStyles: [] };
    }, binaryGet: async url => { assert.equal(url, 'https://example.test/api/CommunicationContent/v1/body/id'); return Buffer.from('<p>Hello</p>'); },
  }).open();
  const result = await reader.snapshot('Draft');
  assert.equal(result.issues.length, 0);
  assert.equal(result.artifacts.length, 1);
  assert.ok(calls.includes('/api/CommunicationContent/v1/CommunicationContentVersionMasterConfig/version-id'));
  assert.doesNotMatch(JSON.stringify(result), /hidden/);
});

test('CLI produces clean JSON/Markdown, saves output, and returns a distinct incomplete status', t => {
  const { root } = cacheFixture(t);
  const cli = fileURLToPath(new URL('../bin/occs.js', import.meta.url));
  const args = [cli, 'compare', 'content', 'Example', '--cache', root, '--from-version', '1.0', '--to-version', '2.0'];
  let run = spawnSync(process.execPath, [...args, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).report.result, 'different');
  const output = path.join(root, 'report.md');
  run = spawnSync(process.execPath, [...args, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, fs.readFileSync(output, 'utf8'));
  assert.ok(run.stdout.startsWith('# Resource comparison'));
  fs.unlinkSync(path.join(root, 'contents/Example/versions/2.0/id-2.0.blob'));
  run = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).report.complete, false);
  run = spawnSync(process.execPath, [cli, 'compare', 'content', 'Example', '--json', '--from-cache', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).ok, false);
});

test('malformed and legacy caches cannot establish equivalence; non-blob content compares its definition', async t => {
  const pkg = cacheFixture(t, 'package');
  fs.unlinkSync(path.join(pkg.dir, 'versions/1.0/1.0_expanded.json'));
  const packages = await new ResourceReader('package', 'Example', { cache: pkg.root }).open();
  assert.equal(compareSnapshots(await packages.snapshot('1.0'), await packages.snapshot('2.0')).result, 'incomplete');
  const content = cacheFixture(t);
  content.save('versions/1.0/1.0_expanded.json', {});
  const contents = await new ResourceReader('content', 'Example', { cache: content.root }).open();
  const missingDetails = await contents.snapshot('1.0');
  assert.ok(missingDetails.issues.some(issue => issue.includes('version details')));
  assert.equal(compareSnapshots(missingDetails, await contents.snapshot('2.0')).result, 'incomplete');
  assert.ok(!compareSnapshots(missingDetails, await contents.snapshot('2.0')).changes.some(change => change.path.startsWith('$.')));
  const style = cacheFixture(t, 'style');
  style.save('Example.json', {});
  await assert.rejects(new ResourceReader('style', 'Example', { cache: style.root }).open(), /missing its properties/);
  content.master.CommunicationContentConfigRec.CommunicationContentConfigInfo.ContentType = 'Link';
  content.save('Example_master.json', content.master);
  for (const v of ['1.0', '2.0']) content.save(`versions/${v}/${v}_expanded.json`, {
    CommunicationContentVersionConfigRec: versionRec('CommunicationContent', v),
    CommunicationContentVersionStyles: [], Link: { href: 'https://example.test', LinkText: 'Read more' },
  });
  const links = await new ResourceReader('content', 'Example', { cache: content.root }).open();
  assert.equal(compareSnapshots(await links.snapshot('1.0'), await links.snapshot('2.0')).result, 'equivalent');
  const changed = compareSnapshots(snapshot({ Link: { href: 'https://example.test/old', Location: 'old target' } }),
    snapshot({ Link: { href: 'https://example.test/new', Location: 'new target' } }));
  assert.equal(changed.summary.changed, 2, 'Authored link URLs and locations must remain significant');
});
