import os from 'node:os';
import path from 'node:path';

export const getDefaultControlEndpoint = (): string => {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\rpa-browser-agent';
    }

    const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    if (typeof xdgRuntimeDir === 'string' && xdgRuntimeDir.trim().length > 0) {
        return path.join(xdgRuntimeDir, 'rpa-browser', 'agent.sock');
    }

    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username || 'user';
    return path.join('/tmp', `rpa-browser-${uid}`, 'agent.sock');
};
