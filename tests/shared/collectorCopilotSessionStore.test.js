'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { collectUsageOnce } = require('../../src/shared/collector');
const { emptyWslBundle } = require('../../src/shared/wslUsage');
const { localMs } = require('../helpers/localTime');

function pricing(rows) {
  return Object.fromEntries([...new Set(rows.map((row) => row.model))].map((model) => [model, {
    inputCostPerToken: 1,
    outputCostPerToken: 1,
    cacheReadInputTokenCost: 1,
    cacheCreationInputTokenCost: 1
  }]));
}

test('collector adds session-store-only Copilot models without duplicating Tokscale sessions', async () => {
  const now = localMs(2026, 9, 11, 12);
  const rows = [{
    sessionId: 'existing',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 200,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: now - 2_000,
    messages: 1
  }, {
    sessionId: 'vscode-live',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 2,
    cacheRead: 30,
    cacheWrite: 4,
    reasoning: 1,
    createdAt: now - 1_000,
    messages: 1
  }];
  const runTokscale = async () => ({
    entries: [{
      client: 'copilot',
      sessionId: 'existing',
      model: 'claude-fable-5-1',
      provider: 'anthropic',
      input: 100,
      output: 10,
      cost: 110,
      messageCount: 1
    }]
  });

  const summary = await collectUsageOnce({
    clients: 'copilot',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'copilot-store-test',
    now,
    limitsEnabled: false,
    historyEnabled: true,
    includeHistory: true,
    dailyHistoryArchiveEnabled: false,
    wslScanEnabled: false,
    runTokscale,
    runGraph: async () => ({ contributions: [] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    collectCopilotSessionStoreRows: () => rows,
    resolveCopilotSessionStorePricing: async () => pricing(rows)
  });

  assert.equal(summary.today.totalTokens, 156);
  assert.equal(summary.today.models['claude-fable-5-1'], 156);
  assert.equal(summary.today.sessions['copilot:existing'].totalTokens, 110);
  assert.equal(summary.today.sessions['copilot:vscode-live'].totalTokens, 46);
  assert.equal(summary.today.sessions['copilot:vscode-live'].cacheReadTokens, 30);
  assert.equal(summary.history.daily[0].tokens, 46, 'history adds only the session missing from Tokscale');
});

test('collector applies all-time Tokscale ownership consistently to narrower periods', async () => {
  const now = localMs(2026, 9, 11, 12);
  const rows = [{
    sessionId: 'owned-by-tokscale',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 200,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: now - 2_000,
    messages: 1
  }, {
    sessionId: 'store-only',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: now - 1_000,
    messages: 1
  }];
  const runTokscale = async ({ flags }) => ({
    entries: flags[0] === '--since'
      ? [{
          client: 'copilot',
          sessionId: 'owned-by-tokscale',
          model: 'claude-fable-5-1',
          provider: 'anthropic',
          input: 100,
          output: 10,
          cost: 110,
          messageCount: 1
        }]
      : []
  });

  const summary = await collectUsageOnce({
    clients: 'copilot',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'copilot-store-ownership-test',
    now,
    limitsEnabled: false,
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    collectCopilotSessionStoreRows: () => rows,
    resolveCopilotSessionStorePricing: async () => pricing(rows)
  });

  assert.equal(summary.today.totalTokens, 12);
  assert.equal(summary.month.totalTokens, 12);
  assert.equal(summary.allTime.totalTokens, 122);
  assert.equal(summary.today.sessions['copilot:owned-by-tokscale'], undefined);
  assert.equal(summary.today.sessions['copilot:store-only'].totalTokens, 12);
});

test('Copilot store month usage remains independent of the all-time cutoff', async () => {
  const now = localMs(2026, 9, 11, 12);
  const monthStart = localMs(2026, 9, 1);
  const rows = [{
    sessionId: 'early-month',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: localMs(2026, 9, 2, 12),
    messages: 1
  }];

  const summary = await collectUsageOnce({
    clients: 'copilot',
    allTimeSince: '2026-09-10',
    commandTimeoutMs: 1000,
    deviceId: 'copilot-store-month-cutoff-test',
    now,
    limitsEnabled: false,
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    collectCopilotSessionStoreRows: ({ sinceMs }) => {
      assert.equal(sinceMs, monthStart);
      return rows;
    },
    resolveCopilotSessionStorePricing: async () => pricing(rows)
  });

  assert.equal(summary.today.totalTokens, 0);
  assert.equal(summary.month.totalTokens, 12);
  assert.equal(summary.allTime.totalTokens, 0);
});

test('Copilot store history is independent of the all-time cutoff', async () => {
  const now = localMs(2026, 9, 11, 12);
  const oldDay = localMs(2024, 1, 15, 12);
  const rows = [{
    sessionId: 'old-store-session',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: oldDay,
    messages: 1
  }];

  const summary = await collectUsageOnce({
    clients: 'copilot',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'copilot-store-history-test',
    now,
    limitsEnabled: false,
    historyEnabled: true,
    includeHistory: true,
    historyCapDays: 30,
    dailyHistoryArchiveEnabled: false,
    wslScanEnabled: false,
    runTokscale: async ({ flags }) => ({
      entries: flags[0] === '--since' && flags[1] !== '2026-01-01'
        ? [{
            client: 'copilot',
            sessionId: 'old-store-session',
            model: 'claude-fable-5-1',
            input: 10,
            output: 2
          }]
        : []
    }),
    runGraph: async () => ({
      contributions: [{
        date: '2024-01-15',
        clients: [{
          client: 'copilot',
          modelId: 'claude-fable-5-1',
          tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          cost: 12,
          messages: 1
        }]
      }]
    }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    collectCopilotSessionStoreRows: ({ sinceMs }) => {
      assert.equal(sinceMs, 0);
      return rows;
    },
    resolveCopilotSessionStorePricing: async () => pricing(rows)
  });

  assert.equal(summary.allTime.totalTokens, 0);
  assert.equal(summary.history.daily.length, 0);
  assert.equal(summary.history.monthly[0].month, '2024-01');
  assert.equal(summary.history.monthly[0].tokens, 12);
  assert.equal(summary.history.summary.totalTokens, 12);
});

test('Copilot ownership failure marks the history refresh failed', async () => {
  const now = localMs(2026, 9, 11, 12);
  const statuses = [];
  let graphCalls = 0;
  const rows = [{
    sessionId: 'old-store-session',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: localMs(2024, 1, 15, 12),
    messages: 1
  }];

  const summary = await collectUsageOnce({
    clients: 'copilot',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'copilot-store-history-failure-test',
    now,
    limitsEnabled: false,
    historyEnabled: true,
    includeHistory: true,
    dailyHistoryArchiveEnabled: false,
    wslScanEnabled: false,
    runTokscale: async ({ flags }) => {
      if (flags[0] === '--since' && flags[1] !== '2026-01-01') throw new Error('ownership unavailable');
      return { entries: [] };
    },
    runGraph: async () => {
      graphCalls += 1;
      return { contributions: [] };
    },
    onHistoryStatus: (status) => statuses.push(status),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    collectCopilotSessionStoreRows: () => rows,
    resolveCopilotSessionStorePricing: async () => pricing(rows)
  });

  assert.equal(Object.hasOwn(summary, 'history'), false);
  assert.equal(graphCalls, 0);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].successAt, null);
  assert.equal(statuses[0].failureCode, 'copilot-history-ownership-failed');
});
