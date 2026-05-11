import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

export function parseContentBlobs(baseDir) {
  const contentRoot = path.join(baseDir, 'contents');
  const usageMap = {}; // { fieldId: [ { type, contentId, versionId, raw } ] }

  if (!fs.existsSync(contentRoot)) {
    return usageMap;
  }

  for (const contentFolder of fs.readdirSync(contentRoot)) {
    const contentId = getContentShortName(contentRoot, contentFolder);
    const versionsDir = path.join(contentRoot, contentFolder, 'versions');
    if (!fs.existsSync(versionsDir)) continue;

    for (const versionFolder of fs.readdirSync(versionsDir)) {
      const versionPath = path.join(versionsDir, versionFolder);
      const files = fs.readdirSync(versionPath).filter((f) => f.endsWith('.blob'));
      if (files.length !== 1) continue;

      const blobPath = path.join(versionPath, files[0]);
      const content = fs.readFileSync(blobPath, 'utf8');

      try {
        extractCommsTags(content, contentId, getContentVersionShortName(versionPath, versionFolder), usageMap);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          chalk.yellow(
            `⚠️ Skipping blob parse failure in ${contentFolder}/${versionFolder}: ${message}`
          )
        );
      }
    }
  }

  return usageMap;
}

function getContentShortName(contentRoot, contentFolder) {
  const masterPath = path.join(contentRoot, contentFolder, `${contentFolder}_master.json`);
  if (!fs.existsSync(masterPath)) return contentFolder;

  try {
    const data = JSON.parse(fs.readFileSync(masterPath));
    return data.CommunicationContentConfigRec?.CommunicationContentConfigInfo?.ShortName || contentFolder;
  } catch {
    return contentFolder;
  }
}

function getContentVersionShortName(versionPath, versionFolder) {
  const recPath = path.join(versionPath, `${versionFolder}.json`);
  if (!fs.existsSync(recPath)) return versionFolder;

  try {
    const data = JSON.parse(fs.readFileSync(recPath));
    return data.CommunicationContentVersionConfigInfo?.ShortName || versionFolder;
  } catch {
    return versionFolder;
  }
}

function extractCommsTags(html, contentId, versionId, usageMap) {
  const decoded = decodeEntities(html);

  const dataTagRegex = /<comms-data>([\s\S]*?)<\/comms-data>/gi;
  const condTagRegex = /<comms-cond>\$Cond([\s\S]*?)<\/comms-cond>/gi;

  let match;

  while ((match = dataTagRegex.exec(decoded)) !== null) {
    const payload = normalizePayload(match[1]);
    const ids = extractIdsFromPayload(payload);

    if (ids.length === 0) {
      console.warn(
        chalk.yellow(
          `⚠️ Failed to identify field IDs in <comms-data> for ${contentId}/${versionId}`
        )
      );
      continue;
    }

    for (const id of ids) {
      addUsage(usageMap, id, {
        type: 'data',
        contentId,
        versionId,
        raw: payload,
      });
    }
  }

  while ((match = condTagRegex.exec(decoded)) !== null) {
    const payload = normalizePayload(match[1]);

    const parsed = tryParseJsonObject(payload);
    const conditionText =
      parsed && typeof parsed.Condition === 'string' ? parsed.Condition : payload;

    const ids = extractIdsFromPayload(conditionText);

    if (ids.length === 0) {
      // Fallback: capture simple quoted identifiers in condition expressions like
      // "fieldName empty false" when there are no embedded <comms-data> tags.
      const heuristicIds = extractSimpleConditionIdentifiers(conditionText);
      for (const id of heuristicIds) {
        addUsage(usageMap, id, {
          type: 'cond',
          contentId,
          versionId,
          raw: parsed ?? payload,
        });
      }
      continue;
    }

    for (const id of ids) {
      addUsage(usageMap, id, {
        type: 'cond',
        contentId,
        versionId,
        raw: parsed ?? payload,
      });
    }
  }
}

function addUsage(usageMap, id, usage) {
  if (!id) return;

  if (!usageMap[id]) {
    usageMap[id] = [];
  }

  const exists = usageMap[id].some(
    (entry) =>
      entry.type === usage.type &&
      entry.contentId === usage.contentId &&
      entry.versionId === usage.versionId
  );

  if (!exists) {
    usageMap[id].push(usage);
  }
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#61;/g, '=')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function normalizePayload(value) {
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

function tryParseJsonObject(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractIdsFromPayload(payload) {
  const ids = new Set();

  // 1) Best case: valid $Data JSON fragments
  const jsonFragments = payload.match(/\$Data\s*\{[\s\S]*?\}/g) || [];
  for (const fragment of jsonFragments) {
    const jsonText = fragment.replace(/^\$Data\s*/, '');
    const parsed = tryParseJsonObject(jsonText);
    if (parsed && typeof parsed.Id === 'string' && parsed.Id.trim() !== '') {
      ids.add(parsed.Id.trim());
      continue;
    }

    const fallbackMatch = jsonText.match(/"Id"\s*:\s*"([^"<>]+)"/);
    if (fallbackMatch) {
      ids.add(fallbackMatch[1].trim());
    }
  }

  // 2) Fallback for contaminated payloads that still contain Id:"..."
  const rawIdRegex = /"Id"\s*:\s*"([^"<>]+)"/g;
  let match;
  while ((match = rawIdRegex.exec(payload)) !== null) {
    ids.add(match[1].trim());
  }

  return [...ids];
}

function extractSimpleConditionIdentifiers(conditionText) {
  const ids = new Set();
  const text = String(conditionText || '').trim();

  // Very light heuristic for simple expressions such as:
  //   accountBalances_totAmt > 0.0
  //   thisbillproj_onpeak empty false
  // Avoid numbers, operators, and obvious keywords.
  const firstTokenMatch = text.match(/^([A-Za-z_][A-Za-z0-9_\.:-]*)\b/);
  if (firstTokenMatch) {
    const token = firstTokenMatch[1];
    if (!isConditionKeyword(token)) {
      ids.add(token);
    }
  }

  return [...ids];
}

function isConditionKeyword(token) {
  return new Set([
    'true',
    'false',
    'null',
    'empty',
    'and',
    'or',
    'not',
  ]).has(String(token).toLowerCase());
}
