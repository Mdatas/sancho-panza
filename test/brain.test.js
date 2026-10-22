'use strict';
/** Runs the brain against local mocks of the Anthropic Messages API and an OpenAI-compatible API. */
const http = require('http');
const path = require('path');
const assert = require('assert');
const { GameData } = require('../src/main/engine/gamedata');
const { BuildOrders } = require('../src/main/engine/buildorders');
const { Knowledge } = require('../src/main/engine/knowledge');
const { Strategy } = require('../src/main/engine/strategy');
const { Brain } = require('../src/main/brain/brain');

const root = path.join(__dirname, '..', 'data');
const gd = new GameData(path.join(root, 'game')).load();
const buildOrders = new BuildOrders([path.join(root, 'build_orders', 'rtsbuilds')]).load();
const knowledge = new Knowledge([path.join(root, 'knowledge')]).load();

function readBody(req) {
  return new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(JSON.parse(b || '{}')));
  });
}
const seen = { anthropic: [], openai: [] };

// --- mock Anthropic: round 0 forced update_match_state; round 1 find_counters + civ_info; round 2 final text
const mockA = http.createServer(async (req, res) => {
  const body = await readBody(req);
  seen.anthropic.push(body);
  assert.strictEqual(req.headers['x-api-key'], 'sk-test');
  if (body.tools) assert.ok(body.tools.find((t) => t.name === 'update_match_state'));
  const toolResults = body.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).length;
  let out;
  assert.strictEqual(body.tool_choice, undefined);
  if (!body.tools) {
    // extraction call: plain, JSON only
    assert.ok(body.system.includes('extract'));
    assert.strictEqual(body.model, 'claude-haiku-5-5');
    out = {
      usage: { input_tokens: 300, output_tokens: 60 },
      content: [
        {
          type: 'text',
          text: 'Here: {"my_civ":"Francos","opp_civ":"Mongols","age":3,"their_army":"mangudai","key_facts":["sin pasarme de rosca"],"question_type":"counter"}',
        },
      ],
    };
  } else if (toolResults === 0) {
    const last = body.messages[body.messages.length - 1];
    assert.ok(
      last.content.startsWith('[match state: Franks vs Mongols · my age: Castle Age · their army: mangudai ; constraints to respect: sin pasarme de rosca]'),
      last.content
    );
    assert.ok(JSON.stringify(body.system).includes('their army: mangudai'));
    out = {
      stop_reason: 'tool_use',
      usage: { input_tokens: 1500, output_tokens: 80 },
      content: [
        { type: 'tool_use', id: 't1', name: 'find_counters', input: { target_unit: 'mangudai' } }, // civ/age default from state
        { type: 'tool_use', id: 't2', name: 'civ_info', input: { civ: 'Franks' } },
      ],
    };
  } else {
    const results = body.messages[body.messages.length - 1].content;
    const counters = JSON.parse(results[0].content);
    const civ = JSON.parse(results[1].content);
    assert.strictEqual(counters.civ, 'Franks');
    assert.strictEqual(counters.age, 'Castle Age');
    out = {
      stop_reason: 'end_turn',
      usage: { input_tokens: 3000, output_tokens: 120, cache_read_input_tokens: 2000 },
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: `Top counter: ${counters.candidates[0].unit}. Trait: ${civ.trait}.` }],
    };
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
});

// --- mock OpenAI-compatible: round 0 forced function; round 1 lookup; round 2 text
const mockO = http.createServer(async (req, res) => {
  const body = await readBody(req);
  seen.openai.push(body);
  const toolMsgs = body.messages.filter((m) => m.role === 'tool').length;
  let out;
  if (!body.tools) {
    out = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"key_facts":["hp question"],"question_type":"general"}' } }],
      usage: { prompt_tokens: 200, completion_tokens: 15 },
    };
  } else if (toolMsgs === 0) {
    assert.strictEqual(body.tool_choice, 'auto');
    out = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup_unit', arguments: JSON.stringify({ name: 'piqueros' }) } }],
          },
        },
      ],
      usage: { prompt_tokens: 600, completion_tokens: 20 },
    };
  } else {
    const u = JSON.parse(body.messages[body.messages.length - 1].content);
    out = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `Unit ${u.name_en} has ${u.hp} HP.` } }],
      usage: { prompt_tokens: 800, completion_tokens: 30 },
    };
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
});

(async () => {
  await new Promise((r) => mockA.listen(0, r));
  await new Promise((r) => mockO.listen(0, r));
  const settings = {
    provider: 'anthropic',
    anthropicApiKey: 'sk-test',
    anthropicBaseUrl: `http://127.0.0.1:${mockA.address().port}`,
    anthropicModel: 'claude-sonnet-5-5',
    language: 'auto',
    answerMode: 'libre', // the free coach answer (the default 'ficha' mode is tested at the end)
    match: {},
  };
  const logs = [];
  let saved = null;
  const brain = new Brain({
    gd,
    buildOrders,
    knowledge,
    getSettings: () => settings,
    saveState: (st) => {
      saved = { ...st };
    },
    log: (e) => logs.push(e),
  });
  const events = [];
  const r1 = await brain.ask('soy francos vs mongoles en castillos, me tira mangudai, ¿qué hago sin pasarme de rosca?', { onEvent: (e) => events.push(e) });
  assert.ok(r1.text.includes('Top counter: Elite Skirmisher'), r1.text);
  assert.strictEqual(r1.state.myCiv, 'Franks');
  assert.strictEqual(r1.state.oppCiv, 'Mongols');
  assert.strictEqual(r1.state.age, 3);
  assert.ok(r1.stateLine.includes('Franks vs Mongols'));
  assert.strictEqual(r1.toolLog.length, 2);
  assert.ok(r1.toolLog[0].result.length > 50);
  assert.ok(events.some((e) => e.type === 'state'));
  assert.strictEqual(saved.theirArmy, 'mangudai');
  assert.ok(r1.cost > 0.001 && r1.cost < 0.1, 'cost ' + r1.cost);
  assert.ok(seen.anthropic[1].system[0].text.includes('TURN PROTOCOL'));
  assert.strictEqual(logs.filter((l) => l.type === 'ask').length, 1);
  assert.strictEqual(logs[0].tools.length, 2);
  assert.ok(logs[0].extraction.ok, 'extraction finished before the answer (fast mock)');
  // default settings (v0.19): two cached system blocks (static rules / per-question notes) and a cache breakpoint on the last message of later rounds
  assert.strictEqual(seen.anthropic[1].system.length, 2, 'default → split system blocks');
  assert.ok(seen.anthropic[1].system[0].cache_control && seen.anthropic[1].system[1].cache_control, 'both blocks cached');
  assert.ok(JSON.stringify(seen.anthropic.slice(2).map((b) => b.messages)).includes('cache_control'), 'later rounds mark the last message for the cache');
  // explicit opt-out keeps the single block of v0.11
  settings.experimentalCache = false;
  seen.anthropic.length = 0;
  await brain.ask('y contra caballeros?');
  assert.strictEqual(seen.anthropic[1].system.length, 1, 'experimentalCache off → single system block');
  assert.ok(!JSON.stringify(seen.anthropic.slice(1).map((b) => b.messages)).includes('cache_control'), 'experimentalCache off → no message breakpoints');
  delete settings.experimentalCache;
  logs.length = 0;
  saved = null;
  // state restore: a match saved minutes ago comes back, an old one does not
  const b2 = new Brain({ gd, buildOrders, knowledge, getSettings: () => settings, saveState: () => {}, log: () => {} });
  assert.ok(b2.restoreState({ myCiv: 'Franks', oppCiv: 'Mongols', age: 3, allies: [], enemies: ['Mongols'] }, Date.now() - 60000));
  assert.strictEqual(b2.state.myCiv, 'Franks');
  const b3 = new Brain({ gd, buildOrders, knowledge, getSettings: () => settings, saveState: () => {}, log: () => {} });
  assert.ok(!b3.restoreState({ myCiv: 'Franks' }, Date.now() - 5 * 3600 * 1000));
  assert.strictEqual(b3.state.myCiv, '');
  // asks are serialised: two concurrent questions never interleave the history
  const [c1, c2] = await Promise.all([brain.ask('primera'), brain.ask('segunda')]);
  assert.ok(c1.id < c2.id);
  assert.deepStrictEqual(
    brain.history
      .slice(-4)
      .filter((m) => m.role === 'user')
      .map((m) => m.content),
    ['primera', 'segunda']
  );
  brain.history = brain.history.slice(0, 2);
  logs.length = 0;

  // second turn: state header injected, slash-command edits
  brain.setState({ age: 2, map: 'Arabia' });
  assert.strictEqual(brain.state.age, 2);
  assert.throws(() => brain.setState({ myCiv: 'Klingons' }));
  settings.provider = 'openai';
  settings.openaiBaseUrl = `http://127.0.0.1:${mockO.address().port}/v1`;
  settings.openaiModel = 'qwen2.5:14b';
  const r2 = await brain.ask('cuanta vida tiene el piquero');
  assert.ok(r2.text.includes('Pikeman has 55 HP'), r2.text);
  const firstToolReq = seen.openai.find((b) => b.tools);
  const lastUser = firstToolReq.messages.filter((m) => m.role === 'user').pop();
  assert.ok(lastUser.content.startsWith('[match state: Franks vs Mongols · my age: Feudal Age'), lastUser.content);
  assert.deepStrictEqual(brain.state.keyFacts, ['hp question']);
  assert.strictEqual(brain.history.length, 4);
  brain.flag('se olvidó que no tengo oro');
  assert.strictEqual(logs[logs.length - 1].type, 'flag');
  brain.newGame();
  assert.strictEqual(brain.state.myCiv, '');
  assert.strictEqual(brain.history.length, 0);

  // ---- v0.22 ficha mode: the structured sheet from the data; the model only parses the message (one extraction call, no answer call)
  settings.provider = 'anthropic';
  settings.answerMode = 'ficha';
  brain.strategy = new Strategy([path.join(root, 'knowledge')]).load();
  seen.anthropic.length = 0;
  const f1 = await brain.ask('soy francos vs mongoles en castillos, me tira mangudai', { onEvent: (e) => events.push(e) });
  assert.strictEqual(f1.kind, 'sheet');
  assert.strictEqual(seen.anthropic.length, 1, 'ficha: only the extraction call goes to the API');
  assert.strictEqual(f1.state.myCiv, 'Franks');
  assert.strictEqual(f1.state.oppCiv, 'Mongols');
  assert.strictEqual(f1.state.age, 3);
  assert.strictEqual(f1.sheet.me.name, 'Francos');
  assert.ok(f1.sheet.opp.against.length > 20, 'opponent block carries "Jugando CONTRA esta civ"');
  assert.strictEqual(f1.sheet.counters.rows[0].unit_en, 'Mangudai');
  assert.ok(
    f1.sheet.counters.rows[0].options.some((o) => o.unit_en === 'Elite Skirmisher'),
    JSON.stringify(f1.sheet.counters.rows[0].options)
  );
  assert.ok(f1.text.includes('## Mi civ') && f1.spoken.length > 10);
  assert.ok(/^ficha\+claude-haiku/.test(f1.model), f1.model);
  assert.ok(f1.cost > 0, 'the extraction cost is reported');
  assert.strictEqual(logs[logs.length - 1].type, 'sheet');
  // without a key the keyword parse fills the state (no API call at all)
  settings.anthropicApiKey = '';
  brain.newGame();
  seen.anthropic.length = 0;
  const f2 = await brain.ask('britanos contra mayas en arena, estoy en feudal');
  assert.strictEqual(f2.kind, 'sheet');
  assert.strictEqual(seen.anthropic.length, 0);
  // local mode: even with a key, nothing is sent (the keyword parser does the work)
  settings.anthropicApiKey = 'sk-test';
  settings.answerMode = 'local';
  brain.newGame();
  const f2b = await brain.ask('soy francos vs mongoles en arabia');
  assert.strictEqual(f2b.kind, 'sheet');
  assert.strictEqual(seen.anthropic.length, 0, 'local mode never calls the API');
  assert.deepStrictEqual([f2b.state.myCiv, f2b.state.oppCiv, f2b.state.map], ['Franks', 'Mongols', 'Arabia']);
  assert.strictEqual(f2b.model, 'ficha');
  settings.answerMode = 'ficha';
  settings.anthropicApiKey = '';
  assert.deepStrictEqual([f2.state.myCiv, f2.state.oppCiv, f2.state.map, f2.state.age], ['Britons', 'Mayans', 'Arena', 2]);
  assert.strictEqual(f2.model, 'ficha');
  assert.strictEqual(f2.sheet.map.type, 'cerrado');
  assert.ok(f2.sheet.me.openingHere.includes('Arena'), 'the opening line for closed maps');
  // "pedir consejo": the free answer carries the sheet in its prompt
  settings.anthropicApiKey = 'sk-test';
  brain.newGame();
  await brain.ask('soy francos vs mongoles en castillos, me tira mangudai');
  seen.anthropic.length = 0;
  const f3 = await brain.ask('qué hago?', { mode: 'libre', withSheet: true });
  assert.strictEqual(f3.kind, 'answer');
  assert.ok(f3.text.includes('Top counter'), f3.text);
  assert.ok(JSON.stringify(seen.anthropic[1].system).includes('## FICHA'), 'the advice prompt carries the sheet');
  // live HUD readings: the age only moves forward, the line reaches the prompt while fresh
  brain.setState({ age: 2 });
  assert.strictEqual(brain.setLive({ food: 420, wood: 310, gold: 120, stone: 200, pop: '34/40', idle: 2, age: 3, time: '12:30' }), true);
  assert.strictEqual(brain.state.age, 3);
  assert.strictEqual(brain.setLive({ food: 500, wood: 300, gold: 100, stone: 200, age: 2, time: '12:45' }), false);
  assert.strictEqual(brain.state.age, 3);
  assert.ok(brain.keyData('x').startsWith('LIVE HUD'));
  brain.live.at -= 10 * 60 * 1000;
  assert.ok(!brain.keyData('x').includes('LIVE HUD'), 'a stale reading is not shown to the model');
  console.log('brain tests passed');
  mockA.close();
  mockO.close();
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
