import crypto from 'node:crypto';
import net from 'node:net';
import type { ControlRequest, ControlResponse } from './protocol';
import { getDefaultControlEndpoint } from './transport';

export type ControlClientOptions = {
    endpoint?: string;
    timeoutMs?: number;
};

const parseResponse = (line: string): ControlResponse => {
    const parsed = JSON.parse(line) as ControlResponse;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.ok !== 'boolean') {
        throw new Error('invalid control response');
    }
    return parsed;
};

export const sendControlRequest = async (
    request: Omit<ControlRequest, 'id'> & { id?: string },
    options: ControlClientOptions = {},
): Promise<ControlResponse> => {
    const endpoint = options.endpoint || getDefaultControlEndpoint();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const req: ControlRequest = {
        id: request.id || crypto.randomUUID(),
        method: request.method,
        ...(Object.prototype.hasOwnProperty.call(request, 'params') ? { params: request.params } : {}),
    };

    return await new Promise<ControlResponse>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let settled = false;
        let buffer = '';

        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            fn();
        };

        socket.setEncoding('utf8');
        socket.setTimeout(timeoutMs, () => {
            finish(() => reject(new Error(`control request timeout after ${timeoutMs}ms`)));
        });
        socket.once('error', (error) => {
            finish(() => reject(error));
        });
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            const index = buffer.indexOf('\n');
            if (index < 0) {
                return;
            }
            const line = buffer.slice(0, index).replace(/\r$/, '');
            finish(() => {
                try {
                    resolve(parseResponse(line));
                } catch (error) {
                    reject(error);
                }
            });
        });
        socket.once('connect', () => {
            socket.write(`${JSON.stringify(req)}\n`);
        });
    });
};
