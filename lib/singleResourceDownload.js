import fs from 'node:fs';
import path from 'node:path';

// Single-item commands share their output root with other cached resources.
// Publish only the downloaded folder, and keep the old copy on any failure.
export async function downloadSingleResource(outputDir, download) {
  const destination = path.resolve(outputDir);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.occs-resource-'));
  const staging = path.join(temporary, 'download');
  fs.mkdirSync(staging);
  try {
    if (!await download(staging)) throw new Error('Resource download failed; existing cache was preserved.');
    const entries = fs.readdirSync(staging, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) {
      throw new Error('Expected one downloaded resource folder; existing cache was preserved.');
    }
    fs.mkdirSync(destination, { recursive: true });
    const source = path.join(staging, entries[0].name);
    const target = path.join(destination, entries[0].name);
    const backup = path.join(temporary, 'previous');
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      fs.renameSync(source, target);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
