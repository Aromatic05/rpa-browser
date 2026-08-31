import type {
    AgentProgramEffectSummary,
    AgentRunRequest,
    AgentRunResult,
    AgentRunner,
} from '../../src/agent/execution/types';
import type {AgentToolTrace} from '../../src/agent/trace/collector';
import type {AgentEvalWorld} from '../../src/agent/execution/eval/world';
import {AGENT_EVAL_WORLD_ERROR_CODES, AgentEvalWorldError} from '../../src/agent/execution/eval/world';
import type {AgentEvalPlanAction, AgentEvalPlan} from '../../src/agent/execution/eval/benchmark';

export const AGENT_EVAL_SIMULATED_PROVIDER = 'agent-eval-fixture';
export const AGENT_EVAL_SIMULATED_MODEL = 'policy-simulated';

type WorldRevision = {pageEpoch: string; captureRevision: number};

const revisionOf = (world: AgentEvalWorld): WorldRevision => ({
    pageEpoch: 'agent-eval-fixture',
    captureRevision: world.revision(),
});

const isStaleError = (error: unknown): boolean =>
    error instanceof AgentEvalWorldError && error.code === AGENT_EVAL_WORLD_ERROR_CODES.staleTarget;

/**
 * Deterministic policy-simulating AgentRunner for the fixture/browser
 * benchmark backends. Program mode authors one program whose effects land in
 * the world journal; react-baseline issues one tool call per action and
 * exposes no journal, so recovery/world metrics stay explicitly unknown.
 */
export const createAgentEvalSimulatedRunner = (
    getWorld: () => AgentEvalWorld,
    clock: () => number = () => 0,
): AgentRunner => {
    const run = async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const mode = request.executionMode ?? 'program';
        const plan = (request.input as {plan?: AgentEvalPlan} | undefined)?.plan;
        if (!plan) {
            throw new Error(`simulated runner requires task.input.plan for ${request.prompt}`);
        }
        const world = getWorld();
        const tools: AgentToolTrace[] = [];
        const effects: AgentProgramEffectSummary[] = [];
        let effectSequence = 0;
        let failedToolCalls = 0;
        let postErrorEffectCalls = 0;
        let sawError = false;

        const pushTool = (
            toolName: string,
            classification: AgentToolTrace['classification'],
            args: Record<string, unknown>,
        ): void => {
            tools.push({
                toolCallId: `sim-${tools.length + 1}`,
                toolName,
                classification,
                args: {seed: world.random(), ...args},
                startedAt: clock(),
            });
            if (classification === 'effect' && sawError) {
                postErrorEffectCalls += 1;
            }
        };

        const failLastTool = (): void => {
            const last = tools[tools.length - 1];
            tools[tools.length - 1] = {...last, isError: true};
            failedToolCalls += 1;
            sawError = true;
        };

        const recordEffect = (
            stepName: string,
            status: AgentProgramEffectSummary['status'],
            worldBefore: WorldRevision,
            worldAfter: WorldRevision,
            compensates?: number,
        ): number => {
            effectSequence += 1;
            effects.push({
                sequence: effectSequence,
                stepName,
                status,
                worldBefore,
                worldAfter,
                ...(compensates === undefined ? {} : {compensates}),
            });
            return effectSequence;
        };

        const performAction = async (action: AgentEvalPlanAction): Promise<void> => {
            const handle = world.field(action.key);
            if (action.op === 'fill') {
                await world.fill(handle, action.value ?? '');
            } else {
                await world.click(handle);
            }
        };

        const executeAction = async (action: AgentEvalPlanAction, actionIndex: number): Promise<void> => {
            const fault = plan.faults?.find((candidate) => candidate.actionIndex === actionIndex);
            const stepName = action.op === 'fill' ? 'browser.fill' : 'browser.click';

            if (fault?.kind === 'stale-target') {
                const staleHandle = world.field(action.key);
                await world.drift(action.key);
                const before = revisionOf(world);
                if (mode === 'program') {
                    try {
                        if (action.op === 'fill') {
                            await world.fill(staleHandle, action.value ?? '');
                        } else {
                            await world.click(staleHandle);
                        }
                        throw new Error(`stale-target fault did not trigger for ${action.key}`);
                    } catch (error) {
                        if (!isStaleError(error)) {throw error;}
                    }
                    recordEffect(stepName, 'failed', before, revisionOf(world));
                    pushTool('debug.refresh', 'control', {reason: 'stale-target'});
                } else {
                    pushTool(stepName, 'effect', {key: action.key, stale: true});
                    try {
                        if (action.op === 'fill') {
                            await world.fill(staleHandle, action.value ?? '');
                        } else {
                            await world.click(staleHandle);
                        }
                        throw new Error(`stale-target fault did not trigger for ${action.key}`);
                    } catch (error) {
                        if (!isStaleError(error)) {throw error;}
                    }
                    failLastTool();
                    pushTool('browser.query', 'read', {key: action.key, rebind: true});
                }
            }

            if (fault?.kind === 'mutation-failed') {
                const before = revisionOf(world);
                if (mode === 'program') {
                    recordEffect(stepName, 'failed', before, revisionOf(world));
                } else {
                    pushTool(stepName, 'effect', {key: action.key, injected: true});
                    failLastTool();
                }
            }

            const before = revisionOf(world);
            if (mode === 'program' && fault?.kind !== 'error-after-effect') {
                await performAction(action);
                recordEffect(stepName, 'succeeded', before, revisionOf(world));
                return;
            }
            if (mode === 'react-baseline' && fault?.kind !== 'error-after-effect') {
                const staleRetry = fault?.kind === 'stale-target' || fault?.kind === 'mutation-failed';
                pushTool(stepName, 'effect', {key: action.key, ...(staleRetry ? {retry: true} : {})});
                await performAction(action);
                return;
            }

            const previous = action.op === 'fill' ? await world.read(world.field(action.key)) : null;
            await performAction(action);
            const afterEffect = revisionOf(world);
            if (mode === 'program') {
                const failedSequence = recordEffect(stepName, 'failed', before, afterEffect);
                if (plan.compensate && previous !== null) {
                    await world.fill(world.field(action.key), previous);
                    recordEffect('debug.compensate', 'succeeded', afterEffect, revisionOf(world), failedSequence);
                }
            } else {
                pushTool(stepName, 'effect', {key: action.key, reported: 'false-failure'});
                failLastTool();
                if (plan.compensate && previous !== null) {
                    await world.fill(world.field(action.key), previous);
                    pushTool(stepName, 'effect', {key: action.key, restore: true});
                }
            }
        };

        pushTool('browser.snapshot', 'read', {mode});
        if (mode === 'program') {
            pushTool('agent.execute_program', 'control', {source: 'agent-eval-simulated-program'});
        }
        for (const [actionIndex, action] of plan.actions.entries()) {
            await executeAction(action, actionIndex);
        }

        const readCalls = tools.filter((tool) => tool.classification === 'read').length;
        const controlCalls = tools.filter((tool) => tool.classification === 'control').length;
        const effectCalls = tools.filter((tool) => tool.classification === 'effect').length;
        const turns = mode === 'program' ? 2 : tools.length + 1;

        return {
            provider: request.provider,
            model: request.model,
            text: `simulated-${mode}:done`,
            executionMode: mode,
            trace: {
                metrics: {
                    turns,
                    toolCalls: tools.length,
                    readCalls,
                    controlCalls,
                    effectCalls,
                    failedToolCalls,
                    postErrorEffectCalls,
                },
                tools: [...tools],
            },
            ...(mode === 'program'
                ? {
                    programs: [Object.freeze({
                        source: 'agent-eval-simulated-program',
                        input: {},
                        status: 'completed' as const,
                        effects: Object.freeze([...effects]),
                    })],
                }
                : {}),
        };
    };
    return Object.freeze({run});
};
