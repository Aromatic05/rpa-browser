import http from 'node:http';
import {AgentRequestError, parseAgentRunRequest} from '../execution/request';
import {SessionCancelledError, type SessionManager} from './session/manager';

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
    manager: SessionManager;
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
    const sessionsPath = `${agentPath}/sessions`;

    const parseStatusId = (pathname: string): string | null => {
        const prefix = `${sessionsPath}/`;
        if (!pathname.startsWith(prefix)) {return null;}
        const id = pathname.slice(prefix.length);
        if (!id || id.includes('/')) {return null;}
        return id;
    };

    const parseCancelId = (pathname: string): string | null => {
        if (!pathname.endsWith('/cancel')) {return null;}
        return parseStatusId(pathname.slice(0, -'/cancel'.length));
    };

    const server = http.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${String(options.port)}`}`);
            const pathname = url.pathname;

            if (req.method === 'GET' && pathname === healthPath) {
                writeJson(res, 200, {
                    ok: true,
                    serviceName: 'agent',
                    workspaceName: options.workspaceName,
                    agentPath,
                });
                return;
            }

            if (req.method === 'POST' && pathname === agentPath) {
                const request = parseAgentRunRequest(await readJsonBody(req));
                const {sessionId, result} = await options.manager.runTracked(request);
                res.setHeader('x-session-id', sessionId);
                writeJson(res, 200, result);
                return;
            }

            if (pathname === sessionsPath) {
                if (req.method === 'POST') {
                    const request = parseAgentRunRequest(await readJsonBody(req));
                    writeJson(res, 202, options.manager.start(request));
                    return;
                }
                if (req.method === 'GET') {
                    writeJson(res, 200, {sessions: options.manager.list()});
                    return;
                }
                writeJson(res, 405, {error: 'method not allowed'});
                return;
            }

            const statusId = parseStatusId(pathname);
            if (statusId !== null && req.method === 'GET') {
                const snapshot = options.manager.status(statusId);
                if (!snapshot) {writeJson(res, 404, {error: 'session not found'}); return;}
                writeJson(res, 200, snapshot);
                return;
            }

            const cancelId = parseCancelId(pathname);
            if (cancelId !== null && req.method === 'POST') {
                const snapshot = options.manager.cancel(cancelId);
                if (!snapshot) {writeJson(res, 404, {error: 'session not found'}); return;}
                writeJson(res, 200, snapshot);
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
            if (error instanceof SessionCancelledError) {
                writeJson(res, 409, {error: error.message});
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
