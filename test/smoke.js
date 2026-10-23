'use strict';
/**
 * Headless self-check used by `npm run smoke` / CI: `xvfb-run electron . --no-sandbox --smoke [--shot DIR]`.
 * Loads the real UI, pokes the renderer and the guide window, checks key handling, prints SMOKE {...} and SMOKE_ERRORS [...], exits 0/1.
 * Lives in test/ (not shipped in the packaged app); main.js requires it only with --smoke.
 */
async function run({ win, guideWin: getGuideWin, openGuide, brain, settings, getSettings, decryptSecret, log, send = () => {} }) {
  const { app } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push('preload: ' + err.message));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));
  const js = (code) => win.webContents.executeJavaScript(code);
  const type = async (text) => {
    await js(
      `document.getElementById('cmd').value = ${JSON.stringify(text)}; document.getElementById('cmd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));`
    );
    await new Promise((r) => setTimeout(r, 500));
  };
  const shotDir = process.argv[process.argv.indexOf('--shot') + 1];
  const shot = async (name) => {
    if (process.argv.includes('--shot')) {
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(shotDir, `shot-${name}.png`), (await win.capturePage()).toPNG());
    }
  };
  try {
    const probe = {};
    probe.welcome = await js(
      `!document.getElementById('welcome').classList.contains('hidden') + ' ' + document.body.classList.contains('full') + ' ' + (document.querySelector('#tabs button.active') || {}).dataset?.tab`
    );
    await shot('welcome');
    await js(`document.getElementById('wSkip').click()`);
    await type('/compact');
    await new Promise((r) => setTimeout(r, 400));
    probe.navCompact = await js(
      `(() => { const n = document.getElementById('tabs'); return getComputedStyle(n).display + ' ' + n.querySelectorAll('button').length + ' ' + n.querySelector('[data-tab="chat"]').textContent; })()`
    );
    await type('/civ francos');
    await type('/vs mongoles');
    await type('/edad castillos');
    await type('/mapa Arabia');
    probe.stateLine = await js(`document.getElementById('stateLine').textContent`);
    await type('/aliados mayas, britanos');
    await type('/rivales mongoles, aztecas, gurjaras, teutones');
    await new Promise((r) => setTimeout(r, 500));
    probe.team = await js(
      `document.querySelectorAll('#tbMine .slot.set').length + 'v' + document.querySelectorAll('#tbTheirs .slot.set').length + ' | ' + document.getElementById('answer').textContent.slice(0, 200)`
    );
    probe.teamState = JSON.stringify([brain.state.myCiv, brain.state.allies, brain.state.enemies, brain.state.oppCiv]);
    probe.teamPrompt = brain.teamCountersText().split('\n').length + ' lines';
    await shot('team-compact');
    probe.tldr = await js(`answerHtml('• Hacé piqueros\\n• 8 piqueros y seguí con arqueros\\n• Piquero: +22 vs caballería\\n---\\nDetalle acá.')`);
    probe.replayIn = await js(
      `(() => { showAnswer({ q: 'x', html: answerHtml('• a\\n• b\\n• c\\n---\\nd'), speakText: 'a b c d' }); addMsg('assistant', '• a\\n• b\\n• c\\n---\\nd'); return document.querySelectorAll('#answer .replayIn').length + ' ' + document.querySelectorAll('#messages .replayIn').length; })()`
    );
    await js(`document.querySelector('#tbTheirs .slot').click()`);
    await new Promise((r) => setTimeout(r, 300));
    probe.picker = await js(`!document.getElementById('civPick').classList.contains('hidden') + ' ' + document.querySelectorAll('#cpList .cpi').length`);
    await js(`document.getElementById('cpClose').click()`);
    await type('/bo scouts');
    probe.boList = await js(`document.getElementById('answer').textContent.slice(0, 160)`);
    await type('/bo 1');
    await type('/n');
    await type('/n');
    probe.boLine = await js(`document.getElementById('boLine').textContent.slice(0, 120)`);
    await shot('compact');
    await type('qué hago contra mangudai');
    await new Promise((r) => setTimeout(r, 1500));
    probe.answer = await js(`document.getElementById('answer').textContent.slice(0, 160)`);
    // v0.22: default answer mode is the sheet (ficha) built from the data: blocks, counters for the unit asked, loadable builds
    probe.sheet = await js(
      `document.querySelectorAll('#answer .sheet details.shd').length + ' blocks | counters ' + document.querySelectorAll('#answer .sheet details.shd.counters .shc').length + ' | builds ' + document.querySelectorAll('#answer .sheet [data-shbo]').length + ' | ' + (document.querySelector('#answer .sheet .shh') || {}).textContent`
    );
    if (!/^[3-6] blocks \| counters [1-9]/.test(probe.sheet)) errors.push('sheet: ' + probe.sheet);
    await shot('sheet-compact');
    await type('/ayuda');
    probe.help = (await js(`document.getElementById('answer').textContent`)).length;
    await type('/full');
    await new Promise((r) => setTimeout(r, 600));
    probe.full = await js(
      `document.body.classList.contains('full') + ' ' + document.querySelectorAll('#boSelect option').length + ' builds ' + document.querySelectorAll('.msg').length + ' msgs'`
    );
    probe.boundsFull = win.getBounds().height;
    probe.compactSetting = settings.get().compact;
    await shot('full');
    await js(`document.querySelector('#tabs button[data-tab="bo"]').click()`);
    await new Promise((r) => setTimeout(r, 1500));
    probe.catalog = await js(
      `document.querySelectorAll('#boList .bocard').length + ' cards | ' + document.getElementById('boCount').textContent + ' | chips ' + document.querySelectorAll('#boTypes .chip').length`
    );
    await shot('bo-list');
    await js(`[...document.querySelectorAll('#boTypes .chip')].find(b => b.dataset.t === 'Drush').click()`);
    await new Promise((r) => setTimeout(r, 500));
    probe.catalogDrush = await js(`document.getElementById('boCount').textContent`);
    await js(`document.querySelector('#boList .bocard.note').click()`);
    await new Promise((r) => setTimeout(r, 800));
    probe.reader = await js(
      `document.getElementById('boReader').classList.contains('hidden') + ' ' + document.getElementById('boReader').textContent.length + ' chars ' + document.querySelectorAll('#boReader details').length + ' vig'`
    );
    await shot('bo-reader');
    await js(`[...document.querySelectorAll('#boTypes .chip')][0].click()`);
    await new Promise((r) => setTimeout(r, 300));
    await js(`document.querySelector('#boList .bocard.steps').click()`);
    await new Promise((r) => setTimeout(r, 600));
    probe.stepsLoaded = await js(`document.getElementById('boStep').textContent.slice(0, 80)`);
    await js(`document.querySelector('#tabs button[data-tab="settings"]').click()`);
    probe.settingsNew = await js(
      `(document.querySelector('#setAnswerMode button.on') || {}).dataset?.v + ' | screen ' + !!document.getElementById('setScreenRead') + ' ' + document.getElementById('setScreenRead').checked + ' | ocr ' + (document.querySelector('#setOcrEngine button.on') || {}).dataset?.v + ' | aiBox hidden ' + document.getElementById('aiBox').classList.contains('hidden') + ' | info ' + document.getElementById('modeInfo').textContent.length`
    );
    if (!/^local \| screen true false \| ocr local \| aiBox hidden true \| info [1-9]\d\d/.test(probe.settingsNew))
      errors.push('settings (modes): ' + probe.settingsNew);
    await shot('settings');
    await js(`(() => { const s = document.getElementById('setProvider'); s.value = 'groq'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((r) => setTimeout(r, 600));
    probe.groqPreset = JSON.stringify([settings.get().provider, settings.get().openaiBaseUrl, settings.get().openaiModel]);
    await shot('settings-groq');
    await js(`(() => { const s = document.getElementById('setProvider'); s.value = 'claude'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((r) => setTimeout(r, 300));
    await type('/compact');
    await new Promise((r) => setTimeout(r, 400));
    probe.compactAgain = await js(`!document.body.classList.contains('full')`);
    await js(`document.querySelector('#tabs button[data-tab="bo"]').click()`);
    await new Promise((r) => setTimeout(r, 500));
    probe.navFromCompact = await js(`document.body.classList.contains('full') + ' ' + document.querySelector('#tabs button.active').dataset.tab`);
    await type('/compact');
    await new Promise((r) => setTimeout(r, 300));
    await type('/modo libre');
    probe.errText = await js(
      `(() => { document.getElementById('cmd').value = 'hola'; document.getElementById('cmd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return new Promise(r => setTimeout(() => r(document.getElementById('answer').textContent.slice(0, 120)), 600)); })()`
    );
    if (!/API key/i.test(probe.errText)) errors.push('free mode without a key must explain the missing key: ' + probe.errText);
    await shot('nokey');
    await type('/modo ficha');
    probe.answerMode = settings.get().answerMode;
    // screen reader: without a key the manual read fails cleanly (the capture itself runs); a reading paints the HUD line and syncs the build clock
    // local engine (default): the capture + Tesseract run on the xvfb screen, where there is no HUD → a clean "not the bar" answer
    probe.screenTest = JSON.stringify(await js('window.coach.screen.test()')).slice(0, 300);
    if (!/"ok":false/.test(probe.screenTest) || !/notHud|notFound/.test(probe.screenTest)) errors.push('local screen test: ' + probe.screenTest);
    probe.screenStatus = JSON.stringify(await js('window.coach.screen.status()'));
    if (!/"engine":"local"/.test(probe.screenStatus)) errors.push('screen status: ' + probe.screenStatus);
    // AI engine without a key fails with the key message
    await js(`window.coach.settings.set({ ocrEngine: 'ai' })`);
    probe.screenTestAi = JSON.stringify(await js('window.coach.screen.test()')).slice(0, 300);
    await js(`window.coach.settings.set({ ocrEngine: 'local' })`);
    if (!/"ok":false/.test(probe.screenTestAi) || !/notHud|notFound/.test(probe.screenTestAi))
      errors.push('screen test with ai engine and no key must fall back to local: ' + probe.screenTestAi);
    brain.setLive({
      food: 420,
      wood: 310,
      gold: 120,
      stone: 200,
      pop: '34/40',
      idle: 2,
      villagers: { food: 12, wood: 6, gold: 4, stone: 0 },
      age: 3,
      time: '12:30',
    });
    send('screen:reading', { reading: brain.live, state: brain.state, line: brain.stateLine(), ageChanged: false });
    await new Promise((r) => setTimeout(r, 400));
    probe.hudLine = await js(
      `document.getElementById('hudLine').classList.contains('hidden') + ' | ' + document.getElementById('hudLine').textContent + ' | clock ' + document.getElementById('boClock').textContent`
    );
    if (!/^false \| .*420.*34\/40.*12:30/.test(probe.hudLine) || !/clock ❚❚ 12:3/.test(probe.hudLine)) errors.push('hud line: ' + probe.hudLine);
    await shot('hud');
    await js('clockToggle()'); // stop the clock the reading started
    brain.live = null;
    // visual guide
    openGuide({ civ: 'Franks' });
    await new Promise((r) => setTimeout(r, 2500));
    const guideWin = getGuideWin();
    const gjs = (code) => guideWin.webContents.executeJavaScript(code);
    guideWin.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) errors.push('guide: ' + message);
    });
    const gshot = async (name) => {
      if (process.argv.includes('--shot')) {
        await new Promise((r) => setTimeout(r, 400));
        fs.writeFileSync(path.join(shotDir, `guide-${name}.png`), (await guideWin.webContents.capturePage()).toPNG());
      }
    };
    probe.guideCiv = await gjs(
      `document.querySelector('#civView h2') && document.querySelector('#civView h2').textContent + ' | cards ' + document.querySelectorAll('#civView details').length + ' | list ' + document.querySelectorAll('#civList .item').length`
    );
    await gshot('civ');
    await gjs(`document.querySelector('[data-tab="maps"]').click(); document.querySelector('#mapList .item').click()`);
    await new Promise((r) => setTimeout(r, 600));
    probe.guideMap = await gjs(`document.querySelector('#mapView h2').textContent + ' | list ' + document.querySelectorAll('#mapList .item').length`);
    await gshot('map');
    await gjs(
      `document.querySelector('[data-tab="units"]').click(); document.getElementById('uTarget').value = 'Knight'; document.getElementById('uGo').click()`
    );
    await new Promise((r) => setTimeout(r, 1500));
    probe.guideUnits = await gjs(`document.querySelectorAll('#uOut tr').length + ' rows ' + document.getElementById('uOut').textContent.slice(0, 60)`);
    await gshot('units');
    await gjs(`document.querySelector('[data-tab="meta"]').click()`);
    await new Promise((r) => setTimeout(r, 800));
    probe.guideMeta = await gjs(`document.querySelectorAll('#metaTable tr').length + ' rows'`);
    await gshot('meta');
    // Meta by civ → "Load in the panel": the guide's button loads the build into the main window's panel
    {
      const before = await js(`document.getElementById('boLine').textContent`);
      const picked = await gjs(
        `(() => { const b = document.querySelector('#metaView [data-load]'); if (!b) return ''; const t = b.closest('.bcard').querySelector('.t').textContent.trim(); b.click(); return t; })()`
      );
      await new Promise((r) => setTimeout(r, 1200));
      const after = await js(`document.getElementById('boLine').textContent`);
      const title = picked.replace(/\s*\(.*$/, '').slice(0, 20);
      probe.guideLoad = `${picked ? 'picked' : 'no button'} | ${title && after.includes(title) ? 'loaded' : 'NOT loaded'} | ${before === after ? 'unchanged' : 'changed'}`;
      if (!picked || !after.includes(title)) errors.push('guide "Load in the panel" must load the build into the main window: ' + probe.guideLoad);
    }
    await gjs(
      `document.querySelector('[data-tab="notes"]').click(); const i = document.getElementById('noteSearch'); i.value = 'men-at-arms'; i.dispatchEvent(new Event('input'))`
    );
    await new Promise((r) => setTimeout(r, 1200));
    probe.guideNotes = await gjs(`document.querySelectorAll('#noteView details').length + ' hits'`);
    await gshot('notes');
    {
      const prevLang = settings.get().uiLanguage;
      settings.set({ uiLanguage: 'en' });
      guideWin.webContents.reload();
      await new Promise((r) => setTimeout(r, 2500));
      await gjs(`handleGoto({ civ: 'Franks' })`);
      await new Promise((r) => setTimeout(r, 1200));
      probe.guideEn = await gjs(
        `document.querySelector('#civView h2').textContent + ' | ' + document.querySelectorAll('#civView .trBtn').length + ' translate buttons | tab ' + document.querySelector('#tabs button').textContent + ' | ' + document.querySelector('#civView summary').textContent.slice(0, 30)`
      );
      await gshot('civ-en');
      settings.set({ uiLanguage: prevLang || 'es' });
    }
    // key handling: default = v0.11 (plain in the settings field), experimental privacy = masked, amnesiac = nothing on disk, back = restored
    {
      const set = (p) => js(`window.coach.settings.set(${JSON.stringify(p)})`);
      const get = () => js('window.coach.settings.get()');
      const prev = settings.get();
      await set({ anthropicApiKey: 'sk-ant-smoke-test-1234', experimentalPrivacy: false, rememberKey: true });
      const a = await get();
      const b1 = a.anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ experimentalPrivacy: true });
      const b = await get();
      const b2 = b.anthropicApiKey === '••••1234' && b.anthropicApiKeySet === true;
      await set({ anthropicApiKey: '••••1234' });
      const b3 = getSettings().anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ rememberKey: false });
      const b4 = !settings.get().anthropicApiKey && getSettings().anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ rememberKey: true });
      const b5 = String(settings.get().anthropicApiKey || '').length > 0 && getSettings().anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ experimentalPrivacy: false, anthropicApiKey: prev.anthropicApiKey ? decryptSecret(prev.anthropicApiKey) : '' });
      probe.keys = [b1, b2, b3, b4, b5].join(',');
      if (![b1, b2, b3, b4, b5].every(Boolean)) errors.push('key handling: ' + probe.keys);
    }
    console.log('SMOKE', JSON.stringify(probe, null, 1));
  } catch (e) {
    errors.push('probe: ' + e.message);
  }
  console.log('SMOKE_ERRORS', JSON.stringify(errors));
  app.isQuiting = true;
  app.exit(errors.length ? 1 : 0);
}

module.exports = { run };
