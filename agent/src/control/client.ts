import crypto from 'node:crypto';
import net from 'node:net';
import type { ControlEvalRequest, ControlEvalResponse } from './protocol';
import { getDefaultControlEndpoint } from './transport';

export type ControlClientOptions = {
    endpoint?: string;
    timeoutMs?: number;
};

const parseResponse = (line: string): ControlEvalResponse => {
    const parsed = JSON.parse(line) as ControlEvalResponse;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.ok !== 'boolean') {
        throw new Error('invalid control eval response');
    }
    if (!Array.isArray(parsed.logs)) {
        throw new Error('invalid control eval response logs');
    }
    return parsed;
};

export const sendControlEval = async (
    request: Omit<ControlEvalRequest, 'id'> & { id?: string },
    options: ControlClientOptions = {},
): Promise<ControlEvalResponse> => {
    const endpoint = options.endpoint || getDefaultControlEndpoint();
    const timeoutMs = options.timeoutMs ?? request.timeoutMs ?? 10_000;
    const req: ControlEvalRequest = {
        id: request.id || crypto.randomUUID(),
        source: request.source,
        ...(Object.prototype.hasOwnProperty.call(request, 'timeoutMs') ? { timeoutMs: request.timeoutMs } : {}),
        ...(Object.prototype.hasOwnProperty.call(request, 'workspaceName') ? { workspaceName: request.workspaceName } : {}),
        ...(Object.prototype.hasOwnProperty.call(request, 'input') ? { input: request.input } : {}),
    };

    return await new Promise<ControlEvalResponse>((resolve, reject) => {
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
            finish(() => reject(new Error(`control eval timeout after ${timeoutMs}ms`)));
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
