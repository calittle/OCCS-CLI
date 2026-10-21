import { get } from './api.js';
import { mapWithConcurrency } from './utils.js';

const COMMUNICATION_LIST = '/api/Communication/v1/CommunicationConfigRec';
const COMMUNICATION_MASTER = '/api/Communication/v1/CommunicationMasterConfig/';

export function active(record, now) {
  const statuses = record?.Status?.Items;
  if (!Array.isArray(statuses) || !statuses.length) return true;
  const applicable = statuses.filter((item) => !item.EffDtTm || Date.parse(item.EffDtTm) <= now)
    .sort((a, b) => (Date.parse(a.EffDtTm) || 0) - (Date.parse(b.EffDtTm) || 0));
  return applicable.at(-1)?.StatusCode?.toLowerCase() === 'active';
}

// Follow the actual Communication -> detail -> process -> service -> email
// relationship. Similar short names do not establish a routing relationship.
export function emailRoutes(master, emailUuid, now = Date.now()) {
  const parent = master?.CommunicationConfigRec;
  if (!parent?.CommunicationConfigUuid || !active(parent, now)) return [];
  const routes = [];
  for (const detail of master.CommunicationDetails || []) {
    const record = detail.CommunicationDetailConfigRec;
    const info = record?.CommunicationDetailConfigInfo;
    if (!info?.CommunicationTransactionType || !active(record, now)) continue;
    if (info.CommunicationTransactionType === 'User Defined' && !info.CommunicationUserDefinedTransactionType) continue;
    for (const process of detail.CommunicationProcesses || []) {
      if (!active(process.CommunicationProcessConfigRec, now)) continue;
      for (const service of process.CommunicationServices || []) {
        const relation = service.CommunicationServiceConfigCommunicationEmailConfigRelRec;
        const target = relation?.CommunicationServiceConfigCommunicationEmailConfigRelInfo?.CommunicationEmailConfigUuid;
        if (target !== emailUuid || !active(service.CommunicationServiceConfigRec, now) || !active(relation, now)) continue;
        routes.push({
          emailConfigUuid: emailUuid,
          communicationConfigUuid: parent.CommunicationConfigUuid,
          communicationShortName: parent.CommunicationConfigInfo?.ShortName || '',
          transactionType: info.CommunicationTransactionType,
          userDefinedTransactionType: info.CommunicationUserDefinedTransactionType || '',
        });
      }
    }
  }
  return routes;
}

export async function resolveEmailRoute(session, emailUuid, opts = {}, request = get) {
  const started = Date.now();
  let checked = 0;
  const options = { timeout: opts.timeout, throwOnError: true, trace: false };
  const records = [];
  for (let offset = 0; ; offset += 49) {
    const page = await request(session, COMMUNICATION_LIST,
      { offset, limit: 49, depth: true, summary: true, totalResults: true }, false, options);
    if (!Array.isArray(page?.Items)) throw new Error('Communication routing list is missing Items.');
    records.push(...page.Items);
    if (page.HasMore === false || (page.HasMore == null && page.Items.length < 49)) break;
    if (!page.Items.length) throw new Error('Communication routing pagination returned an empty page.');
  }
  const matches = (await mapWithConcurrency(records, opts.concurrency ?? 4, async (item) => {
    const record = item.CommunicationConfigRec || item;
    const uuid = record.CommunicationConfigUuid;
    if (!uuid) throw new Error('Communication routing list contains a record without CommunicationConfigUuid.');
    if (!active(record, Date.now())) return [];
    checked += 1;
    const master = await request(session, COMMUNICATION_MASTER + encodeURIComponent(uuid), {}, false, options);
    if (!master?.CommunicationConfigRec || !Array.isArray(master.CommunicationDetails)) {
      throw new Error(`Communication master ${uuid} is missing routing details.`);
    }
    return emailRoutes(master, emailUuid);
  })).flat();
  const unique = [...new Map(matches.map((route) => [JSON.stringify([
    route.communicationConfigUuid, route.transactionType, route.userDefinedTransactionType,
  ]), route])).values()];
  if (opts.verbose || process.env.OCCS_HTTP_DEBUG === '1') console.log(`→ Email routing: checked ${checked} configurations, found ${unique.length} matching route(s) in ${Date.now() - started} ms.`);
  if (!unique.length) throw new Error(`No active Communication route references Communication Email ${emailUuid}. No email was submitted.`);
  if (unique.length > 1) throw new Error(`Communication Email ${emailUuid} has multiple active routes: ${unique.map((route) => `${route.communicationShortName || route.communicationConfigUuid} / ${route.userDefinedTransactionType || route.transactionType}`).join(', ')}. No email was submitted.`);
  return unique[0];
}

export function buildEmailCommunicationBody(route, emailData) {
  return {
    CommunicationInfo: {
      CommunicationConfigUuid: route.communicationConfigUuid,
      CommunicationTransactionType: route.transactionType,
      ...(route.userDefinedTransactionType ? { CommunicationUserDefinedTransactionType: route.userDefinedTransactionType } : {}),
      CommunicationData: emailData,
    },
  };
}

// A distribution route can select an Email through runtime rules rather than a
// direct Email relationship. Enumerate the transaction and its email services.
export function emailDistributionRoutes(master, now = Date.now()) {
  const parent = master?.CommunicationConfigRec;
  if (!parent?.CommunicationConfigUuid || !active(parent, now)) return [];
  return (master.CommunicationDetails || []).flatMap(detail => {
    const record = detail.CommunicationDetailConfigRec;
    const info = record?.CommunicationDetailConfigInfo;
    if (!info?.CommunicationTransactionType || !active(record, now)) return [];
    if (info.CommunicationTransactionType === 'User Defined' && !info.CommunicationUserDefinedTransactionType) return [];
    const hasEmailService = (detail.CommunicationProcesses || []).some(process =>
      active(process.CommunicationProcessConfigRec, now) && (process.CommunicationServices || []).some(service =>
        active(service.CommunicationServiceConfigRec, now) &&
        ['Email Creation', 'Email Distribution'].includes(service.CommunicationServiceConfigRec?.CommunicationServiceConfigInfo?.CommunicationServiceName)));
    if (!hasEmailService) return [];
    return [{ uuid: parent.CommunicationConfigUuid,
      name: parent.CommunicationConfigInfo?.Name || parent.CommunicationConfigInfo?.ShortName || parent.CommunicationConfigUuid,
      shortName: parent.CommunicationConfigInfo?.ShortName || '',
      transactionType: info.CommunicationTransactionType,
      userDefinedTransactionType: info.CommunicationUserDefinedTransactionType || '' }];
  });
}

export function explicitEmailRoute(opts) {
  const values = [opts.communicationConfigUuid, opts.communicationTransactionType, opts.communicationUserDefinedTransactionType];
  if (!values.some(value => value !== undefined)) return null;
  const [uuid, transaction, subtype] = values.map(value => String(value || '').trim());
  if (!uuid || !transaction || (transaction === 'User Defined' && !subtype)) {
    throw new Error('Explicit email routing requires --communication-config-uuid, --communication-transaction-type and, for User Defined, --communication-user-defined-transaction-type.');
  }
  if (opts.emailConfigUuid) throw new Error('Choose an explicit Communication route or --email-config-uuid, not both.');
  return { communicationConfigUuid: uuid, transactionType: transaction, userDefinedTransactionType: subtype };
}
