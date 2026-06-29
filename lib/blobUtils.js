import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

export function parseContentBlobs(baseDir) {
  const contentRoot = path.join(baseDir, 'contents');
  const usageMap = {}; // { fieldId: [ { type, contentId, versionId, raw } ] }
  const contentRefs = []; // [ { type, contentId, versionId, targetContentId, raw } ]

  if (!fs.existsSync(contentRoot)) {
    return { usageMap, contentRefs };
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
        extractCommsTags(
          content,
          contentId,
          getContentVersionShortName(versionPath, versionFolder),
          usageMap,
          contentRefs
        );
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

  return { usageMap, contentRefs };
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

function extractCommsTags(html, contentId, versionId, usageMap, contentRefs) {
  const decoded = decodeEntities(html);

  const dataTagRegex = /<comms-data>([\s\S]*?)<\/comms-data>/gi;
  const condTagRegex = /<comms-cond>\$Cond([\s\S]*?)<\/comms-cond>/gi;

  let match;

  while ((match = dataTagRegex.exec(decoded)) !== null) {
    const payload = normalizePayload(match[1]);
    const ids = extractIdsFromPayload(payload);

    if (ids.length === 0) {
      if (isImageOnlyPayload(payload)) {
        continue;
      }
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
    const targetContentIds = extractContentRefsFromCondPayload(parsed ?? payload);

    for (const targetContentId of targetContentIds) {
      addContentRef(contentRefs, {
        type: 'cond-content',
        contentId,
        versionId,
        targetContentId,
        raw: parsed ?? payload,
      });
    }

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

function addContentRef(contentRefs, ref) {
  if (!ref?.contentId || !ref?.targetContentId) return;

  const exists = contentRefs.some(
    (entry) =>
      entry.type === ref.type &&
      entry.contentId === ref.contentId &&
      entry.versionId === ref.versionId &&
      entry.targetContentId === ref.targetContentId
  );

  if (!exists) {
    contentRefs.push(ref);
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
    if (parsed && typeof parsed === 'object') {
      collectIdsFromParsedObject(parsed, ids);
    }

    collectIdsFromRawText(jsonText, ids);
  }

  // 2) Fallback for contaminated payloads that still contain id-like references.
  collectIdsFromRawText(payload, ids);

  return [...ids];
}

function extractContentRefsFromCondPayload(payload) {
  const ids = new Set();

  if (payload && typeof payload === 'object') {
    collectContentRefsFromValue(payload.Content ?? payload.content, ids);
  } else {
    collectContentRefsFromRawText(payload, ids);
  }

  return [...ids];
}

function collectContentRefsFromValue(value, ids) {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectContentRefsFromValue(item, ids);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const key of ['Content', 'content', 'ShortName', 'shortName', '$$Id']) {
      collectContentRefsFromValue(value[key], ids);
    }
    return;
  }

  const normalized = normalizeContentIdentifier(value);
  if (normalized) {
    ids.add(normalized);
  }
}

function collectContentRefsFromRawText(text, ids) {
  const patterns = [
    /["']Content["']\s*:\s*["']([^"']+)["']/gi,
    /["']content["']\s*:\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
      const normalized = normalizeContentIdentifier(match[1]);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
}

function collectIdsFromParsedObject(parsed, ids) {
  const candidates = [
    { key: 'Id', value: parsed.Id },
    { key: 'id', value: parsed.id },
    { key: 'DC', value: parsed.DC },
    { key: 'dc', value: parsed.dc },
  ];

  for (const candidate of candidates) {
    const normalized = normalizeIdentifierCandidate(candidate.key, candidate.value);
    if (normalized) {
      ids.add(normalized);
    }
  }
}

function collectIdsFromRawText(text, ids) {
  const patterns = [
    { key: 'Id', regex: /["']Id["']\s*:\s*["']+([^"'<>},\s]+)["']*/gi },
    { key: 'id', regex: /["']id["']\s*:\s*["']+([^"'<>},\s]+)["']*/gi },
    { key: 'DC', regex: /["']DC["']\s*:\s*["']*([A-Za-z0-9_-]+)["']*/gi },
    { key: 'dc', regex: /["']dc["']\s*:\s*["']*([A-Za-z0-9_-]+)["']*/gi },
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const normalized = normalizeIdentifierCandidate(pattern.key, match[1]);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
}

function normalizeIdentifierCandidate(key, value) {
  if (value === undefined || value === null) {
    return '';
  }

  let normalized = String(value).trim();
  if (!normalized) {
    return '';
  }

  normalized = normalized.replace(/^['"]+|['"]+$/g, '').trim();
  if (!normalized) {
    return '';
  }

  if (String(key).toLowerCase() === 'dc') {
    return /^dc/i.test(normalized) ? normalized : `DC${normalized}`;
  }

  return normalized;
}

function normalizeContentIdentifier(value) {
  let normalized = String(value ?? '').trim();
  if (!normalized) return '';

  normalized = normalized.replace(/^['"]+|['"]+$/g, '').trim();
  if (!normalized) return '';

  return normalized;
}

function isImageOnlyPayload(payload) {
  const lower = String(payload || '').toLowerCase();
  if (!lower) return false;

  const hasImageType = /["']type["']\s*:\s*["']image["']/.test(payload);
  const hasDc = /["']dc["']\s*:/.test(payload);
  const hasId = /["']id["']\s*:/.test(payload);

  return hasImageType && hasDc && !hasId;
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
