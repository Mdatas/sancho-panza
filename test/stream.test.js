'use strict';
/** Streamed answers: SSE from an Anthropic-shaped and an OpenAI-shaped mock (tool round + final text), deltas reach onEvent, fallback to JSON. */
const http = require('http');
const assert = require('assert');
const { complete } = require('../src/main/brain/providers');

const TOOLS = [{ name: 'lookup_unit', description: 'x', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }];
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i >= events.length) return res.end();
    const [type, data] = events[i++];
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    setTimeout(tick, 3);
  };
  tick();
};
const readBody = (req) =>
  new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(JSON.parse(b || '{}')));
  });

// Anthropic-shaped: first request → tool_use (streamed), second → text (streamed); streaming refused when ?nostream

const mockA = http.createServer(async (req, res) => {
  const body = await readBody(req);

  const hasToolResult = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({
        content: [{ type: 'text', text: 'plain json answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
        model: 'claude-sonnet-5-5',
      })
    );
  }
  if (!hasToolResult) {
    return sse(res, [
      ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 900, cache_read_input_tokens: 700 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'lookup_unit' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name": "Pik' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'eman"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  }
  sse(res, [
    ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 950 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '• Hacé piqueros\n• 8 piqueros\n' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '• +22 vs caballería\n---\n' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Detalle: el piquero cuesta 35F 25W.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
});
// OpenAI-shaped: tool call split across chunks, then text chunks, usage in the last chunk
const mockO = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const hasTool = body.messages.some((m) => m.role === 'tool');
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'plain' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      })
    );
  }
  const chunks = !hasTool
    ? [
        { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'lookup_', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'unit', arguments: '{"name":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Pikeman"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ]
    : [
        { choices: [{ delta: { role: 'assistant', content: 'Pikeman ' } }] },
        { choices: [{ delta: { content: 'has 55 HP.' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 6 } },
      ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i >= chunks.length) {
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
    setTimeout(tick, 3);
  };
  tick();
});

(async () => {
  await new Promise((r) => mockA.listen(0, r));
  await new Promise((r) => mockO.listen(0, r));
  const dispatched = [];
  const dispatch = async (name, input) => {
    dispatched.push([name, input]);
    return { hp: 55 };
  };
  const events = [];
  const base = {
    apiKey: 'sk-test',
    maxTokens: 300,
    system: ['RULES', 'DYN'],
    messages: [{ role: 'user', content: 'piqueros?' }],
    tools: TOOLS,
    dispatch,
    onEvent: (e) => events.push(e),
    stream: true,
  };
  const a = await complete('anthropic', { ...base, model: 'claude-sonnet-5-5', baseUrl: `http://127.0.0.1:${mockA.address().port}` });
  assert.deepStrictEqual(dispatched, [['lookup_unit', { name: 'Pikeman' }]], 'tool input rebuilt from json deltas');
  assert.ok(a.text.startsWith('• Hacé piqueros') && a.text.includes('35F 25W'), a.text);
  const deltas = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('');
  assert.strictEqual(deltas, a.text, 'every text delta reached onEvent');
  assert.ok(events.filter((e) => e.type === 'round').length === 2 && events.some((e) => e.type === 'tool'));
  assert.strictEqual(a.usage.input_tokens, 1850);
  assert.strictEqual(a.usage.output_tokens, 60);
  assert.strictEqual(a.usage.cache_read_input_tokens, 700);
  assert.ok(a.cost > 0);
  // JSON answer to a streaming request (a proxy that ignores stream:true) still works
  const plain = await complete('anthropic', { ...base, stream: false, model: 'claude-sonnet-5-5', baseUrl: `http://127.0.0.1:${mockA.address().port}` });
  assert.strictEqual(plain.text, 'plain json answer');
  // OpenAI-compatible
  dispatched.length = 0;
  events.length = 0;
  const o = await complete('openai', { ...base, model: 'qwen', baseUrl: `http://127.0.0.1:${mockO.address().port}/v1` });
  assert.deepStrictEqual(dispatched, [['lookup_unit', { name: 'Pikeman' }]], 'tool call assembled across chunks');
  assert.strictEqual(o.text, 'Pikeman has 55 HP.');
  assert.strictEqual(
    events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join(''),
    'Pikeman has 55 HP.'
  );
  assert.strictEqual(o.usage.input_tokens, 220);
  console.log('stream tests passed');
  mockA.close();
  mockO.close();
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
