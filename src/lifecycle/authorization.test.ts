import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorization, authorizationPrefix } from './authorization.ts';
import { lifecycleConfig } from './model.ts';
import type { TaskRunnerConfig } from '../types.ts';

const config = { lifecycle: lifecycleConfig({ joshUserId: 'josh' }) } as TaskRunnerConfig;
const request = { action: 'extend' as const, identifier: 'JOS-1', reason: 'Approved time for review', deadline: '2027-01-01T00:00:00Z' };
const comment = { authorId: 'josh', identifier: 'JOS-1', body: authorizationPrefix + JSON.stringify(request) };
test('only an exact Josh-authored authorization on the target ticket permits policy changes', () => {
  validateAuthorization(config, request, comment);
  for (const changed of [{ ...comment, authorId: 'agent' }, { ...comment, identifier: 'JOS-2' }, { ...comment, body: JSON.stringify(request) }]) assert.throws(() => validateAuthorization(config, request, changed));
  assert.throws(() => validateAuthorization(config, { ...request, deadline: '2028-01-01T00:00:00Z' }, comment), /exactly match/);
});
test('deadline authority includes reason and timezone; priority and scope require explicit values', () => {
  for (const bad of [{ ...request, reason: '' }, { ...request, deadline: '2027-01-01' }, { ...request, action: 'reprioritize' as const }, { ...request, action: 'scope-change' as const }]) {
    assert.throws(() => validateAuthorization(config, bad, { ...comment, body: authorizationPrefix + JSON.stringify(bad) }));
  }
});
