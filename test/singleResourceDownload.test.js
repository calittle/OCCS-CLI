import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { downloadSingleResource } from '../lib/singleResourceDownload.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/occs.js', import.meta.url));

test('single-resource CLI commands preserve siblings and replace only the fetched resource', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-single-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.searchParams.has('whr')) {
      const name = JSON.parse(url.searchParams.get('whr')).a[0].t[2].slice(1, -1);
      const type = /\/([^/]+)ConfigRec$/.exec(url.pathname)[1];
      const record = { [`${type}ConfigUuid`]: name, [`${type}ConfigInfo`]: { ShortName: name } };
      const item = type === 'CommunicationFont' ? record : { [`${type}ConfigRec`]: record };
      response.end(JSON.stringify({ HasMore: false, Items: name === 'missing' ? [] : [item] }));
    } else if (url.pathname.endsWith('/fail')) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Simulated failed artifact request' }));
    } else if (url.pathname.includes('CommunicationLayoutMasterConfig')) {
      const name = decodeURIComponent(url.pathname.split('/').at(-1));
      response.end(JSON.stringify({ CommunicationLayoutConfigRec: {
        CommunicationLayoutConfigUuid: name, CommunicationLayoutConfigInfo: { ShortName: name },
      } }));
    } else {
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sessionKey = 'test.test/test';
  fs.writeFileSync(path.join(root, '.occs-session.json'), JSON.stringify({
    currentSessionKey: sessionKey,
    sessions: { [sessionKey]: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test' } },
  }));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  for (const type of ['package', 'document', 'layout', 'content', 'font', 'style', 'chart']) {
    await t.test(type, async () => {
      const output = path.join(root, `${type}s`);
      fs.mkdirSync(output);
      for (const name of ['selector ec detail4', 'EC detail PRO']) {
        fs.mkdirSync(path.join(output, name));
        fs.writeFileSync(path.join(output, name, 'stale.txt'), 'old cached resource');
      }
      for (const name of ['EC detail PRO', 'selector ec detail4', 'EC detail PRO']) {
        await run(process.execPath, [cli, `get-${type}`, name, '--output', output], { env });
        assert.deepEqual(fs.readdirSync(output).sort(), ['EC detail PRO', 'selector ec detail4']);
        assert.equal(fs.existsSync(path.join(output, name, 'stale.txt')), false);
        assert.ok(fs.readdirSync(path.join(output, name)).length > 0);
      }
      const before = fs.readdirSync(output);
      await assert.rejects(run(process.execPath, [cli, `get-${type}`, 'missing', '--output', output], { env }));
      assert.deepEqual(fs.readdirSync(output), before);
    });
  }
  const contentOutput = path.join(root, 'contents');
  await assert.rejects(run(process.execPath, [cli, 'get-content', 'fail', '--output', contentOutput], { env }));
  assert.deepEqual(fs.readdirSync(contentOutput).sort(), ['EC detail PRO', 'selector ec detail4']);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.occs-resource-')), false);
});

test('a failed cache replacement restores the previous resource', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-single-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'contents');
  const target = path.join(output, 'EC detail PRO');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'original.blob'), 'original');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (source.includes(`${path.sep}download${path.sep}`)) throw new Error('Simulated rename failure');
    return rename(source, destination);
  });
  await assert.rejects(downloadSingleResource(output, async (staging) => {
    const resource = path.join(staging, 'EC detail PRO');
    fs.mkdirSync(resource);
    fs.writeFileSync(path.join(resource, 'new.blob'), 'new');
    return true;
  }), /Simulated rename failure/);
  assert.equal(fs.readFileSync(path.join(target, 'original.blob'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['contents']);
});

test('failed and interrupted downloads retain the original resource and clean staging', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-single-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'contents');
  const original = path.join(output, 'EC detail PRO', 'original.blob');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'original');
  for (const mode of ['false', 'throw', 'empty', 'multiple']) {
    await assert.rejects(downloadSingleResource(output, async (staging) => {
      if (mode !== 'empty') {
        fs.mkdirSync(path.join(staging, 'EC detail PRO'));
        fs.writeFileSync(path.join(staging, 'EC detail PRO', 'new.blob'), 'partial');
      }
      if (mode === 'throw') throw new Error('Interrupted');
      if (mode === 'multiple') fs.mkdirSync(path.join(staging, 'unrequested'));
      return mode !== 'false';
    }));
    assert.equal(fs.readFileSync(original, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(root), ['contents']);
  }
});
