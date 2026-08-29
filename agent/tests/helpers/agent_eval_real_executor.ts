import type { RunStepsDeps } from '../../src/automation/runner/run_steps';
import type { StepExecutionPort } from '../../src/automation/dsl/runtime';
import { compileDslSource } from '../../src/automation/dsl/runtime';
import { createDslDebugExecutionSession } from '../../src/agent/debug/execution/dsl_session';
import type { PausedDslDebugExecution } from '../../src/agent/debug/execution/contracts';
import type {
    AgentProgram,
    AgentProgramExecutor,
} from '../../src/agent/execution/program/contracts';
import type { AgentProgramEffectSummary } from '../../src/agent/execution/types';
import type { AgentFaultWorld } from '../../src/agent/execution/eval/faults/contracts';
import type { AgentEvalFixtureSpec } from '../../src/agent/execution/eval/world';
import type { AgentEvalRealFixtureTargets } from './agent_eval_real_worldview';
import { createFixtureWorldViewSource, fixtureNodeTargets } from './agent_eval_real_worldview';
import { AgentFaultWorldError } from '../../src/agent/execution/eval/faults/contracts';

const faultErrorCode = (error: unknown): string =>
    error instanceof AgentFaultWorldError
        ? error.code
        : error instanceof Error
        ? error.message
        : String(error);

type ExecutorResult = {
    stepId: string;
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
};

const errorResult = (stepId: string, error: unknown): ExecutorResult => ({
    stepId,
    ok: false,
    error: { code: faultErrorCode(error), message: String(error) },
});

/**
 * Step executor mapping production DSL browser steps onto the fault world
 * port. This is the "browser port" boundary: the fault script armed on the
 * world is what the production runner's DSL steps hit.
 */
export const createFixtureStepPort = (
    world: AgentFaultWorld,
    targets: AgentEvalRealFixtureTargets,
): StepExecutionPort => {
    const keyForNode = (nodeId: string | undefined): string | null => {
        if (!nodeId) {
            return null;
        }
        return targets.keyForNode[nodeId] ?? null;
    };
    return {
        execute: async (step): Promise<ExecutorResult> => {
            const args = step.args as { nodeId?: string; selector?: string; value?: string };
            const key = keyForNode(args.nodeId ?? args.selector);
            if (key === null) {
                return errorResult(
                    step.id,
                    new Error(
                        `fixture has no target for ${step.name} node ${
                            args.nodeId ?? args.selector
                        }`,
                    ),
                );
            }
            try {
                if (step.name === 'browser.fill') {
                    await world.fill(world.field(key), args.value ?? '');
                } else if (step.name === 'browser.click') {
                    await world.click(world.field(key));
                } else {
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {
                            code: 'ERR_UNSUPPORTED',
                            message: `unsupported fixture step: ${step.name}`,
                        },
                    };
                }
                return { stepId: step.id, ok: true, data: {} };
            } catch (error) {
                return errorResult(step.id, error);
            }
        },
    };
};

/**
 * Compensation port for the production rollback/rewind physical strategy.
 * Compensation steps are also routed through the fault world port, so the
 * restore write is observable in the event log with the same revision space as
 * the retained journal.
 */
export const createFixtureCompensationPort = (
    world: AgentFaultWorld,
    targets: AgentEvalRealFixtureTargets,
): { execute(step: { name: string; args: unknown }): Promise<ExecutorResult> } => {
    const port = createFixtureStepPort(world, targets);
    return {
        execute: async (step) => {
            const typed = step as {
                id?: string;
                name: string;
                args: { nodeId?: string; value?: string };
            };
            return port.execute({
                id: typed.id ?? 'compensation',
                name: typed.name,
                args: typed.args ?? {},
            } as never);
        },
    };
};

export type CreateFixtureProgramExecutorOptions = {
    world: AgentFaultWorld;
    spec: AgentEvalFixtureSpec;
};

const emptyCheckpointProvider = {
    getCheckpoint: () => null,
    getCheckpointResolves: () => null,
    listCheckpoints: () => [],
    getCheckpointBody: () => null,
};

const normalizeFailure = (error: unknown): { code: string; message: string } => {
    if (error && typeof error === 'object') {
        const value = error as { code?: unknown; message?: unknown };
        return Object.freeze({
            code: typeof value.code === 'string' ? value.code : 'ERR_DSL_RUNTIME',
            message: typeof value.message === 'string' ? value.message : String(error),
        });
    }
    return Object.freeze({ code: 'ERR_DSL_RUNTIME', message: String(error) });
};

const effectSummaries = (
    session: ReturnType<typeof createDslDebugExecutionSession>,
): readonly AgentProgramEffectSummary[] =>
    session.auditEffects().map((record) =>
        Object.freeze({
            sequence: record.sequence,
            stepName: record.effect.stepName,
            status: record.outcome.status,
            worldBefore: structuredClone(record.worldBefore.revision),
            worldAfter: structuredClone(record.worldAfter.revision),
            ...(record.compensates ? { compensates: record.compensates.effectSequence } : {}),
        }),
    );

/**
 * Production Program-first executor over the fixture world port. It uses the
 * committed DSL debug session (retained transaction, effect journal,
 * compensation planner) exactly as createWorkspaceProgramExecutor does; only
 * the step/compensation ports are the fixture world boundary.
 */
export const createFixtureProgramExecutor = (
    options: CreateFixtureProgramExecutorOptions,
): AgentProgramExecutor => {
    const targets = fixtureNodeTargets(options.spec);
    return async (program: AgentProgram) => {
        compileDslSource(program.source, undefined, undefined);
        const session = createDslDebugExecutionSession({
            source: program.source,
            context: {
                workspaceName: 'agent-eval-real',
                deps: {} as unknown as RunStepsDeps,
                input: structuredClone(program.input),
                checkpointProvider: emptyCheckpointProvider,
                stepExecutionPort: createFixtureStepPort(options.world, targets),
            },
            worldViewSource: createFixtureWorldViewSource(options.world, options.spec),
            compensationPort: createFixtureCompensationPort(options.world, targets),
            debug: {
                initialMode: 'continue',
                breakOnFailure: true,
                barrierOn: [],
            },
        });
        const initial = await Promise.race([
            session.waitForPause().then((pause) => ({ status: 'paused' as const, pause })),
            session.waitForCompletion().then(
                (completed) => ({
                    status: 'completed' as const,
                    output: structuredClone(completed.scope.output),
                }),
                (error) => ({ status: 'failed' as const, failure: normalizeFailure(error) }),
            ),
        ]);
        const effects = effectSummaries(session);
        if (initial.status === 'completed') {
            return {
                summary: Object.freeze({
                    source: program.source,
                    input: structuredClone(program.input),
                    status: 'completed',
                    text: JSON.stringify(initial.output),
                    effects,
                }),
            };
        }
        if (initial.status === 'failed') {
            return {
                summary: Object.freeze({
                    source: program.source,
                    input: structuredClone(program.input),
                    status: 'failed',
                    text: initial.failure.message,
                    error: Object.freeze({
                        code: initial.failure.code,
                        message: initial.failure.message,
                    }),
                    effects,
                }),
            };
        }
        const pause = initial.pause as PausedDslDebugExecution;
        return {
            summary: Object.freeze({
                source: program.source,
                input: structuredClone(program.input),
                status: 'paused',
                effects,
            }),
            debug: Object.freeze({
                session,
                pause,
            }),
        };
    };
};
