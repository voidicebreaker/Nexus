'use strict';
const $ = id => document.getElementById(id);
let connection = null;
let history = [];
let current = null;
let connecting = false;
let connectionEpoch = 0;

function desktopAddress(value) {
  const url = new URL(value.trim());
  const allowed = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url.hostname) ||
    ['ai.mindovermatter.space', 'llm.mindovermatter.space'].includes(url.hostname);
  if (url.protocol !== 'https:' || !allowed || url.port || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw new Error('Paste the HTTPS desktop address printed in the sharing window.');
  return url.origin;
}

try {
  const incoming = new URL(location.href).searchParams.get('server');
  const stored = localStorage.getItem('mom-desktop-address');
  if (incoming || stored) $('server').value = desktopAddress(incoming || stored);
} catch { /* A blocked browser storage setting does not prevent chat. */ }

function message(text, isError = false) {
  $('connection-message').textContent = text;
  $('connection-message').classList.toggle('error', isError);
}
function replyStatus(text, isError = false) {
  $('reply-status').textContent = text;
  $('reply-status').classList.toggle('error', isError);
}
function updateControls() {
  const ready = Boolean(connection);
  $('prompt').disabled = !ready || connecting;
  $('send').disabled = !ready || Boolean(current) || connecting;
  $('new-chat').disabled = !ready || Boolean(current) || connecting;
  $('model').disabled = Boolean(current) || connecting;
  $('connect').disabled = Boolean(current) || connecting;
  $('server').disabled = Boolean(current) || connecting;
  $('access-key').disabled = Boolean(current) || connecting;
  $('stop').hidden = !current;
  $('send').hidden = Boolean(current);
  $('model-controls').hidden = !ready;
  $('prompt').placeholder = ready ? 'Message the desktop model…' : 'Connect to the desktop to start chatting…';
}

async function api(conn, path, options = {}) {
  let response;
  try {
    response = await fetch(`${conn.server}${path}`, {
      ...options, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Authorization: `Bearer ${conn.key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new Error('Cannot reach the desktop. Check that its sharing window is open and use its latest address.');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The tunnel is unavailable. Check the desktop sharing window and try again.'); }
  if (!response.ok) throw new Error(data.error || `The desktop returned an error (${response.status}).`);
  return data;
}

function clearConversation() {
  history = [];
  $('conversation').querySelectorAll('.message').forEach(item => item.remove());
  $('empty-state').hidden = false;
  replyStatus('');
}

$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (current || connecting) return;
  let candidate;
  try {
    candidate = { server: desktopAddress($('server').value), key: $('access-key').value.trim() };
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate.key)) throw new Error('Paste the full private access key from the desktop sharing window.');
  } catch (error) { message(error.message, true); return; }
  const epoch = ++connectionEpoch;
  connecting = true;
  updateControls(); message('Connecting to the desktop…');
  try {
    const data = await api(candidate, '/api/models');
    if (epoch !== connectionEpoch) return;
    if (!Array.isArray(data.models) || !data.models.length) throw new Error('No models are available. Ask the host to load a chat model in LM Studio.');
    const previous = connection;
    connection = candidate;
    if (!previous || previous.server !== candidate.server || previous.key !== candidate.key) clearConversation();
    const selected = $('model').value;
    $('model').replaceChildren();
    for (const model of data.models) {
      if (typeof model.id !== 'string') continue;
      const option = document.createElement('option'); option.value = model.id; option.textContent = model.id;
      $('model').append(option);
    }
    if (!$('model').options.length) throw new Error('No usable model was returned by the desktop.');
    if (Array.from($('model').options).some(option => option.value === selected)) $('model').value = selected;
    $('connection-status').textContent = 'Desktop connected';
    $('status-dot').className = 'dot online';
    $('connect').textContent = 'Reconnect / refresh models';
    message('Connected. Choose a chat model and send a message.');
    try { localStorage.setItem('mom-desktop-address', candidate.server); } catch { /* optional */ }
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    connection = null;
    $('connection-status').textContent = 'Connection failed';
    $('status-dot').className = 'dot error';
    message(error.message, true);
  } finally { connecting = false; updateControls(); }
});

$('disconnect').addEventListener('click', () => {
  ++connectionEpoch;
  if (current) {
    current.stopped = true;
    if (current.id) void api(current.conn, `/api/jobs/${current.id}`, { method: 'DELETE' }).catch(() => {});
  }
  connection = null;
  $('access-key').value = '';
  $('connection-status').textContent = 'Not connected';
  $('status-dot').className = 'dot';
  $('connect').textContent = 'Connect to desktop →';
  message('Disconnected. Your access key has been forgotten.');
  updateControls();
});

$('new-chat').addEventListener('click', () => { clearConversation(); $('prompt').value = ''; $('prompt').focus(); });
$('model').addEventListener('change', () => { clearConversation(); replyStatus('New conversation started for the selected model.'); });

function addMessage(role, text) {
  $('empty-state').hidden = true;
  const article = document.createElement('article'); article.className = `message ${role}`;
  const head = document.createElement('div'); head.className = 'message-head';
  const name = document.createElement('span'); name.textContent = role === 'user' ? 'YOU' : 'DESKTOP AI'; head.append(name);
  const content = document.createElement('div'); content.className = 'message-content'; content.textContent = text;
  if (role === 'assistant') {
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-button'; copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(content.textContent); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Select text to copy'; }
    });
    head.append(copy);
  }
  article.append(head, content); $('conversation').append(article); scrollChat();
  return { article, content };
}
function scrollChat() { $('conversation').scrollTop = $('conversation').scrollHeight; }

$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!connection || current || connecting) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  if (history.length >= 78) { replyStatus('Start a new chat to keep the conversation within the desktop limit.', true); return; }
  const task = { conn: connection, id: null, stopped: false };
  current = task; updateControls();
  const user = addMessage('user', prompt);
  const assistant = addMessage('assistant', '');
  history.push({ role: 'user', content: prompt });
  $('prompt').value = '';
  let answer = '';
  let finished = false;
  replyStatus('Sending to the desktop…');
  try {
    const created = await api(task.conn, '/api/chat', { method: 'POST', body: JSON.stringify({ model: $('model').value, messages: history }) });
    task.id = created.id;
    if (!/^[a-f0-9]{48}$/.test(task.id)) throw new Error('The desktop returned an invalid reply identifier.');
    if (task.stopped) { await api(task.conn, `/api/jobs/${task.id}`, { method: 'DELETE' }); return; }
    let failures = 0;
    while (!task.stopped) {
      let job;
      try { job = await api(task.conn, `/api/jobs/${task.id}`); failures = 0; }
      catch (error) {
        if (++failures >= 3) throw error;
        replyStatus('Connection interrupted. Trying to resume the reply…');
        await new Promise(resolve => setTimeout(resolve, 2000)); continue;
      }
      if (task.stopped) break;
      if (typeof job.text === 'string') {
        const box = $('conversation'); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
        answer = job.text; assistant.content.textContent = answer;
        if (nearBottom) scrollChat();
      }
      if (job.state === 'done') { finished = true; replyStatus(job.notice || 'Reply complete.'); break; }
      if (job.state === 'error') throw new Error(job.error || 'The desktop could not finish the reply.');
      if (job.state === 'cancelled') { task.stopped = true; break; }
      replyStatus(job.state === 'queued' ? `Waiting for the GPU · queue position ${job.position}` : answer ? 'Receiving reply…' : 'Model is working…');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (!task.stopped) replyStatus(error.message, true);
    if (task.id) void api(task.conn, `/api/jobs/${task.id}`, { method: 'DELETE' }).catch(() => {});
  } finally {
    if (answer) history.push({ role: 'assistant', content: answer });
    else {
      history.pop(); user.article.remove(); assistant.article.remove();
      if (connection === task.conn) $('prompt').value = prompt;
      $('empty-state').hidden = history.length > 0;
    }
    if (task.stopped) replyStatus(answer ? 'Reply stopped. You can continue the conversation.' : 'Reply stopped. Your message is back in the composer.');
    current = null; updateControls();
    if (finished && connection) $('prompt').focus();
  }
});

$('stop').addEventListener('click', () => {
  if (!current) return;
  current.stopped = true;
  replyStatus('Stopping the reply…');
  if (current.id) void api(current.conn, `/api/jobs/${current.id}`, { method: 'DELETE' }).catch(() => {});
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); if (!$('send').disabled) $('chat-form').requestSubmit();
  }
});
updateControls();
