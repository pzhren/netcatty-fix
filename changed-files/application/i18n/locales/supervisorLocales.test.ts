/**
 * Supervisor Agent locale coverage. Keys are extracted from the panel source
 * so a newly used `t('supervisor.…')` key can never silently miss a locale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enAiMessages } from './en/ai.ts';
import { esAiMessages } from './es/ai.ts';
import { ruAiMessages } from './ru/ai.ts';
import { zhCNAiMessages } from './zh-CN/ai.ts';
import { zhTWAiMessages } from './zh-TW/ai.ts';

/** Keys referenced from stores / runtime (not statically visible in the panel). */
const supervisorActionsSourceKeys = [
  'supervisor.stopReason.manual',
];

const locales = {
  en: enAiMessages,
  es: esAiMessages,
  ru: ruAiMessages,
  'zh-CN': zhCNAiMessages,
  'zh-TW': zhTWAiMessages,
} as const;

const here = path.dirname(fileURLToPath(import.meta.url));
/** Every surface that renders supervisor copy: monitor-card console, side-panel console, combobox, transcript. */
const supervisorSources = [
  path.join(here, '..', '..', '..', 'components', 'ai', 'AIMonitorPage.tsx'),
  path.join(here, '..', '..', '..', 'components', 'ai', 'SupervisorSidePanel.tsx'),
  path.join(here, '..', '..', '..', 'components', 'ai', 'SupervisorModelPoolCombobox.tsx'),
  path.join(here, '..', '..', '..', 'components', 'ai', 'SupervisorTranscript.tsx'),
  path.join(here, '..', '..', '..', 'components', 'ai', 'SupervisorExecutionDetails.tsx'),
  path.join(here, '..', '..', '..', 'components', 'ai', 'SupervisorRunHistoryDrawer.tsx'),
  path.join(here, '..', '..', '..', 'components', 'ai', 'SupervisorAdvicePanel.tsx'),
  path.join(here, '..', '..', '..', 'components', 'AIChatPanelContent.tsx'),
  path.join(here, '..', '..', '..', 'components', 'AIChatSidePanel.tsx'),
].map((file) => fs.readFileSync(file, 'utf8')).join('\n');

/** Static `t('supervisor.…')` keys used by the panels. */
const staticKeys = [...new Set(
  [...supervisorSources.matchAll(/t\('(supervisor\.[A-Za-z0-9_.]+)'/g)].map((match) => match[1]),
)].sort();

/** Dynamic keys: `t(\`supervisor.status.${status}\`)` etc. */
const dynamicStatuses = [
  'idle', 'running', 'stopped', 'completed', 'budget_exhausted', 'stalled', 'error_loop',
].map((status) => `supervisor.status.${status}`);
const dynamicResults = [
  'complete', 'empty', 'error', 'failed', 'stopped', 'timeout', 'stale_snapshot', 'session_missing',
].map((result) => `supervisor.result.${result}`);
const dynamicActors = ['supervisor', 'agent', 'user', 'system'].map((actor) => `supervisor.actor.${actor}`);

const allKeys = [...new Set([
  ...staticKeys,
  ...dynamicStatuses,
  ...dynamicResults,
  ...dynamicActors,
  ...supervisorActionsSourceKeys,
])].sort();

test('every supervisor key used by the UI exists in all five locales', () => {
  assert.ok(allKeys.length >= 50, `expected a full key set, got ${allKeys.length}`);
  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of allKeys) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`);
      assert.notEqual((messages[key] as string)?.trim(), '', `${locale} has an empty ${key}`);
    }
  }
});

test('all five locales expose exactly the same supervisor keys', () => {
  const sets = Object.entries(locales).map(([locale, messages]) => ({
    locale,
    keys: Object.keys(messages).filter((key) => key.startsWith('supervisor.')).sort(),
  }));
  const baseline = sets[0].keys;
  for (const entry of sets.slice(1)) {
    assert.deepEqual(entry.keys, baseline, `${entry.locale} supervisor key set differs from en`);
  }
  assert.equal(baseline.length, 199);
});

test('placeholder-bearing keys stay consistent across locales', () => {
  const placeholders: Record<string, string[]> = {
    'supervisor.rounds': ['{done}', '{total}'],
    'supervisor.round': ['{n}'],
    'supervisor.eventCount': ['{count}'],
    'supervisor.guard.stall': ['{n}'],
    'supervisor.guard.error': ['{n}'],
    'supervisor.guard.wallClock': ['{n}'],
    'supervisor.side.taskModelInherit': ['{model}'],
  };
  for (const [locale, messages] of Object.entries(locales)) {
    for (const [key, tokens] of Object.entries(placeholders)) {
      for (const token of tokens) {
        assert.ok((messages[key] as string).includes(token), `${locale} ${key} lost ${token}`);
      }
    }
  }
});

test('supervisor surfaces expose stable data attributes for runtime DOM verification', () => {
  for (const attr of [
    'data-ai-monitor-supervisor-badge', 'data-ai-monitor-supervisor-console',
    'data-supervisor-budget-editor', 'data-supervisor-budget-apply',
    'data-ai-monitor-interrupt', 'data-ai-monitor-queue',
    'data-supervisor-timeline',
    'data-supervisor-event-kind', 'data-supervisor-actor',
  ]) {
    assert.ok(supervisorSources.includes(attr), `missing ${attr}`);
  }
});
