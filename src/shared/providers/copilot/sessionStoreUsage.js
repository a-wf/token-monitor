'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_USAGE_COLUMNS = new Set([
  'id',
  'session_id',
  'model',
  'input_tokens',
  'output_tokens',
  'created_at'
]);

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return 0;
  const localDate = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (localDate) {
    return new Date(Number(localDate[1]), Number(localDate[2]) - 1, Number(localDate[3])).getTime();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeCopilotStoreModel(value) {
  const model = String(value || '').trim().toLowerCase();
  if (!model) return 'unknown';
  return model.startsWith('claude-') ? model.replace(/\./g, '-') : model;
}

function providerForModel(model) {
  const value = normalizeCopilotStoreModel(model);
  if (value.startsWith('claude-')) return 'anthropic';
  if (value.startsWith('gemini-')) return 'google';
  if (value.startsWith('grok-')) return 'xai';
  if (value.startsWith('kimi-')) return 'moonshotai';
  if (/^(?:gpt-|o[1-9]|codex)/.test(value)) return 'openai';
  return 'github-copilot';
}

function copilotSessionStorePath(options = {}) {
  return options.dbPath || path.join(options.homeDir || os.homedir(), '.copilot', 'session-store.db');
}

function usageKey(sessionId, model) {
  const session = String(sessionId || '').trim();
  return session ? `${session}\u0000${normalizeCopilotStoreModel(model)}` : '';
}

function normalizeCopilotStoreRow(row) {
  const sessionId = String(row?.session_id || row?.sessionId || '').trim();
  if (!sessionId) return null;
  const inclusiveInput = numberValue(row.input_tokens ?? row.inputTokens);
  const cacheRead = Math.min(numberValue(row.cache_read_tokens ?? row.cacheReadTokens), inclusiveInput);
  const cacheWrite = Math.min(
    numberValue(row.cache_write_tokens ?? row.cacheWriteTokens),
    Math.max(0, inclusiveInput - cacheRead)
  );
  const input = Math.max(0, inclusiveInput - cacheRead - cacheWrite);
  const output = numberValue(row.output_tokens ?? row.outputTokens);
  const reasoning = numberValue(row.reasoning_tokens ?? row.reasoningTokens);
  const totalNanoAiu = nullableNumber(row.total_nano_aiu ?? row.totalNanoAiu);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  return {
    eventId: String(row.id ?? ''),
    sessionId,
    model: normalizeCopilotStoreModel(row.model),
    provider: providerForModel(row.model),
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    recordedCostUsd: totalNanoAiu === null ? null : totalNanoAiu / 100_000_000_000,
    createdAt: timestampMs(row.created_at ?? row.createdAt),
    cwd: String(row.cwd || ''),
    title: String(row.summary || ''),
    messages: 1
  };
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((row) => String(row.name || '')));
}

function readCopilotSessionStoreRows(options = {}) {
  const dbPath = copilotSessionStorePath(options);
  if (!fs.existsSync(dbPath)) return [];
  const requireFn = options.requireFn || require;
  const { DatabaseSync } = requireFn('node:sqlite');
  if (typeof DatabaseSync !== 'function') throw new Error('Copilot session-store tracking requires node:sqlite');

  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 250');
    const usageColumns = tableColumns(database, 'assistant_usage_events');
    if ([...REQUIRED_USAGE_COLUMNS].some((column) => !usageColumns.has(column))) return [];
    const usageColumn = (name, fallback = '0') => usageColumns.has(name) ? `u.${name}` : fallback;
    const sessionColumns = tableColumns(database, 'sessions');
    const hasSessionMetadata = ['id', 'host_type', 'cwd', 'summary'].every((column) => sessionColumns.has(column));
    const selectMetadata = hasSessionMetadata
      ? 's.host_type, s.cwd, s.summary'
      : "NULL AS host_type, NULL AS cwd, NULL AS summary";
    const joinSessions = hasSessionMetadata ? 'LEFT JOIN sessions s ON s.id = u.session_id' : '';
    const sinceMs = Math.max(0, timestampMs(options.sinceMs));
    const where = sinceMs ? 'WHERE julianday(u.created_at) >= julianday(?)' : '';
    const statement = database.prepare(`
      SELECT u.id, u.session_id, u.model, u.input_tokens, u.output_tokens,
             ${usageColumn('cache_read_tokens')} AS cache_read_tokens,
             ${usageColumn('cache_write_tokens')} AS cache_write_tokens,
             ${usageColumn('reasoning_tokens')} AS reasoning_tokens,
             ${usageColumn('total_nano_aiu', 'NULL')} AS total_nano_aiu,
             u.created_at, ${selectMetadata}
      FROM assistant_usage_events u
      ${joinSessions}
      ${where}
      ORDER BY u.id
    `);
    const rows = sinceMs ? statement.all(new Date(sinceMs).toISOString()) : statement.all();
    return rows.map(normalizeCopilotStoreRow).filter(Boolean);
  } finally {
    database.close();
  }
}

function estimatedRowCost(row, pricingByModel) {
  if (row.recordedCostUsd !== null && row.recordedCostUsd !== undefined) return row.recordedCostUsd;
  const pricing = pricingByModel?.[normalizeCopilotStoreModel(row.model)];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function buildTokscaleJson(startMs, rows, pricingByModel, options = {}) {
  const excluded = options.excludeKeys instanceof Set ? options.excludeKeys : new Set(options.excludeKeys || []);
  const grouped = new Map();
  for (const row of rows || []) {
    if (startMs && (!row.createdAt || row.createdAt < startMs)) continue;
    const key = usageKey(row.sessionId, row.model);
    if (!key || excluded.has(key)) continue;
    if (!grouped.has(key)) {
      grouped.set(key, {
        client: 'copilot',
        mergedClients: null,
        sessionId: row.sessionId,
        model: row.model,
        provider: row.provider,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        messageCount: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0,
        projectId: '',
        projectLabel: '',
        sessionTitle: row.title || '',
        performance: null
      });
    }
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.reasoning += row.reasoning;
    group.messageCount += row.messages;
    const cost = estimatedRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
    if (!group.projectId && row.cwd && typeof options.projectIdentity === 'function') {
      const identity = options.projectIdentity(row.cwd);
      group.projectId = identity.projectId || '';
      group.projectLabel = identity.projectLabel || '';
    }
  }

  const entries = [...grouped.values()].map((row) => ({
    ...row,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : ''
  }));
  const sum = (key) => entries.reduce((total, row) => total + numberValue(row[key]), 0);
  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: sum('input'),
    totalOutput: sum('output'),
    totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'),
    totalReasoning: sum('reasoning'),
    totalMessages: sum('messageCount'),
    totalCost: sum('cost'),
    processingTimeMs: 0
  };
}

function buildCopilotSessionStorePeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const buildOptions = {
    excludeKeys: options.excludeKeys,
    projectIdentity: options.projectIdentity
  };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTokscaleJson(todayStart, rows, options.pricingByModel, buildOptions),
    month: buildTokscaleJson(monthStart, rows, options.pricingByModel, buildOptions),
    allTime: buildTokscaleJson(timestampMs(options.allTimeSince), rows, options.pricingByModel, buildOptions)
  };
}

function copilotUsageEntryKeys(json) {
  const keys = new Set();
  for (const entry of Array.isArray(json?.entries) ? json.entries : []) {
    if (String(entry?.client || '').trim().toLowerCase() !== 'copilot') continue;
    const key = usageKey(entry.sessionId ?? entry.session_id, entry.model ?? entry.modelId);
    if (key) keys.add(key);
  }
  return keys;
}

function mergeMissingCopilotStoreEntries(tokscaleJson, storeJson, options = {}) {
  if (!storeJson?.entries?.length) return tokscaleJson;
  const base = tokscaleJson && typeof tokscaleJson === 'object' ? tokscaleJson : {};
  const entries = Array.isArray(base.entries) ? base.entries : [];
  const existing = new Set(options.excludeKeys || []);
  for (const key of copilotUsageEntryKeys(base)) existing.add(key);
  const additions = storeJson.entries.filter((entry) => !existing.has(usageKey(entry.sessionId, entry.model)));
  return additions.length ? { ...base, entries: [...entries, ...additions] } : base;
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildCopilotSessionStoreHistoryGraph(options = {}) {
  const excluded = options.excludeKeys instanceof Set ? options.excludeKeys : new Set(options.excludeKeys || []);
  const days = new Map();
  for (const row of options.rows || []) {
    // One source owns a whole session/model pair. Cross-source request ids are
    // not stable enough to deduplicate safely at a finer granularity.
    if (excluded.has(usageKey(row.sessionId, row.model))) continue;
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = {
        client: 'copilot',
        modelId: row.model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(model);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.tokens.reasoning += row.reasoning;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  buildCopilotSessionStoreHistoryGraph,
  buildCopilotSessionStorePeriods,
  copilotSessionStorePath,
  copilotUsageEntryKeys,
  estimatedRowCost,
  mergeMissingCopilotStoreEntries,
  normalizeCopilotStoreModel,
  normalizeCopilotStoreRow,
  readCopilotSessionStoreRows,
  timestampMs,
  usageKey
};
