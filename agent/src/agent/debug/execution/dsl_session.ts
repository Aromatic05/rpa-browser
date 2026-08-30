import {
    createDslDebugController,
    type CreateDslDebugControllerOptions,
} from '../../../automation/dsl/debug/controller';
import type {
    DslBeforeStatementEvent,
    DslDebugPort,
    DslEffectDescriptor,
    DslExecutionFrameSnapshot,
    DslFailureDescriptor,
    DslScopeSnapshot,
    DslStatementLocation,
    DslValueProvenanceEvent,
    PausedDslExecution,
} from '../../../automation/dsl/debug/contracts';
import {DslDebugAbortError} from '../../../automation/dsl/debug/errors';
import {runCheckpointRecovery, selectRecovery, enterRecovery, isAutomaticRecoveryCheckpoint, entityExistsInPageSessionEntities, textVisibleInPageSession} from '../../../automation/runner/checkpoint/recovery';
import type {RecoveryFailureContext, RecoveryWorldProbe, RunCheckpointRecoveryOutcome} from '../../../automation/runner/checkpoint/recovery/types';
import type {Checkpoint} from '../../../automation/runner/checkpoint/types';
import {classifyBrowserOperation} from '../../../automation/runner/steps/effects';
import {injectStepResolve} from '../../../automation/runner/step_resolve';
import type {StepResolve, StepResult, StepUnion} from '../../../automation/runner/steps/types';
import {UNKNOWN_EFFECT_SEMANTICS} from '../../../program/effects/declaration';
import {
    runDslSource,
    type RunDslContext,
    type RunDslSourceResult,
    type StepExecutionPort,
} from '../../../automation/dsl/runtime';
import type {ComputeEvalScope} from '../../../program/compute/evaluate';
import type {ComputeExpr} from '../../../program/compute/types';
import type {QueryIR} from '../../../program/query/contracts';
import type {WorldView, WorldViewDescriptor, WorldViewSource} from '../../worldview/contracts';
import {describeWorldView} from '../../worldview/descriptor';
import {buildWorldCatalog} from '../../worldview/catalog';
import {diffWorldViews, isEmptyWorldViewDiff} from '../../worldview/diff';
import {isSameWorldView} from '../../worldview/revision';
import {diffDebugEffect} from '../effects/diff';
import {createDebugEffectJournal} from '../effects/journal';
import {proveTransactionLocalWorldLineage, worldConflictStepResult} from '../effects/lineage';
import {createDebugQuerySession} from '../query/session';
import type {DebugQuerySession} from '../query/contracts';
import {createDebugValueProvenanceStore} from '../provenance/store';
import {recomputeDebugValue} from '../provenance/recompute';
import {buildDebugProgramView, type DebugProgramView} from '../program/view';
import {createDebugProgramPatchStore, isDurableProgramPatchStatement} from '../program/patches';
import {buildDebugProgramOverlay} from '../program/overlay';
import {materializeDebugProgramSource} from '../program/materialize';
import {collectAvailableVariablesAtPath} from '../../../program/dsl/analysis/available_variables';
import {createDebugStatementHistoryStore} from '../history/store';
import {buildDebugExecutionHistory} from '../history/view';
import {compileStatementPatch} from './patch_statement';
import type {DebugCompensationPort} from '../transaction/compensation/contracts';
import {executePhysicalCompensations} from '../transaction/compensation/executor';
import {createDebugTransaction} from '../transaction/state';
import type {
    DebugSavepoint,
    DebugRollbackOptions,
    DebugRollbackResult,
    DebugTransaction,
} from '../transaction/contracts';
import type {
    DebugExecutionSavepoint,
    DslDebugAdvanceResult,
    DslDebugCommitResult,
    DslDebugExecutionSession,
    DslDebugPatchProgramResult,
    DslDebugUnpatchProgramResult,
    DslDebugRecomputeEffectResult,
    DslDebugRecoveryRunOptions,
    DslDebugRecoveryRunResult,
    DslDebugRewindPlanResult,
    DslDebugRewindResult,
    PausedDslDebugExecution,
} from './contracts';
import {aggregateEffectRisk, classifyFailure, executedEffectsSince} from '../recovery/semantics';
import {normalizeStepEntityRulesControl} from '../../../automation/snapshot/rules/model';
import {rebindLogicalEffectTarget} from './rebind_effect';

export type CreateDslDebugExecutionSessionOptions = {
    source: string;
    context: Omit<RunDslContext, 'debugPort'>;
    worldViewSource: WorldViewSource;
    compensationPort?: DebugCompensationPort;
    debug?: CreateDslDebugControllerOptions;
};

type ActivePause = {
    pause: PausedDslExecution;
    view: WorldView;
    debug: DebugQuerySession;
    effectResolvedAt?: WorldViewDescriptor;
    automaticSavepointId?: string;
    rollbackSavepointId?: string;
};

type PendingRecoveryRun = {
    checkpoint: Checkpoint;
    retryOriginal: boolean;
    safeToRetryOriginal: boolean;
    failurePause: Extract<PausedDslExecution, {reason: 'failure'}>;
    failureContinuationId: string;
    controller: ReturnType<typeof createDslDebugController>;
    completion: Promise<RunCheckpointRecoveryOutcome>;
    barrierContinuationId: string;
};

export const createDslDebugExecutionSession = (
    options: CreateDslDebugExecutionSessionOptions,
): DslDebugExecutionSession => {
    let controller: ReturnType<typeof createDslDebugController>;
    const journal = createDebugEffectJournal();
    const provenance = createDebugValueProvenanceStore();
    const statementHistory = createDebugStatementHistoryStore();
    const programs = new Map<string, DebugProgramView>();
    const programPatches = createDebugProgramPatchStore();
    const pendingEffectOverrides = new Map<string, DslEffectDescriptor>();
    const executionSavepoints = new Map<string, Readonly<{
        state: DebugExecutionSavepoint;
        provenance: readonly DslValueProvenanceEvent[];
        origin: 'automatic' | 'explicit';
    }>>();
    let currentStatementEvent: DslBeforeStatementEvent | null = null;
    let transaction: DebugTransaction | null = null;
    let transactionEffectStartSequence = 0;
    let latestEffectRollbackSavepointId: string | undefined;
    /** Per-checkpoint recovery attempt counts keyed by failure point, durable
     *  across recovery re-entries inside one retained task (maxAttempts). */
    const recoveryAttemptsByPoint = new Map<string, Record<string, number>>();
    /** In-flight recovery body paused at an irreversible approval barrier. */
    let pendingRecovery: PendingRecoveryRun | null = null;
    const initializeTransaction = (view: WorldView): DebugTransaction => {
        if (!transaction) {
            transaction = createDebugTransaction(view);
            transactionEffectStartSequence = journal.list().length;
        }
        return transaction;
    };
    const ensureTransaction = async (): Promise<DebugTransaction> => {
        return initializeTransaction(await options.worldViewSource.pin());
    };
    const requireTransaction = (): DebugTransaction => {
        if (!transaction) {throw new Error('DSL debug transaction is not initialized');}
        return transaction;
    };
    const lastCheckpointFrameIndex = (frames: readonly DslExecutionFrameSnapshot[]): number => {
        for (let index = frames.length - 1; index >= 0; index -= 1) {
            if (frames[index].kind === 'checkpoint') {return index;}
        }
        return -1;
    };
    const isRewindableStatementLocation = (
        location: DslStatementLocation,
        frames: Extract<PausedDslExecution, {reason: 'statement'}>['frames'],
    ): boolean => {
        const checkpointFrames = frames.filter((frame) => frame.kind === 'checkpoint');
        if (location.programId === 'main') {
            if (location.callStack.length > 0 || checkpointFrames.length > 0) {return false;}
        } else {
            const activeCheckpoint = checkpointFrames.at(-1);
            if (!activeCheckpoint
                || location.programId !== `checkpoint:${activeCheckpoint.checkpointId}`
                || location.callStack.length !== checkpointFrames.length
                || checkpointFrames.some((frame, index) => frame.checkpointId !== location.callStack[index])) {
                return false;
            }
        }
        const lastCheckpointIndex = lastCheckpointFrameIndex(frames);
        const localFrames = lastCheckpointIndex >= 0 ? frames.slice(lastCheckpointIndex + 1) : frames;
        const loopFrames = localFrames.filter((frame) => frame.kind === 'for');
        if (loopFrames.length !== location.loops.length
            || loopFrames.some((frame, index) => {
                const loop = location.loops[index];
                return loop.path !== frame.statementPath || loop.iteration !== frame.iteration;
            })) {
            return false;
        }
        if (localFrames.length === 0) {return /^body\.\d+$/u.test(location.path);}
        const currentFrame = localFrames.at(-1);
        const blockPath = currentFrame?.kind === 'if'
            ? `${currentFrame.statementPath}.${currentFrame.branch}`
            : currentFrame
                ? `${currentFrame.statementPath}.body`
                : null;
        return Boolean(
            blockPath
            && location.path.startsWith(`${blockPath}.`)
            && /^\d+$/u.test(location.path.slice(`${blockPath}.`.length)),
        );
    };
    const captureExecutionSavepoint = (
        current: ActivePause,
        savepoint: DebugSavepoint,
        origin: 'automatic' | 'explicit',
    ): void => {
        const history = statementHistory.list();
        executionSavepoints.set(savepoint.id, Object.freeze({
            state: Object.freeze({
                savepoint,
                reason: current.pause.reason,
                location: structuredClone(current.pause.location),
                scope: structuredClone(current.pause.scope),
                frames: current.pause.reason === 'statement'
                    ? structuredClone(current.pause.frames)
                    : Object.freeze([]),
                historySequence: history.at(-1)?.sequence ?? 0,
                world: current.debug.world,
            }),
            provenance: provenance.snapshot(),
            origin,
        }));
    };
    const isSameProgramPoint = (
        left: DslStatementLocation,
        right: DslStatementLocation,
    ): boolean => left.programId === right.programId && left.path === right.path;
    const captureStatementExecutionSavepoint = (
        event: DslBeforeStatementEvent,
        view: WorldView,
        savepoint: DebugSavepoint,
        origin: 'automatic' | 'explicit',
    ): void => {
        if (executionSavepoints.has(savepoint.id)) {return;}
        const history = statementHistory.list();
        executionSavepoints.set(savepoint.id, Object.freeze({
            state: Object.freeze({
                savepoint,
                reason: 'statement' as const,
                location: structuredClone(event.location),
                scope: structuredClone(event.scope),
                frames: structuredClone(event.frames),
                historySequence: history.at(-1)?.sequence ?? 0,
                world: describeWorldView(view),
            }),
            provenance: provenance.snapshot(),
            origin,
        }));
    };
    const captureCurrentStatementAt = (
        location: DslStatementLocation,
        view: WorldView,
        savepoint: DebugSavepoint,
    ): void => {
        const event = currentStatementEvent;
        if (!event
            || !isSameProgramPoint(event.location, location)
            || !isRewindableStatementLocation(event.location, event.frames)) {
            return;
        }
        captureStatementExecutionSavepoint(event, view, savepoint, 'automatic');
    };
    const ensureEffectRollbackAnchor = (
        location: DslStatementLocation,
        view: WorldView,
    ): DebugSavepoint => {
        const currentWorld = describeWorldView(view);
        const existing = latestEffectRollbackSavepointId
            ? requireTransaction().readSavepoint(latestEffectRollbackSavepointId)
            : null;
        const savepoint = existing?.savepoint.effectSequence === journal.list().length
            && isSameWorldView(existing.savepoint.world, currentWorld)
            ? existing.savepoint
            : requireTransaction().internalSavepoint(view, journal.list().length);
        latestEffectRollbackSavepointId = savepoint.id;
        captureCurrentStatementAt(location, view, savepoint);
        return savepoint;
    };
    const captureFailureStatementPoint = (
        location: DslStatementLocation,
        view: WorldView,
    ): DebugSavepoint | null => {
        const event = currentStatementEvent;
        if (!event
            || !isSameProgramPoint(event.location, location)
            || !isRewindableStatementLocation(event.location, event.frames)) {
            return null;
        }
        const rollbackRuntime = latestEffectRollbackSavepointId
            ? executionSavepoints.get(latestEffectRollbackSavepointId)
            : null;
        if (rollbackRuntime && isSameProgramPoint(rollbackRuntime.state.location, location)) {
            return null;
        }
        const savepoint = requireTransaction().internalSavepoint(view, journal.list().length);
        captureStatementExecutionSavepoint(event, view, savepoint, 'automatic');
        return savepoint;
    };
    const debugPort: DslDebugPort = {
        beforeStatement: async (event) => {
            const patch = programPatches.get(event.location.programId, event.location.path);
            const effectiveEvent = patch
                ? Object.freeze({
                    ...event,
                    location: Object.freeze({...event.location, kind: patch.statement.kind}),
                    statement: structuredClone(patch.statement),
                })
                : event;
            currentStatementEvent = effectiveEvent;
            const resolution = await controller.port.beforeStatement(effectiveEvent);
            if (resolution?.statement) {
                currentStatementEvent = Object.freeze({
                    ...effectiveEvent,
                    location: Object.freeze({...effectiveEvent.location, kind: resolution.statement.kind}),
                    statement: structuredClone(resolution.statement),
                });
            }
            return patch
                ? resolution ?? Object.freeze({statement: structuredClone(patch.statement)})
                : resolution;
        },
        afterStatement: (event) => {
            statementHistory.record(event);
            if (currentStatementEvent && isSameProgramPoint(currentStatementEvent.location, event.location)) {
                currentStatementEvent = null;
            }
        },
        beforeEffect: async (event) => {
            await ensureTransaction();
            pendingEffectOverrides.delete(event.effect.stepId);
            await controller.port.beforeEffect?.(event);
            const effect = pendingEffectOverrides.get(event.effect.stepId) ?? event.effect;
            pendingEffectOverrides.delete(event.effect.stepId);
            const worldBefore = await options.worldViewSource.pin();
            ensureEffectRollbackAnchor(event.location, worldBefore);
            journal.begin(Object.freeze({...event, effect}), worldBefore);
            return effect === event.effect ? undefined : Object.freeze({effect});
        },
        afterEffect: async (event) => {
            journal.finish(event, await options.worldViewSource.pin());
            await controller.port.afterEffect?.(event);
        },
        onFailure: async (event) => {await controller.port.onFailure?.(event);},
        onValue: (event) => {provenance.record(event);},
        onProgram: (event) => {programs.set(event.programId, buildDebugProgramView(event));},
    };
    const rawStepExecutionPort = options.context.stepExecutionPort;
    const stepExecutionPort: StepExecutionPort | undefined = rawStepExecutionPort
        ? {
            execute: async (step, precondition) => {
                if (precondition) {
                    const pinned = await options.worldViewSource.pin();
                    const retained = journal.list().slice(transactionEffectStartSequence);
                    const verification = proveTransactionLocalWorldLineage(precondition.revision, pinned, retained);
                    if (!verification.ok) {
                        return worldConflictStepResult(step, precondition, pinned.revision);
                    }
                }
                return await rawStepExecutionPort.execute(step, precondition);
            },
        }
        : undefined;
    const runContext: Omit<RunDslContext, 'debugPort'> = {
        ...options.context,
        ...(stepExecutionPort ? {stepExecutionPort} : {}),
    };
    let completion!: Promise<RunDslSourceResult>;
    let active: ActivePause | null = null;
    const resetController = (forceStep: boolean): void => {
        controller = createDslDebugController(
            forceStep ? {...options.debug, initialMode: 'step'} : options.debug,
        );
    };
    const startExecution = (
        resume?: RunDslContext['resume'],
        forceStep = false,
    ): void => {
        resetController(forceStep);
        completion = runDslSource(options.source, {
            ...runContext,
            ...(resume ? {resume} : {}),
            debugPort,
        });
    };

    const programSource = (programId: string): string => {
        if (programId === 'main') {return options.source;}
        const program = programs.get(programId);
        if (!program) {throw new Error(`DSL debug program is unavailable: ${programId}`);}
        return program.source;
    };

    const runProgramFromSavedState = async (input: Readonly<{
        programId: string;
        scope: DslScopeSnapshot;
        location: DslStatementLocation;
        frames: readonly DslExecutionFrameSnapshot[];
    }>): Promise<RunDslSourceResult> => {
        const checkpointIndex = lastCheckpointFrameIndex(input.frames);
        const debugFrames = checkpointIndex >= 0
            ? input.frames.slice(0, checkpointIndex + 1)
            : [];
        const localFrames = checkpointIndex >= 0
            ? input.frames.slice(checkpointIndex + 1)
            : input.frames;
        const topLevel = localFrames.length === 0 ? /^body\.(\d+)$/u.exec(input.location.path) : null;
        const resume: NonNullable<RunDslContext['resume']> = topLevel
            ? {scope: input.scope, startIndex: Number(topLevel[1])}
            : {scope: input.scope, location: input.location, frames: localFrames};

        const context = createProgramResumeContext(
            input.programId,
            input.scope,
            input.location.callStack,
            debugFrames,
            resume,
        );
        const result = await runDslSource(programSource(input.programId), context);
        if (checkpointIndex < 0) {return result;}

        const checkpointFrame = input.frames[checkpointIndex];
        if (checkpointFrame.kind !== 'checkpoint') {
            throw new Error('checkpoint frame index resolved to a non-checkpoint frame');
        }
        const parentScope = {
            input: structuredClone(checkpointFrame.parentScope.input),
            ...(checkpointFrame.parentScope.failure
                ? {failure: structuredClone(checkpointFrame.parentScope.failure)}
                : {}),
            vars: {...structuredClone(checkpointFrame.parentScope.vars)},
            output: {...structuredClone(checkpointFrame.parentScope.output)},
        };
        if (checkpointFrame.bind) {
            parentScope.vars[checkpointFrame.bind] = structuredClone(result.scope.output);
        }
        recordCompletedCheckpoint(checkpointFrame, parentScope);
        const parentFrames = input.frames.slice(0, checkpointIndex);
        const parentLocation: DslStatementLocation = Object.freeze({
            programId: checkpointFrame.parentProgramId,
            path: `${checkpointFrame.parentBlockPath}.${checkpointFrame.statementIndex + 1}`,
            kind: 'checkpoint',
            loops: structuredClone(checkpointFrame.loops),
            callStack: structuredClone(checkpointFrame.callStack),
        });
        return await runProgramFromSavedState({
            programId: checkpointFrame.parentProgramId,
            scope: parentScope,
            location: parentLocation,
            frames: parentFrames,
        });
    };

    const createProgramResumeContext = (
        programId: string,
        scope: DslScopeSnapshot,
        callStack: readonly string[],
        debugFrames: readonly DslExecutionFrameSnapshot[],
        resume: NonNullable<RunDslContext['resume']>,
    ): RunDslContext => {
        if (programId === 'main') {
            return {
                ...runContext,
                input: structuredClone(scope.input),
                ...(scope.failure ? {failure: structuredClone(scope.failure)} : {failure: undefined}),
                checkpointCallStack: [],
                debugProgramId: 'main',
                debugFrames,
                resume,
                debugPort,
            };
        }
        const prefix = 'checkpoint:';
        if (!programId.startsWith(prefix)) {
            throw new Error(`unsupported DSL debug program id: ${programId}`);
        }
        const checkpointId = programId.slice(prefix.length);
        const body = options.context.checkpointProvider?.getCheckpointBody?.(checkpointId);
        if (!body) {throw new Error(`checkpoint body unavailable: ${checkpointId}`);}
        const parentResolveResolver = runContext.resolveResolver;
        return {
            ...runContext,
            input: structuredClone(scope.input),
            ...(scope.failure ? {failure: structuredClone(scope.failure)} : {failure: undefined}),
            resolveResolver: {
                resolveBundle: (name) => name === checkpointId
                    ? {resolves: body.stepResolves, diagnostics: []}
                    : parentResolveResolver?.resolveBundle(name) ?? {resolves: null, diagnostics: []},
            },
            stepResolves: body.stepResolves,
            checkpointCallStack: [...callStack],
            debugProgramId: programId,
            debugFrames,
            resume,
            debugPort,
        };
    };

    const recordCompletedCheckpoint = (
        frame: Extract<DslExecutionFrameSnapshot, {kind: 'checkpoint'}>,
        scope: DslScopeSnapshot,
    ): void => {
        const program = programs.get(frame.parentProgramId);
        const entry = program?.statements.find((statement) => statement.path === frame.statementPath);
        if (entry?.statement.kind !== 'checkpoint') {
            throw new Error(`checkpoint caller statement is unavailable: ${frame.parentProgramId}/${frame.statementPath}`);
        }
        const location: DslStatementLocation = Object.freeze({
            programId: frame.parentProgramId,
            path: frame.statementPath,
            kind: 'checkpoint',
            loops: structuredClone(frame.loops),
            ...(entry.source ? {source: structuredClone(entry.source)} : {}),
            callStack: structuredClone(frame.callStack),
        });
        if (frame.bind) {
            provenance.record(Object.freeze({
                target: `vars.${frame.bind}`,
                location,
                source: Object.freeze({
                    kind: 'checkpoint' as const,
                    checkpointId: frame.checkpointId,
                    dependencies: structuredClone(frame.dependencies),
                }),
            }));
        }
        statementHistory.record(Object.freeze({
            location,
            scope: structuredClone(scope),
            statement: structuredClone(entry.statement),
        }));
    };

    const startExecutionSavepoint = (saved: DebugExecutionSavepoint, forceStep = true): void => {
        resetController(forceStep);
        completion = runProgramFromSavedState({
            programId: saved.location.programId,
            scope: saved.scope,
            location: saved.location,
            frames: saved.frames,
        });
    };
    startExecution(options.context.resume);

    const requireActive = (continuationId: string): ActivePause => {
        if (active?.pause.continuationId !== continuationId) {
            throw new Error(`DSL debug continuation is not active: ${continuationId}`);
        }
        return active;
    };

    const exposePause = (value: ActivePause): PausedDslDebugExecution => {
        const {pause, debug} = value;
        const rollbackAnchor = value.rollbackSavepointId
            ? requireTransaction().readSavepoint(value.rollbackSavepointId)?.savepoint
            : undefined;
        const base = {
            continuationId: pause.continuationId,
            reason: pause.reason,
            location: pause.location,
            scope: pause.scope,
            world: debug.world,
            ...(rollbackAnchor ? {rollbackAnchor} : {}),
        } as const;
        return pause.reason === 'effect'
            ? Object.freeze({...base, reason: 'effect' as const, effect: pause.effect})
            : pause.reason === 'barrier'
                ? Object.freeze({...base, reason: 'barrier' as const, effect: pause.effect})
                : pause.reason === 'failure'
                    ? Object.freeze({...base, reason: 'failure' as const, failure: pause.failure})
                    : Object.freeze({...base, reason: 'statement' as const, statement: pause.statement});
    };

    const release = (continuationId: string, mode: 'continue' | 'step' | 'abort'): void => {
        requireActive(continuationId);
        active = null;
        if (mode === 'abort') {
            if (pendingRecovery) {
                try {pendingRecovery.controller.abort(pendingRecovery.barrierContinuationId);} catch { /* ignore */ }
                pendingRecovery = null;
            }
            controller.abort(continuationId);
            return;
        }
        if (mode === 'step') {controller.step(continuationId); return;}
        controller.continue(continuationId);
    };

    const waitForPause = async (): Promise<PausedDslDebugExecution> => {
        if (active) {throw new Error('DSL debug execution is already paused');}
        const pause = await controller.waitForPause();
        const view = await options.worldViewSource.pin();
        initializeTransaction(view);
        const debug = createDebugQuerySession(view);
        const effectResolvedAt = (pause.reason === 'effect' || pause.reason === 'barrier')
            && pause.effect.logicalTarget
            ? Object.freeze({
                ...debug.world,
                revision: pause.effect.logicalTarget.resolvedAt ?? debug.world.revision,
            })
            : undefined;
        active = {
            pause,
            view,
            debug,
            ...(effectResolvedAt ? {effectResolvedAt} : {}),
            ...(latestEffectRollbackSavepointId
                ? {rollbackSavepointId: latestEffectRollbackSavepointId}
                : {}),
        };
        if (pause.reason === 'statement' && isRewindableStatementLocation(pause.location, pause.frames)) {
            const savepoint = requireTransaction().internalSavepoint(view, journal.list().length);
            captureExecutionSavepoint(active, savepoint, 'automatic');
            active = {...active, automaticSavepointId: savepoint.id};
        } else if (pause.reason === 'effect' || pause.reason === 'barrier') {
            const savepoint = ensureEffectRollbackAnchor(pause.location, view);
            active = {
                ...active,
                automaticSavepointId: savepoint.id,
                rollbackSavepointId: savepoint.id,
            };
        } else if (pause.reason === 'failure') {
            const savepoint = captureFailureStatementPoint(pause.location, view);
            if (savepoint) {active = {...active, automaticSavepointId: savepoint.id};}
        }
        return exposePause(active);
    };

    const refresh = async (continuationId: string): Promise<PausedDslDebugExecution> => {
        const current = requireActive(continuationId);
        const view = await options.worldViewSource.pin();
        const previousEffectSavepointId = latestEffectRollbackSavepointId;
        const refreshedEffectSavepoint = current.pause.reason === 'effect' || current.pause.reason === 'barrier'
            ? ensureEffectRollbackAnchor(current.pause.location, view)
            : null;
        if (refreshedEffectSavepoint
            && previousEffectSavepointId
            && previousEffectSavepointId !== refreshedEffectSavepoint.id) {
            executionSavepoints.delete(previousEffectSavepointId);
        }
        active = {
            pause: current.pause,
            view,
            debug: createDebugQuerySession(view),
            ...(current.effectResolvedAt ? {effectResolvedAt: current.effectResolvedAt} : {}),
            ...(refreshedEffectSavepoint
                ? {
                    automaticSavepointId: refreshedEffectSavepoint.id,
                    rollbackSavepointId: refreshedEffectSavepoint.id,
                }
                : {
                    ...(current.automaticSavepointId ? {automaticSavepointId: current.automaticSavepointId} : {}),
                    ...(current.rollbackSavepointId ? {rollbackSavepointId: current.rollbackSavepointId} : {}),
                }),
        };
        return exposePause(active);
    };

    const patchStatement = (
        continuationId: string,
        source: string,
        target: Readonly<{programId?: string; path?: string}> = {},
    ) => {
        const current = requireActive(continuationId);
        const explicitTarget = target.programId !== undefined || target.path !== undefined;
        if (!explicitTarget && current.pause.reason !== 'statement') {
            return Object.freeze({
                status: 'unavailable' as const,
                reason: 'not_statement_pause' as const,
                pause: exposePause(current),
            });
        }
        const targetProgramId = target.programId ?? current.pause.location.programId;
        const targetPath = target.path ?? current.pause.location.path;
        const program = programs.get(targetProgramId);
        if (!program) {
            return Object.freeze({
                status: 'unknown_program' as const,
                target: Object.freeze({programId: targetProgramId, path: targetPath}),
                pause: exposePause(current),
            });
        }
        const currentPath = current.pause.reason === 'statement'
            && current.pause.location.programId === targetProgramId
            ? current.pause.location.path
            : undefined;
        const point = buildDebugExecutionHistory(
            program,
            statementHistory.list(targetProgramId),
            currentPath,
        ).points.find((entry) => entry.path === targetPath);
        if (!point) {
            return Object.freeze({
                status: 'unknown_path' as const,
                target: Object.freeze({programId: targetProgramId, path: targetPath}),
                pause: exposePause(current),
            });
        }
        const isCurrent = current.pause.reason === 'statement'
            && current.pause.location.programId === targetProgramId
            && current.pause.location.path === targetPath;
        if (!isCurrent) {
            return point.executions > 0
                ? Object.freeze({
                    status: 'rewind_required' as const,
                    target: Object.freeze({
                        programId: targetProgramId,
                        path: targetPath,
                        executions: point.executions,
                    }),
                    rewind: rewindPlan(continuationId, {
                        programId: targetProgramId,
                        path: targetPath,
                    }),
                    pause: exposePause(current),
                })
                : Object.freeze({
                    status: 'not_current' as const,
                    target: Object.freeze({programId: targetProgramId, path: targetPath, executions: 0 as const}),
                    pause: exposePause(current),
                });
        }
        const compiled = compileStatementPatch(
            program.source,
            source,
            options.context.entityRulesResolver,
            options.context.resolveResolver,
            {
                initialVars: Object.keys(current.pause.scope.vars),
                allowFailureRoot: options.context.failure !== undefined,
            },
        );
        if (!compiled.ok) {
            return Object.freeze({
                status: 'invalid' as const,
                error: compiled.error,
                pause: exposePause(current) as Extract<PausedDslDebugExecution, {reason: 'statement'}>,
            });
        }
        controller.patchStatement(continuationId, compiled.statement);
        const pause = Object.freeze({
            ...current.pause,
            location: Object.freeze({...current.pause.location, kind: compiled.statement.kind}),
            statement: compiled.statement,
        });
        active = {...current, pause};
        return Object.freeze({
            status: 'patched' as const,
            pause: exposePause(active) as Extract<PausedDslDebugExecution, {reason: 'statement'}>,
        });
    };

    const patchProgram = (
        continuationId: string,
        programId: string,
        path: string,
        source: string,
    ): DslDebugPatchProgramResult => {
        const current = requireActive(continuationId);
        const program = programs.get(programId);
        if (!program) {
            return Object.freeze({
                status: 'unknown_program' as const,
                target: Object.freeze({programId, path}),
                pause: exposePause(current),
            });
        }
        const original = program.statements.find((entry) => entry.path === path);
        if (!original) {
            return Object.freeze({
                status: 'unknown_path' as const,
                target: Object.freeze({programId, path}),
                pause: exposePause(current),
            });
        }
        const overlay = buildDebugProgramOverlay(program, programPatches.list(programId));
        const initialVars = collectAvailableVariablesAtPath(overlay, path);
        if (!initialVars) {throw new Error(`DSL debug program path disappeared: ${programId}/${path}`);}
        const compiled = compileStatementPatch(
            program.source,
            source,
            options.context.entityRulesResolver,
            options.context.resolveResolver,
            {initialVars, allowFailureRoot: options.context.failure !== undefined},
        );
        if (!compiled.ok) {
            return Object.freeze({status: 'invalid' as const, error: compiled.error, pause: exposePause(current)});
        }
        if (!isDurableProgramPatchStatement(original.statement)
            || !isDurableProgramPatchStatement(compiled.statement)) {
            return Object.freeze({
                status: 'invalid' as const,
                error: Object.freeze({
                    code: 'ERR_DSL_PATCH_UNSUPPORTED' as const,
                    message: 'durable program patches cannot replace structural if/for/checkpoint statements',
                }),
                pause: exposePause(current),
            });
        }
        const patch = programPatches.set(Object.freeze({programId, path, source, statement: compiled.statement}));
        const isCurrent = current.pause.reason === 'statement'
            && current.pause.location.programId === programId
            && current.pause.location.path === path;
        if (isCurrent) {
            controller.patchStatement(continuationId, compiled.statement);
            const pause = Object.freeze({
                ...current.pause,
                location: Object.freeze({...current.pause.location, kind: compiled.statement.kind}),
                statement: structuredClone(compiled.statement),
            });
            active = {...current, pause};
            return Object.freeze({
                status: 'patched' as const,
                patch,
                target: Object.freeze({programId, path, state: 'current' as const}),
                pause: exposePause(active),
            });
        }
        const point = buildDebugExecutionHistory(
            program,
            statementHistory.list(programId),
            undefined,
        ).points.find((entry) => entry.path === path);
        const executions = point?.executions ?? 0;
        if (executions > 0) {
            return Object.freeze({
                status: 'rewind_required' as const,
                patch,
                target: Object.freeze({programId, path, executions}),
                rewind: rewindPlan(continuationId, {programId, path}),
                pause: exposePause(current),
            });
        }
        return Object.freeze({
            status: 'patched' as const,
            patch,
            target: Object.freeze({programId, path, state: 'future' as const}),
            pause: exposePause(current),
        });
    };

    const unpatchProgram = (
        continuationId: string,
        programId: string,
        path: string,
    ): DslDebugUnpatchProgramResult => {
        const current = requireActive(continuationId);
        const removed = programPatches.remove(programId, path);
        if (!removed) {
            return Object.freeze({
                status: 'not_found' as const,
                target: Object.freeze({programId, path}),
                pause: exposePause(current),
            });
        }
        if (current.pause.reason === 'statement'
            && current.pause.location.programId === programId
            && current.pause.location.path === path) {
            const original = programs.get(programId)?.statements.find((entry) => entry.path === path)?.statement;
            if (!original) {throw new Error(`DSL debug program path disappeared: ${programId}/${path}`);}
            controller.patchStatement(continuationId, original);
            const pause = Object.freeze({
                ...current.pause,
                location: Object.freeze({...current.pause.location, kind: original.kind}),
                statement: structuredClone(original),
            });
            active = {...current, pause};
        }
        return Object.freeze({
            status: 'removed' as const,
            patch: removed,
            target: Object.freeze({programId, path}),
            pause: exposePause(active ?? current),
        });
    };

    const recomputeEffect = (continuationId: string): DslDebugRecomputeEffectResult => {
        const current = requireActive(continuationId);
        if (current.pause.reason !== 'effect' && current.pause.reason !== 'barrier') {
            return Object.freeze({
                status: 'unavailable' as const,
                reason: 'not_effect_pause' as const,
                pause: exposePause(current),
            });
        }
        const effect = current.pause.effect;
        if (!effect.logicalTarget) {
            return Object.freeze({
                status: 'unavailable' as const,
                reason: 'no_logical_target' as const,
                pause: exposePause(current),
            });
        }
        const queried = current.debug.query(effect.logicalTarget.query);
        if (!queried.ok) {
            return Object.freeze({
                status: 'failed' as const,
                error: queried.error,
                pause: exposePause(current) as Extract<PausedDslDebugExecution, {reason: 'effect' | 'barrier'}>,
            });
        }
        const rebound = rebindLogicalEffectTarget(effect, queried.result);
        if (!rebound.ok) {
            return Object.freeze({
                status: 'unavailable' as const,
                reason: 'unsupported_effect' as const,
                pause: exposePause(current),
            });
        }
        pendingEffectOverrides.set(effect.stepId, rebound.effect);
        const pause = Object.freeze({...current.pause, effect: rebound.effect});
        active = {
            ...current,
            pause,
            effectResolvedAt: current.debug.world,
        };
        return Object.freeze({
            status: 'recomputed' as const,
            pause: exposePause(active) as Extract<PausedDslDebugExecution, {reason: 'effect' | 'barrier'}>,
        });
    };

    const recomputeRequired = (current: ActivePause): Extract<DslDebugAdvanceResult, {status: 'recompute_required'}> | null => {
        if ((current.pause.reason !== 'effect' && current.pause.reason !== 'barrier')
            || !current.effectResolvedAt
            || isSameWorldView(current.effectResolvedAt, current.debug.world)) {
            return null;
        }
        return Object.freeze({
            status: 'recompute_required' as const,
            pause: exposePause(current) as Extract<PausedDslDebugExecution, {reason: 'effect' | 'barrier'}>,
            target: Object.freeze({resolvedAt: current.effectResolvedAt, current: current.debug.world}),
        });
    };

    const rollback = async (
        continuationId: string,
        savepointId: string,
        rollbackOptions: DebugRollbackOptions = {},
    ): Promise<DebugRollbackResult> => {
        const current = requireActive(continuationId);
        const entry = requireTransaction().readSavepoint(savepointId);
        if (!entry) {
            return Object.freeze({
                status: 'not_found' as const,
                error: Object.freeze({
                    code: 'ERR_NOT_FOUND' as const,
                    message: `transaction savepoint not found: ${savepointId}`,
                }),
            });
        }
        const actual = describeWorldView(await options.worldViewSource.pin());
        if (!isSameWorldView(current.debug.world, actual)) {
            return Object.freeze({
                status: 'conflict' as const,
                conflict: Object.freeze({expected: current.debug.world, actual}),
            });
        }
        const sinceSavepoint = journal.list().filter((record) => record.sequence > entry.savepoint.effectSequence);
        const compensatedSequences = new Set(
            sinceSavepoint.flatMap((record) =>
                record.compensates && record.outcome.status === 'succeeded'
                    ? [record.compensates.effectSequence]
                    : []),
        );
        const effects = sinceSavepoint.filter((record) =>
            !record.compensates && !compensatedSequences.has(record.sequence));
        if (effects.length > 0) {
            if (rollbackOptions.strategy === 'physical') {
                if (!options.compensationPort) {
                    return Object.freeze({
                        status: 'blocked' as const,
                        reason: 'compensation_executor_unavailable' as const,
                        savepoint: entry.savepoint,
                        world: current.debug.world,
                        effects: Object.freeze([...effects]),
                        diff: diffWorldViews(entry.world, current.view),
                    });
                }
                const journalEntries = effects.map((record) => journal.read(record.sequence));
                if (journalEntries.some((value) => !value)) {
                    throw new Error('effect journal entry disappeared during rollback planning');
                }
                const compensation = await executePhysicalCompensations({
                    entries: journalEntries as NonNullable<(typeof journalEntries)[number]>[],
                    port: options.compensationPort,
                    worldViewSource: options.worldViewSource,
                    journal,
                    location: current.pause.location,
                    scope: current.pause.scope,
                });
                if (compensation.status === 'blocked') {
                    return Object.freeze({
                        status: 'blocked' as const,
                        reason: 'compensation_unavailable' as const,
                        savepoint: entry.savepoint,
                        world: current.debug.world,
                        effects: Object.freeze([...effects]),
                        diff: diffWorldViews(entry.world, current.view),
                        plans: compensation.plans,
                    });
                }
                active = {
                    pause: current.pause,
                    view: compensation.world,
                    debug: createDebugQuerySession(compensation.world),
                    ...(current.rollbackSavepointId ? {rollbackSavepointId: current.rollbackSavepointId} : {}),
                };
                const residualDiff = diffWorldViews(entry.world, compensation.world);
                if (compensation.status === 'failed') {
                    return Object.freeze({
                        status: 'partial' as const,
                        mode: 'physical' as const,
                        semanticRisk: compensation.semanticRisk,
                        savepoint: entry.savepoint,
                        compensations: compensation.compensations,
                        failure: compensation.failure,
                        world: describeWorldView(compensation.world),
                        residualDiff,
                    });
                }
                if (compensation.semanticRisk === 'reversible' && isEmptyWorldViewDiff(residualDiff)) {
                    return Object.freeze({
                        status: 'restored' as const,
                        mode: 'physical_verified' as const,
                        semanticRisk: 'reversible' as const,
                        savepoint: entry.savepoint,
                        compensations: compensation.compensations,
                        world: describeWorldView(compensation.world),
                        residualDiff,
                    });
                }
                return Object.freeze({
                    status: 'compensated' as const,
                    mode: 'physical' as const,
                    semanticRisk: compensation.semanticRisk,
                    savepoint: entry.savepoint,
                    compensations: compensation.compensations,
                    world: describeWorldView(compensation.world),
                    residualDiff,
                });
            }
            return Object.freeze({
                status: 'blocked' as const,
                reason: 'effects_require_compensation' as const,
                savepoint: entry.savepoint,
                world: current.debug.world,
                effects: Object.freeze([...effects]),
                diff: diffWorldViews(entry.world, current.view),
            });
        }
        if (!isSameWorldView(entry.savepoint.world, current.debug.world)) {
            return Object.freeze({
                status: 'blocked' as const,
                reason: 'world_drift' as const,
                savepoint: entry.savepoint,
                world: current.debug.world,
                effects: Object.freeze([]),
                diff: diffWorldViews(entry.world, current.view),
            });
        }
        return Object.freeze({
            status: 'restored' as const,
            mode: 'noop' as const,
            savepoint: entry.savepoint,
            world: current.debug.world,
        });
    };

    const advance = async (
        continuationId: string,
        mode: 'continue' | 'step' | 'abort',
    ): Promise<DslDebugAdvanceResult> => {
        if (pendingRecovery?.barrierContinuationId === continuationId) {
            if (mode !== 'abort') {
                throw new Error(`DSL recovery barrier requires approval via debug.cross_barrier: ${continuationId}`);
            }
            const failureLocation = pendingRecovery.failurePause.location;
            try {pendingRecovery.controller.abort(continuationId);} catch { /* ignore */ }
            pendingRecovery = null;
            const mainFailure = active;
            if (mainFailure) {
                return Object.freeze({status: 'paused' as const, pause: exposePause(mainFailure)});
            }
            return Object.freeze({status: 'aborted' as const, at: {reason: 'barrier' as const, location: failureLocation}});
        }
        const current = requireActive(continuationId);
        if (mode !== 'abort') {
            const stale = recomputeRequired(current);
            if (stale) {return stale;}
        }
        if (current.pause.reason === 'barrier' && mode !== 'abort') {
            return Object.freeze({
                status: 'barrier' as const,
                pause: exposePause(current) as Extract<PausedDslDebugExecution, {reason: 'barrier'}>,
            });
        }
        const pausedFailure = current.pause.reason === 'failure' ? current.pause.failure : undefined;
        const abortedAt = Object.freeze({
            reason: current.pause.reason,
            location: current.pause.location,
        });
        if (mode !== 'abort' && current.pause.reason !== 'failure') {
            const actual = describeWorldView(await options.worldViewSource.pin());
            if (!isSameWorldView(current.debug.world, actual)) {
                return Object.freeze({
                    status: 'conflict' as const,
                    conflict: Object.freeze({expected: current.debug.world, actual}),
                });
            }
        }
        release(continuationId, mode);
        return await Promise.race([
            waitForPause().then((pause) => ({status: 'paused' as const, pause})),
            completion.then((result) => ({
                status: 'completed' as const,
                output: structuredClone(result.scope.output),
            }), (error) => error instanceof DslDebugAbortError
                ? {status: 'aborted' as const, at: abortedAt}
                : {
                    status: 'failed' as const,
                    failure: pausedFailure ?? normalizeTerminalFailure(error),
                }),
        ]);
    };

    const crossBarrier = async (continuationId: string): Promise<DslDebugAdvanceResult> => {
        if (pendingRecovery?.barrierContinuationId === continuationId) {
            return await resumeRecoveryAfterApproval(continuationId);
        }
        const current = requireActive(continuationId);
        if (current.pause.reason !== 'barrier') {
            throw new Error(`DSL debug continuation is not paused at a commit barrier: ${continuationId}`);
        }
        const stale = recomputeRequired(current);
        if (stale) {return stale;}
        const actual = describeWorldView(await options.worldViewSource.pin());
        if (!isSameWorldView(current.debug.world, actual)) {
            return Object.freeze({
                status: 'conflict' as const,
                conflict: Object.freeze({expected: current.debug.world, actual}),
            });
        }
        active = null;
        controller.crossBarrier(continuationId);
        return await Promise.race([
            waitForPause().then((pause) => ({status: 'paused' as const, pause})),
            completion.then((result) => ({
                status: 'completed' as const,
                output: structuredClone(result.scope.output),
            }), (error) => ({
                status: 'failed' as const,
                failure: normalizeTerminalFailure(error),
            })),
        ]);
    };


    const commit = async (continuationId: string): Promise<DslDebugCommitResult> => {
        const current = requireActive(continuationId);
        if (current.pause.reason === 'failure') {
            return Object.freeze({
                status: 'unavailable' as const,
                reason: 'failure_pause' as const,
                pause: exposePause(current),
            });
        }
        const actualView = await options.worldViewSource.pin();
        const actual = describeWorldView(actualView);
        if (!isSameWorldView(current.debug.world, actual)) {
            return Object.freeze({
                status: 'conflict' as const,
                conflict: Object.freeze({expected: current.debug.world, actual}),
            });
        }
        const journalSequence = journal.list().length;
        const previous = requireTransaction().snapshot(
            current.view,
            journalSequence - transactionEffectStartSequence,
        );
        transaction = createDebugTransaction(actualView);
        transactionEffectStartSequence = journalSequence;
        latestEffectRollbackSavepointId = undefined;
        executionSavepoints.clear();
        active = {
            pause: current.pause,
            view: actualView,
            debug: createDebugQuerySession(actualView),
            ...(current.effectResolvedAt ? {effectResolvedAt: current.effectResolvedAt} : {}),
        };
        if (current.pause.reason === 'statement'
            && isRewindableStatementLocation(current.pause.location, current.pause.frames)) {
            const savepoint = requireTransaction().internalSavepoint(actualView, journalSequence);
            captureExecutionSavepoint(active, savepoint, 'automatic');
            active = {...active, automaticSavepointId: savepoint.id};
        }
        return Object.freeze({
            status: 'committed' as const,
            previous,
            transaction: requireTransaction().snapshot(actualView, 0),
            world: actual,
        });
    };

    const rewind = async (
        continuationId: string,
        savepointId: string,
        rewindOptions: DebugRollbackOptions = {},
    ): Promise<DslDebugRewindResult> => {
        requireActive(continuationId);
        const savedRuntime = executionSavepoints.get(savepointId);
        if (!savedRuntime) {
            return Object.freeze({
                status: 'not_found' as const,
                error: Object.freeze({
                    code: 'ERR_NOT_FOUND' as const,
                    message: `execution savepoint not found: ${savepointId}`,
                }),
            });
        }
        const saved = savedRuntime.state;
        if (saved.reason !== 'statement') {
            return Object.freeze({
                status: 'unsupported_target' as const,
                reason: 'not_statement_savepoint' as const,
                savepoint: structuredClone(saved),
            });
        }
        if (!isRewindableStatementLocation(saved.location, saved.frames)) {
            return Object.freeze({
                status: 'unsupported_target' as const,
                reason: 'not_main_top_level' as const,
                savepoint: structuredClone(saved),
            });
        }
        const rollbackResult = await rollback(continuationId, savepointId, rewindOptions);
        if (rollbackResult.status !== 'restored') {
            return Object.freeze({
                status: 'blocked' as const,
                reason: 'world_not_restored' as const,
                savepoint: structuredClone(saved),
                rollback: rollbackResult,
            });
        }

        const oldCompletion = completion;
        active = null;
        controller.abort(continuationId);
        try {
            await oldCompletion;
        } catch (error) {
            if (!(error instanceof DslDebugAbortError)) {throw error;}
        }

        statementHistory.truncate(saved.historySequence);
        provenance.restore(savedRuntime.provenance);
        pendingEffectOverrides.clear();
        requireTransaction().truncateSavepoints(savepointId);
        latestEffectRollbackSavepointId = undefined;
        for (const id of [...executionSavepoints.keys()]) {
            if (!requireTransaction().readSavepoint(id)) {executionSavepoints.delete(id);}
        }

        startExecutionSavepoint(saved);
        const pause = await waitForPause();
        if (pause.reason !== 'statement'
            || pause.location.programId !== saved.location.programId
            || pause.location.path !== saved.location.path) {
            throw new Error(`rewind resumed at unexpected DSL location: ${pause.location.programId}/${pause.location.path}`);
        }
        if (!isSameWorldView(rollbackResult.world, pause.world)) {
            return Object.freeze({
                status: 'conflict' as const,
                savepoint: structuredClone(saved),
                pause,
                conflict: Object.freeze({expected: rollbackResult.world, actual: pause.world}),
            });
        }
        return Object.freeze({
            status: 'rewound' as const,
            savepoint: structuredClone(saved),
            pause,
        });
    };

    const rewindPlan = (
        continuationId: string,
        target: Readonly<{programId?: string; path?: string}> = {},
    ): DslDebugRewindPlanResult => {
        const current = requireActive(continuationId);
        const programId = target.programId ?? current.pause.location.programId;
        const path = target.path ?? current.pause.location.path;
        const program = programs.get(programId);
        if (!program) {
            return Object.freeze({
                status: 'unknown_program' as const,
                target: Object.freeze({programId, path}),
            });
        }
        if (!program.statements.some((entry) => entry.path === path)) {
            return Object.freeze({
                status: 'unknown_path' as const,
                target: Object.freeze({programId, path}),
            });
        }
        const currentPath = current.pause.reason === 'statement'
            && current.pause.location.programId === programId
            ? current.pause.location.path
            : undefined;
        const point = buildDebugExecutionHistory(
            program,
            statementHistory.list(programId),
            currentPath,
        ).points.find((entry) => entry.path === path);
        const executions = point?.executions ?? 0;
        const planTarget = Object.freeze({programId, path, executions});
        const targetMatch = /^body\.(\d+)$/u.exec(path);
        const nestedTarget = /^body\.\d+(?:\.(?:then|else|body)\.\d+)+$/u.test(path);
        if ((programId !== 'main' && !programId.startsWith('checkpoint:'))
            || (!targetMatch && !nestedTarget)) {
            return Object.freeze({
                status: 'unsupported_target' as const,
                reason: 'not_main_top_level' as const,
                target: planTarget,
            });
        }
        const candidates = [...executionSavepoints.values()]
            .reverse()
            .flatMap((entry) => {
                const saved = entry.state;
                if (saved.reason !== 'statement'
                    || saved.location.programId !== programId
                    || !isRewindableStatementLocation(saved.location, saved.frames)) {
                    return [];
                }
                if (nestedTarget) {
                    if (saved.location.path !== path) {return [];}
                    return [Object.freeze({
                        savepointId: saved.savepoint.id,
                        origin: entry.origin,
                        ...(saved.savepoint.name ? {name: saved.savepoint.name} : {}),
                        location: structuredClone(saved.location),
                        checkpointStack: Object.freeze(
                            saved.frames
                                .filter((frame) => frame.kind === 'checkpoint')
                                .map((frame) => Object.freeze({
                                    checkpointId: frame.checkpointId,
                                    invocationId: frame.invocationId,
                                })),
                        ),
                        effectSequence: saved.savepoint.effectSequence,
                        world: structuredClone(saved.world),
                        exact: true,
                        replayStatements: 0,
                    })];
                }
                const match = /^body\.(\d+)$/u.exec(saved.location.path);
                if (!match) {return [];}
                const savedIndex = Number(match[1]);
                const targetIndex = Number(targetMatch![1]);
                if (savedIndex > targetIndex) {return [];}
                return [Object.freeze({
                    savepointId: saved.savepoint.id,
                    origin: entry.origin,
                    ...(saved.savepoint.name ? {name: saved.savepoint.name} : {}),
                    location: structuredClone(saved.location),
                    checkpointStack: Object.freeze(
                        saved.frames
                            .filter((frame) => frame.kind === 'checkpoint')
                            .map((frame) => Object.freeze({
                                checkpointId: frame.checkpointId,
                                invocationId: frame.invocationId,
                            })),
                    ),
                    effectSequence: saved.savepoint.effectSequence,
                    world: structuredClone(saved.world),
                    exact: savedIndex === targetIndex,
                    replayStatements: targetIndex - savedIndex,
                })];
            })
            .sort((left, right) => left.replayStatements - right.replayStatements);
        return candidates.length > 0
            ? Object.freeze({status: 'ready' as const, target: planTarget, candidates: Object.freeze(candidates)})
            : Object.freeze({status: 'no_savepoint' as const, target: planTarget, candidates: Object.freeze([])});
    };

    const describeRecoveryEffect = (step: StepUnion): DslEffectDescriptor => Object.freeze({
        stepId: step.id,
        stepName: step.name,
        args: structuredClone(step.args),
        semantics: UNKNOWN_EFFECT_SEMANTICS,
    });

    const failureCodeOf = (failure: DslFailureDescriptor): string =>
    failure.kind === 'invariant' ? 'invariant' : failure.code;

const failureContextOf = (current: ActivePause): RecoveryFailureContext => {
        if (current.pause.reason !== 'failure') {
            throw new Error('recovery failure context requires a failure pause');
        }
        const failure = current.pause.failure;
        const stepFailure = failure.kind === 'step' ? failure : undefined;
        return {
            runId: current.pause.continuationId,
            workspaceName: options.context.workspaceName,
            stepId: stepFailure?.stepId ?? current.pause.location.path,
            stepName: stepFailure?.stepName ?? 'invariant',
            args: stepFailure?.args,
            error: {
                code: failure.code,
                message: failure.message,
                ...(failure.details === undefined ? {} : {details: structuredClone(failure.details)}),
            },
            currentUrl: current.debug.world.pageUrl,
        };
    };

    const recoveryWorldProbeOf = (current: ActivePause): RecoveryWorldProbe => ({
        currentUrl: async () => current.debug.world.pageUrl,
        textVisible: async (needle: string) => await textVisibleInPageSession(current.view.entry, needle),
        entityExists: async (args, entityRules) => {
            try {
                const control = normalizeStepEntityRulesControl(entityRules);
                if (control.selection === 'explicit' && control.profiles) {
                    const available = new Set(Object.keys(current.view.entry.semanticBindingsByProfile));
                    if (!control.profiles.every((profile) => available.has(profile))) {
                        return false;
                    }
                    const selectedBindings = Object.fromEntries(
                        control.profiles.map((profile) => [
                            profile,
                            current.view.entry.semanticBindingsByProfile[profile],
                        ]),
                    );
                    return await entityExistsInPageSessionEntities(
                        Object.freeze({
                            ...current.view.entry,
                            semanticBindingsByProfile: Object.freeze(selectedBindings),
                        }),
                        args,
                    );
                }
                return await entityExistsInPageSessionEntities(current.view.entry, args);
            } catch {
                return false;
            }
        },
    });

    const canRetryOriginalSafely = (
        failure: DslFailureDescriptor,
        anchorEffectSequence: number | undefined,
    ): boolean => {
        if (classifyFailure(failure) !== 'read') {return false;}
        const risk = aggregateEffectRisk(anchorEffectSequence !== undefined
            ? executedEffectsSince(journal.list(), anchorEffectSequence)
            : []);
        return risk === 'none' || risk === 'reversible';
    };

    const driveRecovery = async (
        recoveryCompletion: Promise<RunCheckpointRecoveryOutcome>,
        recoveryController: ReturnType<typeof createDslDebugController>,
    ): Promise<
        | {kind: 'done'; outcome: RunCheckpointRecoveryOutcome}
        | {kind: 'barrier'; pause: Extract<PausedDslExecution, {reason: 'barrier'}>}
    > => {
        const result = await Promise.race([
            recoveryCompletion.then((outcome) => ({kind: 'done' as const, outcome})),
            recoveryController.waitForPause().then((pause) => ({
                kind: 'barrier' as const,
                pause: pause as Extract<PausedDslExecution, {reason: 'barrier'}>,
            })),
        ]);
        return result;
    };

    const exposeRecoveryBarrier = async (
        pause: Extract<PausedDslExecution, {reason: 'barrier'}>,
    ): Promise<Extract<PausedDslDebugExecution, {reason: 'barrier'}>> => {
        const world = describeWorldView(await options.worldViewSource.pin());
        const rollbackAnchor = latestEffectRollbackSavepointId
            ? requireTransaction().readSavepoint(latestEffectRollbackSavepointId)?.savepoint
            : undefined;
        return Object.freeze({
            continuationId: pause.continuationId,
            reason: 'barrier' as const,
            location: pause.location,
            scope: pause.scope,
            effect: pause.effect,
            world,
            ...(rollbackAnchor ? {rollbackAnchor} : {}),
        });
    };

    const nextRecoveryResumeLocation = (
        saved: DebugExecutionSavepoint,
    ): DslStatementLocation | null => {
        const checkpointIndex = lastCheckpointFrameIndex(saved.frames);
        const localFrames = checkpointIndex >= 0
            ? saved.frames.slice(checkpointIndex + 1)
            : saved.frames;
        const currentFrame = localFrames.at(-1);
        const blockPath = currentFrame?.kind === 'if'
            ? `${currentFrame.statementPath}.${currentFrame.branch}`
            : currentFrame?.kind === 'for'
                ? `${currentFrame.statementPath}.body`
                : 'body';
        const prefix = `${blockPath}.`;
        if (!saved.location.path.startsWith(prefix)) {return null;}
        const indexText = saved.location.path.slice(prefix.length);
        if (!/^\d+$/u.test(indexText)) {return null;}
        return Object.freeze({
            ...saved.location,
            path: `${blockPath}.${Number(indexText) + 1}`,
        });
    };

    const replayAfterRecovery = async (
        continuationId: string,
        mode: 'retry' | 'skip',
    ): Promise<DslDebugAdvanceResult | null> => {
        const savepointId = active?.automaticSavepointId;
        if (!savepointId) {return null;}
        const savedRuntime = executionSavepoints.get(savepointId);
        if (savedRuntime?.state.reason !== 'statement') {return null;}
        const saved = savedRuntime.state;
        if (!isRewindableStatementLocation(saved.location, saved.frames)) {return null;}

        const resumeLocation = mode === 'skip'
            ? nextRecoveryResumeLocation(saved)
            : saved.location;
        if (!resumeLocation) {return null;}

        const oldCompletion = completion;
        active = null;
        controller.abort(continuationId);
        try {
            await oldCompletion;
        } catch (error) {
            if (!(error instanceof DslDebugAbortError)) {throw error;}
        }
        pendingEffectOverrides.clear();
        startExecutionSavepoint(Object.freeze({
            ...saved,
            location: resumeLocation,
        }), mode === 'retry');
        return await Promise.race([
            waitForPause().then(async (pause) => {
                if (pause.reason === 'failure') {
                    const activeFailure = active;
                    if (!activeFailure) {throw new Error('recovery failure pause lost its active continuation');}
                    return Object.freeze({
                        status: 'paused' as const,
                        pause: exposePause(activeFailure),
                    });
                }
                if (mode === 'skip') {
                    return Object.freeze({status: 'paused' as const, pause});
                }
                if (pause.reason !== 'statement'
                    || pause.location.programId !== saved.location.programId
                    || pause.location.path !== resumeLocation.path) {
                    throw new Error(`recovery resume at unexpected DSL location: ${pause.location.programId}/${pause.location.path}`);
                }
                return await advance(pause.continuationId, 'continue');
            }),
            completion.then(
                (result) => Object.freeze({status: 'completed' as const, output: structuredClone(result.scope.output)}),
                (error) => error instanceof DslDebugAbortError
                    ? Object.freeze({status: 'aborted' as const, at: {reason: saved.reason, location: saved.location}})
                    : Object.freeze({status: 'failed' as const, failure: normalizeTerminalFailure(error)}),
            ),
        ]);
    };

    const finalizeRecoveryOutcome = async (
        outcome: RunCheckpointRecoveryOutcome,
        ctx: {
            checkpoint: Checkpoint;
            retryOriginal: boolean;
            safeToRetryOriginal: boolean;
            failureContinuationId: string;
        },
    ): Promise<DslDebugRecoveryRunResult> => {
        if (!outcome.active || !outcome.runResult?.ok) {
            return Object.freeze({status: 'failed' as const, checkpointId: ctx.checkpoint.id});
        }
        if (ctx.retryOriginal) {
            if (ctx.safeToRetryOriginal) {
                const advanceResult = await replayAfterRecovery(ctx.failureContinuationId, 'retry');
                if (advanceResult) {
                    return Object.freeze({
                        status: 'recovered' as const,
                        checkpointId: ctx.checkpoint.id,
                        ...(ctx.checkpoint.name ? {checkpointName: ctx.checkpoint.name} : {}),
                        retried: true,
                        advance: advanceResult,
                    });
                }
            }
        } else {
            const advanceResult = await replayAfterRecovery(ctx.failureContinuationId, 'skip');
            if (advanceResult) {
                return Object.freeze({
                    status: 'recovered' as const,
                    checkpointId: ctx.checkpoint.id,
                    ...(ctx.checkpoint.name ? {checkpointName: ctx.checkpoint.name} : {}),
                    retried: false,
                    advance: advanceResult,
                });
            }
        }
        return Object.freeze({
            status: 'recovered' as const,
            checkpointId: ctx.checkpoint.id,
            ...(ctx.checkpoint.name ? {checkpointName: ctx.checkpoint.name} : {}),
            retried: false,
        });
    };

    const advanceResultFromRecovery = (outcome: DslDebugRecoveryRunResult): DslDebugAdvanceResult => {
        if (outcome.status === 'recovered' && outcome.advance) {return outcome.advance;}
        if (outcome.status === 'recovered' && active) {
            return Object.freeze({status: 'paused' as const, pause: exposePause(active)});
        }
        return Object.freeze({
            status: 'failed' as const,
            failure: Object.freeze({code: 'ERR_RECOVERY_FAILED', message: 'retained recovery failed after approval'}),
        });
    };

    const resumeRecoveryAfterApproval = async (continuationId: string): Promise<DslDebugAdvanceResult> => {
        const recovery = pendingRecovery;
        if (recovery?.barrierContinuationId !== continuationId) {
            throw new Error(`DSL recovery continuation is not paused at a recovery barrier: ${continuationId}`);
        }
        recovery.controller.crossBarrier(continuationId);
        const driven = await driveRecovery(recovery.completion, recovery.controller);
        if (driven.kind === 'barrier') {
            recovery.barrierContinuationId = driven.pause.continuationId;
            return Object.freeze({
                status: 'paused' as const,
                pause: await exposeRecoveryBarrier(driven.pause),
            });
        }
        pendingRecovery = null;
        const outcome = await finalizeRecoveryOutcome(driven.outcome, recovery);
        return advanceResultFromRecovery(outcome);
    };

    const runRecovery = async (
        continuationId: string,
        recovery: DslDebugRecoveryRunOptions,
    ): Promise<DslDebugRecoveryRunResult> => {
        const current = requireActive(continuationId);
        if (current.pause.reason !== 'failure' || !stepExecutionPort) {
            return Object.freeze({status: 'failed' as const});
        }
        const pause = current.pause;
        const failureContext = failureContextOf(current);

        if (!enterRecovery({
            checkpointEnabled: true,
            inCheckpointFlow: pause.location.programId !== 'main',
            errorCode: pause.failure.code,
        }).entered) {
            return Object.freeze({status: 'no_recovery' as const});
        }

        const checkpoints = recovery.runtime.provider.listCheckpoints
            ? recovery.runtime.provider.listCheckpoints().filter(isAutomaticRecoveryCheckpoint)
            : [];
        const failureKey = `${pause.location.programId}@${pause.location.path}#${failureCodeOf(pause.failure)}`;
        const attempts = recoveryAttemptsByPoint.get(failureKey) ?? {};
        const selection = await selectRecovery({
            checkpoints,
            failure: failureContext,
            checkpointEnabled: true,
            checkpointAttempt: 0,
            checkpointAttempts: attempts,
            checkpointMaxAttempts: recovery.checkpointMaxAttempts ?? Number.MAX_SAFE_INTEGER,
            world: recoveryWorldProbeOf(current),
        });
        if (selection.status === 'no_match') {
            return Object.freeze({status: 'no_recovery' as const});
        }
        attempts[selection.checkpoint.id] = (attempts[selection.checkpoint.id] ?? 0) + 1;
        recoveryAttemptsByPoint.set(failureKey, attempts);

        const anchorEffectSequence = (() => {
            const anchorId = current.rollbackSavepointId ?? current.automaticSavepointId;
            return anchorId ? requireTransaction().readSavepoint(anchorId)?.savepoint.effectSequence : undefined;
        })();
        const safeToRetryOriginal = canRetryOriginalSafely(pause.failure, anchorEffectSequence);
        const retryOriginal = selection.checkpoint.policy?.retryOriginal !== false;

        const executeStep = async (step: StepUnion, stepResolves?: Record<string, StepResolve>): Promise<StepResult> => {
            const injected = stepResolves ? injectStepResolve(step, stepResolves) : {ok: true as const, step};
            if (!injected.ok) {
                return {stepId: step.id, ok: false, error: injected.error};
            }
            const runtimeStep = injected.step;
            let effect: DslEffectDescriptor | undefined;
            if (classifyBrowserOperation(runtimeStep.name, runtimeStep.args) === 'effect') {
                effect = describeRecoveryEffect(runtimeStep);
                const worldBefore = await options.worldViewSource.pin();
                ensureEffectRollbackAnchor(pause.location, worldBefore);
                journal.begin(Object.freeze({location: pause.location, scope: pause.scope, effect}), worldBefore);
            }
            const result = await stepExecutionPort.execute(runtimeStep, undefined);
            if (effect) {
                const worldAfter = await options.worldViewSource.pin();
                journal.finish(Object.freeze({
                    location: pause.location,
                    effect,
                    outcome: result.ok
                        ? Object.freeze({status: 'succeeded' as const})
                        : Object.freeze({
                            status: 'failed' as const,
                            error: Object.freeze({
                                code: result.error?.code || 'ERR_DSL_STEP_FAILED',
                                message: result.error?.message || `DSL step failed: ${effect.stepName}`,
                                ...(result.error?.details === undefined
                                    ? {}
                                    : {details: structuredClone(result.error.details)}),
                            }),
                        }),
                }), worldAfter);
            }
            return result;
        };

        const recoveryController = createDslDebugController({
            initialMode: 'continue',
            barrierOn: ['unknown', 'compensatable', 'irreversible'],
            barrierResumeMode: 'continue',
        });
        const recoveryDebugPort: DslDebugPort = {
            beforeStatement: () => undefined,
            beforeEffect: (event) => recoveryController.port.beforeEffect?.(event),
        };

        const completion: Promise<RunCheckpointRecoveryOutcome> = (async () => {
            try {
                return await runCheckpointRecovery({
                    checkpoint: selection.checkpoint,
                    runtime: recovery.runtime,
                    failure: failureContext,
                    executeStep,
                    debugPort: recoveryDebugPort,
                    workspaceName: options.context.workspaceName,
                    deps: options.context.deps,
                    attempt: selection.attempt,
                    checkpointMaxAttempts: recovery.checkpointMaxAttempts ?? Number.MAX_SAFE_INTEGER,
                });
            } catch (error) {
                return Object.freeze({
                    active: false as const,
                    stopReason: 'checkpoint_step_failed' as const,
                    runResult: {
                        stepId: failureContext.stepId,
                        ok: false,
                        error: {
                            code: error instanceof Error && 'code' in error
                                ? String((error as {code: unknown}).code)
                                : 'ERR_RECOVERY_FAILED',
                            message: error instanceof Error ? error.message : String(error),
                        },
                    },
                    meta: {checkpointBodyFailure: true, bodyError: error},
                });
            }
        })();

        const driven = await driveRecovery(completion, recoveryController);
        if (driven.kind === 'barrier') {
            pendingRecovery = {
                checkpoint: selection.checkpoint,
                retryOriginal,
                safeToRetryOriginal,
                failurePause: pause,
                failureContinuationId: continuationId,
                controller: recoveryController,
                completion,
                barrierContinuationId: driven.pause.continuationId,
            };
            return Object.freeze({
                status: 'needs_approval' as const,
                checkpointId: selection.checkpoint.id,
                barrier: await exposeRecoveryBarrier(driven.pause),
            });
        }

        return await finalizeRecoveryOutcome(driven.outcome, {
            checkpoint: selection.checkpoint,
            retryOriginal,
            safeToRetryOriginal,
            failureContinuationId: continuationId,
        });
    };

    return {
        waitForPause,
        runRecovery,
        query: (continuationId: string, ir: QueryIR) =>
            requireActive(continuationId).debug.query(ir),
        compute: (
            continuationId: string,
            expr: ComputeExpr,
            scope: ComputeEvalScope = {},
        ) => requireActive(continuationId).debug.compute(expr, scope),
        catalog: (continuationId: string) => buildWorldCatalog(requireActive(continuationId).view),
        program: (continuationId: string, programId?: string) => {
            const current = requireActive(continuationId);
            const targetProgramId = programId ?? current.pause.location.programId;
            const program = programs.get(targetProgramId);
            if (!program) {throw new Error(`DSL debug program is unavailable: ${targetProgramId}`);}
            return program;
        },
        materializeProgram: (programId = 'main') => {
            const program = programs.get(programId);
            if (!program) {throw new Error(`DSL debug program is unavailable: ${programId}`);}
            return materializeDebugProgramSource(program, programPatches.list(programId));
        },
        patches: (continuationId: string, programId?: string) => {
            requireActive(continuationId);
            return programPatches.list(programId);
        },
        history: (continuationId: string, programId?: string) => {
            const current = requireActive(continuationId);
            const targetProgramId = programId ?? current.pause.location.programId;
            const program = programs.get(targetProgramId);
            if (!program) {throw new Error(`DSL debug program is unavailable: ${targetProgramId}`);}
            const currentPath = current.pause.reason === 'statement'
                && current.pause.location.programId === targetProgramId
                ? current.pause.location.path
                : undefined;
            return buildDebugExecutionHistory(
                program,
                statementHistory.list(targetProgramId),
                currentPath,
            );
        },
        auditEffects: () => journal.list(),
        effects: (continuationId: string) => {
            requireActive(continuationId);
            return journal.list();
        },
        explain: (continuationId: string, path: string) => {
            const current = requireActive(continuationId);
            return provenance.explain(current.pause.location.programId, path);
        },
        recompute: (continuationId: string, path: string) => {
            const current = requireActive(continuationId);
            return recomputeDebugValue(
                provenance,
                current.pause.location.programId,
                path,
                current.pause.scope,
                current.debug,
            );
        },
        diff: (continuationId: string, effectSequence: number) => {
            requireActive(continuationId);
            return diffDebugEffect(journal, effectSequence);
        },
        transaction: (continuationId: string) => {
            const current = requireActive(continuationId);
            return requireTransaction().snapshot(current.view, journal.list().length - transactionEffectStartSequence);
        },
        commit,
        savepoint: (continuationId: string, name?: string) => {
            const current = requireActive(continuationId);
            let savepoint: DebugSavepoint;
            if (current.automaticSavepointId) {
                savepoint = requireTransaction().promoteSavepoint(current.automaticSavepointId, name);
                const captured = executionSavepoints.get(savepoint.id);
                if (captured) {
                    executionSavepoints.set(savepoint.id, Object.freeze({
                        ...captured,
                        state: Object.freeze({...captured.state, savepoint}),
                        origin: 'explicit' as const,
                    }));
                } else {
                    captureExecutionSavepoint(current, savepoint, 'explicit');
                }
                active = {...current, automaticSavepointId: undefined};
            } else {
                savepoint = requireTransaction().savepoint(current.view, journal.list().length, name);
                captureExecutionSavepoint(current, savepoint, 'explicit');
            }
            return savepoint;
        },
        executionSavepoint: (continuationId: string, savepointId: string) => {
            requireActive(continuationId);
            const saved = executionSavepoints.get(savepointId);
            return saved ? structuredClone(saved.state) : null;
        },
        transactionDiff: (continuationId: string) => {
            const current = requireActive(continuationId);
            return diffWorldViews(requireTransaction().baseline, current.view);
        },
        rollback,
        rewindPlan,
        rewind,
        refresh,
        patchStatement,
        patchProgram,
        unpatchProgram,
        recomputeEffect,
        crossBarrier,
        advance,
        waitForCompletion: async () => await completion,
    };
};

const normalizeTerminalFailure = (error: unknown) => {
    if (error && typeof error === 'object') {
        const value = error as {code?: unknown; message?: unknown; details?: unknown};
        return Object.freeze({
            code: typeof value.code === 'string' ? value.code : 'ERR_DSL_RUNTIME',
            message: typeof value.message === 'string' ? value.message : 'DSL execution failed',
            ...(value.details === undefined ? {} : {details: structuredClone(value.details)}),
        });
    }
    return Object.freeze({
        code: 'ERR_DSL_RUNTIME',
        message: typeof error === 'string' ? error : 'DSL execution failed',
    });
};
