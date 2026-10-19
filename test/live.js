'use strict';
// Live check against the real API: ANTHROPIC_API_KEY=... node test/live.js "pregunta 1" "pregunta 2"
const path = require('path');
const { GameData } = require('../src/main/engine/gamedata');
const { Strategy } = require('../src/main/engine/strategy');
const { Knowledge } = require('../src/main/engine/knowledge');
const { BuildOrders } = require('../src/main/engine/buildorders');
const { Brain } = require('../src/main/brain/brain');
const root = path.join(__dirname, '..', 'data');
const gd = new GameData(path.join(root, 'game')).load();
const kn = new Knowledge([path.join(root, 'knowledge')]).load();
const st = new Strategy([path.join(root, 'knowledge')]).load();
const bo = new BuildOrders([path.join(root, 'build_orders')]).load();
const s = { provider: 'anthropic', anthropicApiKey: process.env.ANTHROPIC_API_KEY, anthropicModel: process.env.MODEL || 'claude-sonnet-5-5', extractModel: 'claude-haiku-5-5', language: 'auto', extractState: true };
const brain = new Brain({ gd, buildOrders: bo, knowledge: kn, strategy: st, getSettings: () => s });
(async () => {
  for (const q of process.argv.slice(2)) {
    const t0 = Date.now();
    const r = await brain.ask(q, { onEvent: e => e.type === 'tool' && process.stderr.write(' [' + e.name + ']') });
    console.log('\n> ' + q + '\n' + r.text + `\n(${((Date.now() - t0) / 1000).toFixed(1)}s, $${(r.cost || 0).toFixed(4)}) state: ${brain.stateLine()}`);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
