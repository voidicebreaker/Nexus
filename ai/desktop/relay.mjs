// No npm dependencies. Node.js 22+; started by Start-LM-Share.cmd on Windows.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SITE = 'https://mindovermatter.space';
const ORIGINS = new Set([SITE, 'https://www.mindovermatter.space', 'https://voidicebreaker.github.io']);
const MAX_BODY = 128 * 1024;
const MAX_TEXT = 100_000;
const MAX_OUTPUT = 200_000;
const ACTIVE_STATES = new Set(['queued', 'running']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function localBase(value = 'http://127.0.0.1:1234') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('LM Studio must use a local HTTP address, for example http://127.0.0.1:1234');
  }
  return url.origin;
}

function matchesKey(header, key) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Message history is too large. Start a new chat.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON request.'); }
}

function chatInput(body) {
  if (!body || typeof body.model !== 'string' || !body.model || body.model.length > 300)
    throw new HttpError(400, 'Choose an available model.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 80)
    throw new HttpError(400, 'Use between 1 and 80 messages. Start a new chat if needed.');
  let length = 0;
  const messages = body.messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
      throw new HttpError(400, 'Only text chat messages are supported.');
    length += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (length > MAX_TEXT) throw new HttpError(413, 'Message history is too large. Start a new chat.');
  if (messages.at(-1).role !== 'user') throw new HttpError(400, 'The last message must be from you.');
  // Deliberately do not forward tools, MCP servers, URLs, or extra model parameters.
  return { model: body.model, messages, stream: true, max_tokens: 2048, temperature: 0.7 };
}

export function createRelay({ key, lmBase, lmToken = '', fetchImpl = fetch,
  generationTimeout = 10 * 60_000, abandonTimeout = 90_000, jobTTL = 15 * 60_000 } = {}) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('A random access key of at least 32 characters is required.');
  const base = localBase(lmBase);
  const upstreamHeaders = { 'Content-Type': 'application/json', ...(lmToken ? { Authorization: `Bearer ${lmToken}` } : {}) };
  const jobs = new Map();
  const queue = [];
  let active = null;
  let stopped = false;
  let modelCache = null;
  let modelPromise = null;
  const attempts = new Map();
  let globalAttempts = { start: Date.now(), count: 0 };

  function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (ACTIVE_STATES.has(job.state) && now - job.seen > abandonTimeout) cancel(job);
      if (!ACTIVE_STATES.has(job.state) && now - job.finished > jobTTL) jobs.delete(id);
    }
    for (const [ip, entry] of attempts) if (now - entry.start > 60_000) attempts.delete(ip);
  }

  function rateLimit(req) {
    // cloudflared connects locally; CF-Connecting-IP is supplied by the edge.
    // This is an abuse guard, never an authentication mechanism.
    const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress).slice(0, 80);
    const now = Date.now();
    if (now - globalAttempts.start > 60_000) globalAttempts = { start: now, count: 0 };
    if (++globalAttempts.count > 3000) throw new HttpError(429, 'Too many requests. Wait a minute.');
    let entry = attempts.get(ip);
    if (!entry || now - entry.start > 60_000) {
      if (attempts.size >= 2048) throw new HttpError(429, 'Too many requests. Wait a minute.');
      attempts.set(ip, entry = { start: now, count: 0 });
    }
    if (++entry.count > 240) throw new HttpError(429, 'Too many requests. Wait a minute.');
  }

  async function models() {
    if (modelCache && Date.now() - modelCache.time < 15_000) return modelCache.data;
    if (modelPromise) return modelPromise;
    modelPromise = (async () => {
      let response;
      try {
        response = await fetchImpl(`${base}/v1/models`, {
          headers: upstreamHeaders, redirect: 'error', signal: AbortSignal.timeout(12_000)
        });
      } catch { throw new HttpError(503, 'LM Studio is offline. Ask the host to start its local server.'); }
      if (response.status === 401 || response.status === 403)
        throw new HttpError(503, 'LM Studio needs its API token. Restart the Windows launcher to enter it.');
      if (!response.ok) throw new HttpError(503, 'LM Studio could not list models. Check the server on the desktop.');
      const body = await response.json();
      const data = (Array.isArray(body.data) ? body.data : [])
        .filter(item => typeof item.id === 'string' && item.id.length <= 300)
        .slice(0, 100).map(item => ({ id: item.id }));
      modelCache = { time: Date.now(), data };
      return data;
    })();
    try { return await modelPromise; } finally { modelPromise = null; }
  }

  function cancel(job) {
    if (!ACTIVE_STATES.has(job.state)) return;
    job.state = 'cancelled';
    job.finished = Date.now();
    job.controller.abort();
  }

  async function run(job) {
    const timeout = setTimeout(() => {
      job.error = 'Generation took more than 10 minutes. Try a shorter prompt or a smaller model.';
      job.controller.abort();
    }, generationTimeout);
    try {
      const response = await fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST', headers: upstreamHeaders, body: JSON.stringify(job.input),
        signal: job.controller.signal, redirect: 'error'
      });
      if (!response.ok) {
        // Do not reflect upstream error bodies, filesystem paths, or secrets to callers.
        throw new Error(response.status === 401 || response.status === 403
          ? 'LM Studio needs its API token. Restart the Windows launcher.'
          : `LM Studio rejected the request (${response.status}). Check that the selected model supports chat and fits its context window.`);
      }
      if (!response.body) throw new Error('LM Studio returned an empty response.');
      if (!response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('LM Studio did not return a chat stream. Update LM Studio and try again.');
      const decoder = new TextDecoder();
      let buffer = '';
      let complete = false;
      const event = block => {
        const data = block.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data.trim() === '[DONE]') { complete = true; return; }
        const value = JSON.parse(data);
        if (value.error) throw new Error('LM Studio reported a generation error. Check the desktop.');
        const choice = value.choices?.[0];
        if (choice?.finish_reason) {
          complete = true;
          if (choice.finish_reason === 'length') job.notice = 'Reply reached the 2,048-token limit.';
        }
        const content = choice?.delta?.content;
        if (typeof content === 'string') job.text += content;
        if (job.text.length > MAX_OUTPUT) throw new Error('Reply exceeded the output limit.');
      };
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); event(block);
        }
        if (buffer.length > MAX_OUTPUT) throw new Error('LM Studio returned an invalid stream.');
      }
      buffer += decoder.decode();
      if (buffer.trim()) event(buffer);
      if (!complete) throw new Error('LM Studio disconnected before the reply finished.');
      if (job.state !== 'cancelled') {
        if (!job.text.trim()) throw new Error('The model returned no text. Try a chat model or a shorter prompt.');
        job.state = 'done';
      }
    } catch (error) {
      if (job.state !== 'cancelled') {
        job.state = 'error';
        job.error ||= error.name === 'TypeError' ? 'Lost connection to LM Studio. Check the desktop.' : error.message;
      }
    } finally {
      clearTimeout(timeout);
      job.finished = Date.now();
      delete job.input;
    }
  }

  async function pump() {
    if (active || stopped) return;
    while (queue.length && !stopped) {
      const job = queue.shift();
      if (job.state !== 'queued') continue;
      active = job;
      job.state = 'running';
      try { await run(job); } finally { active = null; }
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Vary', 'Origin');
    const reply = (status, data) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !ORIGINS.has(origin)) throw new HttpError(403, 'This website is not allowed.');
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204); res.end(); return;
      }
      rateLimit(req);
      if (!matchesKey(req.headers.authorization, key)) throw new HttpError(401, 'Access key is missing or incorrect.');
      prune();
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/models') {
        reply(200, { models: await models(), waiting: queue.filter(job => job.state === 'queued').length }); return;
      }
      if (req.method === 'POST' && path === '/api/chat') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
        const input = chatInput(await readJson(req));
        if (jobs.size >= 100) throw new HttpError(429, 'Session is full. Try again in 15 minutes.');
        if ([...jobs.values()].filter(job => ACTIVE_STATES.has(job.state)).length >= 5)
          throw new HttpError(429, 'The desktop is busy with five requests. Try again shortly.');
        const available = await models();
        if (!available.some(model => model.id === input.model)) throw new HttpError(400, 'That model is unavailable. Reconnect to refresh the list.');
        // Recheck after awaiting the shared models request to keep the queue bounded.
        if ([...jobs.values()].filter(job => ACTIVE_STATES.has(job.state)).length >= 5 || jobs.size >= 100)
          throw new HttpError(429, 'The desktop is busy. Try again shortly.');
        const job = { id: randomBytes(24).toString('hex'), state: 'queued', text: '',
          input, controller: new AbortController(), seen: Date.now(), finished: null };
        jobs.set(job.id, job); queue.push(job);
        reply(202, { id: job.id });
        void pump(); return;
      }
      const match = path.match(/^\/api\/jobs\/([a-f0-9]{48})$/);
      if (match && ['GET', 'DELETE'].includes(req.method)) {
        const job = jobs.get(match[1]);
        if (!job) throw new HttpError(404, 'This reply expired. Send your message again.');
        job.seen = Date.now();
        if (req.method === 'DELETE') cancel(job);
        reply(200, { id: job.id, state: job.state, text: job.text, error: job.error,
          notice: job.notice, position: job.state === 'queued' ? queue.filter(item => item.state === 'queued').indexOf(job) + 1 : 0 });
        return;
      }
      throw new HttpError(404, 'Unknown endpoint.');
    } catch (error) {
      reply(error.status || 500, { error: error.status ? error.message : 'The desktop relay encountered an error.' });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 20_000;
  const interval = setInterval(prune, 15_000);
  interval.unref();
  return { server, close() {
    stopped = true; clearInterval(interval);
    for (const job of jobs.values()) cancel(job);
    return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}

async function main() {
  const stateDir = process.env.MOM_STATE_DIR;
  if (!stateDir) throw new Error('Start this app using Start-LM-Share.cmd.');
  mkdirSync(stateDir, { recursive: true });
  const keyFile = join(stateDir, 'access-key.txt');
  let key;
  if (process.argv.includes('--rotate-key') || !existsSync(keyFile)) {
    key = randomBytes(32).toString('base64url');
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  } else key = readFileSync(keyFile, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Access key file is invalid. Run Reset-Access-Key.cmd.');
  const relay = createRelay({ key, lmBase: process.env.MOM_LM_URL, lmToken: process.env.MOM_LM_TOKEN });
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(8787, '127.0.0.1', resolve);
  });
  console.log('\nPRIVATE ACCESS KEY (give only to your friends):\n');
  console.log(key);
  console.log('\nKeep this window open and your desktop awake. Ctrl+C stops sharing.');
  console.log('Starting the encrypted tunnel...\n');
  const tunnelPath = process.env.MOM_CLOUDFLARED;
  if (!tunnelPath) throw new Error('cloudflared is missing. Restart Start-LM-Share.cmd.');
  // An explicit empty config prevents a pre-existing cloudflared config from overriding this tunnel.
  const emptyConfig = join(stateDir, 'quick-tunnel.yml');
  writeFileSync(emptyConfig, '{}\n');
  const tunnelEnv = { ...process.env };
  // Do not pass the LM token or a pre-existing named-tunnel configuration to cloudflared.
  for (const name of Object.keys(tunnelEnv)) {
    if (name.startsWith('MOM_') || name.startsWith('TUNNEL_') || name === 'NO_TLS_VERIFY') delete tunnelEnv[name];
  }
  const tunnel = spawn(tunnelPath, ['tunnel', '--config', emptyConfig, '--url', 'http://127.0.0.1:8787', '--no-autoupdate', '--metrics', '127.0.0.1:0'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: tunnelEnv });
  let announced = false;
  let recent = '';
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    tunnel.kill();
    await relay.close();
    process.exit(code);
  };
  function logs(chunk) {
    recent = (recent + chunk.toString()).slice(-8000);
    const match = recent.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/);
    if (match && !announced) {
      announced = true;
      const chat = `${SITE}/ai/?server=${encodeURIComponent(match[0])}`;
      console.log('YOUR CHAT LINK (opens the website with the server address filled in):\n');
      console.log(chat);
      console.log('\nShare that link and the private access key with your friends.');
      console.log('The link changes when you restart. Your access key stays the same.');
      console.log('Chats pass through Cloudflare; keep this in mind for private prompts.');
      if (process.platform === 'win32') {
        // No key in this URL, browser history, or process arguments.
        spawn('rundll32.exe', ['url.dll,FileProtocolHandler', chat], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      }
    }
  }
  tunnel.stdout.on('data', logs); tunnel.stderr.on('data', logs);
  tunnel.on('error', error => {
    console.error(`Could not start cloudflared: ${error.message}`); void shutdown(1);
  });
  tunnel.on('exit', () => {
    if (shuttingDown) return;
    console.error('Tunnel stopped. Close this window and restart Start-LM-Share.cmd.');
    if (!announced) console.error(recent.replaceAll(key, '[redacted]'));
    void shutdown(1);
  });
  const timer = setTimeout(() => {
    if (!announced) {
      console.error('The tunnel is still connecting. Check internet access and outbound port 7844.');
      console.error(recent.replaceAll(key, '[redacted]'));
    }
  }, 40_000);
  timer.unref();
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`\n${error.message}`); process.exit(1); });
}
