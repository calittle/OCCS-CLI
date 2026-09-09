import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

test('CLI banner and --version report the package version', () => {
  const output = execFileSync(process.execPath, ['bin/occs.js', '--version'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  assert.match(output, new RegExp(`OCCS CLI ${version.replaceAll('.', '\\.')} 🚀`));
  assert.match(output, new RegExp(`^${version.replaceAll('.', '\\.')}$`, 'm'));
});
