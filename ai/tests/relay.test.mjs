import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay, localBase } from '../desktop/relay.mjs';

const KEY = 't'.repeat(43);
const SITE = 'https://mindovermatter.space';
const input = { model: 'test-chat', messages: [{ role: 'user', content: 'hello' }] };
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handler, options = {}) {
  const calls = [];
  const sockets = new Set();
  const lm = http.createServer(async (req, res) => {
    calls.push({ path: req.url, auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'test-chat', internal: 'not forwarded' }] })); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.at(-1).body = body;
    if (handler) await handler(req, res, body);
    else {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\r\n\r\n');
      res.write('data: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    }
  });
  lm.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const lmBase = await listen(lm);
  const relay = createRelay({ key: KEY, lmBase, lmToken: 'upstream-secret', ...options });
  const address = await listen(relay.server);
  t.after(async () => {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => lm.close(resolve));
  });
  async function api(path, { key = KEY, origin = SITE, body, ...rest } = {}) {
    const response = await fetch(address + path, {
      ...rest, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  }
  async function submit(body = input) {
    const response = await api('/api/chat', { method: 'POST', body });
    assert.equal(response.status, 202, JSON.stringify(response.data));
    return response.data.id;
  }
  async function untilDone(id) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const reply = await api(`/api/jobs/${id}`);
      if (!['queued', 'running'].includes(reply.data.state)) return reply.data;
      await delay(10);
    }
    assert.fail('Generation did not finish');
  }
  return { api, submit, untilDone, calls, address };
}

test('requires a long access key and restricts the LM upstream to loopback', () => {
  assert.throws(() => createRelay({ key: 'short' }));
  for (const value of ['https://example.com', 'http://192.168.1.20:1234', 'http://localhost:1234/v1', 'http://user:pw@localhost:1234', 'http://localhost:1234?x=1'])
    assert.throws(() => localBase(value));
  assert.equal(localBase('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});

test('unauthenticated requests never reach LM Studio, including job paths', async t => {
  const f = await fixture(t);
  for (const key of [null, 'wrong', KEY + 'extra']) {
    assert.equal((await f.api('/api/models', { key })).status, 401);
    assert.equal((await f.api('/api/chat', { key, method: 'POST', body: input })).status, 401);
    assert.equal((await f.api('/api/jobs/' + 'a'.repeat(48), { key })).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('CORS allows the website and rejects other origins; responses are not cached', async t => {
  const f = await fixture(t);
  const allowed = await f.api('/api/models', { method: 'OPTIONS', key: null });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), SITE);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.api('/api/models', { origin: 'https://untrusted.example' })).status, 403);
  const good = await f.api('/api/models');
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.deepEqual(good.data.models, [{ id: 'test-chat' }]);
  assert.equal(f.calls[0].auth, 'Bearer upstream-secret');
});

test('streams a Unicode answer through the polling API and strips tools and extra parameters', async t => {
  const f = await fixture(t);
  const id = await f.submit({ ...input, tools: [{ type: 'function' }], mcp_servers: ['evil'], max_tokens: 900_000 });
  assert.match(id, /^[a-f0-9]{48}$/);
  const result = await f.untilDone(id);
  assert.equal(result.state, 'done');
  assert.equal(result.text, 'Hello 世界');
  const sent = f.calls.find(call => call.path === '/v1/chat/completions').body;
  assert.deepEqual(Object.keys(sent).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(sent.max_tokens, 2048);
  assert.equal(JSON.stringify(result).includes('upstream-secret'), false);
});

test('only one generation runs at a time; queued requests can be cancelled', async t => {
  const pending = [];
  let running = 0, peak = 0;
  const f = await fixture(t, async (_req, res) => {
    running++; peak = Math.max(peak, running);
    res.on('close', () => running--);
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    pending.push(res);
  });
  const first = await f.submit();
  const second = await f.submit();
  const third = await f.submit();
  assert.equal((await f.api(`/api/jobs/${second}`)).data.state, 'queued');
  assert.equal((await f.api(`/api/jobs/${third}`)).data.position, 2);
  assert.equal((await f.api(`/api/jobs/${second}`, { method: 'DELETE' })).data.state, 'cancelled');
  pending[0].end('data: [DONE]\n\n');
  await f.untilDone(first);
  for (let i = 0; pending.length < 2 && i < 50; i++) await delay(10);
  assert.equal(pending.length, 2);
  pending[1].end('data: [DONE]\n\n');
  assert.equal((await f.untilDone(third)).state, 'done');
  assert.equal(peak, 1);
  assert.equal(f.calls.filter(call => call.path === '/v1/chat/completions').length, 2);
});

test('cancelling a running generation releases the GPU for the next request', async t => {
  let count = 0;
  const f = await fixture(t, async (_req, res) => {
    count++;
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    if (count > 1) res.end('data: [DONE]\n\n');
  });
  const first = await f.submit();
  const second = await f.submit();
  assert.equal((await f.api(`/api/jobs/${first}`, { method: 'DELETE' })).data.state, 'cancelled');
  assert.equal((await f.untilDone(second)).state, 'done');
});

test('bounds the generation queue and blocks model-management routes', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(': waiting\n\n');
  });
  for (let i = 0; i < 5; i++) await f.submit();
  assert.equal((await f.api('/api/chat', { method: 'POST', body: input })).status, 429);
  for (const path of ['/v1/chat/completions', '/api/v1/models/load', '/v1/models', '/files', '/'])
    assert.equal((await f.api(path)).status, 404);
});

test('validates model, message roles, message count, and total input size', async t => {
  const f = await fixture(t);
  for (const body of [
    { ...input, model: 'unknown' },
    { ...input, messages: [] },
    { ...input, messages: [{ role: 'system', content: 'not permitted' }] },
    { ...input, messages: [{ role: 'user', content: { image: 'x' } }] },
    { ...input, messages: Array.from({ length: 81 }, () => input.messages[0]) }
  ]) assert.equal((await f.api('/api/chat', { method: 'POST', body })).status, 400);
  assert.equal((await f.api('/api/chat', { method: 'POST', body: { ...input, messages: [{ role: 'user', content: 'x'.repeat(100_001) }] } })).status, 413);
  assert.equal(f.calls.filter(call => call.path === '/v1/chat/completions').length, 0);
});

test('upstream errors are useful but do not reflect secrets or local paths', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(400); res.end('Secret upstream-secret at C:\\Users\\Host\\private');
  });
  const result = await f.untilDone(await f.submit());
  assert.equal(result.state, 'error');
  assert.match(result.error, /400/);
  assert.equal(JSON.stringify(result).includes('upstream-secret'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('generation timeout aborts the upstream instead of leaving the GPU occupied', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(': waiting\n\n');
  }, { generationTimeout: 50 });
  const result = await f.untilDone(await f.submit());
  assert.equal(result.state, 'error');
  assert.match(result.error, /took more/);
});

test('an incomplete stream is reported as an error, not a completed reply', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n');
  });
  const result = await f.untilDone(await f.submit());
  assert.equal(result.state, 'error');
  assert.equal(result.text, 'unfinished');
});

test('split UTF-8 and CRLF events are parsed correctly', async t => {
  const f = await fixture(t, async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"🌍"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (const byte of bytes) { res.write(Buffer.from([byte])); await delay(1); }
    res.end();
  });
  const result = await f.untilDone(await f.submit());
  assert.equal(result.state, 'done');
  assert.equal(result.text, '🌍');
});
