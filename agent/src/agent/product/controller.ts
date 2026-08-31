import type {AgentExecutionMode, AgentRunRequest} from '../execution/types';
import type {AgentProgramSaver} from '../execution/program/persistence';
import type {GuidanceMode, InteractionRecord} from '../interaction/contracts';
import type {LibraryAssetSummary} from '../library/contracts';
import type {SessionManager} from '../service/session/manager';
import {promptSummaryFrom, projectAgentTaskView} from './projection';
import {createProductEventLog, type ProductEventSink} from './events';
import {librarySummaryFrom} from './library';
import {decodeInteractionToken} from './token';
import type {
    AgentTaskView,
    ProductAnswerInput,
    ProductApproveInput,
    ProductBeginAuthoringInput,
    ProductBeginGuidanceInput,
    ProductChooseRecoveryInput,
    ProductDenyInput,
    ProductEndAuthoringInput,
    ProductEventsResponse,
    ProductPauseTaskInput,
    ProductResumeTaskInput,
    ProductReturnControlInput,
    ProductSaveAutomationInput,
    ProductSaveAutomationResult,
    ProductStartTaskInput,
    ProductStopTaskInput,
    WorkspaceLibrarySummary,
    WorkspaceProductView,
} from './types';

export const PRODUCT_USER_ACTOR = 'product-user';

const ASSET_REF_KINDS = new Set(['procedure', 'recovery', 'demonstration', 'page_knowledge', 'automation']);

/** Parses the bounded `kind:name` saved-asset reference the extension supplies
 *  on return-control. Anything unknown degrades to a coarse, still-sanitized
 *  `asset` kind; raw payloads never pass through. */
const parseSavedReference = (savedReference: string): {kind: string; name?: string} => {
    const separator = savedReference.indexOf(':');
    if (separator <= 0) {return {kind: 'asset'};}
    const kind = savedReference.slice(0, separator);
    const name = savedReference.slice(separator + 1).trim();
    if (!ASSET_REF_KINDS.has(kind) || name.length === 0 || name.length > 120) {return {kind: 'asset'};}
    return {kind, name};
};

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
    /** Real committed Library summaries; projected through the bounded product
     *  adapter. When absent, the Library endpoint truthfully reports unavailable. */
    library?: () => Promise<ReadonlyArray<LibraryAssetSummary>>;
    saveAutomation?: AgentProgramSaver;
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
    pauseTask: (input: ProductPauseTaskInput) => AgentTaskView | null;
    resumeTask: (input: ProductResumeTaskInput) => Promise<AgentTaskView | null>;
    stopTask: (input: ProductStopTaskInput) => AgentTaskView | null;
    saveAutomation: (input: ProductSaveAutomationInput) => Promise<ProductSaveAutomationResult>;
    approveTask: (input: ProductApproveInput) => Promise<AgentTaskView | null>;
    denyTask: (input: ProductDenyInput) => Promise<AgentTaskView | null>;
    answerTask: (input: ProductAnswerInput) => Promise<AgentTaskView | null>;
    chooseRecoveryTask: (input: ProductChooseRecoveryInput) => Promise<AgentTaskView | null>;
    beginGuidanceTask: (input: ProductBeginGuidanceInput) => AgentTaskView | null;
    returnControlTask: (input: ProductReturnControlInput) => Promise<AgentTaskView | null>;
    beginAuthoring: (input: ProductBeginAuthoringInput) => WorkspaceProductView;
    endAuthoring: (input: ProductEndAuthoringInput) => WorkspaceProductView;
    librarySummary: () => Promise<WorkspaceLibrarySummary | null>;
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

const guidanceCompletedEvent = (
    mode: GuidanceMode,
    savedReference: string | undefined,
): Parameters<ProductEventSink['append']>[1] => {
    if (savedReference === undefined) {return {kind: 'human_guidance_completed', mode};}
    const parsed = parseSavedReference(savedReference);
    return {
        kind: 'human_guidance_completed',
        mode,
        savedAssetKind: parsed.kind,
        ...(parsed.name === undefined ? {} : {savedAssetRef: parsed.name}),
    };
};

const isStandaloneOwner = (owner: string): boolean =>
    owner === 'standalone_teach' || owner === 'standalone_annotate';

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

    const appendGuidanceStarted = (
        taskId: string,
        record: {payload: InteractionRecord['payload']},
    ): void => {
        const reservationNow = manager.activityReservation();
        const activeMode: GuidanceMode = reservationNow.owner === 'task'
            && reservationNow.ownerTaskId === taskId
            && reservationNow.humanControl !== 'none'
            ? reservationNow.humanControl
            : 'manual';
        events.append(taskId, {
            kind: 'human_guidance_started',
            mode: activeMode,
            purpose: record.payload.kind === 'takeover' ? record.payload.reason : 'human guidance',
        });
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
                            if (record.stage === 'active') {
                                appendGuidanceStarted(taskId, record);
                            }
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
                            events.append(taskId, {
                                kind: 'human_guidance_started',
                                mode: record.decision.mode,
                                purpose: 'human guidance',
                            });
                            events.append(taskId, {
                                kind: 'interaction_resolved',
                                interactionKind: record.kind,
                                decisionSummary: resolvedDecisionSummary(record),
                            });
                            events.append(taskId, guidanceCompletedEvent(
                                record.decision.mode,
                                record.decision.savedReference,
                            ));
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
                        appendGuidanceStarted(taskId, record);
                        tracker.guidance.set(record.id, 'active');
                    }
                } else if (previous !== record.status) {
                    if (record.decision?.kind === 'returnControl') {
                        events.append(taskId, {
                            kind: 'interaction_resolved',
                            interactionKind: record.kind,
                            decisionSummary: resolvedDecisionSummary(record),
                        });
                        events.append(taskId, guidanceCompletedEvent(
                            record.decision.mode,
                            record.decision.savedReference,
                        ));
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
        const saveEligible = options.saveAutomation !== undefined
            && snapshot.state === 'completed'
            && (snapshot.result?.programs ?? []).some((program) => program.status === 'completed');
        return projectAgentTaskView({
            taskId,
            snapshot,
            interactions,
            lastSeq: events.lastSeq(taskId),
            saveEligible,
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

    const workspaceView = (): WorkspaceProductView => {
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
                ...(reservation.teachKind === undefined ? {} : {teachKind: reservation.teachKind}),
                humanControl: reservation.humanControl,
            },
            ...(activeView ? {activeTask: activeView} : {}),
        });
    };

    return {
        workspaceView,
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
        pauseTask: (input) => {
            sync();
            const snapshot = manager.status(input.taskId);
            if (!snapshot) {return null;}
            if (snapshot.state !== 'running') {
                throw new ProductCommandError('ERR_BAD_STATE', 'only a running task can be paused');
            }
            manager.pause(input.taskId);
            sync();
            return viewFor(input.taskId);
        },
        resumeTask: async (input) => {
            sync();
            const snapshot = manager.status(input.taskId);
            if (!snapshot) {return null;}
            if (snapshot.state !== 'paused' || snapshot.result?.pausedByUser !== true || !snapshot.resumable) {
                throw new ProductCommandError('ERR_BAD_STATE', 'task is not a user-paused resumable task');
            }
            await manager.resume(input.taskId);
            sync();
            return viewFor(input.taskId);
        },
        stopTask: (input) => {
            sync();
            const snapshot = manager.cancel(input.taskId);
            if (!snapshot) {return null;}
            sync();
            return viewFor(input.taskId);
        },
        saveAutomation: async (input) => {
            const name = input.name.trim();
            if (!name) {throw new ProductCommandError('ERR_BAD_ARGS', 'automation name must not be empty');}
            if (!options.saveAutomation) {
                throw new ProductCommandError('ERR_BAD_STATE', 'automation saving is not available on this workspace');
            }
            const snapshot = manager.status(input.taskId);
            if (!snapshot) {throw new ProductCommandError('ERR_NOT_FOUND', `task not found: ${input.taskId}`);}
            if (snapshot.state !== 'completed' || snapshot.result === null) {
                throw new ProductCommandError('ERR_BAD_STATE', 'only a completed task can be saved as an automation');
            }
            const program = [...(snapshot.result.programs ?? [])]
                .reverse()
                .find((candidate) => candidate.status === 'completed');
            if (!program) {
                throw new ProductCommandError('ERR_BAD_STATE', 'completed task has no reusable Program to save');
            }
            const saved = await options.saveAutomation({
                name,
                source: program.materializedSource ?? program.source,
            });
            if (saved.status === 'conflict') {
                return Object.freeze({saved: false, name, reason: 'conflict' as const});
            }
            return Object.freeze({saved: true, name: saved.name});
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
        beginAuthoring: (input) => {
            const owner = input.activity === 'teach'
                ? {kind: 'standalone_teach' as const, teachKind: input.teachKind}
                : {kind: 'standalone_annotate' as const};
            const acquired = manager.activityAcquire(owner);
            if (!acquired.ok) {
                throw new ProductCommandError(
                    'ERR_ACTIVITY_CONFLICT',
                    'the workspace is already owned by another activity; standalone authoring was not started',
                );
            }
            return workspaceView();
        },
        endAuthoring: () => {
            const current = manager.activityReservation();
            if (isStandaloneOwner(current.owner)) {
                // Reservation release matches on the owner kind; the recorded
                // teachKind is descriptive, not an ownership identity. A
                // Task-owned reservation is never released through here.
                const owner = current.owner === 'standalone_teach'
                    ? {kind: 'standalone_teach' as const, teachKind: 'demonstration' as const}
                    : {kind: 'standalone_annotate' as const};
                manager.activityRelease(owner);
            }
            return workspaceView();
        },
        librarySummary: async () => {
            if (!options.library) {return null;}
            return librarySummaryFrom(await options.library());
        },
        events: (taskId, afterSeq) => {
            sync();
            return events.eventsAfter(taskId, afterSeq);
        },
    };
};