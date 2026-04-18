// Socket.io wrapper — handles connection and event forwarding

let _socket = null;
const _handlers = {};

export function initSocket(handlers) {
  Object.assign(_handlers, handlers);

  _socket = io({ transports: ['websocket'] });

  _socket.on('connect', () => _handlers.onConnect?.());
  _socket.on('disconnect', () => _handlers.onDisconnect?.());

  _socket.on('vm:state', (state) => _handlers.onVmState?.(state));
  _socket.on('vm:update', ({ param, value }) => _handlers.onVmUpdate?.(param, value));
  _socket.on('vm:state_patch', (params) => params.forEach(({ param, value }) => _handlers.onVmUpdate?.(param, value)));
  _socket.on('vm:levels', (levels) => _handlers.onLevels?.(levels));
  _socket.on('bridge:status', (info) => _handlers.onBridgeStatus?.(info));
  _socket.on('bridge:error', (msg) => _handlers.onBridgeError?.(msg));
  _socket.on('layout:data', (layout) => _handlers.onLayout?.(layout));

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
  _socket?.emit('bridge:request_state');
}
