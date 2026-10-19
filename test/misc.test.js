'use strict';
const assert = require('assert');
const { cleanForSpeech } = require('../src/main/voice/tts');
const { validate, cleanNote } = require('../src/main/engine/buildorders');
assert.strictEqual(cleanForSpeech('**Piqueros** ahora: +3 vs cav.\n- 6 piqueros\n- seguí con arqueros'), 'Piqueros ahora: más 3 vs cav. 6 piqueros seguí con arqueros');
assert.deepStrictEqual(validate({ name: 'x', build_order: [{ villager_count: 6, age: 1, resources: { wood: 0, food: 6, gold: 0, stone: 0 }, notes: ['a'] }] }), []);
assert.ok(validate({ name: 'x', build_order: [{ age: 1 }] }).length >= 3);
assert.strictEqual(cleanNote('Next @resource/MaleVillDE.webp@ to @animal/Boar_aoe2DE.webp@, click @age/FeudalAgeIconDE.webp@'), 'Next villager to Boar, click Feudal Age');
console.log('misc tests passed');
