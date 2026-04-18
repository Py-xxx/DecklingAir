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

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DEFAULT_LAYOUT = {
  version: '1.0',
  pages: [
    {
      id: 'main',
      name: 'Main',
      grid: { columns: 8 },
      controls: []
    }
  ],
  settings: {
    theme: 'dark',
    accentColor: '#6c63ff',
    gridColumns: 8
  }
};

let layout = DEFAULT_LAYOUT;
try {
  if (fs.existsSync(LAYOUT_FILE)) {
    layout = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Failed to load layout:', e.message);
}

function saveLayout() {
  try {
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2));
  } catch (e) {
    console.error('Failed to save layout:', e.message);
  }
}

let vmState = {};
let vmLevels = [];
let bridgeWs = null;
let bridgeInfo = { connected: false, vmType: null, vmVersion: null, capabilities: {} };
const desktopIconCache = new Map();

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
  layout = req.body;
  saveLayout();
  io.emit('layout:data', layout);
  res.json({ success: true });
});
app.get('/api/state', (req, res) => res.json(vmState));
app.get('/api/bridge', (req, res) => res.json(bridgeInfo));

function sendToBridge(msg) {
  if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
    bridgeWs.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

io.on('connection', (socket) => {
  console.log(`Browser connected: ${socket.id}`);

  socket.emit('layout:data', layout);
  socket.emit('vm:state', vmState);
  socket.emit('bridge:status', bridgeInfo);

  socket.on('vm:set', ({ param, value }) => {
    if (sendToBridge({ type: 'set', param, value })) {
      vmState[param] = value;
      socket.broadcast.emit('vm:update', { param, value });
    }
  });

  socket.on('vm:macro', (params) => {
    if (sendToBridge({ type: 'macro', params })) {
      params.forEach(({ param, value }) => {
        vmState[param] = value;
      });
      socket.broadcast.emit('vm:state_patch', params);
    }
  });

  socket.on('desktop:action', (action) => {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      socket.emit('bridge:error', 'Desktop actions are unavailable because the Windows bridge is offline.');
      return;
    }

    if (!bridgeInfo.capabilities?.desktopActions) {
      socket.emit('bridge:error', 'Desktop actions require an updated Windows bridge. Restart or rebuild the bridge on the PC.');
      return;
    }

    sendToBridge({ type: 'desktopAction', action });
  });

  socket.on('desktop:icon_request', ({ target }) => {
    const resolvedTarget = typeof target === 'string' ? target.trim() : '';
    if (!resolvedTarget) return;

    if (desktopIconCache.has(resolvedTarget)) {
      socket.emit('desktop:icon', { target: resolvedTarget, icon: desktopIconCache.get(resolvedTarget) });
      return;
    }

    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) return;
    if (!bridgeInfo.capabilities?.desktopIcons) return;

    sendToBridge({ type: 'desktopIconRequest', target: resolvedTarget });
  });

  socket.on('layout:save', (newLayout) => {
    layout = newLayout;
    saveLayout();
    io.emit('layout:data', layout);
  });

  socket.on('layout:get', () => socket.emit('layout:data', layout));

  socket.on('bridge:request_state', () => {
    socket.emit('bridge:status', bridgeInfo);
    socket.emit('vm:state', vmState);
    sendToBridge({ type: 'requestState' });
  });

  socket.on('disconnect', () => {
    console.log(`Browser disconnected: ${socket.id}`);
  });
});

// WebSocket server for the Windows bridge
const wss = new WebSocket.Server({ port: BRIDGE_PORT });
console.log(`Bridge WebSocket listening on port ${BRIDGE_PORT}`);

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`Bridge connected from ${clientIp}`);

  if (bridgeWs) {
    bridgeWs.terminate();
  }
  bridgeWs = ws;

  ws.send(JSON.stringify({ type: 'requestState' }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'hello':
        bridgeInfo = {
          connected: true,
          vmType: msg.vmType,
          vmVersion: msg.vmVersion,
          capabilities: msg.capabilities || {},
        };
        io.emit('bridge:status', bridgeInfo);
        console.log(`VM type: ${msg.vmType}, version: ${msg.vmVersion}`);
        break;
      case 'desktopIcon':
        if (msg.target && typeof msg.icon === 'string') {
          desktopIconCache.set(msg.target, msg.icon);
          io.emit('desktop:icon', { target: msg.target, icon: msg.icon });
        }
        break;

      case 'state':
        vmState = msg.data;
        io.emit('vm:state', vmState);
        break;

      case 'update':
        vmState[msg.param] = msg.value;
        io.emit('vm:update', { param: msg.param, value: msg.value });
        break;

      case 'levels':
        vmLevels = msg.data;
        io.emit('vm:levels', msg.data);
        break;

      case 'error':
        console.error('Bridge error:', msg.message);
        io.emit('bridge:error', msg.message);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Bridge disconnected');
    bridgeWs = null;
    bridgeInfo = { connected: false, vmType: null, vmVersion: null, capabilities: {} };
    io.emit('bridge:status', bridgeInfo);
  });

  ws.on('error', (err) => {
    console.error('Bridge WS error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nVoiceMeeter Control Server`);
  console.log(`  Web UI:  http://0.0.0.0:${PORT}`);
  console.log(`  Bridge:  ws://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`  Layout:  ${LAYOUT_FILE}\n`);
});
