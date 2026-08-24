import {
    createDslDebugController,
    type CreateDslDebugControllerOptions,
} from '../../../automation/dsl/debug/controller';
import type {DslDebugPort, DslEffectDescriptor, PausedDslExecution} from '../../../automation/dsl/debug/contracts';
import {DslDebugAbortError} from '../../../automation/dsl/debug/errors';
import {
    runDslSource,
    type RunDslContext,
    type RunDslSourceResult,
} from '../../../automation/dsl/runtime';
import type {ComputeEvalScope} from '../../../program/compute/evaluate';
import type {ComputeExpr} from '../../../program/compute/types';
import type {QueryIR} from '../../../program/query/contracts';
import type {WorldView, WorldViewDescriptor, WorldViewSource} from '../../worldview/contracts';
import {describeWorldView} from '../../worldview/descriptor';
import {buildWorldCatalog} from '../../worldview/catalog';
import {diffWorldViews} from '../../worldview/diff';
import {isSameWorldView} from '../../worldview/revision';
import {diffDebugEffect} from '../effects/diff';
import {createDebugEffectJournal} from '../effects/journal';
import {createDebugQuerySession} from '../query/session';
import type {DebugQuerySession} from '../query/contracts';
import {createDebugValueProvenanceStore} from '../provenance/store';
import {recomputeDebugValue} from '../provenance/recompute';
import {buildDebugProgramView, type DebugProgramView} from '../program/view';
import {createDebugStatementHistoryStore} from '../history/store';
import {buildDebugExecutionHistory} from '../history/view';
import {compileStatementPatch} from './patch_statement';
import type {DebugCompensationPort} from '../transaction/compensation/contracts';
import {executePhysicalCompensations} from '../transaction/compensation/executor';
import {createDebugTransaction} from '../transaction/state';
import type {
    DebugRollbackOptions,
    DebugRollbackResult,
    DebugTransaction,
} from '../transaction/contracts';
import type {
    DslDebugAdvanceResult,
    DslDebugExecutionSession,
    DslDebugRecomputeEffectResult,
    PausedDslDebugExecution,
} from './contracts';
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
};

export const createDslDebugExecutionSession = (
    options: CreateDslDebugExecutionSessionOptions,
): DslDebugExecutionSession => {
    const controller = createDslDebugController(options.debug);
    const journal = createDebugEffectJournal();
    const provenance = createDebugValueProvenanceStore();
    const statementHistory = createDebugStatementHistoryStore();
    const programs = new Map<string, DebugProgramView>();
    const pendingEffectOverrides = new Map<string, DslEffectDescriptor>();
    let transaction: DebugTransaction | null = null;
    const ensureTransaction = async (): Promise<DebugTransaction> => {
        transaction ??= createDebugTransaction(await options.worldViewSource.pin());
        return transaction;
    };
    const requireTransaction = (): DebugTransaction => {
        if (!transaction) {throw new Error('DSL debug transaction is not initialized');}
        return transaction;
    };
    const debugPort: DslDebugPort = {
        beforeStatement: async (event) => {
            await ensureTransaction();
            return await controller.port.beforeStatement(event);
        },
        afterStatement: (event) => {statementHistory.record(event);},
        beforeEffect: async (event) => {
            await ensureTransaction();
            pendingEffectOverrides.delete(event.effect.stepId);
            await controller.port.beforeEffect?.(event);
            const effect = pendingEffectOverrides.get(event.effect.stepId) ?? event.effect;
            pendingEffectOverrides.delete(event.effect.stepId);
            journal.begin(Object.freeze({...event, effect}), await options.worldViewSource.pin());
            return effect === event.effect ? undefined : Object.freeze({effect});
        },
        afterEffect: async (event) => {
            journal.finish(event, await options.worldViewSource.pin());
            await controller.port.afterEffect?.(event);
        },
        onFailure: controller.port.onFailure,
        onValue: (event) => {provenance.record(event);},
        onProgram: (event) => {programs.set(event.programId, buildDebugProgramView(event));},
    };
    const completion: Promise<RunDslSourceResult> = runDslSource(options.source, {
        ...options.context,
        debugPort,
    });
    let active: ActivePause | null = null;

    const requireActive = (continuationId: string): ActivePause => {
        if (active?.pause.continuationId !== continuationId) {
            throw new Error(`DSL debug continuation is not active: ${continuationId}`);
        }
        return active;
    };

    const exposePause = (value: ActivePause): PausedDslDebugExecution => {
        const {pause, debug} = value;
        const base = {
            continuationId: pause.continuationId,
            reason: pause.reason,
            location: pause.location,
            scope: pause.scope,
            world: debug.world,
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
        if (mode === 'abort') {controller.abort(continuationId); return;}
        if (mode === 'step') {controller.step(continuationId); return;}
        controller.continue(continuationId);
    };

    const waitForPause = async (): Promise<PausedDslDebugExecution> => {
        if (active) {throw new Error('DSL debug execution is already paused');}
        const pause = await controller.waitForPause();
        const view = await options.worldViewSource.pin();
        const debug = createDebugQuerySession(view);
        const effectResolvedAt = (pause.reason === 'effect' || pause.reason === 'barrier')
            && pause.effect.logicalTarget
            ? Object.freeze({
                ...debug.world,
                revision: pause.effect.logicalTarget.resolvedAt ?? debug.world.revision,
            })
            : undefined;
        active = {pause, view, debug, ...(effectResolvedAt ? {effectResolvedAt} : {})};
        return exposePause(active);
    };

    const refresh = async (continuationId: string): Promise<PausedDslDebugExecution> => {
        const current = requireActive(continuationId);
        const view = await options.worldViewSource.pin();
        active = {
            pause: current.pause,
            view,
            debug: createDebugQuerySession(view),
            ...(current.effectResolvedAt ? {effectResolvedAt: current.effectResolvedAt} : {}),
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

    return {
        waitForPause,
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
            return requireTransaction().snapshot(current.view, journal.list().length);
        },
        savepoint: (continuationId: string, name?: string) => {
            const current = requireActive(continuationId);
            return requireTransaction().savepoint(current.view, journal.list().length, name);
        },
        transactionDiff: (continuationId: string) => {
            const current = requireActive(continuationId);
            return diffWorldViews(requireTransaction().baseline, current.view);
        },
        rollback,
        refresh,
        patchStatement,
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
