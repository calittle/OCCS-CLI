import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stripHtmlTags } from '../lib/textMarkup.js';
import { credentialSourceLabel } from '../lib/credentials.js';
import { parseContentBlobs } from '../lib/blobUtils.js';

test('text extraction removes tags formed by stripping nested markup', () => {
  assert.equal(stripHtmlTags('<scr<script>ipt>alert(1)</scr</script>ipt>'), 'alert(1)');
  assert.equal(stripHtmlTags('<span>Amount</span> <b>due</b>'), 'Amount due');
  assert.equal(stripHtmlTags('a &lt;= 0 &amp;&amp; b &gt; 1'), 'a &lt;= 0 &amp;&amp; b &gt; 1');
  assert.equal(stripHtmlTags('amount < 10'), 'amount < 10');
});

test('password diagnostics emit fixed labels even for unexpected metadata', () => {
  for (const [source, expected] of [
    [undefined, 'unset'], ['unset', 'unset'], ['cli:password', 'command line'],
    ['prompt:password', 'interactive prompt'], ['session:encrypted', 'encrypted session'],
    ['process.env:OCCS_PASSWORD', 'process environment'],
    ['env-file:/private/user/.env:OCCS_PASSWORD', 'environment file'],
    ['decrypted:env-file:/private/user/.env:OCCS_PASSWORD_ENC+process.env:OCCS_PASSWORD_KEY', 'encrypted environment'],
    ['secret-password', 'unknown'], [{ password: 'secret-password' }, 'unknown'],
    ['env-file:secret-password\nInjected log line', 'environment file'],
  ]) assert.equal(credentialSourceLabel(source), expected);
});

test('blob parsing decodes one entity layer while preserving literal entity names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-entities-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = path.join(root, 'contents', 'example', 'versions', '1.0');
  fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(path.join(version, 'content.blob'),
    '&lt;comms-data&gt;$Data{&quot;Id&quot;:&quot;field&amp;nbsp;name&quot;}&lt;/comms-data&gt;' +
    '&lt;comms-data&gt;$Data{&quot;Id&quot;:&quot;ordinary&nbsp;field&quot;}&lt;/comms-data&gt;' +
    '&lt;comms-cond&gt;$Cond{&quot;Content&quot;:&quot;child&amp;nbsp;content&quot;,&quot;Condition&quot;:&quot;balance &lt;= 0 &amp;&amp; active&quot;}&lt;/comms-cond&gt;');
  const { usageMap, contentRefs } = parseContentBlobs(root);
  assert.equal(usageMap['field&nbsp;name'][0].type, 'data');
  assert.equal(usageMap['ordinary field'][0].type, 'data');
  assert.equal(usageMap['field name'], undefined);
  assert.equal(contentRefs[0].targetContentId, 'child&nbsp;content');
  assert.equal(contentRefs[0].raw.Condition, 'balance <= 0 && active');
});
