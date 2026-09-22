import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureDir } from './utils.js';

const MANIFEST_FILE = 'get-everything-state.json';
const SCHEMA_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function sourceFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        const size = fs.statSync(fullPath).size;
        if (size > 0) files.push({ path: path.relative(root, fullPath), size, sha256: crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex') });
      }
    }
  };
  visit(root);
  return files.sort();
}

function filesStillPresent(root, files) {
  return Array.isArray(files) && files.length > 0 && files.every((file) => {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') return false;
    const fullPath = path.join(root, file.path);
    return fs.existsSync(fullPath)
      && fs.statSync(fullPath).isFile()
      && fs.statSync(fullPath).size === file.size
      && crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex') === file.sha256;
  });
}

export class ExportResumeState {
  constructor(baseDir, resume) {
    this.baseDir = path.resolve(baseDir);
    this.manifestPath = path.join(this.baseDir, MANIFEST_FILE);
    ensureDir(this.baseDir);
    this.state = resume ? this.load() : { schemaVersion: SCHEMA_VERSION, entries: {} };
    this.resumed = resume;
    this.write();
  }

  load() {
    if (!fs.existsSync(this.manifestPath)) return { schemaVersion: SCHEMA_VERSION, entries: {} };
    try {
      const state = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (state.schemaVersion === SCHEMA_VERSION && state.entries && typeof state.entries === 'object') return state;
      console.warn(`⚠ Ignoring incompatible export resume manifest: ${this.manifestPath}`);
    } catch {
      console.warn(`⚠ Ignoring unreadable export resume manifest: ${this.manifestPath}`);
    }
    return { schemaVersion: SCHEMA_VERSION, entries: {} };
  }

  write() {
    const tempPath = `${this.manifestPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(tempPath, this.manifestPath);
  }

  key(type, uuid) {
    return `${type}:${uuid}`;
  }

  shouldSkip(type, uuid, source, artifactDir) {
    if (!this.resumed) return false;
    const entry = this.state.entries[this.key(type, uuid)];
    if (!entry || entry.status !== 'complete' || entry.fingerprint !== sourceFingerprint(source)) return false;
    return filesStillPresent(artifactDir, entry.files);
  }

  markPending(type, uuid, source) {
    this.state.entries[this.key(type, uuid)] = {
      status: 'pending',
      fingerprint: sourceFingerprint(source),
      files: [],
    };
    this.write();
  }

  markComplete(type, uuid, source, artifactDir) {
    const files = filesBelow(artifactDir);
    this.state.entries[this.key(type, uuid)] = {
      status: 'complete',
      fingerprint: sourceFingerprint(source),
      files,
    };
    this.write();
  }

  markFailed(type, uuid, source) {
    this.state.entries[this.key(type, uuid)] = {
      status: 'failed',
      fingerprint: sourceFingerprint(source),
      files: [],
    };
    this.write();
  }
}

export async function resumeArtifact(resumeState, type, uuid, source, artifactDir, download) {
  if (!resumeState) return { ok: await download(), skipped: false };
  if (resumeState.shouldSkip(type, uuid, source, artifactDir)) return { ok: true, skipped: true };
  resumeState.markPending(type, uuid, source);
  const ok = await download();
  if (ok) resumeState.markComplete(type, uuid, source, artifactDir);
  else resumeState.markFailed(type, uuid, source);
  return { ok, skipped: false };
}
