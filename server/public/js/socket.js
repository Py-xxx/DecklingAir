// Socket.io wrapper — handles connection, lifecycle recovery, and refreshes.

let _socket = null;
let _reconnectTimer = null;
let _visibilityTimer = null;
let _lifecycleBound = false;
let _handlers = {};

const RESUME_RECONNECT_DELAY_MS = 150;
const VISIBLE_RECONNECT_DELAY_MS = 500;

export function initSocket(handlers) {
  _handlers = { ...handlers };
  createSocket();
  bindLifecycleHandlers();
  return _socket;
}

export function vmSet(param, value) {
  _socket?.emit('vm:set', { param, value });
}

export function vmMacro(params) {
  _socket?.emit('vm:macro', params);
}

export function saveLayout(layout) {
  _socket?.emit('layout:save', layout);
}

export function requestState() {
  requestSnapshot();
}

export function forceReconnect(reason = 'manual') {
  if (!_socket) {
    createSocket();
    return;
  }

  clearTimeout(_reconnectTimer);
  console.info('[socket] forcing reconnect:', reason);

  // Closing first prevents stale iOS/BFCache sessions from lingering.
  if (_socket.connected || _socket.active) {
    _socket.disconnect();
  }

  _reconnectTimer = window.setTimeout(() => {
    _socket.connect();
  }, RESUME_RECONNECT_DELAY_MS);
}

function createSocket() {
  if (_socket) {
    detachSocketHandlers(_socket);
  }

  _socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    rememberUpgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 10000,
  });

  attachSocketHandlers(_socket);
}

function attachSocketHandlers(socket) {
  socket.on('connect', () => {
    _handlers.onConnect?.();
    requestSnapshot();
  });

  socket.on('disconnect', reason => {
    _handlers.onDisconnect?.(reason);
  });

  socket.on('connect_error', error => {
    _handlers.onConnectError?.(error);
  });

  socket.on('vm:state', state => _handlers.onVmState?.(state));
  socket.on('vm:update', ({ param, value }) => _handlers.onVmUpdate?.(param, value));
  socket.on('vm:state_patch', params => {
    params.forEach(({ param, value }) => _handlers.onVmUpdate?.(param, value));
  });
  socket.on('vm:levels', levels => _handlers.onLevels?.(levels));
  socket.on('bridge:status', info => _handlers.onBridgeStatus?.(info));
  socket.on('bridge:error', msg => _handlers.onBridgeError?.(msg));
  socket.on('layout:data', layout => _handlers.onLayout?.(layout));
}

function detachSocketHandlers(socket) {
  socket.removeAllListeners();
}

function requestSnapshot() {
  if (!_socket?.connected) return;
  _socket.emit('layout:get');
  _socket.emit('bridge:request_state');
}

function bindLifecycleHandlers() {
  if (_lifecycleBound) return;
  _lifecycleBound = true;

  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      forceReconnect('pageshow-bfcache');
      return;
    }

    scheduleVisibleHealthCheck('pageshow');
  });

  window.addEventListener('pagehide', event => {
    clearTimeout(_visibilityTimer);
    // Safari home-screen apps often BFCache the page. Drop the session so restore
    // starts cleanly instead of resuming a half-dead transport.
    if (event.persisted) {
      _socket?.disconnect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(_visibilityTimer);
      return;
    }

    scheduleVisibleHealthCheck('visibilitychange');
  });

  window.addEventListener('focus', () => {
    scheduleVisibleHealthCheck('focus');
  });

  window.addEventListener('online', () => {
    forceReconnect('online');
  });

  window.addEventListener('freeze', () => {
    _socket?.disconnect();
  });

  document.addEventListener('resume', () => {
    forceReconnect('resume');
  });
}

function scheduleVisibleHealthCheck(reason) {
  clearTimeout(_visibilityTimer);
  _visibilityTimer = window.setTimeout(() => {
    if (document.visibilityState !== 'visible') return;

    if (!_socket || !_socket.connected) {
      forceReconnect(reason);
      return;
    }

    requestSnapshot();
  }, VISIBLE_RECONNECT_DELAY_MS);
}
