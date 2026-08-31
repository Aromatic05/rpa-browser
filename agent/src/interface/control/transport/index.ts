import { getDefaultControlEndpoint } from './endpoint';
import { createNamedPipeTransport } from './named_pipe';
import { createUnixSocketTransport } from './unix_socket';
import type { ControlTransport } from './types';

export type { ControlConnection, ControlTransport } from './types';
export { getDefaultControlEndpoint } from './endpoint';

export const createControlTransport = (endpoint = getDefaultControlEndpoint()): ControlTransport =>
    process.platform === 'win32' ? createNamedPipeTransport(endpoint) : createUnixSocketTransport(endpoint);
