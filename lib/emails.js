import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSession } from './session.js';
import { get } from './api.js';
import { ensureDir, writeStdoutJSON } from './utils.js';

export const EMAIL_LIST_ENDPOINT = '/api/CommunicationEmail/v1/CommunicationEmailConfigRec';

export function emailSummary(item) {
  const record = item?.CommunicationEmailConfigRec || item;
  const info = record?.CommunicationEmailConfigInfo || {};
  const uuid = String(record?.CommunicationEmailConfigUuid || '').trim();
  if (!uuid) throw new Error('Communication Email list contains a record without CommunicationEmailConfigUuid.');
  return {
    uuid,
    shortName: String(info.ShortName || ''),
    name: String(info.Name || info.ShortName || uuid),
    configId: String(record.ConfigId || info.ConfigId || ''),
    statuses: (record.Status?.Items || []).map((status) => ({
      status: status.StatusCode || '', effectiveAt: status.EffDtTm || '',
    })),
  };
}

// Use the shared authentication/timeout/retry transport, but validate every page
// before replacing a complete cache with a potentially incomplete response.
export async function fetchEmails(session, opts = {}, request = get) {
  const records = [];
  const limit = 49;
  for (let offset = 0; ; offset += limit) {
    const page = await request(session, EMAIL_LIST_ENDPOINT,
      { offset, limit, depth: true, summary: true, totalResults: true },
      Boolean(opts.verbose && !opts.json), { timeout: opts.timeout, throwOnError: true });
    if (!page || !Array.isArray(page.Items)) throw new Error('Communication Email list response is missing Items.');
    records.push(...page.Items);
    if (page.HasMore === false || (page.HasMore == null && page.Items.length < limit)) break;
    if (!page.Items.length) throw new Error('Communication Email pagination returned an empty page with HasMore=true.');
  }
  return {
    ok: true,
    count: records.length,
    emails: records.map(emailSummary),
    session: {
      alias: String(opts.session || ''),
      sessionKey: session.sessionKey || '',
      baseUrl: String(session.baseUrl || '').replace(/\/$/, ''),
    },
    fetchedAt: new Date().toISOString(),
    records,
  };
}

export function writeEmailCache(outputDir, payload) {
  ensureDir(outputDir);
  const target = path.join(outputDir, 'index.json');
  const temporary = path.join(outputDir, `.index-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function listEmailsCommand(cmd) {
  const opts = typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : cmd;
  try {
    const session = loadSession({ sessionName: opts.session, customer: opts.customer,
      region: opts.region ?? opts.environment, tenancy: opts.tenancy });
    const payload = await fetchEmails(session, opts);
    // JSON mode has no filesystem side effects unless --output was requested.
    if (opts.output || !opts.json) writeEmailCache(opts.output || './output/emails', payload);
    if (opts.json) writeStdoutJSON(payload);
    else {
      for (const email of payload.emails) console.log(`${email.shortName || email.name}\t${email.uuid}`);
      console.log(`✅ Saved ${payload.count} Communication Emails to ${opts.output || './output/emails'}`);
    }
    return payload;
  } catch (error) {
    const payload = { ok: false, error: error.message };
    if (opts.json) writeStdoutJSON(payload);
    else console.error(`Communication Email enumeration failed: ${error.message}`);
    process.exitCode = 1;
    return payload;
  }
}
