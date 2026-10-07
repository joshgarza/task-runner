import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorization, authorizationPrefix, verifyAuthorization, authorize } from './authorization.ts';
import { lifecycleConfig } from './model.ts';
import { Registry } from './registry.ts';
import { LinearClient } from '@linear/sdk';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRunnerConfig } from '../types.ts';
import type { Authorization } from './authorization.ts';

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

test('SDK HTTP boundary verifies exact authority and consumes a proof only once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'authorization-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cfg = { ...config, projects: { fixture: {} }, linear: { agentLabel: 'agent-ready' },
    lifecycle: lifecycleConfig({ joshUserId: 'josh', registryPath: join(root, 'state/lifecycle.sqlite') }) } as TaskRunnerConfig;
  const adoption = { action: 'adopt' as const, identifier: 'JOS-1', project: 'fixture',
    startedAt: '2026-01-01T00:00:00Z', reason: 'Preserve original execution clock' };
  const valid = { id: 'approval-id', body: authorizationPrefix + JSON.stringify(adoption),
    user: { id: 'josh' }, issue: { identifier: 'JOS-1' } };
  let response: unknown = { data: { comment: valid } };
  let status = 200;
  const requests: { query: string; variables: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const client = new LinearClient({ apiKey: 'fixture-only', apiUrl: `http://127.0.0.1:${address.port}` });
  const verify = (cfg: TaskRunnerConfig, id: string, req: Authorization) => verifyAuthorization(cfg, id, req, client);
  const registry = new Registry(cfg.lifecycle.registryPath);

  assert.equal(await verify(cfg, valid.id, adoption), valid.id);
  assert.equal(existsSync(registry.path), false, 'read-only verification must not initialize state');
  assert.deepEqual(requests[0].variables, { id: valid.id }, 'variables must be an object on the HTTP wire');
  assert.match(requests[0].query, /comment\(id: \$id\)/);
  assert.equal(requests.length, 1, 'authority evidence comes from one response');

  for (const bad of [null, {}, { ...valid, id: 'different' }, { ...valid, body: null },
    { ...valid, user: null }, { ...valid, user: { id: 'agent' } }, { ...valid, issue: null },
    { ...valid, issue: { identifier: 'JOS-2' } }, { ...valid, body: authorizationPrefix + '{bad-json' },
    { ...valid, body: authorizationPrefix + 'null' }, { ...valid, body: authorizationPrefix + '[]' },
    { ...valid, body: JSON.stringify(adoption) }]) {
    response = { data: { comment: bad } };
    await assert.rejects(authorize(cfg, valid.id, adoption, verify));
    assert.equal(existsSync(registry.path), false);
  }
  response = { data: { comment: valid } };
  for (const change of [{ reason: 'Changed reason' }, { startedAt: '2026-02-01T00:00:00Z' },
    { project: 'other' }, { deadline: '2027-01-01T00:00:00Z' }, { action: 'cancel' as const }]) {
    await assert.rejects(authorize(cfg, valid.id, { ...adoption, ...change },
      (cfg, id, req) => verifyAuthorization(cfg, id, req, client)), /exactly match/);
    assert.equal(existsSync(registry.path), false);
  }
  for (const failure of [{ data: { comment: valid }, errors: [{ message: 'partial response' }] },
    { errors: [{ message: 'server internals must not be printed' }] }]) {
    response = failure;
    status = 'data' in failure ? 200 : 400;
    await assert.rejects(authorize(cfg, valid.id, adoption, verify), error => {
      assert.equal((error as Error).message, 'Could not fetch lifecycle authorization from Linear; verify the comment ID, API access, and connectivity');
      return true;
    });
    assert.equal(existsSync(registry.path), false);
  }
  status = 200;
  response = { data: { comment: valid } };
  await authorize(cfg, valid.id, adoption, verify);
  const state = registry.read();
  assert.equal(state.tickets['JOS-1'].startedAt, Date.parse(adoption.startedAt));
  assert.equal(state.tickets['JOS-1'].deadline, Date.parse(adoption.startedAt) + 72 * 3600_000);
  assert.deepEqual(Object.keys(state.authorizations), [valid.id]);
  await assert.rejects(authorize(cfg, valid.id, adoption, verify), /already consumed/);
  assert.deepEqual(registry.read(), state);
});
