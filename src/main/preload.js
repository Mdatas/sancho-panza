'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };

contextBridge.exposeInMainWorld('coach', {
  settings: { get: () => ipcRenderer.invoke('settings:get'), set: (patch) => ipcRenderer.invoke('settings:set', patch) },
  chat: {
    ask: (text) => ipcRenderer.invoke('chat:ask', { text }), reset: () => ipcRenderer.invoke('chat:reset'), newGame: () => ipcRenderer.invoke('chat:newGame'),
    flag: (comment) => ipcRenderer.invoke('chat:flag', comment), onEvent: on('chat:event'),
  },
  state: { get: () => ipcRenderer.invoke('state:get'), set: (patch) => ipcRenderer.invoke('state:set', patch) },
  team: { counters: () => ipcRenderer.invoke('team:counters') },
  tts: { speak: (text) => ipcRenderer.invoke('tts:speak', text), voices: () => ipcRenderer.invoke('tts:voices') },
  bo: { list: (q) => ipcRenderer.invoke('bo:list', q), get: (id) => ipcRenderer.invoke('bo:get', id), import: (text) => ipcRenderer.invoke('bo:import', text), importFile: () => ipcRenderer.invoke('bo:importFile'), catalog: () => ipcRenderer.invoke('bo:catalog'), noteText: (a) => ipcRenderer.invoke('bo:noteText', a) },
  civs: () => ipcRenderer.invoke('civs:list'),
  maps: () => ipcRenderer.invoke('maps:list'),
  profile: (kind, q) => ipcRenderer.invoke('profile:get', { kind, q }),
  data: { info: () => ipcRenderer.invoke('data:info'), sync: () => ipcRenderer.invoke('data:sync'), onStatus: on('data:status') },
  app: { imgIndex: () => ipcRenderer.invoke('app:imgIndex'), openUserDir: () => ipcRenderer.invoke('app:openUserDir'), openLogs: () => ipcRenderer.invoke('app:openLogs'), openExternal: (u) => ipcRenderer.invoke('app:openExternal', u) },
  window: { minimize: () => ipcRenderer.invoke('window:minimize'), hide: () => ipcRenderer.invoke('window:hide'), quit: () => ipcRenderer.invoke('window:quit'),
    setCompact: (c) => ipcRenderer.invoke('window:setCompact', c), release: () => ipcRenderer.invoke('window:release') },
  guide: {
    open: (arg) => ipcRenderer.invoke('guide:open', arg), index: () => ipcRenderer.invoke('guide:index'), civ: (k) => ipcRenderer.invoke('guide:civ', k), map: (k) => ipcRenderer.invoke('guide:map', k),
    stats: () => ipcRenderer.invoke('guide:stats'), notes: (q) => ipcRenderer.invoke('guide:notes', q), noteList: () => ipcRenderer.invoke('guide:noteList'), noteText: (a) => ipcRenderer.invoke('guide:noteText', a), translate: (a) => ipcRenderer.invoke('guide:translate', a),
    tool: (name, input) => ipcRenderer.invoke('guide:tool', { name, input }), onGoto: on('guide:goto'),
  },
  patch: { status: () => ipcRenderer.invoke('patch:status'), check: () => ipcRenderer.invoke('patch:check'), onStatus: on('patch:status') },
  match: { searchProfile: (n) => ipcRenderer.invoke('match:searchProfile', n), now: () => ipcRenderer.invoke('match:now'), apply: (force) => ipcRenderer.invoke('match:apply', { force }), onDetected: on('match:detected') },
  logs: { clear: () => ipcRenderer.invoke('logs:clear') },
  onHotkey: on('hotkey'),
  onToast: on('toast'),
  onMode: on('mode'),
});
