import type {AgentExecutionMode, AgentRunRequest} from '../execution/types';
import type {InteractionRecord} from '../interaction/contracts';
import type {SessionManager} from '../service/session/manager';
import {promptSummaryFrom, projectAgentTaskView} from './projection';
import {createProductEventLog, type ProductEventSink} from './events';
import {decodeInteractionToken} from './token';
import type {
    AgentTaskView,
    ProductAnswerInput,
    ProductApproveInput,
    ProductBeginGuidanceInput,
    ProductChooseRecoveryInput,
    ProductDenyInput,
    ProductEventsResponse,
    ProductReturnControlInput,
    ProductStartTaskInput,
    ProductStopTaskInput,
    WorkspaceLibrarySummary,
    WorkspaceProductView,
} from './types';

export const PRODUCT_USER_ACTOR = 'product-user';

export class ProductCommandError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

export type ProductControllerOptions = Readonly<{
    manager: SessionManager;
    workspace: string;
    defaults?: Readonly<{provider: string; model: string; executionMode?: AgentExecutionMode}>;
    library?: () => WorkspaceLibrarySummary;
    now?: () => number;
}>;

export type ProductTaskList = Readonly<{
    active: ReadonlyArray<AgentTaskView>;
    history: ReadonlyArray<AgentTaskView>;
}>;

export type ProductController = Readonly<{
    workspaceView: () => WorkspaceProductView;
    startTask: (input: ProductStartTaskInput) => AgentTaskView;
    taskView: (taskId: string) => AgentTaskView | null;
    listTasks: () => ProductTaskList;
    stopTask: (input: ProductStopTaskInput) => AgentTaskView | null;
    approveTask: (input: ProductApproveInput) => Promise<AgentTaskView | null>;
    denyTask: (input: ProductDenyInput) => Promise<AgentTaskView | null>;
    answerTask: (input: ProductAnswerInput) => Promise<AgentTaskView | null>;
    chooseRecoveryTask: (input: ProductChooseRecoveryInput) => Promise<AgentTaskView | null>;
    beginGuidanceTask: (input: ProductBeginGuidanceInput) => AgentTaskView | null;
    returnControlTask: (input: ProductReturnControlInput) => Promise<AgentTaskView | null>;
    events: (taskId: string, afterSeq: number) => ProductEventsResponse;
}>;

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const interactionHeadline = (record: {payload: {kind: 'approval'; actionName: string} | {kind: 'clarification'; question: string} | {kind: 'recovery_decision'; failureSummary: string} | {kind: 'takeover'; reason: string}}): string => {
    switch (record.payload.kind) {
        case 'approval': return record.payload.actionName;
        case 'clarification': return record.payload.question;
        case 'recovery_decision': return record.payload.failureSummary;
        case 'takeover': return record.payload.reason;
    }
};

const resolvedDecisionSummary = (record: {kind: string; decision: InteractionRecord['decision']}): string => {
    const decision = record.decision;
    if (decision?.kind === 'returnControl') {return `Returned control (${decision.mode})`;}
    if (decision?.kind === 'choose') {return `Chose ${decision.optionId}`;}
    if (decision?.kind === 'answer') {return 'Answered';}
    if (decision?.kind === 'deny') {return 'Denied';}
    if (decision?.kind === 'approve') {return 'Approved';}
    if (decision?.kind === 'cancel') {return 'Cancelled';}
    if (decision?.kind === 'expire') {return 'Expired';}
    return 'Resolved';
};

export const createProductController = (options: ProductControllerOptions): ProductController => {
    const manager = options.manager;
    const events: ProductEventSink = createProductEventLog(options.now);

    type TaskTracker = {
        seen: boolean;
        terminated: boolean;
        reportEmitted: boolean;
        effectsEmitted: Set<string>;
        interactions: Map<string, string>;
        guidance: Map<string, 'offered' | 'active'>;
    };
    const trackers = new Map<string, TaskTracker>();

    const trackerOf = (taskId: string): TaskTracker => {
        const existing = trackers.get(taskId);
        if (existing) {return existing;}
        const created: TaskTracker = {
            seen: false,
            terminated: false,
            reportEmitted: false,
            effectsEmitted: new Set(),
            interactions: new Map(),
            guidance: new Map(),
        };
        trackers.set(taskId, created);
        return created;
    };

    const sync = (): void => {
        manager.expireStale();
        manager.sweepOrphans();
        for (const snapshot of manager.list()) {
            const taskId = snapshot.sessionId;
            const tracker = trackerOf(taskId);

            if (!tracker.seen) {
                events.append(taskId, {
                    kind: 'task_created',
                    promptSummary: promptSummaryFrom(snapshot.request.prompt),
                    startedAt: snapshot.createdAt,
                });
                tracker.seen = true;
            }

            for (const record of manager.listInteractions(taskId) ?? []) {
                const previous = tracker.interactions.get(record.id);
                if (previous === undefined) {
                    if (record.status === 'pending') {
                        events.append(taskId, {
                            kind: 'interaction_requested',
                            interactionKind: record.kind,
                            headline: interactionHeadline(record),
                            deadlineAt: record.deadlineAt,
                        });
                        if (record.kind === 'takeover') {
                            tracker.guidance.set(record.id, record.stage === 'active' ? 'active' : 'offered');
                        }
                    } else {
                        events.append(taskId, {
                            kind: 'interaction_requested',
                            interactionKind: record.kind,
                            headline: interactionHeadline(record),
                            deadlineAt: record.deadlineAt,
                        });
                        if (record.decision?.kind === 'returnControl') {
                            events.append(taskId, {kind: 'human_guidance_started', mode: 'manual', purpose: 'human guidance'});
                            events.append(taskId, {
                                kind: 'interaction_resolved',
                                interactionKind: record.kind,
                                decisionSummary: resolvedDecisionSummary(record),
                            });
                            events.append(taskId, {
                                kind: 'human_guidance_completed',
                                mode: record.decision.mode,
                                ...(record.decision.savedReference === undefined ? {} : {savedAssetKind: 'asset'}),
                            });
                        } else {
                            events.append(taskId, {
                                kind: 'interaction_resolved',
                                interactionKind: record.kind,
                                decisionSummary: resolvedDecisionSummary(record),
                            });
                        }
                    }
                } else if (record.status === 'pending') {
                    if (
                        record.kind === 'takeover'
                        && record.stage === 'active'
                        && tracker.guidance.get(record.id) !== 'active'
                    ) {
                        events.append(taskId, {
                            kind: 'human_guidance_started',
                            mode: 'manual',
                            purpose: record.payload.kind === 'takeover' ? record.payload.reason : 'human guidance',
                        });
                        tracker.guidance.set(record.id, 'active');
                    }
                } else if (previous !== record.status) {
                    if (record.decision?.kind === 'returnControl') {
                        events.append(taskId, {
                            kind: 'interaction_resolved',
                            interactionKind: record.kind,
                            decisionSummary: resolvedDecisionSummary(record),
                        });
                        events.append(taskId, {
                            kind: 'human_guidance_completed',
                            mode: record.decision.mode,
                            ...(record.decision.savedReference === undefined ? {} : {savedAssetKind: 'asset'}),
                        });
                    } else {
                        events.append(taskId, {
                            kind: 'interaction_resolved',
                            interactionKind: record.kind,
                            decisionSummary: resolvedDecisionSummary(record),
                        });
                    }
                }
                tracker.interactions.set(record.id, record.status);
                if (record.status !== 'pending') {
                    tracker.guidance.delete(record.id);
                }
            }

            const programs = snapshot.result?.programs ?? [];
            programs.forEach((program, programIndex) => {
                for (const effect of program.effects ?? []) {
                    const key = `${programIndex}:${effect.sequence}`;
                    if (tracker.effectsEmitted.has(key)) {continue;}
                    tracker.effectsEmitted.add(key);
                    events.append(taskId, {
                        kind: 'effect_applied',
                        summary: effect.stepName,
                        status: effect.status === 'succeeded' ? 'succeeded' : 'failed',
                    });
                }
            });

            if (TERMINAL_STATES.has(snapshot.state) && !tracker.terminated) {
                events.append(taskId, {kind: 'task_terminated', outcome: snapshot.state as 'completed' | 'failed' | 'cancelled' | 'interrupted'});
                tracker.terminated = true;
            }
            if (snapshot.reportAvailable && !tracker.reportEmitted) {
                events.append(taskId, {kind: 'report_ready'});
                tracker.reportEmitted = true;
            }
        }
    };

    const viewFor = (taskId: string): AgentTaskView | null => {
        const snapshot = manager.status(taskId);
        if (snapshot === null) {return null;}
        const interactions = manager.listInteractions(taskId) ?? [];
        return projectAgentTaskView({
            taskId,
            snapshot,
            interactions,
            lastSeq: events.lastSeq(taskId),
        });
    };

    const requireToken = (token: string): {interactionId: string; revision: number} => {
        const decoded = decodeInteractionToken(token);
        if (!decoded) {
            throw new ProductCommandError('ERR_STALE', 'the interaction token is invalid or stale; refresh the task and review the updated interaction');
        }
        return decoded;
    };

    const requestWithDefaults = (input: ProductStartTaskInput): AgentRunRequest => {
        const provider = input.provider ?? options.defaults?.provider;
        const model = input.model ?? options.defaults?.model;
        if (!provider || !model) {
            throw new ProductCommandError('ERR_BAD_ARGS', 'provider/model defaults are not configured for the product task composer');
        }
        return {
            prompt: input.prompt.trim(),
            provider,
            model,
            ...(input.executionMode !== undefined
                ? {executionMode: input.executionMode}
                : options.defaults?.executionMode === undefined
                    ? {}
                    : {executionMode: options.defaults.executionMode}),
        };
    };

    return {
        workspaceView: () => {
            sync();
            const reservation = manager.activityReservation();
            const activeView = reservation.owner === 'task' && reservation.ownerTaskId !== undefined
                ? viewFor(reservation.ownerTaskId)
                : undefined;
            return Object.freeze({
                workspace: options.workspace,
                reservation: {
                    owner: reservation.owner,
                    ...(reservation.ownerTaskId === undefined ? {} : {ownerTaskId: reservation.ownerTaskId}),
                    humanControl: reservation.humanControl,
                },
                ...(activeView ? {activeTask: activeView} : {}),
                ...(options.library ? {librarySummary: options.library()} : {}),
            });
        },
        startTask: (input) => {
            if (input.prompt.trim().length === 0) {
                throw new ProductCommandError('ERR_BAD_ARGS', 'prompt must not be empty');
            }
            const snapshot = manager.start(requestWithDefaults(input));
            sync();
            return viewFor(snapshot.sessionId)!;
        },
        taskView: (taskId) => {
            sync();
            return viewFor(taskId);
        },
        listTasks: () => {
            sync();
            const active: AgentTaskView[] = [];
            const history: AgentTaskView[] = [];
            for (const snapshot of manager.list()) {
                const view = viewFor(snapshot.sessionId);
                if (!view) {continue;}
                if (snapshot.state === 'running' || snapshot.state === 'paused') {
                    active.push(view);
                } else if (TERMINAL_STATES.has(snapshot.state)) {
                    history.push(view);
                }
            }
            history.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
            return Object.freeze({active: Object.freeze(active), history: Object.freeze(history)});
        },
        stopTask: (input) => {
            sync();
            const snapshot = manager.cancel(input.taskId);
            if (!snapshot) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        approveTask: async (input) => {
            const token = requireToken(input.interactionToken);
            const decided = await manager.approveInteraction(input.taskId, token.interactionId, token.revision, PRODUCT_USER_ACTOR);
            if (!decided) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        denyTask: async (input) => {
            const token = requireToken(input.interactionToken);
            const decided = await manager.denyInteraction(
                input.taskId,
                token.interactionId,
                token.revision,
                PRODUCT_USER_ACTOR,
                input.reason.trim(),
                input.requestedAlternative?.trim(),
            );
            if (!decided) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        answerTask: async (input) => {
            const token = requireToken(input.interactionToken);
            const decided = await manager.answerInteraction(input.taskId, token.interactionId, token.revision, PRODUCT_USER_ACTOR, input.value);
            if (!decided) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        chooseRecoveryTask: async (input) => {
            const token = requireToken(input.interactionToken);
            const decided = await manager.chooseRecoveryInteraction(input.taskId, token.interactionId, token.revision, PRODUCT_USER_ACTOR, input.optionId);
            if (!decided) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        beginGuidanceTask: (input) => {
            const token = requireToken(input.interactionToken);
            const decided = manager.beginGuidanceInteraction(input.taskId, token.interactionId, token.revision, PRODUCT_USER_ACTOR, input.mode);
            if (!decided) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        returnControlTask: async (input) => {
            const token = requireToken(input.interactionToken);
            const decided = await manager.returnControlInteraction(
                input.taskId,
                token.interactionId,
                token.revision,
                PRODUCT_USER_ACTOR,
                input.mode,
                input.savedReference,
            );
            if (!decided) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        events: (taskId, afterSeq) => {
            sync();
            return events.eventsAfter(taskId, afterSeq);
        },
    };
};