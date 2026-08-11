import axios from 'axios';
import chalk from 'chalk';
import { loadSession } from './session.js';
import { writeStdoutJSON } from './utils.js';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

const CONFIG_REC_PATH = '/api/ConfigurationId/v1/ConfigurationRec';
const CLOSED_STATUS = 'Closed';
const CLOSE_IN_PROGRESS_STATUS = 'CloseInProgress';

function optsWithGlobals(cmd) {
  return typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : (cmd || {});
}

function writeJson(payload) {
  writeStdoutJSON(payload);
}

function log(opts, message) {
  if (opts.json) {
    console.error(message);
  } else {
    console.log(message);
  }
}

function commandError(message, details = undefined) {
  const err = new Error(message);
  err.details = details;
  return err;
}

function errorDetails(err) {
  if (err?.details) {
    return err.details;
  }

  if (err?.response) {
    const data = err.response.data;
    const responseText = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    return {
      status: err.response.status,
      statusText: err.response.statusText,
      response: responseText,
    };
  }

  return undefined;
}

async function runCommand(opts, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err?.message || String(err);
    const details = errorDetails(err);
    if (opts.json) {
      writeJson({
        ok: false,
        error: {
          message,
          ...(details ? { details } : {}),
        },
      });
    } else {
      console.error(chalk.red(`❌ ${message}`));
      if (opts.verbose && details) {
        console.error(details);
      }
    }
    process.exit(1);
  }
}

function apiUrl(session, url) {
  return `${String(session.baseUrl || '').replace(/\/$/, '')}${url}`;
}

function authHeaders(session, extra = {}) {
  return {
    Authorization: `Bearer ${session.token}`,
    Accept: 'application/json',
    ...extra,
  };
}

function redactedParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => (
      /token|authorization|password/i.test(key)
        ? [key, '[REDACTED]']
        : [key, value]
    )),
  );
}

async function apiGetJson(session, url, params = {}, opts = {}) {
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ GET ${fullUrl}`));
    if (Object.keys(params).length) {
      console.error(chalk.gray(`  params ${JSON.stringify(redactedParams(params))}`));
    }
  }

  const res = await axios.get(fullUrl, {
    headers: authHeaders(session, opts.headers),
    params,
    timeout: resolveRequestTimeoutMs(opts.timeout),
  });
  return res.data;
}

async function apiPutJson(session, url, payload, opts = {}) {
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ PUT ${fullUrl}`));
  }

  const res = await axios.put(fullUrl, payload, {
    headers: authHeaders(session, {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    }),
    timeout: resolveRequestTimeoutMs(opts.timeout),
  });
  return res.data;
}

async function apiPostJson(session, url, payload, opts = {}) {
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ POST ${fullUrl}`));
  }

  const res = await axios.post(fullUrl, payload, {
    headers: authHeaders(session, {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    }),
    timeout: resolveRequestTimeoutMs(opts.timeout),
  });
  return res.data;
}

async function apiPaginate(session, url, params = {}, limit = 100, opts = {}) {
  let offset = 0;
  let hasMore = true;
  const items = [];
  let totalResults = null;

  while (hasMore) {
    const page = await apiGetJson(session, url, { ...params, offset, limit }, opts);
    const pageItems = page.Items || [];
    items.push(...pageItems);
    if (page.TotalResults !== undefined) {
      totalResults = page.TotalResults;
    }
    if (opts.verbose) {
      console.error(chalk.gray(`  ↳ got ${pageItems.length} records (offset ${offset})`));
    }
    hasMore = Boolean(page.HasMore) || pageItems.length === limit;
    offset += limit;
  }

  return {
    items,
    totalResults,
  };
}

function topLevelSessionSelector(opts = {}) {
  return {
    sessionName: opts.session,
    customer: opts.customer,
    region: opts.region ?? opts.environment,
    tenancy: opts.tenancy,
  };
}

function prefixedSessionSelector(opts = {}, prefix, options = {}) {
  const envKey = `${prefix}Environment`;
  const regionKey = `${prefix}Region`;
  return {
    sessionName: opts[`${prefix}Session`],
    customer: opts[`${prefix}Customer`],
    region: opts[regionKey] ?? opts[envKey],
    tenancy: opts[`${prefix}Tenancy`],
    ...(options.includeCredentials ? { includeCredentials: true } : {}),
  };
}

function hasSessionSelector(selector = {}) {
  return Boolean(selector.sessionName || selector.customer || selector.region || selector.tenancy);
}

function unwrapConfigRec(item) {
  return item?.ConfigurationRec || item || {};
}

function statusItems(configRec) {
  const status = configRec?.ConfigurationStatus;
  if (!status) {
    return [];
  }
  if (Array.isArray(status)) {
    return status;
  }
  if (Array.isArray(status.Items)) {
    return status.Items;
  }
  return [status];
}

function firstStatusItem(configRec) {
  return statusItems(configRec)[0] || {};
}

function configSummary(item) {
  const configRec = unwrapConfigRec(item);
  const info = configRec.ConfigurationInfo || {};
  const status = firstStatusItem(configRec);

  return {
    id: String(configRec.ConfigurationId || ''),
    uuid: configRec.ConfigurationUuid || '',
    shortName: info.ShortName || '',
    name: info.Name || '',
    description: info.Desc || '',
    status: status.ConfigurationStatusCode || '',
    effectiveAt: status.EffDtTm || '',
    raw: configRec,
  };
}

function createConfigPayload({ shortName, name, description }) {
  return {
    ConfigurationInfo: {
      ShortName: shortName,
      Name: name,
      Desc: description,
    },
  };
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function identityTokens(config) {
  return [
    config.id,
    config.uuid,
    config.shortName,
    config.name,
  ].filter(Boolean);
}

function exactConfigMatch(config, requested) {
  const wanted = normalizeToken(requested);
  return identityTokens(config).some((token) => normalizeToken(token) === wanted);
}

function partialConfigMatch(config, requested) {
  const wanted = normalizeToken(requested);
  if (!wanted) {
    return false;
  }
  return [config.shortName, config.name]
    .filter(Boolean)
    .some((token) => normalizeToken(token).includes(wanted));
}

function configLabel(config) {
  const label = config.shortName || config.name || config.id || config.uuid || '(unnamed)';
  const idSuffix = config.id && config.id !== label ? ` [${config.id}]` : '';
  return `${label}${idSuffix}`;
}

function movementItemLabel(item) {
  const shortName = item.ShortName || '';
  const name = item.Name || '';
  if (shortName && name && shortName !== name) {
    return `${shortName} (${name})`;
  }
  return shortName || name || '(unnamed)';
}

function eligibleItemMatches(item, tokens) {
  const candidates = [item.ShortName, item.Name].filter(Boolean).map(normalizeToken);
  return tokens.some((token) => candidates.includes(normalizeToken(token)));
}

function nonCloseInProgressWhere() {
  return JSON.stringify({
    t: ['ConfigurationStatus.ConfigurationStatusCode', 'ne', CLOSE_IN_PROGRESS_STATUS],
  });
}

async function fetchConfigurations(session, opts = {}) {
  const result = await apiPaginate(
    session,
    CONFIG_REC_PATH,
    {
      depth: true,
      totalResults: true,
      whr: nonCloseInProgressWhere(),
    },
    100,
    opts,
  );
  return result.items.map(configSummary).filter((config) => config.id || config.uuid);
}

async function resolveConfiguration(session, input, opts = {}) {
  const wanted = String(input || '').trim();
  if (!wanted) {
    throw commandError('Missing ConfigId value.');
  }

  const configs = await fetchConfigurations(session, opts);
  let matches = configs.filter((config) => exactConfigMatch(config, wanted));
  if (matches.length === 0) {
    matches = configs.filter((config) => partialConfigMatch(config, wanted));
  }

  if (matches.length === 0) {
    throw commandError(`ConfigId not found: ${wanted}`);
  }
  if (matches.length > 1) {
    throw commandError(`ConfigId is ambiguous: ${wanted}`, {
      matches: matches.map((config) => ({
        id: config.id,
        uuid: config.uuid,
        shortName: config.shortName,
        name: config.name,
        status: config.status,
      })),
    });
  }

  return {
    input: wanted,
    ...matches[0],
  };
}

function closePayload(config) {
  return {
    ConfigurationInfo: config.raw.ConfigurationInfo || {},
    ConfigurationUuid: config.uuid,
    ConfigurationId: config.id,
    ConfigurationStatus: [
      {
        ConfigurationStatusCode: CLOSED_STATUS,
      },
    ],
  };
}

async function closeConfig(session, configId, opts = {}) {
  const config = await resolveConfiguration(session, configId, opts);

  if (config.status === CLOSED_STATUS) {
    return {
      config,
      closed: false,
      alreadyClosed: true,
      response: null,
    };
  }

  if (config.status && config.status !== 'Open' && !opts.force) {
    throw commandError(
      `ConfigId ${configLabel(config)} is ${config.status}, not Open. Use --force to submit a close request anyway.`,
      {
        config: {
          id: config.id,
          uuid: config.uuid,
          shortName: config.shortName,
          name: config.name,
          status: config.status,
        },
      },
    );
  }

  if (opts.dryRun) {
    return {
      config,
      closed: false,
      alreadyClosed: false,
      dryRun: true,
      payload: closePayload(config),
      response: null,
    };
  }

  const response = await apiPutJson(
    session,
    `${CONFIG_REC_PATH}/${encodeURIComponent(config.uuid)}`,
    closePayload(config),
    opts,
  );

  return {
    config,
    closed: true,
    alreadyClosed: false,
    response,
  };
}

async function createConfig(session, input = {}) {
  const shortName = String(input.shortName || '').trim();
  if (!shortName) {
    throw commandError('Missing ConfigId short name.');
  }

  const payload = createConfigPayload({
    shortName,
    name: String(input.name || shortName).trim(),
    description: String(input.description || ''),
  });

  if (input.dryRun) {
    return {
      config: configSummary(payload),
      created: false,
      dryRun: true,
      payload,
      response: null,
    };
  }

  const response = await apiPostJson(session, CONFIG_REC_PATH, payload, input);
  return {
    config: configSummary(response),
    created: true,
    dryRun: false,
    payload,
    response,
  };
}

function tokenWithoutBearer(value) {
  const token = String(value || '').trim();
  return token.replace(/^Bearer\s+/i, '').trim();
}

function bearerToken(value) {
  const token = tokenWithoutBearer(value);
  if (!token) {
    throw commandError('Source access token is empty.');
  }
  return `Bearer ${token}`;
}

async function requestAccessToken(session, opts = {}) {
  if (!session.username || !session.password) {
    throw commandError(
      'Source token refresh requires stored login credentials. Run `occs login` for the source session again, or pass --source-token.',
    );
  }

  const loginUrl = `${String(session.baseUrl || '').replace(/\/$/, '')}/api/oauth2/v1/access`;
  if (opts.verbose) {
    console.error(chalk.gray(`→ POST ${loginUrl}`));
  }

  const response = await axios.post(loginUrl, {
    User: session.username,
    Password: session.password,
  }, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: resolveRequestTimeoutMs(opts.tokenTimeout ?? opts.timeout),
  });

  const token = response.data?.AccessToken;
  if (!token) {
    throw commandError('No source access token returned from Oracle login API.');
  }
  return token;
}

async function resolveSourceBearerToken(sourceSession, opts = {}) {
  if (opts.sourceToken) {
    return {
      token: bearerToken(opts.sourceToken),
      mode: 'source-token-option',
    };
  }

  if (sourceSession?.username && sourceSession?.password && !opts.useStoredSourceToken) {
    return {
      token: bearerToken(await requestAccessToken(sourceSession, opts)),
      mode: 'refreshed-source-session',
    };
  }

  if (sourceSession?.token) {
    return {
      token: bearerToken(sourceSession.token),
      mode: 'stored-source-session-token',
    };
  }

  throw commandError('No usable source token is available. Pass --source-token or use a source session with saved credentials.');
}

async function monitorMovementStatus(targetSession, opts = {}) {
  return apiGetJson(targetSession, CONFIG_REC_PATH, {
    MonitorStatus: true,
  }, opts);
}

function movementResponseText(response) {
  return String(response?.Response || '').trim();
}

function isMovementBusy(response) {
  const text = movementResponseText(response);
  return /Movement in Progress/i.test(text)
    || /Movement has been initiated Successfully/i.test(text);
}

async function requestMovementList(targetSession, sourceBearerToken, opts = {}) {
  const response = await apiGetJson(targetSession, CONFIG_REC_PATH, {
    RequestList: true,
    SourceTenantAuthToken: sourceBearerToken,
  }, opts);
  if (!Array.isArray(response)) {
    throw commandError('Movement request list response was not an array.', { response });
  }
  return response;
}

async function initiateMovement(targetSession, sourceBearerToken, opts = {}) {
  return apiGetJson(targetSession, CONFIG_REC_PATH, {
    InitiateMovement: true,
    SourceTenantAuthToken: sourceBearerToken,
  }, opts);
}

function summarizeEligible(items) {
  return items.map((item) => ({
    shortName: item.ShortName || '',
    name: item.Name || '',
    description: item.Desc || '',
    closedAt: item.EffDtTm || '',
  }));
}

async function resolveSourceConfigForMigration(sourceSession, sourceBearer, configId, opts = {}) {
  if (!sourceSession || !configId) {
    return null;
  }

  const sourceApiSession = {
    ...sourceSession,
    token: tokenWithoutBearer(sourceBearer),
  };

  try {
    return await resolveConfiguration(sourceApiSession, configId, opts);
  } catch (err) {
    if (opts.verbose) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.yellow(`⚠ Could not resolve source ConfigId details: ${message}`));
    }
    return null;
  }
}

function verifyRequestedConfigIfProvided(requestedConfigId, sourceConfig, eligibleItems) {
  const requested = String(requestedConfigId || '').trim();
  if (!requested) {
    return {
      matched: [],
      unmatched: eligibleItems,
    };
  }

  const matchTokens = [
    requested,
    ...(sourceConfig ? identityTokens(sourceConfig) : []),
  ].filter(Boolean);
  const matched = eligibleItems.filter((item) => eligibleItemMatches(item, matchTokens));

  if (matched.length === 0) {
    throw commandError(`ConfigId ${requested} was not returned in the eligible movement list.`, {
      requested,
      sourceConfig: sourceConfig ? {
        id: sourceConfig.id,
        uuid: sourceConfig.uuid,
        shortName: sourceConfig.shortName,
        name: sourceConfig.name,
        status: sourceConfig.status,
      } : null,
      eligible: summarizeEligible(eligibleItems),
    });
  }

  const unmatched = eligibleItems.filter((item) => !matched.includes(item));

  return {
    matched,
    unmatched,
  };
}

export async function closeConfigCommand(configId, cmd) {
  const opts = optsWithGlobals(cmd);
  return runCommand(opts, async () => {
    const requestedConfigId = String(opts.configId || configId || '').trim();
    if (!requestedConfigId) {
      throw commandError('Missing ConfigId value.');
    }

    const session = loadSession(topLevelSessionSelector(opts));
    const result = await closeConfig(session, requestedConfigId, opts);
    const response = {
      ok: true,
      dryRun: Boolean(opts.dryRun),
      closed: Boolean(result.closed),
      alreadyClosed: Boolean(result.alreadyClosed),
      config: {
        input: result.config.input,
        id: result.config.id,
        uuid: result.config.uuid,
        shortName: result.config.shortName,
        name: result.config.name,
        status: result.config.status,
      },
    };

    if (opts.json) {
      writeJson(response);
      return;
    }

    if (result.alreadyClosed) {
      log(opts, `ConfigId ${chalk.cyan(configLabel(result.config))} is already Closed.`);
    } else if (opts.dryRun) {
      log(opts, `Dry run: ConfigId ${chalk.cyan(configLabel(result.config))} would be marked Closed.`);
    } else {
      log(opts, `Marked ConfigId ${chalk.cyan(configLabel(result.config))} as Closed.`);
    }
  });
}

export async function createConfigCommand(shortNameArg, cmd) {
  const opts = optsWithGlobals(cmd);
  return runCommand(opts, async () => {
    const shortName = String(opts.shortName || shortNameArg || '').trim();
    if (!shortName) {
      throw commandError('Missing ConfigId short name.');
    }

    const session = loadSession(topLevelSessionSelector(opts));
    const result = await createConfig(session, {
      shortName,
      name: opts.name,
      description: opts.description ?? opts.desc,
      dryRun: Boolean(opts.dryRun),
      timeout: opts.timeout,
      verbose: opts.verbose,
    });

    const response = {
      ok: true,
      dryRun: Boolean(opts.dryRun),
      created: Boolean(result.created),
      config: {
        id: result.config.id,
        uuid: result.config.uuid,
        shortName: result.config.shortName,
        name: result.config.name,
        description: result.config.description,
        status: result.config.status,
        effectiveAt: result.config.effectiveAt,
      },
    };

    if (opts.json) {
      writeJson(response);
      return;
    }

    const label = configLabel(result.config);
    if (opts.dryRun) {
      log(opts, `Dry run: ConfigId ${chalk.cyan(label)} would be created.`);
    } else {
      log(opts, `Created ConfigId ${chalk.cyan(label)}.`);
      if (result.config.id) {
        log(opts, `Use with --config-id ${chalk.cyan(result.config.id)}.`);
      }
    }
  });
}

export async function migrateCommand(configId, cmd) {
  const opts = optsWithGlobals(cmd);
  return runCommand(opts, async () => {
    const requestedConfigId = String(opts.configId || configId || '').trim();
    const sourceSelector = prefixedSessionSelector(opts, 'source', { includeCredentials: true });
    const targetSelector = prefixedSessionSelector(opts, 'target');

    if (!hasSessionSelector(sourceSelector) && !opts.sourceToken) {
      throw commandError('migrate requires --source-session, source target options, or --source-token.');
    }

    const sourceSession = hasSessionSelector(sourceSelector)
      ? loadSession(sourceSelector)
      : null;
    const targetSession = loadSession(targetSelector);

    if (opts.verbose) {
      console.error(chalk.gray(`Source session: ${sourceSession?.sessionKey || '(source-token option)'}`));
      console.error(chalk.gray(`Target session: ${targetSession.sessionKey}`));
    }

    if (sourceSession?.sessionKey && sourceSession.sessionKey === targetSession.sessionKey) {
      throw commandError(
        `Source and target both resolved to ${sourceSession.sessionKey}. Use --target-session or fix the target session alias before migrating.`,
      );
    }

    const sourceBearer = await resolveSourceBearerToken(sourceSession, opts);
    const sourceConfig = await resolveSourceConfigForMigration(
      sourceSession,
      sourceBearer.token,
      requestedConfigId,
      opts,
    );

    const beforeStatus = await monitorMovementStatus(targetSession, opts);
    if (isMovementBusy(beforeStatus) && !opts.force) {
      throw commandError(
        `Target movement status is busy: ${movementResponseText(beforeStatus)}. Use --force to initiate anyway.`,
        { status: beforeStatus },
      );
    }

    const eligibleItems = await requestMovementList(targetSession, sourceBearer.token, opts);
    const { matched, unmatched } = verifyRequestedConfigIfProvided(
      requestedConfigId,
      sourceConfig,
      eligibleItems,
    );

    if (eligibleItems.length === 0) {
      if (opts.dryRun) {
        const response = {
          ok: true,
          dryRun: true,
          initiated: false,
          sourceSessionKey: sourceSession?.sessionKey || '',
          targetSessionKey: targetSession.sessionKey || '',
          sourceTokenMode: sourceBearer.mode,
          requestedConfigId,
          sourceConfig: sourceConfig ? {
            id: sourceConfig.id,
            uuid: sourceConfig.uuid,
            shortName: sourceConfig.shortName,
            name: sourceConfig.name,
            status: sourceConfig.status,
          } : null,
          beforeStatus,
          eligible: [],
          matched: [],
          additionalEligible: [],
        };

        if (opts.json) {
          writeJson(response);
        } else {
          log(opts, 'Dry run: no eligible ConfigIds were returned by target.');
        }
        return;
      }
      throw commandError('No eligible ConfigIds were returned by the target environment.');
    }

    const baseResponse = {
      ok: true,
      dryRun: Boolean(opts.dryRun),
      sourceSessionKey: sourceSession?.sessionKey || '',
      targetSessionKey: targetSession.sessionKey || '',
      sourceTokenMode: sourceBearer.mode,
      requestedConfigId,
      sourceConfig: sourceConfig ? {
        id: sourceConfig.id,
        uuid: sourceConfig.uuid,
        shortName: sourceConfig.shortName,
        name: sourceConfig.name,
        status: sourceConfig.status,
      } : null,
      beforeStatus,
      eligible: summarizeEligible(eligibleItems),
      matched: summarizeEligible(matched),
      additionalEligible: summarizeEligible(unmatched),
    };

    if (opts.dryRun) {
      if (opts.json) {
        writeJson({
          ...baseResponse,
          initiated: false,
        });
        return;
      }
      log(opts, `Dry run: ${eligibleItems.length} eligible ConfigId(s) would be moved.`);
      for (const item of eligibleItems) {
        log(opts, `- ${movementItemLabel(item)}`);
      }
      return;
    }

    const initiationResponse = await initiateMovement(targetSession, sourceBearer.token, opts);
    const afterStatus = await monitorMovementStatus(targetSession, opts);

    if (opts.json) {
      writeJson({
        ...baseResponse,
        initiated: true,
        initiationResponse,
        afterStatus,
      });
      return;
    }

    log(opts, `Initiated movement for ${eligibleItems.length} eligible ConfigId(s).`);
    for (const item of eligibleItems) {
      log(opts, `- ${movementItemLabel(item)}`);
    }
    const responseText = movementResponseText(initiationResponse);
    if (responseText) {
      log(opts, `Response: ${responseText}`);
    }
    const statusText = movementResponseText(afterStatus);
    if (statusText) {
      log(opts, `Target status: ${statusText}`);
    }
  });
}
