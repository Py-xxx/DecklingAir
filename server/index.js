const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
  serveClient: false,
});

const PORT = process.env.PORT || 3002;
const BRIDGE_PORT = process.env.BRIDGE_PORT || 3003;
const LAYOUT_FILE = path.join(__dirname, 'data', 'layout.json');
const SOCKET_IO_CLIENT_FILE = path.join(
  path.dirname(require.resolve('socket.io')),
  '..',
  'client-dist',
  'socket.io.js'
);

const DEFAULT_DEVICE_LAYOUT = {
  pages: [
    {
      id: 'main',
      name: 'Main',
      controls: [],
    },
  ],
  settings: {
    theme: 'dark',
    accentColor: '#6c63ff',
    gridColumns: 8,
  },
};

const DEFAULT_LAYOUT = {
  version: '2.0',
  deviceOrder: ['default'],
  devices: {
    default: {
      name: 'Primary Device',
      platform: 'unknown',
      ...cloneDefaultDeviceLayout(),
    },
  },
};

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let layout = loadLayout();

const bridgeSockets = new Map();
const deviceRuntime = new Map();
const socketDevices = new WeakMap();

app.disable('etag');
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Last-Modified', new Date(0).toUTCString());
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  },
}));
app.get('/vendor/socket.io.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(SOCKET_IO_CLIENT_FILE, {
    etag: false,
    lastModified: false,
  });
});

app.get('/api/layout', (req, res) => res.json(layout));
app.post('/api/layout', (req, res) => {
  layout = normalizeLayoutStore(req.body);
  saveLayout();
  io.emit('layout:data', layout);
  io.emit('devices:data', serializeDevices());
  res.json({ success: true });
});
app.get('/api/state', (req, res) => {
  const payload = {};
  getKnownDeviceIds().forEach((deviceId) => {
    const runtime = getDeviceRuntime(deviceId);
    payload[deviceId] = {
      state: runtime.vmState,
      levels: runtime.vmLevels,
    };
  });
  res.json(payload);
});
app.get('/api/bridge', (req, res) => res.json(serializeDevices()));

io.on('connection', (socket) => {
  console.log(`Browser connected: ${socket.id}`);
  emitSnapshot(socket);

  socket.on('vm:set', ({ deviceId, param, value }) => {
    const targetId = sanitizeDeviceId(deviceId);
    if (!targetId || typeof param !== 'string') return;

    if (sendToDevice(targetId, { type: 'set', param, value })) {
      const runtime = getDeviceRuntime(targetId);
      runtime.vmState[param] = value;
      io.emit('vm:update', { deviceId: targetId, param, value });
    }
  });

  socket.on('vm:macro', ({ deviceId, params }) => {
    const targetId = sanitizeDeviceId(deviceId);
    if (!targetId || !Array.isArray(params) || !params.length) return;

    if (sendToDevice(targetId, { type: 'macro', params })) {
      const runtime = getDeviceRuntime(targetId);
      params.forEach(({ param, value }) => {
        if (typeof param !== 'string') return;
        runtime.vmState[param] = value;
      });
      io.emit('vm:state_patch', { deviceId: targetId, params });
    }
  });

  socket.on('desktop:action', ({ deviceId, action }) => {
    const targetId = sanitizeDeviceId(deviceId);
    if (!targetId) return;

    const runtime = getDeviceRuntime(targetId);
    const deviceLabel = runtime.deviceName || layout.devices[targetId]?.name || targetId;

    if (!bridgeSockets.has(targetId)) {
      socket.emit('bridge:error', {
        deviceId: targetId,
        message: `Desktop actions are unavailable because ${deviceLabel} is offline.`,
      });
      return;
    }

    if (!runtime.capabilities?.desktopActions) {
      socket.emit('bridge:error', {
        deviceId: targetId,
        message: `${deviceLabel} does not support desktop actions with the current bridge build.`,
      });
      return;
    }

    sendToDevice(targetId, { type: 'desktopAction', action });
  });

  socket.on('desktop:icon_request', ({ deviceId, target }) => {
    const targetId = sanitizeDeviceId(deviceId);
    const resolvedTarget = typeof target === 'string' ? target.trim() : '';
    if (!targetId || !resolvedTarget) return;

    const runtime = getDeviceRuntime(targetId);
    if (runtime.iconCache.has(resolvedTarget)) {
      socket.emit('desktop:icon', {
        deviceId: targetId,
        target: resolvedTarget,
        icon: runtime.iconCache.get(resolvedTarget),
      });
      return;
    }

    if (!bridgeSockets.has(targetId)) return;
    if (!runtime.capabilities?.desktopIcons) return;
    if (runtime.iconPending.has(resolvedTarget)) return;

    runtime.iconPending.add(resolvedTarget);
    sendToDevice(targetId, { type: 'desktopIconRequest', target: resolvedTarget });
  });

  socket.on('soundboard:play', ({ deviceId, file, device, volume } = {}) => {
    const targetId = sanitizeDeviceId(deviceId);
    if (!targetId || typeof file !== 'string' || !file.trim()) return;
    sendToDevice(targetId, {
      type: 'soundboard',
      file: file.trim(),
      device: device || null,
      volume: typeof volume === 'number' ? volume : 1.0,
    });
  });

  socket.on('soundboard:devices_request', ({ deviceId } = {}) => {
    const targetId = sanitizeDeviceId(deviceId);
    if (!targetId) return;
    sendToDevice(targetId, { type: 'soundboardDevicesRequest' });
  });

  socket.on('layout:save', (nextLayout) => {
    layout = normalizeLayoutStore(nextLayout);
    saveLayout();
    io.emit('layout:data', layout);
    io.emit('devices:data', serializeDevices());
  });

  socket.on('layout:get', () => emitSnapshot(socket));

  socket.on('bridge:request_state', ({ deviceId } = {}) => {
    const targetId = sanitizeDeviceId(deviceId);
    socket.emit('devices:data', serializeDevices());

    const deviceIds = targetId ? [targetId] : getKnownDeviceIds();
    deviceIds.forEach((id) => {
      const runtime = getDeviceRuntime(id);
      socket.emit('vm:state', { deviceId: id, state: runtime.vmState });
      if (runtime.vmLevels.length) {
        socket.emit('vm:levels', { deviceId: id, levels: runtime.vmLevels });
      }
      sendToDevice(id, { type: 'requestState' });
    });
  });

  socket.on('disconnect', () => {
    console.log(`Browser disconnected: ${socket.id}`);
  });
});

const wss = new WebSocket.Server({ port: BRIDGE_PORT });
console.log(`Bridge WebSocket listening on port ${BRIDGE_PORT}`);

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`Bridge connected from ${clientIp}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const currentDeviceId = socketDevices.get(ws);

    switch (msg.type) {
      case 'hello': {
        const deviceId = resolveDeviceId(msg, clientIp);
        const oldSocket = bridgeSockets.get(deviceId);
        if (oldSocket && oldSocket !== ws) {
          oldSocket.terminate();
        }

        bridgeSockets.set(deviceId, ws);
        socketDevices.set(ws, deviceId);

        const runtime = getDeviceRuntime(deviceId);
        runtime.connected = true;
        runtime.deviceName = msg.deviceName || runtime.deviceName || prettifyDeviceId(deviceId);
        runtime.platform = msg.platform || runtime.platform || 'unknown';
        runtime.vmType = msg.vmType ?? null;
        runtime.vmVersion = msg.vmVersion ?? null;
        runtime.capabilities = {
          voiceMeeter: msg.vmType !== undefined && msg.vmType !== null,
          ...(msg.capabilities || {}),
        };

        ensureDeviceLayout(deviceId, {
          name: runtime.deviceName,
          platform: runtime.platform,
        });

        io.emit('layout:data', layout);
        io.emit('devices:data', serializeDevices());
        ws.send(JSON.stringify({ type: 'requestState' }));
        console.log(`Bridge hello: ${deviceId} (${runtime.platform})`);
        break;
      }

      case 'soundboardDevices':
        if (!currentDeviceId) return;
        io.emit('soundboard:devices', {
          deviceId: currentDeviceId,
          devices: Array.isArray(msg.devices) ? msg.devices : [],
        });
        break;

      case 'desktopIcon':
        if (!currentDeviceId || !msg.target || typeof msg.icon !== 'string') return;
        getDeviceRuntime(currentDeviceId).iconPending.delete(msg.target);
        getDeviceRuntime(currentDeviceId).iconCache.set(msg.target, msg.icon);
        io.emit('desktop:icon', {
          deviceId: currentDeviceId,
          target: msg.target,
          icon: msg.icon,
        });
        break;

      case 'state':
        if (!currentDeviceId) return;
        getDeviceRuntime(currentDeviceId).vmState = msg.data && typeof msg.data === 'object' ? msg.data : {};
        io.emit('vm:state', {
          deviceId: currentDeviceId,
          state: getDeviceRuntime(currentDeviceId).vmState,
        });
        break;

      case 'update':
        if (!currentDeviceId || typeof msg.param !== 'string') return;
        getDeviceRuntime(currentDeviceId).vmState[msg.param] = msg.value;
        io.emit('vm:update', {
          deviceId: currentDeviceId,
          param: msg.param,
          value: msg.value,
        });
        break;

      case 'levels':
        if (!currentDeviceId) return;
        getDeviceRuntime(currentDeviceId).vmLevels = Array.isArray(msg.data) ? msg.data : [];
        io.emit('vm:levels', {
          deviceId: currentDeviceId,
          levels: getDeviceRuntime(currentDeviceId).vmLevels,
        });
        break;

      case 'error':
        if (!currentDeviceId) return;
        console.error(`Bridge error (${currentDeviceId}):`, msg.message);
        io.emit('bridge:error', {
          deviceId: currentDeviceId,
          message: msg.message,
        });
        break;
    }
  });

  ws.on('close', () => {
    const deviceId = socketDevices.get(ws);
    if (!deviceId) {
      console.log('Bridge disconnected before hello');
      return;
    }

    if (bridgeSockets.get(deviceId) === ws) {
      bridgeSockets.delete(deviceId);
    }

    const runtime = getDeviceRuntime(deviceId);
    runtime.connected = false;
    runtime.iconPending.clear();
    io.emit('devices:data', serializeDevices());
    console.log(`Bridge disconnected: ${deviceId}`);
  });

  ws.on('error', (err) => {
    console.error('Bridge WS error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nVoiceMeeter Control Server');
  console.log(`  Web UI:  http://0.0.0.0:${PORT}`);
  console.log(`  Bridge:  ws://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`  Layout:  ${LAYOUT_FILE}\n`);
});

function cloneDefaultDeviceLayout() {
  return JSON.parse(JSON.stringify(DEFAULT_DEVICE_LAYOUT));
}

function loadLayout() {
  try {
    if (fs.existsSync(LAYOUT_FILE)) {
      return normalizeLayoutStore(JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')));
    }
  } catch (error) {
    console.error('Failed to load layout:', error.message);
  }
  return normalizeLayoutStore(DEFAULT_LAYOUT);
}

function saveLayout() {
  try {
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2));
  } catch (error) {
    console.error('Failed to save layout:', error.message);
  }
}

function normalizeLayoutStore(input) {
  if (isLegacyLayout(input)) {
    return {
      version: '2.0',
      deviceOrder: ['default'],
      devices: {
        default: normalizeDeviceLayout(input, { name: 'Primary Device', platform: 'unknown' }),
      },
    };
  }

  const raw = input && typeof input === 'object' ? input : {};
  const rawDevices = raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
  const deviceOrder = [];
  const devices = {};

  Object.entries(rawDevices).forEach(([deviceId, deviceLayout]) => {
    const normalizedId = sanitizeDeviceId(deviceId);
    if (!normalizedId) return;
    if (!deviceOrder.includes(normalizedId)) deviceOrder.push(normalizedId);
    devices[normalizedId] = normalizeDeviceLayout(deviceLayout, {
      name: deviceLayout?.name || prettifyDeviceId(normalizedId),
      platform: deviceLayout?.platform || 'unknown',
    });
  });

  (Array.isArray(raw.deviceOrder) ? raw.deviceOrder : []).forEach((deviceId) => {
    const normalizedId = sanitizeDeviceId(deviceId);
    if (normalizedId && devices[normalizedId] && !deviceOrder.includes(normalizedId)) {
      deviceOrder.push(normalizedId);
    }
  });

  if (!deviceOrder.length) {
    deviceOrder.push('default');
    devices.default = normalizeDeviceLayout(DEFAULT_LAYOUT.devices.default);
  }

  return {
    version: raw.version || '2.0',
    deviceOrder,
    devices,
  };
}

function normalizeDeviceLayout(input, fallback = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const base = cloneDefaultDeviceLayout();

  return {
    name: raw.name || fallback.name || 'Device',
    platform: raw.platform || fallback.platform || 'unknown',
    pages: Array.isArray(raw.pages) && raw.pages.length ? raw.pages : base.pages,
    settings: {
      ...base.settings,
      ...(raw.settings || {}),
    },
  };
}

function isLegacyLayout(input) {
  return !!(input && typeof input === 'object' && Array.isArray(input.pages));
}

function sanitizeDeviceId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || null;
}

function resolveDeviceId(msg, clientIp) {
  return (
    sanitizeDeviceId(msg.deviceId) ||
    sanitizeDeviceId(msg.deviceName) ||
    sanitizeDeviceId(clientIp) ||
    `device-${Date.now()}`
  );
}

function prettifyDeviceId(deviceId) {
  return String(deviceId || 'Device')
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getDeviceRuntime(deviceId) {
  if (!deviceRuntime.has(deviceId)) {
    deviceRuntime.set(deviceId, {
      deviceId,
      connected: false,
      deviceName: null,
      platform: 'unknown',
      vmType: null,
      vmVersion: null,
      capabilities: {},
      vmState: {},
      vmLevels: [],
      iconCache: new Map(),
      iconPending: new Set(),
    });
  }
  return deviceRuntime.get(deviceId);
}

function maybeAdoptDefaultDevice(deviceId, meta = {}) {
  if (deviceId === 'default') return false;
  if (!layout.devices.default || layout.devices[deviceId]) return false;
  if (layout.deviceOrder.length !== 1 || layout.deviceOrder[0] !== 'default') return false;

  layout.devices[deviceId] = normalizeDeviceLayout(layout.devices.default, {
    name: meta.name || layout.devices.default.name,
    platform: meta.platform || layout.devices.default.platform,
  });
  layout.deviceOrder = [deviceId];
  delete layout.devices.default;
  saveLayout();
  return true;
}

function ensureDeviceLayout(deviceId, meta = {}) {
  maybeAdoptDefaultDevice(deviceId, meta);

  const existing = layout.devices[deviceId];
  if (!existing) {
    layout.devices[deviceId] = normalizeDeviceLayout(null, {
      name: meta.name || prettifyDeviceId(deviceId),
      platform: meta.platform || 'unknown',
    });
    if (!layout.deviceOrder.includes(deviceId)) {
      layout.deviceOrder.push(deviceId);
    }
    saveLayout();
    return layout.devices[deviceId];
  }

  let changed = false;
  if (meta.name && existing.name !== meta.name) {
    existing.name = meta.name;
    changed = true;
  }
  if (meta.platform && existing.platform !== meta.platform) {
    existing.platform = meta.platform;
    changed = true;
  }
  if (!layout.deviceOrder.includes(deviceId)) {
    layout.deviceOrder.push(deviceId);
    changed = true;
  }
  if (changed) saveLayout();

  return existing;
}

function getKnownDeviceIds() {
  const ids = [];

  layout.deviceOrder.forEach((deviceId) => {
    if (layout.devices[deviceId] && !ids.includes(deviceId)) ids.push(deviceId);
  });

  Object.keys(layout.devices).forEach((deviceId) => {
    if (!ids.includes(deviceId)) ids.push(deviceId);
  });

  deviceRuntime.forEach((_, deviceId) => {
    if (!ids.includes(deviceId)) ids.push(deviceId);
  });

  bridgeSockets.forEach((_, deviceId) => {
    if (!ids.includes(deviceId)) ids.push(deviceId);
  });

  return ids;
}

function serializeDevices() {
  return getKnownDeviceIds().map((deviceId) => {
    const runtime = getDeviceRuntime(deviceId);
    const stored = layout.devices[deviceId];
    const platform = runtime.platform && runtime.platform !== 'unknown'
      ? runtime.platform
      : stored?.platform || 'unknown';
    return {
      deviceId,
      connected: !!runtime.connected,
      deviceName: runtime.deviceName || stored?.name || prettifyDeviceId(deviceId),
      platform,
      vmType: runtime.vmType,
      vmVersion: runtime.vmVersion,
      capabilities: runtime.capabilities || {},
      hasLayout: !!stored,
    };
  });
}

function emitSnapshot(socket) {
  socket.emit('layout:data', layout);
  socket.emit('devices:data', serializeDevices());

  getKnownDeviceIds().forEach((deviceId) => {
    const runtime = getDeviceRuntime(deviceId);
    socket.emit('vm:state', { deviceId, state: runtime.vmState });
    if (runtime.vmLevels.length) {
      socket.emit('vm:levels', { deviceId, levels: runtime.vmLevels });
    }
  });
}

function sendToDevice(deviceId, msg) {
  const ws = bridgeSockets.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}
