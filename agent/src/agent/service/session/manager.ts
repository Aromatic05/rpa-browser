import crypto from 'node:crypto';
import type {AgentRunRequest, AgentRunResult, AgentRunner} from '../../execution/types';
import {buildAgentRunReport} from '../../report/builder';
import type {AgentRunReport} from '../../report/contracts';
import {
    createInteractionRepository,
    createInteractionService,
    type InteractionId,
    type InteractionRecord,
    type InteractionService,
    type RunId,
} from '../../interaction';
import {createSessionStore} from './store';
import type {
    SessionId,
    SessionInteractionPolicy,
    SessionInteractionView,
    SessionReport,
    SessionSnapshot,
    SessionState,
} from './types';
import type {SessionStorage} from './storage';
import type {SessionRetentionPolicy} from './store';

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

const PROGRAM_TAG_PREFIX = 'program:';

const pausedProgramIndices = (result: AgentRunResult): number[] => {
    const indices: number[] = [];
    const programs = result.programs ?? [];
    for (let index = 0; index < programs.length; index++) {
        if (programs[index].status === 'paused') {indices.push(index);}
    }
    return indices;
};

const pendingProgramIndices = (records: ReadonlyArray<InteractionRecord>): Set<number> => {
    const pending = new Set<number>();
    for (const record of records) {
        if (record.status !== 'pending') {continue;}
        for (const tag of record.evidence.tags ?? []) {
            if (tag.startsWith(PROGRAM_TAG_PREFIX)) {
                pending.add(Number(tag.slice(PROGRAM_TAG_PREFIX.length)));
            }
        }
    }
    return pending;
};

const approvalPrompt = (index: number, stepName: string): string =>
    `approve ${stepName} to continue the retained run`;

const approvalEvidence = (result: AgentRunResult, index: number): InteractionRecord['evidence'] => {
    const program = (result.programs ?? [])[index];
    const pause = program.pause;
    const stepName = pause?.stepName;
    const lastEffect = program.effects?.[program.effects.length - 1];
    return {
        summary: `program ${index} requests approval before executing${stepName ? ` '${stepName}'` : ' the next effect'}${lastEffect
            ? ` (last effect '${lastEffect.stepName}' ${lastEffect.status})`
            : ''}`,
        ...(stepName ? {effectName: stepName} : {}),
        riskLevel: 'high',
        tags: Object.freeze(['hitl', `${PROGRAM_TAG_PREFIX}${index}`]),
    };
};

const isApprovalBarrier = (result: AgentRunResult, index: number): boolean => {
    const pause = (result.programs ?? [])[index]?.pause;
    return pause?.reason === 'barrier' && pause.risk === 'irreversible';
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

export type InteractionDecisionResult = Readonly<{
    interaction: InteractionRecord;
    session: SessionSnapshot;
}>;

export type SessionManager = {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    runTracked: (request: AgentRunRequest) => Promise<{sessionId: SessionId; result: AgentRunResult}>;
    start: (request: AgentRunRequest) => SessionSnapshot;
    cancel: (sessionId: SessionId) => SessionSnapshot | null;
    status: (sessionId: SessionId) => SessionSnapshot | null;
    list: () => SessionSnapshot[];
    report: (sessionId: SessionId) => SessionReport | null;
    prune: (policy: SessionRetentionPolicy) => number;
    listInteractions: (sessionId: SessionId) => InteractionRecord[] | null;
    getInteraction: (sessionId: SessionId, interactionId: InteractionId) => InteractionRecord | null;
    approveInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        approvedBy: string,
    ) => Promise<InteractionDecisionResult | null>;
    denyInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        deniedBy: string,
        reason: string,
    ) => Promise<InteractionDecisionResult | null>;
    cancelInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        cancelledBy: string,
    ) => InteractionDecisionResult | null;
};

export type SessionManagerOptions = {
    runner: AgentRunner;
    storage?: SessionStorage;
    log?: (...args: unknown[]) => void;
    interactions?: InteractionService;
    interactionPolicy?: SessionInteractionPolicy;
    interactionTtlMs?: number;
    now?: () => number;
};

export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
    const store = createSessionStore({storage: options.storage});
    const controllers = new Map<SessionId, AbortController>();
    const now = options.now ?? Date.now;
    const ttlMs = options.interactionTtlMs ?? 15 * 60 * 1000;
    const interactions = options.interactions
        ?? createInteractionService({repository: createInteractionRepository(), now});
    const runIds = new Map<SessionId, RunId>();

    const toView = (record: InteractionRecord): SessionInteractionView => ({
        id: record.id,
        kind: record.kind,
        status: record.status,
        revision: record.revision,
        deadlineAt: record.deadlineAt,
    });

    const enrich = (snapshot: SessionSnapshot | null): SessionSnapshot | null => {
        if (snapshot === null) {return null;}
        return Object.freeze({
            ...snapshot,
            interactions: interactions.listBySession(snapshot.sessionId).map(toView),
        });
    };

    const requestPauseInteractions = (sessionId: SessionId, runId: RunId, result: AgentRunResult): void => {
        const paused = pausedProgramIndices(result).filter((index) => isApprovalBarrier(result, index));
        if (paused.length === 0) {return;}
        const already = pendingProgramIndices(interactions.listByRun(runId));
        for (const index of paused) {
            if (already.has(index)) {continue;}
            const createdAt = now();
            interactions.request({
                runId,
                sessionId,
                kind: 'irreversible-effect-approval',
                prompt: approvalPrompt(index, (result.programs ?? [])[index].pause?.stepName ?? `effect ${index}`),
                evidence: approvalEvidence(result, index),
                deadlineAt: createdAt + ttlMs,
                createdAt,
            });
        }
    };

    const settle = (
        sessionId: SessionId,
        state: Exclude<SessionState, 'running'>,
        result: AgentRunResult | null,
        error: SessionSnapshot['error'],
    ): void => {
        let report: AgentRunReport | undefined;
        if (result !== null) {
            try {
                report = buildAgentRunReport(result);
            } catch (reportError) {
                options.log?.('agent session report build failed', sessionId, reportError);
            }
        }
        store.settle(sessionId, {state, result, error, report});
        if (state !== 'paused' || result === null) {return;}
        const runId = runIds.get(sessionId);
        if (runId === undefined) {return;}
        const approvals = pausedProgramIndices(result).filter((index) => isApprovalBarrier(result, index));
        if (approvals.length > 0 && options.interactionPolicy === 'headless') {
            store.terminate(sessionId, {
                state: 'cancelled',
                error: {
                    code: 'ERR_SESSION_INTERACTION_BLOCKED',
                    message: 'approval-required irreversible effect is blocked by headless interaction policy',
                },
            });
            return;
        }
        requestPauseInteractions(sessionId, runId, result);
    };

    const cancelPendingInteractions = (sessionId: SessionId, cancelledBy: string): void => {
        for (const record of interactions.listBySession(sessionId)) {
            if (record.status === 'pending') {
                interactions.cancel(record.id, record.revision, cancelledBy);
            }
        }
    };

    const resumePaused = async (sessionId: SessionId): Promise<void> => {
        const snapshot = store.get(sessionId);
        if (snapshot?.state !== 'paused' || snapshot.result === null) {return;}
        const continuation = snapshot.result.continuation;
        const runId = runIds.get(sessionId);
        if (runId === undefined || continuation === undefined) {return;}
        if (interactions.listByRun(runId).some((record) => record.status === 'pending')) {return;}
        if (!store.reopen(sessionId)) {return;}
        try {
            const result = await continuation.resume();
            settle(sessionId, deriveState(result), result, null);
        } catch (error) {
            settle(sessionId, 'failed', null, {code: errorCode(error), message: errorMessage(error)});
        }
    };

    const execute = async (sessionId: SessionId, request: AgentRunRequest): Promise<AgentRunResult> => {
        runIds.set(sessionId, crypto.randomUUID());
        const controller = new AbortController();
        controllers.set(sessionId, controller);
        try {
            const result = await abortable(
                options.runner.run(request),
                controller.signal,
                () => new SessionCancelledError(sessionId),
            );
            const state = deriveState(result);
            settle(sessionId, state, result, null);
            return result;
        } catch (error) {
            if (error instanceof SessionCancelledError) {
                store.settle(sessionId, {
                    state: 'cancelled',
                    error: {code: error.code, message: error.message},
                });
            } else {
                settle(sessionId, 'failed', null, {code: errorCode(error), message: errorMessage(error)});
            }
            throw error;
        } finally {
            controllers.delete(sessionId);
        }
    };

    const boundInteraction = (sessionId: SessionId, interactionId: InteractionId): InteractionRecord | null => {
        if (store.get(sessionId) === null) {return null;}
        const record = interactions.get(interactionId);
        if (!record?.sessionId || record.sessionId !== sessionId) {return null;}
        return record;
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
            if (!controller) {
                const existing = store.get(sessionId);
                if (!existing) {return null;}
                if (existing.state === 'paused') {
                    cancelPendingInteractions(sessionId, 'session-cancel');
                    store.terminate(sessionId, {
                        state: 'cancelled',
                        error: {code: 'ERR_SESSION_CANCELLED', message: `session ${sessionId} was cancelled`},
                    });
                }
                return enrich(store.get(sessionId));
            }
            store.settle(sessionId, {
                state: 'cancelled',
                error: {code: 'ERR_SESSION_CANCELLED', message: `session ${sessionId} was cancelled`},
            });
            cancelPendingInteractions(sessionId, 'session-cancel');
            controller.abort();
            return enrich(store.get(sessionId));
        },
        status: (sessionId) => enrich(store.get(sessionId)),
        list: () => store.list().map((snapshot) => enrich(snapshot)!),
        report: (sessionId) => {
            const report = store.getReport(sessionId);
            return report === null ? null : {sessionId, report};
        },
        prune: (policy) => {
            const before = new Set(store.list().map((snapshot) => snapshot.sessionId));
            const removed = store.prune(policy);
            for (const sessionId of before) {
                if (!store.get(sessionId)) {
                    runIds.delete(sessionId);
                }
            }
            return removed;
        },
        listInteractions: (sessionId) => {
            if (store.get(sessionId) === null) {return null;}
            return [...interactions.listBySession(sessionId)];
        },
        getInteraction: (sessionId, interactionId) => boundInteraction(sessionId, interactionId),
        approveInteraction: async (sessionId, interactionId, expectedRevision, approvedBy) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.approve(interactionId, expectedRevision, approvedBy);
            if (decided.revision !== existing.revision && decided.status === 'approved') {
                await resumePaused(sessionId);
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        denyInteraction: async (sessionId, interactionId, expectedRevision, deniedBy, reason) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.deny(interactionId, expectedRevision, deniedBy, reason);
            if (decided.revision !== existing.revision && decided.status === 'denied') {
                cancelPendingInteractions(sessionId, 'interaction-deny');
                store.terminate(sessionId, {
                    state: 'cancelled',
                    error: {
                        code: 'ERR_SESSION_INTERACTION_DENIED',
                        message: `session ${sessionId} cancelled after interaction ${interactionId} was denied: ${reason}`,
                    },
                });
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        cancelInteraction: (sessionId, interactionId, expectedRevision, cancelledBy) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.cancel(interactionId, expectedRevision, cancelledBy);
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
    };
};
