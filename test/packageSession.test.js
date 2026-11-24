import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Exercise the actual CLI parser: direct handler calls miss parent-option loss.
for (const args of [['list'], ['get', 'Bill'], ['save', 'BUNDLE', '--config-id', '442', '--dry-run']]) {
  test(`package ${args[0]} preserves the explicitly selected parent session`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-package-session-'));
    try {
      const script = `
        import axios from 'axios';
        import { saveSession } from './lib/session.js';
        saveSession({customer:'example',region:'region',tenancy:'prod',baseUrl:'https://example.invalid/prod',token:'synthetic'}, {sessionName:'current'});
        axios.defaults.adapter=async()=>{throw new Error('WRONG_SESSION_REQUEST');};
        process.argv=['node','occs','package','--session','missing-np',...${JSON.stringify(args)},'--json'];
        await import('./bin/occs.js');
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8',
        env: {...process.env, HOME:home, USERPROFILE:home},
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const result = JSON.parse(run.stdout);
      assert.match(result.error.message, /missing-np/);
      assert.doesNotMatch(result.error.message, /WRONG_SESSION_REQUEST/);
    } finally {
      fs.rmSync(home, {recursive:true, force:true});
    }
  });
}

test('package save dry run resolves Config 442 in np even when current session is prod', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-package-save-session-'));
  try {
    for (const [name, value] of Object.entries({
      'occs-package.json':{schemaVersion:'occs-package-bundle/v1',package:{shortName:'Bill'},version:{shortName:'1'}},
      'assembly-template.json':{}, 'version-master.json':{},
    })) fs.writeFileSync(path.join(home, name), JSON.stringify(value));
    const script = `
      import assert from 'node:assert/strict';
      import axios from 'axios';
      import { saveSession } from './lib/session.js';
      for (const [alias,tenancy] of [['np','non-prod'],['current','prod']]) {
        saveSession({customer:'example',region:'region',tenancy,baseUrl:'https://example.invalid/'+tenancy,token:'synthetic'}, {sessionName:alias});
      }
      axios.defaults.adapter=async c=>{
        assert.equal(c.method,'get');
        assert.ok(c.url.includes('/non-prod/api/ConfigurationId/'), 'must read selected np session');
        return {status:200,headers:{},config:c,data:{Items:[{ConfigurationId:'442',ConfigurationInfo:{ShortName:'2026-11-24-AL'}}],HasMore:false}};
      };
      process.argv=['node','occs','package','--session','np','save',${JSON.stringify(home)},'--config-id','442','--dry-run','--json'];
      await import('./bin/occs.js');
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd:new URL('..', import.meta.url), encoding:'utf8', env:{...process.env,HOME:home,USERPROFILE:home},
    });
    assert.equal(run.status,0,run.stdout+run.stderr);
    const result=JSON.parse(run.stdout);
    assert.equal(result.ok,true);
    assert.equal(result.configId.resolved,'442');
    assert.equal(result.dryRun,true);
    assert.deepEqual(result.uploaded,{versionMaster:false,assemblyTemplate:false});
  } finally {
    fs.rmSync(home,{recursive:true,force:true});
  }
});
