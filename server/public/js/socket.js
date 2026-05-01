// Socket.io wrapper — handles connection, lifecycle recovery, and device-aware updates.

let _socket = null;
let _reconnectTimer = null;
let _visibilityTimer = null;
let _lifecycleBound = false;
let _handlers = {};
let _deviceGetter = () => null;

const RESUME_RECONNECT_DELAY_MS = 150;
const VISIBLE_RECONNECT_DELAY_MS = 500;

export function initSocket(handlers) {
  _handlers = { ...handlers };
  _deviceGetter = typeof handlers.getActiveDeviceId === 'function' ? handlers.getActiveDeviceId : () => null;
  createSocket();
  bindLifecycleHandlers();
  return _socket;
}

export function vmSet(param, value, deviceId = currentDeviceId()) {
  if (!deviceId) return;
  _socket?.emit('vm:set', { deviceId, param, value });
}

export function vmMacro(params, deviceId = currentDeviceId()) {
  if (!deviceId) return;
  _socket?.emit('vm:macro', { deviceId, params });
}

export function desktopAction(action, deviceId = currentDeviceId()) {
  if (!deviceId) return;
  _socket?.emit('desktop:action', { deviceId, action });
}

export function soundboardPlay(file, device, volume = 1.0, deviceId = currentDeviceId()) {
  if (!deviceId || !file) return;
  _socket?.emit('soundboard:play', { deviceId, file, device: device || null, volume });
}

export function requestSoundboardDevices(deviceId = currentDeviceId()) {
  if (!deviceId) return;
  _socket?.emit('soundboard:devices_request', { deviceId });
}

export function requestDesktopIcon(target, deviceId = currentDeviceId()) {
  if (!target || !deviceId) return;
  _socket?.emit('desktop:icon_request', { deviceId, target });
}

export function saveLayout(layout) {
  _socket?.emit('layout:save', layout);
}

export function requestState(deviceId = null) {
  requestSnapshot(deviceId);
}

export function forceReconnect(reason = 'manual') {
  if (!_socket) {
    createSocket();
    return;
  }

  clearTimeout(_reconnectTimer);
  console.info('[socket] forcing reconnect:', reason);

  if (_socket.connected || _socket.active) {
    _socket.disconnect();
  }

  _reconnectTimer = window.setTimeout(() => {
    _socket.connect();
  }, RESUME_RECONNECT_DELAY_MS);
}

function currentDeviceId() {
  try {
    return _deviceGetter?.() || null;
  } catch {
    return null;
  }
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

  socket.on('devices:data', devices => _handlers.onDevicesData?.(devices));
  socket.on('vm:state', ({ deviceId, state }) => _handlers.onVmState?.(deviceId, state));
  socket.on('vm:update', ({ deviceId, param, value }) => _handlers.onVmUpdate?.(deviceId, param, value));
  socket.on('vm:state_patch', ({ deviceId, params }) => {
    params.forEach(({ param, value }) => _handlers.onVmUpdate?.(deviceId, param, value));
  });
  socket.on('vm:levels', ({ deviceId, levels }) => _handlers.onLevels?.(deviceId, levels));
  socket.on('bridge:error', payload => {
    if (typeof payload === 'string') {
      _handlers.onBridgeError?.(null, payload);
      return;
    }
    _handlers.onBridgeError?.(payload?.deviceId || null, payload?.message || '');
  });
  socket.on('layout:data', layout => _handlers.onLayout?.(layout));
  socket.on('desktop:icon', payload => _handlers.onDesktopIcon?.(payload));
  socket.on('soundboard:devices', payload => _handlers.onSoundboardDevices?.(payload));
}

function detachSocketHandlers(socket) {
  socket.removeAllListeners();
}

function requestSnapshot(deviceId = null) {
  if (!_socket?.connected) return;
  _socket.emit('layout:get');
  _socket.emit('bridge:request_state', deviceId ? { deviceId } : {});
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
