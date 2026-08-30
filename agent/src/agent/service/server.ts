import http from 'node:http';
import {AgentRequestError, parseAgentRunRequest} from '../execution/request';
import {
    InteractionConcurrencyError,
    InteractionStateError,
    InteractionValidationError,
} from '../interaction';
import {SessionCancelledError, ActivityConflictError, type SessionManager} from './session/manager';
import {ProductCommandError, type ProductController} from '../product';
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

type InteractionRoute = Readonly<{
    sessionId: string;
    interactionId: string | null;
    verb: 'approve' | 'deny' | null;
}>;

const parseInteractionRoute = (pathname: string, sessionsPath: string): InteractionRoute | null => {
    const prefix = `${sessionsPath}/`;
    if (!pathname.startsWith(prefix)) {return null;}
    const segments = pathname.slice(prefix.length).split('/');
    if (segments.length < 2 || segments[0] === '' || segments[1] !== 'interactions') {return null;}
    const sessionId = decodeURIComponent(segments[0]);
    if (segments.length === 2) {return {sessionId, interactionId: null, verb: null};}
    if (!segments[2]) {return null;}
    const interactionId = decodeURIComponent(segments[2]);
    if (segments.length === 3) {return {sessionId, interactionId, verb: null};}
    if (segments.length === 4 && (segments[3] === 'approve' || segments[3] === 'deny')) {
        return {sessionId, interactionId, verb: segments[3]};
    }
    return null;
};

const requireRevision = (body: Record<string, unknown>): number => {
    if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 0) {
        throw new AgentRequestError('revision must be a non-negative integer');
    }
    return body.revision;
};

const requireActor = (body: Record<string, unknown>, field: string): string => {
    if (typeof body[field] !== 'string' || body[field].trim().length === 0) {
        throw new AgentRequestError(`${field} is required`);
    }
    return body[field].trim();
};

const requireField = (body: Record<string, unknown>, field: string): string => {
    if (typeof body[field] !== 'string' || body[field].trim().length === 0) {
        throw new AgentRequestError(`${field} is required`);
    }
    return body[field].trim();
};

type ProductRoute = Readonly<{taskId: string; verb?: string}>;

const parseProductRoute = (pathname: string, productPath: string): ProductRoute | null => {
    const prefix = `${productPath}/tasks/`;
    if (!pathname.startsWith(prefix)) {return null;}
    const segments = pathname.slice(prefix.length).split('/');
    if (segments.length === 1 && segments[0] !== '') {
        return {taskId: decodeURIComponent(segments[0])};
    }
    if (segments.length === 2 && segments[0] !== '' && segments[1] !== '') {
        return {taskId: decodeURIComponent(segments[0]), verb: segments[1]};
    }
    return null;
};

export type AgentHttpServerOptions = {
    manager: SessionManager;
    /** The single service-owned ProductController. The HTTP product routes are a
     *  thin adapter over this exact controller so events/read cursors stay
     *  coherent with the `agent.product` Action plane. */
    product: ProductController;
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
    const productPath = `${agentPath}/product`;
    const security = options.security;
    const product = options.product;

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

            const interactionRoute = parseInteractionRoute(pathname, sessionsPath);
            if (interactionRoute !== null) {
                if (req.method === 'GET' && interactionRoute.interactionId === null) {
                    const principal = await requireAuthz('sessionStatus');
                    if (!principal) {return;}
                    const sessionInteractions = options.manager.listInteractions(interactionRoute.sessionId);
                    if (sessionInteractions === null) {
                        writeJsonSafe(res, 404, {error: 'session not found'});
                        return;
                    }
                    writeJsonSafe(res, 200, {sessionId: interactionRoute.sessionId, interactions: sessionInteractions});
                    return;
                }
                if (req.method === 'GET' && interactionRoute.interactionId !== null) {
                    const principal = await requireAuthz('sessionStatus');
                    if (!principal) {return;}
                    const record = options.manager.getInteraction(interactionRoute.sessionId, interactionRoute.interactionId);
                    if (!record) {writeJsonSafe(res, 404, {error: 'interaction not found'}); return;}
                    writeJsonSafe(res, 200, record);
                    return;
                }
                if (req.method === 'POST' && interactionRoute.verb !== null && interactionRoute.interactionId !== null) {
                    const principal = await requireAuthz(
                        interactionRoute.verb === 'approve' ? 'run' : 'sessionCancel',
                    );
                    if (!principal) {return;}
                    const body = (await readJsonBody(req)) as Record<string, unknown>;
                    const revision = requireRevision(body);
                    const decided = interactionRoute.verb === 'approve'
                        ? await options.manager.approveInteraction(
                            interactionRoute.sessionId,
                            interactionRoute.interactionId,
                            revision,
                            requireActor(body, 'approvedBy'),
                        )
                        : await options.manager.denyInteraction(
                            interactionRoute.sessionId,
                            interactionRoute.interactionId,
                            revision,
                            requireActor(body, 'deniedBy'),
                            requireActor(body, 'reason'),
                        );
                    if (!decided) {writeJsonSafe(res, 404, {error: 'interaction not found'}); return;}
                    writeJsonSafe(res, 200, decided);
                    return;
                }
                writeJsonSafe(res, 405, {error: 'method not allowed'});
                return;
            }

            if (pathname === productPath && req.method === 'GET') {
                const principal = await requireAuthz('sessionList');
                if (!principal) {return;}
                writeJsonSafe(res, 200, product.workspaceView());
                return;
            }

            if (pathname === `${productPath}/library` && req.method === 'GET') {
                const principal = await requireAuthz('sessionList');
                if (!principal) {return;}
                const summary = await product.librarySummary();
                if (summary === null) {
                    writeJsonSafe(res, 404, {
                        error: 'library projection is unavailable on this workspace service',
                        code: 'ERR_LIBRARY_UNAVAILABLE',
                    });
                    return;
                }
                writeJsonSafe(res, 200, summary);
                return;
            }

            if (pathname === `${productPath}/authoring/begin` && req.method === 'POST') {
                const principal = await requireAuthz('run');
                if (!principal) {return;}
                const body = (await readJsonBody(req)) as Record<string, unknown>;
                const activity = requireField(body, 'activity');
                if (activity === 'annotate') {
                    writeJsonSafe(res, 200, product.beginAuthoring({activity: 'annotate'}));
                    return;
                }
                if (activity === 'teach') {
                    const teachKind = requireField(body, 'teachKind');
                    if (teachKind !== 'procedure' && teachKind !== 'recovery' && teachKind !== 'demonstration') {
                        throw new AgentRequestError("teachKind must be 'procedure', 'recovery' or 'demonstration'");
                    }
                    writeJsonSafe(res, 200, product.beginAuthoring({activity: 'teach', teachKind}));
                    return;
                }
                throw new AgentRequestError("activity must be 'teach' or 'annotate'");
            }

            if (pathname === `${productPath}/authoring/end` && req.method === 'POST') {
                const principal = await requireAuthz('run');
                if (!principal) {return;}
                const body = (await readJsonBody(req)) as Record<string, unknown>;
                const outcome = requireField(body, 'outcome');
                if (outcome !== 'saved' && outcome !== 'discarded') {
                    throw new AgentRequestError("outcome must be 'saved' or 'discarded'");
                }
                writeJsonSafe(res, 200, product.endAuthoring({outcome}));
                return;
            }

            if (pathname === `${productPath}/tasks`) {
                if (req.method === 'POST') {
                    const principal = await requireAuthz('sessionStart');
                    if (!principal) {return;}
                    const body = (await readJsonBody(req)) as Record<string, unknown>;
                    const prompt = requireField(body, 'prompt');
                    const view = product.startTask({
                        prompt,
                        ...(typeof body.provider === 'string' ? {provider: body.provider} : {}),
                        ...(typeof body.model === 'string' ? {model: body.model} : {}),
                        ...(body.executionMode === 'program' || body.executionMode === 'react-baseline'
                            ? {executionMode: body.executionMode}
                            : {}),
                    });
                    writeJsonSafe(res, 202, view);
                    return;
                }
                if (req.method === 'GET') {
                    const principal = await requireAuthz('sessionList');
                    if (!principal) {return;}
                    writeJsonSafe(res, 200, product.listTasks());
                    return;
                }
                writeJsonSafe(res, 405, {error: 'method not allowed'});
                return;
            }

            const productRoute = parseProductRoute(pathname, productPath);
            if (productRoute !== null) {
                if (req.method === 'GET' && productRoute.verb === undefined) {
                    const principal = await requireAuthz('sessionList');
                    if (!principal) {return;}
                    const view = product.taskView(productRoute.taskId);
                    if (!view) {writeJsonSafe(res, 404, {error: 'task not found'}); return;}
                    writeJsonSafe(res, 200, view);
                    return;
                }
                if (req.method === 'GET' && productRoute.verb === 'events') {
                    const principal = await requireAuthz('sessionList');
                    if (!principal) {return;}
                    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${String(options.port)}`}`);
                    const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
                    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
                        writeJsonSafe(res, 400, {error: 'afterSeq must be a non-negative integer'});
                        return;
                    }
                    writeJsonSafe(res, 200, product.events(productRoute.taskId, afterSeq));
                    return;
                }
                if (req.method === 'POST' && productRoute.verb !== undefined) {
                    const authzEndpoint: AgentServiceEndpoint = productRoute.verb === 'stop'
                        ? 'sessionCancel'
                        : productRoute.verb === 'approve'
                            || productRoute.verb === 'deny'
                            || productRoute.verb === 'answer'
                            || productRoute.verb === 'recovery'
                            || productRoute.verb === 'takeover'
                            || productRoute.verb === 'return-control'
                            ? 'run'
                            : 'sessionList';
                    const principal = await requireAuthz(authzEndpoint);
                    if (!principal) {return;}
                    const body = productRoute.verb === 'stop'
                        ? {}
                        : (await readJsonBody(req)) as Record<string, unknown>;
                    const taskId = productRoute.taskId;
                    let view: ReturnType<typeof product.taskView>;
                    switch (productRoute.verb) {
                        case 'stop':
                            view = product.stopTask({taskId});
                            break;
                        case 'approve':
                            view = await product.approveTask({
                                taskId,
                                interactionToken: requireField(body, 'interactionToken'),
                            });
                            break;
                        case 'deny':
                            view = await product.denyTask({
                                taskId,
                                interactionToken: requireField(body, 'interactionToken'),
                                reason: requireField(body, 'reason'),
                                ...(typeof body.requestedAlternative === 'string'
                                    ? {requestedAlternative: body.requestedAlternative}
                                    : {}),
                            });
                            break;
                        case 'answer':
                            view = await product.answerTask({
                                taskId,
                                interactionToken: requireField(body, 'interactionToken'),
                                value: body.value,
                            });
                            break;
                        case 'recovery':
                            view = await product.chooseRecoveryTask({
                                taskId,
                                interactionToken: requireField(body, 'interactionToken'),
                                optionId: requireField(body, 'optionId'),
                            });
                            break;
                        case 'takeover':
                            view = product.beginGuidanceTask({
                                taskId,
                                interactionToken: requireField(body, 'interactionToken'),
                                mode: requireField(body, 'mode') as 'manual' | 'teach' | 'annotate',
                            });
                            break;
                        case 'return-control':
                            view = await product.returnControlTask({
                                taskId,
                                interactionToken: requireField(body, 'interactionToken'),
                                mode: requireField(body, 'mode') as 'manual' | 'teach' | 'annotate',
                                ...(typeof body.savedReference === 'string'
                                    ? {savedReference: body.savedReference}
                                    : {}),
                            });
                            break;
                        default:
                            writeJsonSafe(res, 404, {error: 'unknown task command'});
                            return;
                    }
                    if (!view) {writeJsonSafe(res, 404, {error: 'task not found'}); return;}
                    writeJsonSafe(res, 200, view);
                    return;
                }
                writeJsonSafe(res, 405, {error: 'method not allowed'});
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
            if (error instanceof ProductCommandError) {
                if (error.code === 'ERR_STALE') {
                    writeJsonSafe(res, 409, {error: error.message, code: error.code});
                    return;
                }
                if (error.code === 'ERR_ACTIVITY_CONFLICT') {
                    writeJsonSafe(res, 409, {error: error.message, code: error.code});
                    return;
                }
                if (error.code === 'ERR_NOT_FOUND') {
                    writeJsonSafe(res, 404, {error: error.message, code: error.code});
                    return;
                }
                writeJsonSafe(res, 400, {error: error.message, code: error.code});
                return;
            }
            if (error instanceof AgentRequestError || error instanceof SyntaxError || error instanceof InteractionValidationError) {
                writeJsonSafe(res, 400, {error: error.message});
                return;
            }
            if (error instanceof ActivityConflictError) {
                writeJsonSafe(res, 409, {error: error.message, code: error.code});
                return;
            }
            if (error instanceof SessionCancelledError) {
                writeJsonSafe(res, 409, {error: error.message});
                return;
            }
            if (error instanceof InteractionConcurrencyError || error instanceof InteractionStateError) {
                writeJsonSafe(res, 409, {error: error.message, code: error.code});
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
