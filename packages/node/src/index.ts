export {
  NodeAdapter,
  createNodeAdapter,
  type NodeAdapterOptions,
} from './adapter.js';

export {
  attachProcessShutdown,
  type ProcessLike,
  type ProcessShutdownHandle,
  type ProcessShutdownOptions,
  type ProcessShutdownTarget,
  type ShutdownSignal,
} from './shutdown.js';
