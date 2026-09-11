'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  buildCopilotSessionStoreHistoryGraph,
  buildCopilotSessionStorePeriods,
  copilotUsageEntryKeys,
  estimatedRowCost,
  mergeMissingCopilotStoreEntries,
  normalizeCopilotStoreModel,
  normalizeCopilotStoreRow,
  readCopilotSessionStoreRows,
  timestampMs
} = require('../../src/shared/providers/copilot/sessionStoreUsage');

const { localMs } = require('../helpers/localTime');

test('Copilot session-store rows split cache-inclusive input and normalize Claude model ids', () => {
  assert.equal(normalizeCopilotStoreModel('claude-fable-5.1'), 'claude-fable-5-1');
  assert.deepEqual(normalizeCopilotStoreRow({
    id: 7,
    session_id: 'session-1',
    model: 'claude-fable-5.1',
    input_tokens: 100,
    output_tokens: 8,
    cache_read_tokens: 70,
    cache_write_tokens: 20,
    reasoning_tokens: 3,
    created_at: '2026-09-11T08:00:00.000Z',
    cwd: '/work/project',
    summary: 'Session'
  }), {
    eventId: '7',
    sessionId: 'session-1',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 8,
    cacheRead: 70,
    cacheWrite: 20,
    reasoning: 3,
    recordedCostUsd: null,
    createdAt: Date.parse('2026-09-11T08:00:00.000Z'),
    cwd: '/work/project',
    title: 'Session',
    messages: 1
  });
});

test('date-only Copilot window boundaries use local midnight', () => {
  assert.equal(timestampMs('2026-09-11'), localMs(2026, 9, 11));
});

test('Copilot session-store periods preserve day boundaries and cache pricing', () => {
  const now = localMs(2026, 9, 11, 12);
  const dayStart = localMs(2026, 9, 11);
  const rows = [{
    sessionId: 'older',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 2,
    output: 1,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 1,
    createdAt: dayStart - 60_000,
    messages: 1
  }, {
    sessionId: 'today',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 10,
    output: 2,
    cacheRead: 5,
    cacheWrite: 1,
    reasoning: 1,
    createdAt: dayStart + 60_000,
    messages: 1,
    cwd: '/work/project'
  }];
  const pricingByModel = {
    'claude-fable-5-1': {
      inputCostPerToken: 2,
      outputCostPerToken: 3,
      cacheReadInputTokenCost: 4,
      cacheCreationInputTokenCost: 5
    }
  };
  const periods = buildCopilotSessionStorePeriods({
    now,
    allTimeSince: '2026-01-01',
    rows,
    pricingByModel,
    projectIdentity: () => ({ projectId: 'project-id', projectLabel: 'project' })
  });

  assert.equal(periods.today.totalInput, 10);
  assert.equal(periods.today.totalOutput, 2);
  assert.equal(periods.today.totalCacheRead, 5);
  assert.equal(periods.today.totalCacheWrite, 1);
  assert.equal(periods.today.totalReasoning, 1);
  assert.equal(periods.today.totalCost, 51);
  assert.equal(periods.today.entries[0].projectLabel, 'project');
  assert.equal(periods.month.totalInput, 12);
  assert.equal(periods.allTime.totalMessages, 2);
});

test('recorded Copilot request cost takes precedence over static model pricing', () => {
  assert.equal(estimatedRowCost({
    model: 'claude-fable-5-1',
    input: 10,
    output: 2,
    cacheRead: 5,
    cacheWrite: 1,
    reasoning: 50,
    recordedCostUsd: 0.25
  }, {
    'claude-fable-5-1': {
      inputCostPerToken: 2,
      outputCostPerToken: 3,
      cacheReadInputTokenCost: 4,
      cacheCreationInputTokenCost: 5
    }
  }), 0.25);
});

test('Copilot session-store entries fill missing session models without duplicating Tokscale rows', () => {
  const tokscale = {
    entries: [{
      client: 'copilot',
      sessionId: 'existing',
      model: 'claude-fable-5-1',
      input: 100
    }]
  };
  const store = {
    entries: [{
      client: 'copilot',
      sessionId: 'existing',
      model: 'claude-fable-5-1',
      input: 200
    }, {
      client: 'copilot',
      sessionId: 'missing',
      model: 'claude-fable-5-1',
      input: 300
    }]
  };
  const merged = mergeMissingCopilotStoreEntries(tokscale, store);
  assert.equal(merged.entries.length, 2);
  assert.equal(merged.entries[0].input, 100);
  assert.equal(merged.entries[1].sessionId, 'missing');
  assert.deepEqual([...copilotUsageEntryKeys(merged)].sort(), [
    'existing\u0000claude-fable-5-1',
    'missing\u0000claude-fable-5-1'
  ]);
});

test('Copilot session-store history keeps events on their actual local day', () => {
  const firstDay = localMs(2026, 8, 10, 23, 59);
  const secondDay = localMs(2026, 8, 11, 0, 1);
  const rows = [{
    sessionId: 'session-1', model: 'claude-fable-5-1', provider: 'anthropic',
    input: 10, output: 1, cacheRead: 2, cacheWrite: 0, reasoning: 0,
    createdAt: firstDay, messages: 1
  }, {
    sessionId: 'session-1', model: 'claude-fable-5-1', provider: 'anthropic',
    input: 20, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 1,
    createdAt: secondDay, messages: 1
  }];
  const graph = buildCopilotSessionStoreHistoryGraph({ rows });
  assert.equal(graph.contributions.length, 2);
  assert.equal(graph.contributions[0].clients[0].tokens.input, 10);
  assert.equal(graph.contributions[1].clients[0].tokens.input, 20);
});

test('Copilot session-store reader loads live usage rows from SQLite', { skip: !sqlite }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'session-store.db');
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      total_nano_aiu INTEGER,
      created_at TEXT
    );
    INSERT INTO sessions VALUES (
      'session-1', '/work/project', NULL, 'github', NULL, 'Fable task',
      '2026-09-11T08:00:00.000Z', '2026-09-11T08:01:00.000Z'
    );
    INSERT INTO assistant_usage_events VALUES (
      1, 'session-1', 'claude-fable-5.1', 100, 8, 70, 20, 3, 25000000000,
      '2026-09-11T08:01:00.000Z'
    );
  `);
  database.close();

  const rows = readCopilotSessionStoreRows({ dbPath, requireFn: () => sqlite });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'claude-fable-5-1');
  assert.equal(rows[0].input, 10);
  assert.equal(rows[0].cacheRead, 70);
  assert.equal(rows[0].cacheWrite, 20);
  assert.equal(rows[0].recordedCostUsd, 0.25);
  assert.equal(rows[0].title, 'Fable task');
});

test('Copilot session-store reader surfaces operational schema errors', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-store-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'session-store.db');
  fs.writeFileSync(dbPath, '');

  class FailingDatabase {
    exec() {}
    prepare() { throw new Error('SQLITE_BUSY'); }
    close() {}
  }

  assert.throws(
    () => readCopilotSessionStoreRows({
      dbPath,
      requireFn: () => ({ DatabaseSync: FailingDatabase })
    }),
    /SQLITE_BUSY/
  );
});

test('older Copilot stores without recorded cost keep static pricing available', { skip: !sqlite }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-store-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'session-store.db');
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TEXT
    );
    INSERT INTO assistant_usage_events VALUES (
      1, 'session-1', 'claude-fable-5.1', 10, 2, '2026-09-11T08:01:00.000Z'
    );
  `);
  database.close();

  const [row] = readCopilotSessionStoreRows({ dbPath, requireFn: () => sqlite });
  assert.equal(row.recordedCostUsd, null);
  assert.equal(estimatedRowCost(row, {
    'claude-fable-5-1': {
      inputCostPerToken: 2,
      outputCostPerToken: 3
    }
  }), 26);
});
