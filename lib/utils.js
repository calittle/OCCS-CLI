import fs from 'fs';
import path from 'path';
import { parse } from 'json2csv';
import readline from 'readline'; 

export function getNameByUUID(type, uuid, baseDir = './output') {
  const catalogPath = path.join(baseDir, 'catalog', `${type.toLowerCase()}s.csv`);

  if (!fs.existsSync(catalogPath)) {
    console.error(`❌ Catalog file not found: ${catalogPath}`);
    console.error(`   ➤ Run 'report-catalog' command first.`);
    process.exit(1);
  }

  const lines = fs.readFileSync(catalogPath, 'utf-8').split('\n').filter(Boolean);
  const headers = lines[0]
  .replace(/^\uFEFF/, '') // Strip BOM if present
  .split(',')
  .map(h => h.trim().replace(/^"|"$/g, '').toLowerCase()); // Trim and remove quotes
  const uuidIndex = headers.findIndex(h => h.trim().toLowerCase() === 'uuid');
  const nameIndex = headers.findIndex(h => h.trim().toLowerCase() === 'name');
  const shortNameIndex = headers.findIndex(h => h.trim().toLowerCase() === 'shortname');

  if (uuidIndex === -1) {
    console.error(`❌ UUID column not found in ${catalogPath}`);
    process.exit(1);
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols[uuidIndex]?.trim() === uuid) {
      return cols[nameIndex]?.trim() || cols[shortNameIndex]?.trim() || uuid;
    }
  }

  return uuid; // fallback if not found
}


export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function safePathSegment(value, fallback = 'unnamed') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;

  const safe = raw.replace(/[<>:"/\\|?*\x00-\x1F%]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  });

  if (safe === '.' || safe === '..') {
    return safe.replace(/\./g, '%2E');
  }

  return safe;
}

export function setDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

export function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

export function parseJSONFilesInDir(dir, match = () => true) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    if (!fs.statSync(fullPath).isFile()) continue;
    if (!file.endsWith('.json')) continue;
    if (!match(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(fullPath));
      results.push(json);
    } catch (e) {
      console.error(`⚠ Failed to parse ${file}: ${e.message}`);
    }
  }
  return results;
}

export function writeCSV(filePath, headers, rows) {
  const csv = parse(rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]]))), { fields: headers });
  fs.writeFileSync(filePath, csv);
}
