'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = ['app:status', 'jobs:list', 'jobs:save', 'jobs:delete', 'x:saveToken', 'x:clearToken', 'x:resolve',
  'nostr:derive', 'nostr:saveKey', 'nostr:testRelays', 'job:preview', 'job:publish', 'job:importJson', 'job:importLegacy',
  'job:summary', 'job:log', 'job:runNow', 'job:progress', 'job:cancel', 'about:info', 'app:openLink', 'about:copyNpub', 'app:guide', 'launchd:install', 'launchd:uninstall', 'config:export', 'config:import'];
contextBridge.exposeInMainWorld('api', Object.freeze(Object.fromEntries(
  CHANNELS.map((c) => [c.replace(/:(\w)/g, (_, l) => l.toUpperCase()), (...args) => ipcRenderer.invoke(c, ...args)]))));
contextBridge.exposeInMainWorld('onAppEvent', (cb) => ipcRenderer.on('app:event', (_e, msg) => cb(msg)));
