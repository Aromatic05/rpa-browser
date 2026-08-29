import crypto from 'node:crypto';
import type { RunStepsDeps, StepResult as TaskStepResult } from '../../runner/run_steps';
import type { BrowserQueryResult, StepResolve, StepResult as ExecutorStepResult, StepUnion } from '../../runner/steps/types';
import {evaluateComputeExpression} from '../../../program/compute/evaluate';
import { runDslCheckpointCall, type DslCheckpointProvider } from '../emit/checkpoint_call';
import { getLogger, type Logger } from '../../../platform/logging/logger';
import { buildClickStep, buildFillStep, buildQueryStep, buildSelectStep, buildSnapshotStep, buildTypeStep } from '../emit/step_builder';
import { DslRuntimeError } from '../../../program/dsl/diagnostics/errors';
import type { DslExpr, DslProgram, DslStmt } from '../../../program/dsl/ast/types';
import { collectDefinitelyAssignedVariables } from '../../../program/dsl/analysis/definite_assignment';
import { createDslTaskRunner } from './task_runner';
import {
    createChildDslScope,
    createDslScope,
    promoteDslVariables,
    setDslValue,
    type DslScope,
} from './scope';
import { resolveDslValue } from './refs';
import { adaptDslQueryResult } from './value_adapter';
import type { DslEntityRulesResolver } from '../link';
import type { DslResolveResolver } from '../link';
import { injectStepResolve } from '../../runner/step_resolve';
import {classifyBrowserOperation} from '../../runner/steps/effects';
import type {
    DslDebugPort,
    DslExecutionFrameSnapshot,
    DslEffectDescriptor,
    DslFailureDescriptor,
    DslLoopFrame,
    DslScopeSnapshot,
    DslStatementLocation,
    DslValueProvenanceSource,
} from '../debug/contracts';
import {snapshotDslScope} from '../debug/snapshot';
import {collectDslExpressionDependencies, collectDslExpressionsDependencies} from '../debug/provenance';
import type {DslSourceMap} from '../../../program/dsl/parser/source_map';
import type {EffectSemantics} from '../../../program/effects/contracts';
import {UNKNOWN_EFFECT_SEMANTICS} from '../../../program/effects/declaration';
import {compileBrowserQuery} from '../../../program/query/compile';

export type RunDslContext = {
    workspaceName: string;
    deps: RunStepsDeps;
    input?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    checkpointProvider?: DslCheckpointProvider;
    logger?: Logger;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
    stepResolves?: Record<string, StepResolve>;
    stepExecutionPort?: StepExecutionPort;
    checkpointCallStack?: string[];
    debugPort?: DslDebugPort;
    debugProgramId?: string;
    debugSourceMap?: DslSourceMap;
    debugFrames?: readonly DslExecutionFrameSnapshot[];
    resume?: Readonly<{
        scope: DslScopeSnapshot;
        startIndex?: number;
        location?: DslStatementLocation;
        frames?: readonly DslExecutionFrameSnapshot[];
    }>;
};

export type ExpectedWorldRevision = Readonly<{
    pageEpoch: string;
    captureRevision: number;
}>;

export type ExpectedWorldPrecondition = Readonly<{
    kind: 'expected-world';
    revision: ExpectedWorldRevision;
}>;

export type StepExecutionPort = {
    execute(step: StepUnion, precondition?: ExpectedWorldPrecondition): Promise<ExecutorStepResult>;
};

export type RunDslResult = {
    scope: DslScope;
};

export const runDsl = async (program: DslProgram, ctx: RunDslContext): Promise<RunDslResult> => {
    const scope = ctx.resume ? restoreDslScope(ctx.resume.scope) : createDslScope(ctx.input, ctx.failure);
    const startIndex = ctx.resume?.startIndex ?? 0;
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > program.body.length) {
        throw new DslRuntimeError(`invalid DSL resume index: ${startIndex}`, 'ERR_DSL_BAD_RESUME');
    }
    const taskRunner = ctx.stepExecutionPort ? undefined : createDslTaskRunner({
        workspaceName: ctx.workspaceName, deps: ctx.deps, stopOnError: true,
    });
    const rawPort: StepExecutionPort = ctx.stepExecutionPort || {execute: async (step) => toExecutorStepResult(await taskRunner!.runStep(step))};
    const port: StepExecutionPort = {
        execute: async (step, precondition) => {
            const runtimeStep = injectStepResolve(step, ctx.stepResolves);
            if (!runtimeStep.ok) {return {stepId: step.id, ok: false, error: runtimeStep.error};}
            return await rawPort.execute(runtimeStep.step, precondition);
        },
    };
    const logger = ctx.logger || getLogger('dsl');

    await taskRunner?.start();
    try {
        if (ctx.resume?.location && ctx.resume.frames) {
            await resumeDslExecution(program, scope, ctx, port, logger, {
                location: ctx.resume.location,
                frames: ctx.resume.frames,
            });
        } else {
            await executeStatements(program.body, scope, ctx, port, logger, {
                blockPath: 'body',
                loops: [],
                frames: ctx.debugFrames ?? [],
                startIndex,
            });
        }
    } finally {
        await taskRunner?.close();
    }

    return { scope };
};

const executeStatements = async (
    body: DslStmt[],
    scope: DslScope,
    ctx: RunDslContext,
    port: StepExecutionPort,
    logger: Logger,
    execution: {
        blockPath: string;
        loops: readonly DslLoopFrame[];
        frames: readonly DslExecutionFrameSnapshot[];
        startIndex?: number;
    },
): Promise<void> => {
    for (let index = execution.startIndex ?? 0; index < body.length; index += 1) {
        const stmt = body[index];
        const path = `${execution.blockPath}.${index}`;
        const originalLocation = createDslStatementLocation(ctx, path, stmt.kind, execution.loops);
        const resolution = await ctx.debugPort?.beforeStatement({
            location: originalLocation,
            scope: snapshotDslScope(scope),
            statement: structuredClone(stmt),
            frames: execution.frames.map((frame) => structuredClone(frame)),
        });
        const runtimeStmt = resolution?.statement ?? stmt;
        const location: DslStatementLocation = runtimeStmt.kind === originalLocation.kind
            ? originalLocation
            : Object.freeze({...originalLocation, kind: runtimeStmt.kind});
        safeLog(logger, 'debug', 'dsl.stmt.start', { index, kind: runtimeStmt.kind });
        try {
            await executeStmt(runtimeStmt, scope, ctx, port, logger, index, location, execution.frames);
            await ctx.debugPort?.afterStatement?.(Object.freeze({
                location,
                scope: snapshotDslScope(scope),
                statement: structuredClone(runtimeStmt),
            }));
            safeLog(logger, 'debug', 'dsl.stmt.end', { index, kind: runtimeStmt.kind });
        } catch (error) {
            safeLog(logger, 'error', 'dsl.error', { stmtIndex: index, error: toErrorLog(error) });
            throw error;
        }
    }
};

const executeStmt = async (
    stmt: DslStmt,
    scope: DslScope,
    ctx: RunDslContext,
    port: StepExecutionPort,
    logger: Logger,
    stmtIndex: number,
    location: DslStatementLocation,
    frames: readonly DslExecutionFrameSnapshot[],
): Promise<void> => {
    const execution = {scope, ctx, port, logger, stmtIndex, location, frames};
    switch (stmt.kind) {
        case 'let': {
            if (stmt.expr.kind === 'query') {
                const step = buildQueryStep(stmt.expr, (ref) => resolveDslValue(ref, scope));
                const compiled = compileBrowserQuery(step.args);
                const result = await emitStepAndWait(step, execution);
                const queryResult = result as BrowserQueryResult;
                const value = adaptDslQueryResult(queryResult);
                const target = `vars.${stmt.name}`;
                setDslValue(scope, target, value);
                await notifyValue(ctx, target, location, Object.freeze({
                    kind: 'query' as const,
                    expression: structuredClone(stmt.expr),
                    ...(compiled.ok ? {query: compiled.ir} : {}),
                    stepId: step.id,
                    dependencies: collectDslExpressionDependencies(stmt.expr),
                    ...queryObservedAt(queryResult),
                }));
                safeLog(logger, 'debug', 'dsl.scope.write', { key: target, valuePreview: previewValue(value) });
                return;
            }
            if (stmt.expr.kind === 'querySugar') {
                throw new DslRuntimeError(
                    'querySugar must be expanded before runtime',
                    'ERR_DSL_NOT_NORMALIZED',
                );
            }
            const value = evaluatePureDslExpr(stmt.expr, scope);
            const target = `vars.${stmt.name}`;
            setDslValue(scope, target, value);
            await notifyValue(ctx, target, location, pureExpressionProvenance(stmt.expr));
            safeLog(logger, 'debug', 'dsl.scope.write', { key: target, valuePreview: previewValue(value) });
            return;
        }
        case 'output': {
            const value = evaluatePureDslExpr(stmt.expr, scope);
            const target = `output.${stmt.name}`;
            setDslValue(scope, target, value);
            await notifyValue(ctx, target, location, pureExpressionProvenance(stmt.expr));
            return;
        }
        case 'ensure': {
            const actual = Boolean(evaluatePureDslExpr(stmt.condition, scope));
            if (actual) {return;}
            const failure: DslFailureDescriptor = Object.freeze({
                kind: 'invariant' as const,
                code: 'ERR_DSL_ENSURE_FAILED' as const,
                message: 'DSL ensure failed',
                details: Object.freeze({
                    expected: true as const,
                    actual: false as const,
                    condition: structuredClone(stmt.condition),
                }),
            });
            await ctx.debugPort?.onFailure?.({
                location,
                scope: snapshotDslScope(scope),
                failure,
            });
            throw new DslRuntimeError(failure.message, failure.code, failure.details);
        }
        case 'act': {
            if (stmt.action === 'wait') {
                await sleep(stmt.durationMs || 0);
                return;
            }
            if (stmt.action === 'snapshot') {
                await emitStepAndWait(buildSnapshotStep(), execution);
                return;
            }
            if (!stmt.target) {
                throw new DslRuntimeError(`DSL action ${stmt.action} requires target`, 'ERR_DSL_BAD_ACT_ARGS');
            }
            const target = resolveDslValue(stmt.target, scope);
            const precondition = targetObservedPrecondition(target);
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target, stmt.profileName), execution, undefined, undefined, precondition);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step =
                stmt.action === 'fill'
                    ? buildFillStep(target, value, stmt.profileName)
                    : stmt.action === 'type'
                      ? buildTypeStep(target, value, stmt.profileName)
                      : buildSelectStep(target, value, stmt.profileName);
            await emitStepAndWait(step, execution, undefined, undefined, precondition);
            return;
        }
        case 'linked_entity_act': {
            const queryStep = buildQueryStep(stmt.targetQuery, (ref) => resolveDslValue(ref, scope));
            const queryResult = await emitStepAndWait(queryStep, execution);
            const compiledTarget = compileBrowserQuery(queryStep.args);
            if (!compiledTarget.ok) {
                throw new DslRuntimeError(compiledTarget.error.message, compiledTarget.error.code);
            }
            const typedQueryResult = queryResult as BrowserQueryResult;
            const observedAt = queryObservedAt(typedQueryResult).observedAt;
            const logicalTarget = Object.freeze({
                kind: 'query' as const,
                query: compiledTarget.ir,
                ...(observedAt ? {resolvedAt: observedAt} : {}),
            });
            const target = adaptDslQueryResult(
                typedQueryResult,
            );
            const profileName = stmt.targetQuery.profileName;
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target, profileName), execution, stmt.effect, logicalTarget);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step = stmt.action === 'fill'
                ? buildFillStep(target, value, profileName)
                : stmt.action === 'type'
                    ? buildTypeStep(target, value, profileName)
                    : buildSelectStep(target, value, profileName);
            await emitStepAndWait(step, execution, stmt.effect, logicalTarget);
            return;
        }
        case 'resolve_act': {
            if (!stmt.resolveId) {
                throw new DslRuntimeError('resolve action must be linked before runtime', 'ERR_DSL_NOT_LINKED');
            }
            const target = {resolveId: stmt.resolveId};
            safeLog(logger, 'debug', 'dsl.resolve.action', {
                alias: stmt.target.alias,
                bundleName: stmt.target.bundleName,
                symbol: stmt.target.symbol,
                resolveId: stmt.resolveId,
            });
            if (stmt.action === 'click') {
                await emitStepAndWait(buildClickStep(target), execution);
                return;
            }
            const value = resolveDslValue(stmt.value, scope);
            const step = stmt.action === 'fill'
                ? buildFillStep(target, value)
                : stmt.action === 'type'
                    ? buildTypeStep(target, value)
                    : buildSelectStep(target, value);
            await emitStepAndWait(step, execution);
            return;
        }
        case 'form_act':
        case 'table_act': {
            throw new DslRuntimeError(`${stmt.kind} must be expanded before runtime`, 'ERR_DSL_NOT_NORMALIZED');
        }
        case 'entity_act': {
            throw new DslRuntimeError('entity_act must be linked before runtime', 'ERR_DSL_NOT_LINKED');
        }
        case 'checkpoint': {
            const checkpointFrame: DslExecutionFrameSnapshot = Object.freeze({
                kind: 'checkpoint' as const,
                checkpointId: stmt.id,
                invocationId: crypto.randomUUID(),
                statementPath: location.path,
                parentBlockPath: location.path.slice(0, location.path.lastIndexOf('.')),
                statementIndex: stmtIndex,
                parentProgramId: location.programId,
                parentScope: snapshotDslScope(scope),
                ...(stmt.bind ? {bind: stmt.bind} : {}),
                dependencies: Object.freeze(
                    collectDslExpressionsDependencies(Object.values(stmt.input ?? {})),
                ),
                loops: Object.freeze(location.loops.map((loop) => Object.freeze({...loop}))),
                callStack: Object.freeze([...location.callStack]),
            });
            const output = await runDslCheckpointCall({
                stmt,
                scope,
                checkpointProvider: ctx.checkpointProvider,
                executeStep: (step) => port.execute(step),
                beforeEffect: async (step) => {
                    await pauseBeforeEffect(step, execution);
                },
                afterEffect: async (step, result) => {
                    await notifyAfterEffect(describeEffect(step), result, execution);
                },
                onStepFailure: async (step, result) => {
                    await pauseOnFailure(step, result, execution);
                },
                workspaceName: ctx.workspaceName,
                deps: ctx.deps,
                entityRulesResolver: ctx.entityRulesResolver,
                resolveResolver: ctx.resolveResolver,
                callStack: ctx.checkpointCallStack,
                debugPort: ctx.debugPort,
                debugFrames: [...frames, checkpointFrame],
            });
            if (stmt.bind) {
                const target = `vars.${stmt.bind}`;
                setDslValue(scope, target, output);
                await notifyValue(ctx, target, location, Object.freeze({
                    kind: 'checkpoint' as const,
                    checkpointId: stmt.id,
                    dependencies: collectDslExpressionsDependencies(Object.values(stmt.input ?? {})),
                }));
            }
            return;
        }
        case 'if': {
            const condition = Boolean(evaluatePureDslExpr(stmt.condition, scope));
            const branch = condition ? stmt.then : stmt.else || [];
            const branchName = condition ? 'then' : 'else';
            const before = new Set(Object.keys(scope.vars));
            const child = createChildDslScope(scope);
            const frame: DslExecutionFrameSnapshot = Object.freeze({
                kind: 'if' as const,
                statementPath: location.path,
                parentBlockPath: location.path.slice(0, location.path.lastIndexOf('.')),
                statementIndex: stmtIndex,
                branch: branchName,
                parentScope: snapshotDslScope(scope),
                beforeVars: Object.freeze([...before]),
                loops: Object.freeze(location.loops.map((loop) => Object.freeze({...loop}))),
            });
            await executeStatements(branch, child, ctx, port, logger, {
                blockPath: `${location.path}.${branchName}`,
                loops: location.loops,
                frames: [...execution.frames, frame],
            });
            const after = collectDefinitelyAssignedVariables([stmt], before);
            promoteDslVariables(scope, child, [...after].filter((name) => !before.has(name)));
            return;
        }
        case 'for': {
            const iterable = evaluatePureDslExpr(stmt.iterable, scope);
            if (!Array.isArray(iterable)) {
                throw new DslRuntimeError('DSL for iterable must resolve to an array', 'ERR_DSL_BAD_ITERABLE');
            }
            await executeForIterations({
                statement: stmt,
                parentScope: scope,
                items: iterable,
                startIteration: 0,
                ctx,
                port,
                logger,
                statementIndex: stmtIndex,
                location,
                frames: execution.frames,
            });
            return;
        }
    }
};

const createDslStatementLocation = (
    ctx: RunDslContext,
    path: string,
    kind: DslStmt['kind'],
    loops: readonly DslLoopFrame[],
): DslStatementLocation => {
    const source = ctx.debugSourceMap?.[path];
    return Object.freeze({
        programId: ctx.debugProgramId ?? 'main',
        path,
        kind,
        loops: Object.freeze(loops.map((loop) => Object.freeze({...loop}))),
        ...(source ? {source} : {}),
        callStack: Object.freeze([...(ctx.checkpointCallStack ?? [])]),
    });
};

const executeForIterations = async (input: Readonly<{
    statement: Extract<DslStmt, {kind: 'for'}>;
    parentScope: DslScope;
    items: readonly unknown[];
    startIteration: number;
    ctx: RunDslContext;
    port: StepExecutionPort;
    logger: Logger;
    statementIndex: number;
    location: DslStatementLocation;
    frames: readonly DslExecutionFrameSnapshot[];
}>): Promise<void> => {
    const {
        statement,
        parentScope,
        items,
        startIteration,
        ctx,
        port,
        logger,
        statementIndex,
        location,
        frames,
    } = input;
    for (let iteration = startIteration; iteration < items.length; iteration += 1) {
        const item = items[iteration];
        const child = createChildDslScope(parentScope);
        const target = `vars.${statement.item}`;
        setDslValue(child, target, item);
        await notifyValue(ctx, target, location, Object.freeze({
            kind: 'loop' as const,
            expression: structuredClone(statement.iterable),
            iteration,
            dependencies: collectDslExpressionDependencies(statement.iterable),
        }));
        safeLog(logger, 'debug', 'dsl.scope.write', {key: target, valuePreview: previewValue(item)});
        const frame: DslExecutionFrameSnapshot = Object.freeze({
            kind: 'for' as const,
            statementPath: location.path,
            parentBlockPath: location.path.slice(0, location.path.lastIndexOf('.')),
            statementIndex,
            parentScope: snapshotDslScope(parentScope),
            item: statement.item,
            items: Object.freeze(structuredClone(items)),
            iteration,
            loops: Object.freeze(location.loops.map((loop) => Object.freeze({...loop}))),
        });
        await executeStatements(statement.body, child, ctx, port, logger, {
            blockPath: `${location.path}.body`,
            loops: [...location.loops, {path: location.path, iteration}],
            frames: [...frames, frame],
        });
    }
};

const executionFrameBlockPath = (frame: DslExecutionFrameSnapshot): string => {
    if (frame.kind === 'if') {return `${frame.statementPath}.${frame.branch}`;}
    if (frame.kind === 'for') {return `${frame.statementPath}.body`;}
    throw new DslRuntimeError(
        `checkpoint frame requires cross-program resume: ${frame.statementPath}`,
        'ERR_DSL_BAD_RESUME',
    );
};

const resumeDslExecution = async (
    program: DslProgram,
    scope: DslScope,
    ctx: RunDslContext,
    port: StepExecutionPort,
    logger: Logger,
    resume: Readonly<{
        location: DslStatementLocation;
        frames: readonly DslExecutionFrameSnapshot[];
    }>,
): Promise<void> => {
    const frames = resume.frames.map((frame) => structuredClone(frame));
    const currentFrame = frames.at(-1);
    const blockPath = currentFrame
        ? executionFrameBlockPath(currentFrame)
        : 'body';
    const index = parseResumeStatementIndex(resume.location.path, blockPath);
    let childScope = scope;

    await executeStatements(resolveDslBlock(program, blockPath), childScope, ctx, port, logger, {
        blockPath,
        loops: resume.location.loops,
        frames,
        startIndex: index,
    });

    for (let depth = frames.length - 1; depth >= 0; depth -= 1) {
        const frame = frames[depth];
        const parentScope = restoreDslScope(frame.parentScope);
        parentScope.output = childScope.output;
        const parentBody = resolveDslBlock(program, frame.parentBlockPath);
        const statement = parentBody.at(frame.statementIndex);
        const outerFrames = frames.slice(0, depth);
        if (frame.kind === 'if') {
            if (statement?.kind !== 'if') {
                throw new DslRuntimeError(
                    `invalid DSL resume frame: ${frame.statementPath}`,
                    'ERR_DSL_BAD_RESUME',
                );
            }
            const before = new Set(frame.beforeVars);
            const after = collectDefinitelyAssignedVariables([statement], before);
            promoteDslVariables(
                parentScope,
                childScope,
                [...after].filter((name) => !before.has(name)),
            );
        } else if (frame.kind === 'for') {
            if (statement?.kind !== 'for') {
                throw new DslRuntimeError(
                    `invalid DSL resume frame: ${frame.statementPath}`,
                    'ERR_DSL_BAD_RESUME',
                );
            }
            const location = createDslStatementLocation(
                ctx,
                frame.statementPath,
                statement.kind,
                frame.loops,
            );
            await executeForIterations({
                statement,
                parentScope,
                items: frame.items,
                startIteration: frame.iteration + 1,
                ctx,
                port,
                logger,
                statementIndex: frame.statementIndex,
                location,
                frames: outerFrames,
            });
        } else {
            throw new DslRuntimeError(
                `checkpoint frame requires cross-program resume: ${frame.statementPath}`,
                'ERR_DSL_BAD_RESUME',
            );
        }
        childScope = parentScope;
        await executeStatements(parentBody, childScope, ctx, port, logger, {
            blockPath: frame.parentBlockPath,
            loops: frame.loops,
            frames: outerFrames,
            startIndex: frame.statementIndex + 1,
        });
    }
};

const parseResumeStatementIndex = (path: string, blockPath: string): number => {
    const prefix = `${blockPath}.`;
    if (!path.startsWith(prefix)) {
        throw new DslRuntimeError(`invalid DSL resume path: ${path}`, 'ERR_DSL_BAD_RESUME');
    }
    const suffix = path.slice(prefix.length);
    if (!/^\d+$/u.test(suffix)) {
        throw new DslRuntimeError(`invalid DSL resume path: ${path}`, 'ERR_DSL_BAD_RESUME');
    }
    return Number(suffix);
};

const resolveDslBlock = (program: DslProgram, blockPath: string): DslStmt[] => {
    if (blockPath === 'body') {return program.body;}
    const tokens = blockPath.split('.');
    if (tokens.shift() !== 'body') {
        throw new DslRuntimeError(`invalid DSL block path: ${blockPath}`, 'ERR_DSL_BAD_RESUME');
    }
    let body = program.body;
    while (tokens.length > 0) {
        const indexToken = tokens.shift();
        const branch = tokens.shift();
        if (!indexToken
            || !/^\d+$/u.test(indexToken)
            || (branch !== 'then' && branch !== 'else' && branch !== 'body')) {
            throw new DslRuntimeError(`unsupported DSL block path: ${blockPath}`, 'ERR_DSL_BAD_RESUME');
        }
        const statement = body.at(Number(indexToken));
        if (branch === 'body') {
            if (statement?.kind !== 'for') {
                throw new DslRuntimeError(`invalid DSL block path: ${blockPath}`, 'ERR_DSL_BAD_RESUME');
            }
            body = statement.body;
            continue;
        }
        if (statement?.kind !== 'if') {
            throw new DslRuntimeError(`invalid DSL block path: ${blockPath}`, 'ERR_DSL_BAD_RESUME');
        }
        body = branch === 'then' ? statement.then : statement.else || [];
    }
    return body;
};

const emitStepAndWait = async (
    step: StepUnion,
    execution: {
        scope: DslScope;
        ctx: RunDslContext;
        port: StepExecutionPort;
        logger: Logger;
        stmtIndex: number;
        location: DslStatementLocation;
    },
    semantics?: EffectSemantics,
    logicalTarget?: DslEffectDescriptor['logicalTarget'],
    precondition?: ExpectedWorldPrecondition,
): Promise<unknown> => {
    const {scope, ctx, port, logger, stmtIndex, location} = execution;
    safeLog(logger, 'debug', 'dsl.step.emit', {
        stmtIndex,
        stepId: step.id,
        stepName: step.name,
    });
    const effect = await pauseBeforeEffect(step, {scope, ctx, location}, semantics, logicalTarget);
    const runtimeStep = effect ? applyEffectResolution(step, effect) : step;
    const resolvedAt = effect?.logicalTarget?.resolvedAt;
    const expected = resolvedAt
        ? Object.freeze({kind: 'expected-world' as const, revision: resolvedAt})
        : precondition;
    const result = await port.execute(runtimeStep, expected);
    safeLog(logger, 'debug', 'dsl.step.result', {
        stmtIndex,
        stepId: runtimeStep.id,
        ok: result.ok,
    });
    if (effect) {await notifyAfterEffect(effect, result, {ctx, location});}
    if (!result.ok) {
        const failure = await pauseOnFailure(runtimeStep, result, {scope, ctx, location});
        throw new DslRuntimeError(
            failure.message,
            failure.code,
            failure.details,
        );
    }
    return result.data;
};

const pauseOnFailure = async (
    step: StepUnion,
    result: ExecutorStepResult,
    execution: {
        scope: DslScope;
        ctx: RunDslContext;
        location: DslStatementLocation;
    },
): Promise<DslFailureDescriptor> => {
    const failure: DslFailureDescriptor = Object.freeze({
        kind: 'step' as const,
        stepId: step.id,
        stepName: step.name,
        classification: classifyBrowserOperation(step.name, step.args),
        args: structuredClone(step.args),
        code: result.error?.code || 'ERR_DSL_STEP_FAILED',
        message: result.error?.message || `DSL step failed: ${step.name}`,
        ...(result.error?.details === undefined
            ? {}
            : {details: structuredClone(result.error.details)}),
    });
    await execution.ctx.debugPort?.onFailure?.({
        location: execution.location,
        scope: snapshotDslScope(execution.scope),
        failure,
    });
    return failure;
};

const evaluatePureDslExpr = (expr: DslExpr, scope: DslScope): unknown => {
    if (expr.kind === 'compute') {
        return evaluateComputeExpression(expr.expr, {
            input: scope.input,
            vars: scope.vars,
            local: scope.vars,
            output: scope.output,
            ...(scope.failure ? {failure: scope.failure} : {}),
        });
    }
    if (expr.kind === 'ref') {return resolveDslValue(expr, scope);}
    throw new DslRuntimeError(`DSL expression ${expr.kind} is not a pure runtime expression`, 'ERR_DSL_NOT_NORMALIZED');
};

const pureExpressionProvenance = (expr: DslExpr): DslValueProvenanceSource => {
    if (expr.kind === 'compute') {
        return Object.freeze({
            kind: 'compute' as const,
            expression: structuredClone(expr),
            dependencies: collectDslExpressionDependencies(expr),
        });
    }
    if (expr.kind === 'ref') {
        return Object.freeze({
            kind: 'ref' as const,
            ref: expr.ref,
            dependencies: Object.freeze([expr.ref]),
        });
    }
    throw new DslRuntimeError(`DSL expression ${expr.kind} cannot produce pure value provenance`, 'ERR_DSL_NOT_NORMALIZED');
};

export const observedRevisionFromMeta = (
    meta: unknown,
): Readonly<{pageEpoch: string; captureRevision: number}> | undefined => {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {return undefined;}
    const pageEpoch = (meta as Record<string, unknown>).pageEpoch;
    const captureRevision = (meta as Record<string, unknown>).captureRevision;
    return typeof pageEpoch === 'string' && typeof captureRevision === 'number'
        ? Object.freeze({pageEpoch, captureRevision})
        : undefined;
};

const targetObservedPrecondition = (target: unknown): ExpectedWorldPrecondition | undefined => {
    if (!target || typeof target !== 'object') {return undefined;}
    const observedAt = observedRevisionFromMeta((target as Record<string, unknown>).meta);
    return observedAt
        ? Object.freeze({kind: 'expected-world' as const, revision: observedAt})
        : undefined;
};

const queryObservedAt = (
    result: BrowserQueryResult,
): {observedAt?: Readonly<{pageEpoch: string; captureRevision: number}>} => {
    const observedAt = observedRevisionFromMeta(result.meta);
    return observedAt ? {observedAt} : {};
};

const notifyValue = async (
    ctx: RunDslContext,
    target: string,
    location: DslStatementLocation,
    source: DslValueProvenanceSource,
): Promise<void> => {
    await ctx.debugPort?.onValue?.(Object.freeze({target, location, source}));
};

const pauseBeforeEffect = async (
    step: StepUnion,
    execution: {
        scope: DslScope;
        ctx: RunDslContext;
        location: DslStatementLocation;
    },
    semantics?: EffectSemantics,
    logicalTarget?: DslEffectDescriptor['logicalTarget'],
): Promise<DslEffectDescriptor | undefined> => {
    if (classifyBrowserOperation(step.name, step.args) !== 'effect') {return undefined;}
    const effect = describeEffect(step, semantics, logicalTarget);
    const resolution = await execution.ctx.debugPort?.beforeEffect?.({
        location: execution.location,
        scope: snapshotDslScope(execution.scope),
        effect,
    });
    return resolution?.effect ?? effect;
};

const notifyAfterEffect = async (
    effect: DslEffectDescriptor,
    result: ExecutorStepResult,
    execution: {
        ctx: RunDslContext;
        location: DslStatementLocation;
    },
): Promise<void> => {
    await execution.ctx.debugPort?.afterEffect?.({
        location: execution.location,
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
    });
};

const describeEffect = (
    step: StepUnion,
    semantics?: EffectSemantics,
    logicalTarget?: DslEffectDescriptor['logicalTarget'],
): DslEffectDescriptor => Object.freeze({
    stepId: step.id,
    stepName: step.name,
    args: structuredClone(step.args),
    semantics: semantics ?? UNKNOWN_EFFECT_SEMANTICS,
    ...(logicalTarget ? {logicalTarget} : {}),
});

const applyEffectResolution = (step: StepUnion, effect: DslEffectDescriptor): StepUnion => {
    if (effect.stepId !== step.id || effect.stepName !== step.name) {
        throw new DslRuntimeError('debugger effect resolution changed step identity', 'ERR_DSL_DEBUG_EFFECT_IDENTITY');
    }
    return {...step, args: structuredClone(effect.args)} as StepUnion;
};

const toExecutorStepResult = (result: TaskStepResult): ExecutorStepResult => {
    return {
        stepId: result.stepId,
        ok: result.ok,
        data: result.data,
        error: result.error,
    };
};

const sleep = async (durationMs: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
};

const previewValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
        return {type: 'string', length: value.length};
    }
    if (value === null || value === undefined) {
        return {type: value === null ? 'null' : 'undefined'};
    }
    if (typeof value !== 'object') {
        return {type: typeof value};
    }
    return {
        type: Array.isArray(value) ? 'array' : 'object',
        ...(Array.isArray(value) ? {length: value.length} : {keys: Object.keys(value)}),
    };
};

const toErrorLog = (error: unknown): unknown => {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
        };
    }
    return error;
};

const safeLog = (logger: Logger, level: 'debug' | 'error', event: string, payload: Record<string, unknown>): void => {
    try {
        if (level === 'debug') {
            logger.debug(event, payload);
            return;
        }
        logger.error(event, payload);
    } catch {
        // Logging must never affect DSL execution.
    }
};

const restoreDslScope = (snapshot: DslScopeSnapshot): DslScope => ({
    input: structuredClone(snapshot.input),
    ...(snapshot.failure ? {failure: Object.freeze(structuredClone(snapshot.failure))} : {}),
    vars: structuredClone(snapshot.vars),
    output: structuredClone(snapshot.output),
});
