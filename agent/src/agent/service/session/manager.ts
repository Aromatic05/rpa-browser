import crypto from 'node:crypto';
import type {AgentRunRequest, AgentRunResult, AgentRunner, AgentControlInput} from '../../execution/types';
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
    ActivityReservationSnapshot,
    SessionId,
    SessionInteractionPolicy,
    SessionInteractionView,
    SessionReport,
    SessionSnapshot,
    SessionState,
} from './types';
import type {SessionStorage} from './storage';
import type {SessionRetentionPolicy} from './store';
import {createWorkspaceActivityReservation, type WorkspaceActivityAcquire} from '../../product/reservation';

export class SessionCancelledError extends Error {
    readonly code = 'ERR_SESSION_CANCELLED';
    readonly sessionId: SessionId;

    constructor(sessionId: SessionId) {
        super(`session ${sessionId} was cancelled`);
        this.sessionId = sessionId;
    }
}

export class ActivityConflictError extends Error {
    readonly code = 'ERR_ACTIVITY_CONFLICT';

    constructor(message = 'another workspace activity owns the workspace reservation') {
        super(message);
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
    if (result.requestedInteraction) {return 'paused';}
    const programs = result.programs ?? [];
    if (programs.some((program) => program.status === 'paused')) {return 'paused';}
    if (programs.some((program) => program.status === 'failed' || program.status === 'aborted')) {return 'failed';}
    return 'completed';
};

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

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
        const index = record.internal?.programIndex;
        if (index === undefined) {continue;}
        pending.add(index);
    }
    return pending;
};

const approvalPayload = (result: AgentRunResult, index: number): InteractionRecord['payload'] => {
    const program = (result.programs ?? [])[index];
    const pause = program.pause;
    const stepName = pause?.stepName;
    return {
        kind: 'approval',
        actionName: stepName ?? `effect ${index}`,
        summary: `program ${index} requests approval before executing${stepName ? ` '${stepName}'` : ' the next effect'}`,
        risk: 'irreversible',
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

export type ContinuationRestoreResult =
    | Readonly<{ok: true; result: AgentRunResult}>
    | Readonly<{ok: false; error: SessionSnapshot['error']}>;
export type ContinuationRestorer = (
    request: AgentRunRequest,
    image: unknown,
) => Promise<ContinuationRestoreResult>;

export type SessionManager = {
    ready: () => Promise<void>;
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
        requestedAlternative?: string,
    ) => Promise<InteractionDecisionResult | null>;
    answerInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        answeredBy: string,
        value: unknown,
    ) => Promise<InteractionDecisionResult | null>;
    chooseRecoveryInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        chosenBy: string,
        optionId: string,
    ) => Promise<InteractionDecisionResult | null>;
    beginGuidanceInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        actor: string,
        mode: 'manual' | 'teach' | 'annotate',
    ) => InteractionDecisionResult | null;
    returnControlInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        actor: string,
        mode: 'manual' | 'teach' | 'annotate',
        savedReference?: string,
    ) => Promise<InteractionDecisionResult | null>;
    cancelInteraction: (
        sessionId: SessionId,
        interactionId: InteractionId,
        expectedRevision: number,
        cancelledBy: string,
    ) => InteractionDecisionResult | null;
    expireStale: (sessionId?: SessionId) => number;
    sweepOrphans: () => number;
    activityReservation: () => ActivityReservationSnapshot;
    activityAcquire: (owner: Parameters<ReturnType<typeof createWorkspaceActivityReservation>['acquire']>[0]) => WorkspaceActivityAcquire;
    activityRelease: (owner: Parameters<ReturnType<typeof createWorkspaceActivityReservation>['acquire']>[0]) => boolean;
};

export type SessionManagerOptions = {
    runner: AgentRunner;
    storage?: SessionStorage;
    log?: (...args: unknown[]) => void;
    interactions?: InteractionService;
    interactionPolicy?: SessionInteractionPolicy;
    interactionTtlMs?: number;
    now?: () => number;
    reservation?: ReturnType<typeof createWorkspaceActivityReservation>;
    continuationRestorer?: ContinuationRestorer;
};

export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
    const store = createSessionStore({storage: options.storage});
    const controllers = new Map<SessionId, AbortController>();
    const now = options.now ?? Date.now;
    const ttlMs = options.interactionTtlMs ?? 15 * 60 * 1000;
    const interactions = options.interactions
        ?? createInteractionService({repository: createInteractionRepository(), now});
    const runIds = new Map<SessionId, RunId>();
    const reservation = options.reservation ?? createWorkspaceActivityReservation();
    const restoredRequest = (snapshot: SessionSnapshot): AgentRunRequest => ({
        prompt: snapshot.request.prompt,
        provider: snapshot.request.provider,
        model: snapshot.request.model,
        ...(snapshot.request.executionMode === undefined ? {} : {executionMode: snapshot.request.executionMode}),
        ...(snapshot.request.source === undefined ? {} : {source: snapshot.request.source}),
    });

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

    const releaseTask = (sessionId: SessionId): void => {
        reservation.release({kind: 'task', taskId: sessionId});
    };

    const acquireTask = (sessionId: SessionId): WorkspaceActivityAcquire =>
        reservation.acquire({kind: 'task', taskId: sessionId});

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
                kind: 'approval',
                payload: approvalPayload(result, index),
                deadlineAt: createdAt + ttlMs,
                createdAt,
                internal: {programIndex: index},
            });
        }
    };

    const requestControlInteraction = (
        sessionId: SessionId,
        runId: RunId,
        payload: InteractionRecord['payload'],
    ): void => {
        const createdAt = now();
        interactions.request({
            runId,
            sessionId,
            kind: payload.kind,
            payload,
            deadlineAt: createdAt + ttlMs,
            createdAt,
        });
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
        if (options.storage) {
            // A persisted continuation always replaces the previous pause image.
            // Never leave an older barrier behind when the current pause is not
            // durably exportable: restoring that stale image could repeat or
            // authorize the wrong World effect after restart.
            options.storage.deleteContinuation(sessionId);
            const durableApproval = state === 'paused'
                && result !== null
                && result.requestedInteraction === undefined
                && pausedProgramIndices(result).some((index) => isApprovalBarrier(result, index));
            if (durableApproval && result.continuation?.exportImage) {
                try {
                    const image = result.continuation.exportImage();
                    if (image !== undefined) {
                        options.storage.saveContinuation(sessionId, JSON.parse(JSON.stringify(image)));
                    }
                } catch (exportError) {
                    options.log?.('agent continuation export failed', sessionId, exportError);
                }
            }
        }
        if (TERMINAL_STATES.has(state)) {
            releaseTask(sessionId);
        }
        if (state !== 'paused' || result === null) {return;}
        const runId = runIds.get(sessionId);
        if (runId === undefined) {return;}
        if (result.requestedInteraction) {
            if (options.interactionPolicy === 'headless') {
                store.terminate(sessionId, {
                    state: 'cancelled',
                    error: {
                        code: 'ERR_SESSION_INTERACTION_BLOCKED',
                        message: 'model-requested interaction is blocked by headless interaction policy',
                    },
                });
                options.storage?.deleteContinuation(sessionId);
                releaseTask(sessionId);
                return;
            }
            requestControlInteraction(sessionId, runId, result.requestedInteraction);
            return;
        }
        const approvals = pausedProgramIndices(result).filter((index) => isApprovalBarrier(result, index));
        if (approvals.length > 0 && options.interactionPolicy === 'headless') {
            store.terminate(sessionId, {
                state: 'cancelled',
                error: {
                    code: 'ERR_SESSION_INTERACTION_BLOCKED',
                    message: 'approval-required irreversible effect is blocked by headless interaction policy',
                },
            });
            options.storage?.deleteContinuation(sessionId);
            releaseTask(sessionId);
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

    const controlPaused = async (sessionId: SessionId, input: AgentControlInput): Promise<void> => {
        const snapshot = store.get(sessionId);
        if (snapshot?.state !== 'paused' || snapshot.result === null) {return;}
        const control = snapshot.result.control;
        const runId = runIds.get(sessionId);
        if (runId === undefined || control === undefined) {return;}
        if (interactions.listByRun(runId).some((record) => record.status === 'pending')) {return;}
        if (!store.reopen(sessionId)) {return;}
        try {
            const result = await control.control(input);
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
                settle(sessionId, 'cancelled', null, {code: error.code, message: error.message});
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
        const acquired = acquireTask(snapshot.sessionId);
        if (!acquired.ok) {
            store.discard(snapshot.sessionId);
            throw new ActivityConflictError('another workspace activity owns the reservation; the task was not started');
        }
        const result = await execute(snapshot.sessionId, request);
        return {sessionId: snapshot.sessionId, result};
    };

    const readyPromise: Promise<void> = (async () => {
        if (!options.storage || !options.continuationRestorer) {return;}
        const paused = store.list().filter((snapshot) => snapshot.state === 'paused');
        for (const snapshot of paused) {
            const image = options.storage.loadContinuation(snapshot.sessionId);
            if (image === null) {continue;}
            try {
                const restored = await options.continuationRestorer(restoredRequest(snapshot), image);
                if (!restored.ok) {
                    store.terminate(snapshot.sessionId, {state: 'interrupted', error: restored.error});
                    options.storage.deleteContinuation(snapshot.sessionId);
                    releaseTask(snapshot.sessionId);
                    continue;
                }
                const approvalIndices = pausedProgramIndices(restored.result)
                    .filter((index) => isApprovalBarrier(restored.result, index));
                const invalidRestoredResult = deriveState(restored.result) !== 'paused'
                    || restored.result.requestedInteraction !== undefined
                    || restored.result.continuation === undefined
                    || restored.result.control === undefined
                    || approvalIndices.length === 0;
                if (invalidRestoredResult) {
                    store.terminate(snapshot.sessionId, {
                        state: 'interrupted',
                        error: {
                            code: 'ERR_CONTINUATION_INVALID',
                            message: 'restorer did not return a resumable approval barrier',
                        },
                    });
                    options.storage.deleteContinuation(snapshot.sessionId);
                    releaseTask(snapshot.sessionId);
                    continue;
                }
                const acquired = acquireTask(snapshot.sessionId);
                if (!acquired.ok) {
                    store.terminate(snapshot.sessionId, {
                        state: 'interrupted',
                        error: {
                            code: 'ERR_ACTIVITY_CONFLICT',
                            message: 'paused continuation conflicts with another workspace activity',
                        },
                    });
                    options.storage.deleteContinuation(snapshot.sessionId);
                    releaseTask(snapshot.sessionId);
                    continue;
                }
                store.attachPausedResult(snapshot.sessionId, restored.result);
                const restoredRunId = crypto.randomUUID();
                runIds.set(snapshot.sessionId, restoredRunId);
                requestPauseInteractions(snapshot.sessionId, restoredRunId, restored.result);
            } catch (error) {
                store.terminate(snapshot.sessionId, {
                    state: 'interrupted',
                    error: {code: errorCode(error), message: errorMessage(error)},
                });
                options.storage.deleteContinuation(snapshot.sessionId);
                releaseTask(snapshot.sessionId);
            }
        }
    })();

    return {
        ready: () => readyPromise,
        run: async (request) => (await runTracked(request)).result,
        runTracked,
        start: (request) => {
            const snapshot = store.create(request);
            const acquired = acquireTask(snapshot.sessionId);
            if (!acquired.ok) {
                store.discard(snapshot.sessionId);
                throw new ActivityConflictError('another workspace activity owns the reservation; the task was not started');
            }
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
                    options.storage?.deleteContinuation(sessionId);
                    releaseTask(sessionId);
                }
                return enrich(store.get(sessionId));
            }
            store.settle(sessionId, {
                state: 'cancelled',
                error: {code: 'ERR_SESSION_CANCELLED', message: `session ${sessionId} was cancelled`},
            });
            cancelPendingInteractions(sessionId, 'session-cancel');
            releaseTask(sessionId);
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
        denyInteraction: async (sessionId, interactionId, expectedRevision, deniedBy, reason, requestedAlternative) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.deny(interactionId, expectedRevision, deniedBy, reason, requestedAlternative);
            if (decided.revision !== existing.revision && decided.status === 'denied') {
                const effectName = decided.payload.kind === 'approval' ? decided.payload.actionName : 'the denied effect';
                await controlPaused(sessionId, {
                    kind: 'deny',
                    effectName,
                    reason,
                    ...(requestedAlternative === undefined ? {} : {requestedAlternative}),
                });
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        answerInteraction: async (sessionId, interactionId, expectedRevision, answeredBy, value) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.answer(interactionId, expectedRevision, answeredBy, value);
            if (decided.revision !== existing.revision && decided.status === 'answered') {
                const question = decided.payload.kind === 'clarification' ? decided.payload.question : '';
                await controlPaused(sessionId, {kind: 'clarification-answer', question, answer: value});
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        chooseRecoveryInteraction: async (sessionId, interactionId, expectedRevision, chosenBy, optionId) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.choose(interactionId, expectedRevision, chosenBy, optionId);
            if (decided.revision !== existing.revision && decided.status === 'resolved' && decided.decision?.kind === 'choose') {
                const label = decided.payload.kind === 'recovery_decision'
                    ? decided.payload.options.find((candidate) => candidate.id === optionId)?.label
                    : undefined;
                await controlPaused(sessionId, {
                    kind: 'recovery-choice',
                    optionId,
                    optionLabel: label ?? optionId,
                });
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        beginGuidanceInteraction: (sessionId, interactionId, expectedRevision, actor, mode) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.beginGuidance(interactionId, expectedRevision, actor, mode);
            if (decided.revision !== existing.revision && decided.status === 'pending' && decided.stage === 'active') {
                reservation.setHumanControl(sessionId, mode);
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        returnControlInteraction: async (sessionId, interactionId, expectedRevision, actor, mode, savedReference) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.returnControl(interactionId, expectedRevision, actor, mode, savedReference);
            if (decided.revision !== existing.revision && decided.status === 'resolved') {
                reservation.setHumanControl(sessionId, 'none');
                await controlPaused(sessionId, {
                    kind: 'takeover-return',
                    ...(savedReference === undefined ? {} : {savedReference}),
                });
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        cancelInteraction: (sessionId, interactionId, expectedRevision, cancelledBy) => {
            const existing = boundInteraction(sessionId, interactionId);
            if (!existing) {return null;}
            const decided = interactions.cancel(interactionId, expectedRevision, cancelledBy);
            if (decided.revision !== existing.revision && decided.status === 'cancelled' && existing.stage === 'active') {
                reservation.setHumanControl(sessionId, 'none');
            }
            return {interaction: decided, session: enrich(store.get(sessionId))!};
        },
        expireStale: (sessionId) => {
            const targets = sessionId !== undefined
                ? [sessionId]
                : store.list().filter((snapshot) => snapshot.state === 'paused').map((snapshot) => snapshot.sessionId);
            let expired = 0;
            for (const target of targets) {
                if (store.get(target)?.state !== 'paused') {continue;}
                const runId = runIds.get(target);
                if (runId === undefined) {continue;}
                for (const record of interactions.listByRun(runId)) {
                    if (record.status !== 'pending') {continue;}
                    if (now() <= record.deadlineAt) {continue;}
                    const decided = interactions.expire(record.id, record.revision);
                    if (decided.status === 'expired') {expired += 1;}
                }
            }
            return expired;
        },
        sweepOrphans: () => {
            let swept = 0;
            for (const snapshot of store.list()) {
                if (snapshot.state !== 'paused') {continue;}
                const runId = runIds.get(snapshot.sessionId);
                const pendingCount = runId === undefined
                    ? 0
                    : interactions.listByRun(runId).filter((record) => record.status === 'pending').length;
                if (pendingCount > 0) {continue;}
                store.terminate(snapshot.sessionId, {
                    state: 'failed',
                    error: {
                        code: 'ERR_ORPHAN_PAUSE',
                        message: 'task paused without a resolvable interaction and cannot continue',
                    },
                });
                options.storage?.deleteContinuation(snapshot.sessionId);
                releaseTask(snapshot.sessionId);
                swept += 1;
            }
            return swept;
        },
        activityReservation: () => reservation.read(),
        activityAcquire: (owner) => reservation.acquire(owner),
        activityRelease: (owner) => reservation.release(owner),
    };
};
