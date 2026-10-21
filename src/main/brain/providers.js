'use strict';
/**
 * LLM providers with an agentic tool loop.
 *  - anthropic: Claude Messages API (default, Haiku 5.5)
 *  - openai: any OpenAI-compatible /chat/completions endpoint (Ollama, LM Studio, vLLM, OpenRouter...)
 * Both take neutral inputs: { system, messages:[{role, content}], tools:[{name, description, input_schema}], dispatch(name, input) }
 */

const MAX_TOOL_ROUNDS = 8;

// USD per million tokens (first-party Claude API, Oct 2026). Used only for the on-screen cost estimate.
const PRICES = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-sonnet-5-5': { in: 2.0, out: 10.0, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-5': { in: 2.0, out: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
};

// Web version (browser): Anthropic requires this opt-in header for direct browser calls (the user's own key, stored only on their device).
const BROWSER_HEADER = typeof window !== 'undefined' && typeof document !== 'undefined' ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {};
function estimateCost(model, usage) {
  const key = Object.keys(PRICES).find((k) => (model || '').startsWith(k));
  if (!key || !usage) return null;
  const p = PRICES[key];
  const usd =
    ((usage.input_tokens || 0) * p.in +
      (usage.output_tokens || 0) * p.out +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
      (usage.cache_read_input_tokens || 0) * p.cacheRead) /
    1e6;
  return +usd.toFixed(5);
}

async function fetchJson(url, opts, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = (json && json.error && (json.error.message || json.error)) || text.slice(0, 300);
      const err = new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST and read the answer as a stream when the server sends one (text/event-stream), as JSON otherwise.
 * onSse(eventName, dataObject) is called per server-sent event; returns { streamed, json } (json only when not streamed).
 * The timeout is an inactivity timeout: it resets on every chunk, so a long answer never trips it while it is flowing.
 */
async function fetchSse(url, opts, onSse, idleMs = 60000) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), idleMs);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), idleMs);
  };
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const ctype = String(res.headers.get('content-type') || '');
    if (!res.ok || !/text\/event-stream/i.test(ctype)) {
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      if (!res.ok) {
        const msg = (json && json.error && (json.error.message || json.error)) || text.slice(0, 300);
        const err = new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        err.status = res.status;
        throw err;
      }
      return { streamed: false, json };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const handle = (block) => {
      let ev = 'message';
      const datas = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
      }
      if (!datas.length) return;
      const data = datas.join('\n');
      if (data === '[DONE]') return onSse('done', null);
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }
      onSse(obj.type || ev, obj);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bump();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i).replace(/\r/g, '');
        buf = buf.slice(i + 2);
        if (block.trim()) handle(block);
      }
    }
    if (buf.trim()) handle(buf.replace(/\r/g, ''));
    return { streamed: true, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic Messages API, streamed: rebuilds the same { content, stop_reason, usage, model } a plain call returns, emitting text deltas. */
async function anthropicStream(url, headers, body, onDelta) {
  const out = { content: [], stop_reason: null, usage: {}, model: body.model };
  const blocks = [];
  let gotEvents = false;
  const r = await fetchSse(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) }, (type, ev) => {
    gotEvents = true;
    if (type === 'message_start' && ev.message) {
      out.model = ev.message.model || out.model;
      Object.assign(out.usage, ev.message.usage || {});
    } else if (type === 'content_block_start') {
      blocks[ev.index] =
        ev.content_block.type === 'tool_use'
          ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, _json: '' }
          : { type: 'text', text: ev.content_block.text || '' };
    } else if (type === 'content_block_delta') {
      const b = blocks[ev.index];
      if (!b) return;
      if (ev.delta.type === 'text_delta') {
        b.text += ev.delta.text;
        onDelta && onDelta(ev.delta.text);
      } else if (ev.delta.type === 'input_json_delta') b._json += ev.delta.partial_json;
    } else if (type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) out.stop_reason = ev.delta.stop_reason;
      if (ev.usage) Object.assign(out.usage, ev.usage);
    } else if (type === 'error') {
      const err = new Error((ev.error && ev.error.message) || 'stream error');
      err.status = 500;
      throw err;
    }
  });
  if (!r.streamed) return r.json; // the server answered with plain JSON: use it as is
  if (!gotEvents) throw new Error('empty stream');
  // empty text blocks (a text block that got no delta) are dropped: the API rejects them when the content is sent back
  out.content = blocks
    .filter((b) => b && !(b.type === 'text' && !b.text))
    .map((b) => {
      if (b.type !== 'tool_use') return b;
      let input = {};
      try {
        input = b._json ? JSON.parse(b._json) : {};
      } catch {
        input = {};
      }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    });
  return out;
}

/** OpenAI-compatible chat completion, streamed: rebuilds { choices:[{message, finish_reason}], usage }, emitting text deltas. */
async function openaiStream(url, headers, body, onDelta, timeout) {
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  const calls = new Map();
  let finish = null;
  let usage = null;
  let gotEvents = false;
  const r = await fetchSse(
    url,
    { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }) },
    (type, ev) => {
      if (type === 'done' || !ev) return;
      gotEvents = true;
      if (ev.usage) usage = ev.usage;
      const ch = ev.choices && ev.choices[0];
      if (!ch) return;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        msg.content += d.content;
        onDelta && onDelta(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const key = tc.index != null ? tc.index : calls.size;
        let cur = calls.get(key);
        if (!cur) calls.set(key, (cur = { id: tc.id || `call_${key}`, type: 'function', function: { name: '', arguments: '' } }));
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.function.name += tc.function.name;
        if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
      }
    },
    timeout
  );
  if (!r.streamed) return r.json;
  if (!gotEvents) throw new Error('empty stream');
  msg.tool_calls = [...calls.values()];
  if (!msg.tool_calls.length) delete msg.tool_calls;
  return { choices: [{ finish_reason: finish, message: msg }], usage };
}

/** Refuse to send an API key in clear text over the internet: http:// is only allowed to this PC or a private LAN/Tailscale address. Enforced for every provider call. */
function assertSafeKeyTransport(url, apiKey) {
  if (!apiKey) return;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('URL base inválida: ' + url);
  }
  if (u.protocol === 'https:') return;
  const h = u.hostname;
  const privateHost =
    h === 'localhost' ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
    /\.(local|lan|internal|ts\.net)$/.test(h);
  if (!privateHost) throw new Error(`No envío la API key por http:// a ${h}: usá https:// (o una dirección local/privada para Ollama).`);
}

/**
 * System prompt → Anthropic blocks. Cache layout (max 4 breakpoints per request):
 *   1. last tool definition (static)            → reused across every question of the session
 *   2. static system rules (first block)        → reused across every question of the session
 *   3. dynamic block (state + retrieved notes)  → reused across the tool rounds of ONE question
 *   4. last message (set per round in the loop) → previous rounds' tool results are read from cache
 * A string is a single cached block (back-compat).
 */
function systemBlocks(system) {
  // A string (default, experimentalCache OFF) = one cached block, exactly as v0.11. An array (experimentalCache ON) = split layout.
  if (!Array.isArray(system)) return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  return system.filter(Boolean).map((text, i) => (i < 2 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text }));
}
/** Copy of the messages with a cache breakpoint on the last content block only (keeps at most one message breakpoint). */
function withMessageBreakpoint(msgs) {
  if (!msgs.length) return msgs;
  const out = msgs.slice(0, -1);
  const last = msgs[msgs.length - 1];
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
  if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  out.push({ role: last.role, content: blocks });
  return out;
}
function systemText(system) {
  return Array.isArray(system) ? system.filter(Boolean).join('\n\n') : system;
}

/* ------------------------------------------------------------------ Anthropic */
async function anthropicComplete({
  apiKey,
  model,
  baseUrl,
  maxTokens = 700,
  system,
  messages,
  tools,
  dispatch,
  onEvent,
  forceTool = null,
  strictTransport = false,
  stream = false,
}) {
  if (!apiKey) throw new Error('No Claude API key set. Open Settings and paste your key (console.anthropic.com).');
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  assertSafeKeyTransport(url, apiKey); // always: a key never travels in clear text to a public host
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...BROWSER_HEADER };
  const aTools = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  const usageTotal = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const toolLog = [];
  let emptyRetries = 0;
  let useStream = !!stream;
  for (let round = 0; round <= MAX_TOOL_ROUNDS + 2; round++) {
    const body = {
      model,
      max_tokens: maxTokens,
      system: systemBlocks(system),
      tools: aTools,
      messages: round > 0 && Array.isArray(system) ? withMessageBreakpoint(msgs) : msgs,
    };
    if (round === 0 && forceTool) body.tool_choice = { type: 'tool', name: forceTool };
    onEvent && onEvent({ type: 'round', n: round });
    const onDelta = (t) => onEvent && onEvent({ type: 'delta', text: t });
    const post = () => (useStream ? anthropicStream(url, headers, body, onDelta) : fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) }));
    let res;
    try {
      res = await post();
    } catch (e) {
      if (body.tool_choice && e.status === 400 && /tool_choice/i.test(e.message)) {
        delete body.tool_choice;
        res = await post();
      } else if (useStream && (e.status === 400 || e.status === 404 || e.status === 422 || /stream/i.test(String(e.message)))) {
        useStream = false; // the server does not stream: plain request from here on
        res = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) });
      } else throw e;
    }
    for (const k of Object.keys(usageTotal)) usageTotal[k] += (res.usage && res.usage[k]) || 0;
    const content = res.content || [];
    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !toolUses.length) {
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text && emptyRetries < 2) {
        // model ended without an answer (e.g. after tool results): ask for it explicitly
        emptyRetries++;
        toolLog.push({ name: '(empty-answer retry)', stop: res.stop_reason });
        if (content.length) msgs.push({ role: 'assistant', content });
        msgs.push({ role: 'user', content: 'Give the answer to the player now, in text (decision first, short).' });
        continue;
      }
      return {
        text: text || '(el modelo no devolvió respuesta — reintentá)',
        usage: usageTotal,
        cost: estimateCost(model, usageTotal),
        toolLog,
        model: res.model || model,
        stop: res.stop_reason,
      };
    }
    msgs.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) {
      onEvent && onEvent({ type: 'tool', name: tu.name, input: tu.input });
      const out = await dispatch(tu.name, tu.input);
      const json = JSON.stringify(out);
      toolLog.push({ name: tu.name, input: tu.input, ok: !(out && out.error), result: json.slice(0, 3000) });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: json.slice(0, 12000) });
    }
    msgs.push({ role: 'user', content: results });
  }
  throw new Error('Too many tool rounds');
}

/** POST to an OpenAI-compatible endpoint, adapting to provider quirks (max_tokens vs max_completion_tokens, tool_choice). */
async function oaiPost(url, headers, body, timeout) {
  const send = (b) => fetchJson(url, { method: 'POST', headers, body: JSON.stringify(b) }, timeout);
  let b = { ...body };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send(b);
    } catch (e) {
      const m = String(e.message || '');
      if (e.status !== 400 && e.status !== 422) throw e;
      if (/max_completion_tokens/i.test(m) && 'max_tokens' in b) {
        b = { ...b, max_completion_tokens: b.max_tokens };
        delete b.max_tokens;
        continue;
      }
      if (/max_tokens/i.test(m) && 'max_completion_tokens' in b) {
        b = { ...b, max_tokens: b.max_completion_tokens };
        delete b.max_completion_tokens;
        continue;
      }
      if (/tool_choice/i.test(m) && 'tool_choice' in b) {
        b = { ...b };
        delete b.tool_choice;
        continue;
      }
      throw e;
    }
  }
  return send(b);
}

/* ------------------------------------------------------------------ OpenAI-compatible */
async function openaiComplete({
  apiKey,
  model,
  baseUrl,
  maxTokens = 700,
  system,
  messages,
  tools,
  dispatch,
  onEvent,
  forceTool = null,
  strictTransport = false,
  stream = false,
}) {
  const url = (baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '') + '/chat/completions';
  assertSafeKeyTransport(url, apiKey); // always: a key never travels in clear text to a public host
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) };
  const oTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const msgs = [{ role: 'system', content: systemText(system) }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
  const usageTotal = { input_tokens: 0, output_tokens: 0 };
  const toolLog = [];
  let emptyRetries = 0;
  let useStream = !!stream;
  for (let round = 0; round <= MAX_TOOL_ROUNDS + 2; round++) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: msgs,
      tools: oTools,
      tool_choice: round === 0 && forceTool ? { type: 'function', function: { name: forceTool } } : 'auto',
    };
    onEvent && onEvent({ type: 'round', n: round });
    let res;
    if (useStream) {
      try {
        res = await openaiStream(url, headers, body, (t) => onEvent && onEvent({ type: 'delta', text: t }), 120000);
      } catch (e) {
        if (e.status === 400 || e.status === 404 || e.status === 422 || /stream|empty/i.test(String(e.message)))
          useStream = false; // local servers without streaming
        else throw e;
      }
    }
    if (!res) res = await oaiPost(url, headers, body, 120000);
    if (res.usage) {
      usageTotal.input_tokens += res.usage.prompt_tokens || 0;
      usageTotal.output_tokens += res.usage.completion_tokens || 0;
    }
    const msg = res.choices && res.choices[0] && res.choices[0].message;
    if (!msg) throw new Error('Empty response from model');
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const text = (msg.content || '').trim();
      if (!text && emptyRetries < 2) {
        emptyRetries++;
        msgs.push({ role: 'assistant', content: '' });
        msgs.push({ role: 'user', content: 'Give the answer to the player now, in text (decision first, short).' });
        continue;
      }
      return { text: text || '(el modelo no devolvió respuesta — reintentá)', usage: usageTotal, cost: null, toolLog, model };
    }
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      let input = {};
      try {
        input = JSON.parse(c.function.arguments || '{}');
      } catch {
        /* ignore */
      }
      onEvent && onEvent({ type: 'tool', name: c.function.name, input });
      const out = await dispatch(c.function.name, input);
      const json = JSON.stringify(out);
      toolLog.push({ name: c.function.name, input, ok: !(out && out.error), result: json.slice(0, 3000) });
      msgs.push({ role: 'tool', tool_call_id: c.id, content: json.slice(0, 12000) });
    }
  }
  throw new Error('Too many tool rounds');
}

/** Plain text completion without tools (used for the match-state extraction step). */
async function plainComplete(provider, { apiKey, model, baseUrl, system, user, maxTokens = 400, strictTransport = false, timeoutMs = 60000 }) {
  if (provider === 'openai') {
    const url = (baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '') + '/chat/completions';
    assertSafeKeyTransport(url, apiKey); // always: a key never travels in clear text to a public host
    const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) };
    const res = await oaiPost(
      url,
      headers,
      {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      timeoutMs
    );
    const msg = res.choices && res.choices[0] && res.choices[0].message;
    return {
      text: ((msg && msg.content) || '').trim(),
      usage: { input_tokens: (res.usage && res.usage.prompt_tokens) || 0, output_tokens: (res.usage && res.usage.completion_tokens) || 0 },
      cost: null,
    };
  }
  if (!apiKey) throw new Error('No Claude API key set. Open Settings and paste your key (console.anthropic.com).');
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  assertSafeKeyTransport(url, apiKey); // always: a key never travels in clear text to a public host
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...BROWSER_HEADER };
  const res = await fetchJson(
    url,
    { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }) },
    timeoutMs
  );
  const text = (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text, usage: res.usage || {}, cost: estimateCost(model, res.usage), stop: res.stop_reason || null, model: res.model || model };
}

function complete(provider, args) {
  if (provider === 'openai') return openaiComplete(args);
  return anthropicComplete(args);
}

module.exports = { assertSafeKeyTransport, systemBlocks, withMessageBreakpoint, complete, plainComplete, estimateCost, fetchSse, PRICES };
