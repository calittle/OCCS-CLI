import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { ExportResumeState, resumeArtifact } from '../lib/exportResume.js';

test('resume state skips only verified completed artifact directories', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-export-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'packages', 'sample');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'sample.json'), '{"first":true}');

  const initial = new ExportResumeState(root, false);
  initial.markComplete('packages', 'uuid-1', { version: 1 }, artifactDir);

  const resumed = new ExportResumeState(root, true);
  assert.equal(resumed.shouldSkip('packages', 'uuid-1', { version: 1 }, artifactDir), true);
  assert.equal(resumed.shouldSkip('packages', 'uuid-1', { version: 2 }, artifactDir), false);

  fs.writeFileSync(path.join(artifactDir, 'sample.json'), '{"first":false}');
  assert.equal(resumed.shouldSkip('packages', 'uuid-1', { version: 1 }, artifactDir), false);
});

test('interrupted artifact remains pending and is retried', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-export-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'styles', 'sample');
  fs.mkdirSync(artifactDir, { recursive: true });
  const state = new ExportResumeState(root, false);

  const result = await resumeArtifact(state, 'styles', 'uuid-2', { version: 1 }, artifactDir, async () => false);
  assert.equal(result.ok, false);
  assert.equal(new ExportResumeState(root, true).shouldSkip('styles', 'uuid-2', { version: 1 }, artifactDir), false);
});
