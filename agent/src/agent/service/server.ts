import http from 'node:http';
import {AgentRequestError, parseAgentRunRequest} from '../execution/request';
import type {AgentRunner} from '../execution/types';

const writeJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
};

const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<unknown>) {
        if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
        } else if (chunk instanceof Uint8Array) {
            chunks.push(Buffer.from(chunk));
        } else {
            chunks.push(Buffer.from(String(chunk)));
        }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {throw new AgentRequestError('request body is required');}
    return JSON.parse(raw);
};

export type AgentHttpServerOptions = {
    runner: AgentRunner;
    workspaceName: string;
    port: number;
    host?: string;
    agentPath?: string;
    healthPath?: string;
    log?: (...args: unknown[]) => void;
};

export const createAgentHttpServer = async (
    options: AgentHttpServerOptions,
): Promise<{stop: () => Promise<void>}> => {
    const host = options.host || process.env.RPA_AGENT_HOST || '127.0.0.1';
    const agentPath = options.agentPath || process.env.RPA_AGENT_PATH || '/agent';
    const healthPath = options.healthPath || process.env.RPA_AGENT_HEALTH_PATH || '/health';
    const server = http.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${String(options.port)}`}`);
            if (req.method === 'GET' && url.pathname === healthPath) {
                writeJson(res, 200, {
                    ok: true,
                    serviceName: 'agent',
                    workspaceName: options.workspaceName,
                    agentPath,
                });
                return;
            }
            if (req.method === 'POST' && url.pathname === agentPath) {
                const request = parseAgentRunRequest(await readJsonBody(req));
                writeJson(res, 200, await options.runner.run(request));
                return;
            }
            writeJson(res, 404, {error: 'not found'});
        })().catch((error) => {
            options.log?.('agent http handler error', error);
            if (res.headersSent) {
                res.end();
                return;
            }
            if (error instanceof AgentRequestError || error instanceof SyntaxError) {
                writeJson(res, 400, {error: error.message});
                return;
            }
            writeJson(res, 500, {error: error instanceof Error ? error.message : String(error)});
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, host, () => {resolve();});
    });

    return {
        stop: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {reject(error); return;}
                    resolve();
                });
            });
        },
    };
};
