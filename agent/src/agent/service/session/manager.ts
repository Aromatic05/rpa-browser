import type {AgentRunRequest, AgentRunResult, AgentRunner} from '../../execution/types';
import {createSessionStore} from './store';
import type {SessionId, SessionSnapshot, SessionState} from './types';

export class SessionCancelledError extends Error {
    readonly code = 'ERR_SESSION_CANCELLED';
    readonly sessionId: SessionId;

    constructor(sessionId: SessionId) {
        super(`session ${sessionId} was cancelled`);
        this.sessionId = sessionId;
    }
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string => {
    if (error instanceof Error) {
        const code = (error as Error & {code?: unknown}).code;
        if (typeof code === 'string') {return code;}
    }
    return 'ERR_SESSION_FAILED';
};

const deriveState = (result: AgentRunResult): Exclude<SessionState, 'running'> => {
    const programs = result.programs ?? [];
    if (programs.some((program) => program.status === 'paused')) {return 'paused';}
    if (programs.some((program) => program.status === 'failed' || program.status === 'aborted')) {return 'failed';}
    return 'completed';
};

const abortable = <T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
            promise.catch(() => {});
            reject(onAbort());
            return;
        }
        const abort = () => {
            promise.catch(() => {});
            reject(onAbort());
        };
        signal.addEventListener('abort', abort, {once: true});
        promise.then(
            (value) => {
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            reject,
        );
    });

export type SessionManager = {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    runTracked: (request: AgentRunRequest) => Promise<{sessionId: SessionId; result: AgentRunResult}>;
    start: (request: AgentRunRequest) => SessionSnapshot;
    cancel: (sessionId: SessionId) => SessionSnapshot | null;
    status: (sessionId: SessionId) => SessionSnapshot | null;
    list: () => SessionSnapshot[];
};

export type SessionManagerOptions = {
    runner: AgentRunner;
    log?: (...args: unknown[]) => void;
};

export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
    const store = createSessionStore();
    const controllers = new Map<SessionId, AbortController>();

    const execute = async (sessionId: SessionId, request: AgentRunRequest): Promise<AgentRunResult> => {
        const controller = new AbortController();
        controllers.set(sessionId, controller);
        try {
            const result = await abortable(
                options.runner.run(request),
                controller.signal,
                () => new SessionCancelledError(sessionId),
            );
            store.settle(sessionId, {state: deriveState(result), result});
            return result;
        } catch (error) {
            if (error instanceof SessionCancelledError) {
                store.settle(sessionId, {state: 'cancelled', error: {code: error.code, message: error.message}});
            } else {
                store.settle(sessionId, {state: 'failed', error: {code: errorCode(error), message: errorMessage(error)}});
            }
            throw error;
        } finally {
            controllers.delete(sessionId);
        }
    };

    const runTracked = async (request: AgentRunRequest): Promise<{sessionId: SessionId; result: AgentRunResult}> => {
        const snapshot = store.create(request);
        const result = await execute(snapshot.sessionId, request);
        return {sessionId: snapshot.sessionId, result};
    };

    return {
        run: async (request) => (await runTracked(request)).result,
        runTracked,
        start: (request) => {
            const snapshot = store.create(request);
            void execute(snapshot.sessionId, request).catch((error) => {
                options.log?.('agent session detached run failed', snapshot.sessionId, error);
            });
            return snapshot;
        },
        cancel: (sessionId) => {
            const controller = controllers.get(sessionId);
            if (!controller) {return store.get(sessionId);}
            store.settle(sessionId, {
                state: 'cancelled',
                error: {code: 'ERR_SESSION_CANCELLED', message: `session ${sessionId} was cancelled`},
            });
            controller.abort();
            return store.get(sessionId);
        },
        status: (sessionId) => store.get(sessionId),
        list: () => store.list(),
    };
};
