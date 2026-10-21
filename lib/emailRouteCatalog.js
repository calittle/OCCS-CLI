import { loadSession } from './session.js';
import { get } from './api.js';
import { mapWithConcurrency, writeStdoutJSON } from './utils.js';
import { writeEmailCache } from './emails.js';
import { active, emailDistributionRoutes } from './emailRouting.js';

export async function fetchEmailRoutes(session, opts = {}, request = get) {
  const records = [];
  const options = { timeout: opts.timeout, throwOnError: true, trace: false };
  for (let offset = 0; ; offset += 49) {
    const page = await request(session, '/api/Communication/v1/CommunicationConfigRec',
      { offset, limit: 49, depth: true, summary: true, totalResults: true }, false, options);
    if (!Array.isArray(page?.Items)) throw new Error('Communication route list is missing Items.');
    records.push(...page.Items);
    if (page.HasMore === false || (page.HasMore == null && page.Items.length < 49)) break;
    if (!page.Items.length) throw new Error('Communication route pagination returned an empty page.');
  }
  const routes = (await mapWithConcurrency(records, 4, async item => {
    const record = item.CommunicationConfigRec || item;
    if (!record.CommunicationConfigUuid) throw new Error('Communication route has no UUID.');
    if (!active(record, Date.now())) return [];
    const master = await request(session, '/api/Communication/v1/CommunicationMasterConfig/' +
      encodeURIComponent(record.CommunicationConfigUuid), {}, false, options);
    if (!master?.CommunicationConfigRec || !Array.isArray(master.CommunicationDetails)) {
      throw new Error('Communication master is missing routing details.');
    }
    return emailDistributionRoutes(master);
  })).flat();
  const unique = [...new Map(routes.map(route => [JSON.stringify([
    route.uuid, route.transactionType, route.userDefinedTransactionType,
  ]), route])).values()];
  return { ok: true, count: unique.length, routes: unique,
    session: { alias: String(opts.session || ''), sessionKey: session.sessionKey || '',
      baseUrl: String(session.baseUrl || '').replace(/\/$/, '') },
    fetchedAt: new Date().toISOString() };
}

export async function listEmailRoutesCommand(cmd) {
  const opts = typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : cmd;
  try {
    const session = loadSession({ sessionName: opts.session, customer: opts.customer,
      region: opts.region ?? opts.environment, tenancy: opts.tenancy });
    const payload = await fetchEmailRoutes(session, opts);
    if (opts.output || !opts.json) writeEmailCache(opts.output || './output/email-routes', payload);
    if (opts.json) writeStdoutJSON(payload);
    else {
      for (const route of payload.routes) console.log(`${route.name}\t${route.uuid}\t${route.transactionType}\t${route.userDefinedTransactionType}`);
      console.log(`✅ Saved ${payload.count} email distribution routes to ${opts.output || './output/email-routes'}`);
    }
    return payload;
  } catch (error) {
    const payload = { ok: false, error: error.message };
    if (opts.json) writeStdoutJSON(payload);
    else console.error(`Email route enumeration failed: ${error.message}`);
    process.exitCode = 1;
    return payload;
  }
}
