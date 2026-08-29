import http from 'node:http';
import {AgentRequestError, parseAgentRunRequest} from '../execution/request';
import {SessionCancelledError, type SessionManager} from './session/manager';
import type {AgentServiceEndpoint, AgentServiceSecurity} from './security/contracts';
import {authorizeAgentRequest} from './security/guard';
import type {Principal} from '../../security/context';

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

const parseStatusId = (pathname: string, sessionsPath: string): string | null => {
    const prefix = `${sessionsPath}/`;
    if (!pathname.startsWith(prefix)) {return null;}
    const rest = pathname.slice(prefix.length);
    if (!rest || rest.includes('/')) {return null;}
    return rest;
};

const parseReportId = (pathname: string, sessionsPath: string): string | null => {
    const suffix = '/report';
    if (!pathname.endsWith(suffix)) {return null;}
    return parseStatusId(pathname.slice(0, -suffix.length), sessionsPath);
};

const parseCancelId = (pathname: string, sessionsPath: string): string | null => {
    if (!pathname.endsWith('/cancel')) {return null;}
    return parseStatusId(pathname.slice(0, -'/cancel'.length), sessionsPath);
};

export type AgentHttpServerOptions = {
    manager: SessionManager;
    workspaceName: string;
    port: number;
    host?: string;
    agentPath?: string;
    healthPath?: string;
    log?: (...args: unknown[]) => void;
    security?: AgentServiceSecurity;
};

export const createAgentHttpServer = async (
    options: AgentHttpServerOptions,
): Promise<{stop: () => Promise<void>}> => {
    const host = options.host || process.env.RPA_AGENT_HOST || '127.0.0.1';
    const agentPath = options.agentPath || process.env.RPA_AGENT_PATH || '/agent';
    const healthPath = options.healthPath || process.env.RPA_AGENT_HEALTH_PATH || '/health';
    const sessionsPath = `${agentPath}/sessions`;
    const security = options.security;

    const writeJsonSafe = (res: http.ServerResponse, status: number, payload: unknown): void => {
        const sanitized = security ? security.redactionPolicy.redact(payload).value : payload;
        writeJson(res, status, sanitized);
    };

    const server = http.createServer((req, res) => {
        void (async () => {
            const requireAuthz = async (endpoint: AgentServiceEndpoint): Promise<Principal | null> => {
                const authz = await authorizeAgentRequest(security, req.headers.authorization, endpoint);
                if (!authz.ok) {
                    writeJsonSafe(res, authz.status, authz.body);
                    return null;
                }
                return authz.principal;
            };

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
                const principal = await requireAuthz('run');
                if (!principal) {return;}
                const request = parseAgentRunRequest(await readJsonBody(req));
                const {sessionId, result} = await options.manager.runTracked(request);
                res.setHeader('x-session-id', sessionId);
                writeJson(res, 200, result);
                return;
            }

            if (pathname === sessionsPath) {
                if (req.method === 'POST') {
                    const principal = await requireAuthz('sessionStart');
                    if (!principal) {return;}
                    const request = parseAgentRunRequest(await readJsonBody(req));
                    writeJson(res, 202, options.manager.start(request));
                    return;
                }
                if (req.method === 'GET') {
                    const principal = await requireAuthz('sessionList');
                    if (!principal) {return;}
                    writeJson(res, 200, {sessions: options.manager.list()});
                    return;
                }
                if (req.method === 'DELETE' || req.method === 'POST') {
                    writeJsonSafe(res, 405, {error: 'method not allowed'});
                    return;
                }
                writeJsonSafe(res, 405, {error: 'method not allowed'});
                return;
            }

            const reportId = parseReportId(pathname, sessionsPath);
            if (reportId !== null && req.method === 'GET') {
                const principal = await requireAuthz('sessionReport');
                if (!principal) {return;}
                const report = options.manager.report(reportId);
                if (!report) {writeJsonSafe(res, 404, {error: 'session report not found'}); return;}
                writeJson(res, 200, report);
                return;
            }

            const statusId = parseStatusId(pathname, sessionsPath);
            if (statusId !== null && req.method === 'GET') {
                const principal = await requireAuthz('sessionStatus');
                if (!principal) {return;}
                const snapshot = options.manager.status(statusId);
                if (!snapshot) {writeJsonSafe(res, 404, {error: 'session not found'}); return;}
                writeJson(res, 200, snapshot);
                return;
            }

            const cancelId = parseCancelId(pathname, sessionsPath);
            if (cancelId !== null && req.method === 'POST') {
                const principal = await requireAuthz('sessionCancel');
                if (!principal) {return;}
                const snapshot = options.manager.cancel(cancelId);
                if (!snapshot) {writeJsonSafe(res, 404, {error: 'session not found'}); return;}
                writeJson(res, 200, snapshot);
                return;
            }

            if (pathname === `${sessionsPath}/prune` && req.method === 'POST') {
                const principal = await requireAuthz('sessionPrune');
                if (!principal) {return;}
                const body = await readJsonBody(req) as Record<string, unknown>;
                const policy: {maxAgeMs?: number; maxCount?: number} = {};
                if (body.maxAgeMs !== undefined) {
                    if (typeof body.maxAgeMs !== 'number' || !Number.isFinite(body.maxAgeMs) || body.maxAgeMs < 0) {
                        throw new AgentRequestError('maxAgeMs must be a non-negative number');
                    }
                    policy.maxAgeMs = body.maxAgeMs;
                }
                if (body.maxCount !== undefined) {
                    if (typeof body.maxCount !== 'number' || !Number.isInteger(body.maxCount) || body.maxCount < 0) {
                        throw new AgentRequestError('maxCount must be a non-negative integer');
                    }
                    policy.maxCount = body.maxCount;
                }
                writeJson(res, 200, {pruned: options.manager.prune(policy)});
                return;
            }

            writeJsonSafe(res, 404, {error: 'not found'});
        })().catch((error) => {
            options.log?.('agent http handler error', error);
            if (res.headersSent) {
                res.end();
                return;
            }
            if (error instanceof AgentRequestError || error instanceof SyntaxError) {
                writeJsonSafe(res, 400, {error: error.message});
                return;
            }
            if (error instanceof SessionCancelledError) {
                writeJsonSafe(res, 409, {error: error.message});
                return;
            }
            writeJsonSafe(res, 500, {error: error instanceof Error ? error.message : String(error)});
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
