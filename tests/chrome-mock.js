// Shared Chrome API mock for tests
function createChromeMock() {
  const downloadListeners = [];
  const items = new Map();
  let nextDownloadId = 1;
  let autoComplete = true;
  const updateDownload = (id, patch) => {
    Object.assign(items.get(id), patch);
    if (patch.state) for (const listener of [...downloadListeners]) {
      listener({ id, state: { current: patch.state } });
    }
  };
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  return {
    runtime: {
      id: 'fixture-extension',
      lastError: null,
      onMessage: { addListener: jest.fn() },
      onConnect: { addListener: jest.fn() },
      connect: jest.fn(() => ({ onDisconnect: { addListener: jest.fn() }, disconnect: jest.fn() })),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    },
    alarms: {
      create: jest.fn().mockResolvedValue(),
      clear: jest.fn().mockResolvedValue(true),
      onAlarm: { addListener: jest.fn() },
    },
    tabs: {
      create: jest.fn().mockResolvedValue({ id: 99 }),
      remove: jest.fn().mockResolvedValue(),
      update: jest.fn((id, opts, cb) => cb && cb()),
      get: jest.fn().mockResolvedValue({ url: 'about:blank' }),
      query: jest.fn().mockResolvedValue([]),
      onUpdated: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
      onRemoved: {
        addListener: jest.fn(),
      },
    },
    downloads: {
      download: jest.fn((opts, cb) => {
        const id = nextDownloadId++;
        items.set(id, {
          id, url: opts.url, filename: opts.filename, state: 'in_progress', bytesReceived: 0,
          totalBytes: 100, startTime: new Date().toISOString(), byExtensionId: 'fixture-extension',
        });
        cb(id);
        if (autoComplete) setTimeout(() => updateDownload(id, { state: 'complete', bytesReceived: 100 }), 10);
      }),
      search: jest.fn(async ({ id, startedAfter }) => copy([...items.values()].filter(item =>
        (id === undefined || item.id === id) && (!startedAfter || item.startTime >= startedAfter)))),
      cancel: jest.fn(async id => updateDownload(id, { state: 'interrupted', error: 'USER_CANCELED' })),
      _setAutoComplete: value => { autoComplete = value; },
      _update: updateDownload,
      _clearListeners: () => { downloadListeners.length = 0; },
      _clearItems: () => { items.clear(); },
      setUiOptions: jest.fn().mockResolvedValue(),
      onChanged: {
        addListener: jest.fn((fn) => downloadListeners.push(fn)),
        removeListener: jest.fn((fn) => {
          const idx = downloadListeners.indexOf(fn);
          if (idx >= 0) downloadListeners.splice(idx, 1);
        }),
      },
    },
    scripting: {
      executeScript: jest.fn().mockResolvedValue([{ result: [] }]),
    },
    action: {
      setBadgeText: jest.fn().mockResolvedValue(),
      setBadgeBackgroundColor: jest.fn().mockResolvedValue(),
    },
    storage: {
      local: (() => {
        let store = {};
        return {
          get: jest.fn((key) => Promise.resolve({ [key]: copy(store[key]) })),
          set: jest.fn((obj) => { Object.assign(store, copy(obj)); return Promise.resolve(); }),
          _clear: () => { store = {}; },
        };
      })(),
      session: (() => {
        let store = {};
        return {
          get: jest.fn((key) => Promise.resolve({ [key]: copy(store[key]) })),
          set: jest.fn((obj) => { Object.assign(store, copy(obj)); return Promise.resolve(); }),
          remove: jest.fn(() => Promise.resolve()),
          _clear: () => { store = {}; },
        };
      })(),
    },
  };
}

module.exports = { createChromeMock };
