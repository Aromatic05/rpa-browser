import type {AgentToolTrace} from '../../../trace/collector';
import type {
    AgentProgramEffectSummary,
    AgentProgramWorldRevision,
    AgentRunRequest,
    AgentRunResult,
    AgentRunner,
} from '../../types';
import type {AgentEvalPlanAction} from '../benchmark';
import {AgentEvalWorldError} from '../world';
import {AGENT_FAULT_ERROR_CODES, AgentFaultWorldError} from './contracts';
import type {AgentFaultWorld} from './contracts';

const classifyPortError = (error: unknown): Readonly<{worldChanged: boolean}> | null => {
    if (error instanceof AgentFaultWorldError || error instanceof AgentEvalWorldError) {
        return {worldChanged: error.worldChanged};
    }
    return null;
};

export const AGENT_FAULT_SIMULATED_PROVIDER = 'agent-fault-fixture';
export const AGENT_FAULT_SIMULATED_MODEL = 'policy-simulated';

/**
 * Recovery directive carried by a fault plan. It is task guidance, not
 * fault-kind special-casing: the runner only branches on generic port errors
 * and on the observed world state.
 *  - 'restore-previous': a failed world-changing mutation must be taken back
 *    to the pre-effect value instead of being pushed toward the goal value.
 *  - 'complete-goal': after a reported failure, confirm the actual state and
 *    finish the goal if (and only if) the world does not already hold it.
 */
export type AgentFaultRecoveryDirective = 'restore-previous' | 'complete-goal';

export type AgentFaultPolicyRunnerOptions = Readonly<{
    getWorld: () => AgentFaultWorld;
    clock?: () => number;
}>;

const revisionOf = (world: AgentFaultWorld): AgentProgramWorldRevision => ({
    pageEpoch: `epoch-${world.epoch()}`,
    captureRevision: world.revision(),
});

const stepNameOf = (op: AgentEvalPlanAction['op']): string =>
    op === 'fill' ? 'browser.fill' : 'browser.click';

/**
 * Deterministic reference runner for the fault benchmark: program mode keeps a
 * retained effect journal, writes transactionally (compare-and-set), and
 * recovers by journal-linked compensation; react-baseline issues one ad-hoc
 * tool call per action, exposes no journal, and recovers by re-issuing new
 * effects. Both policies only ever observe generic port errors.
 */
export const createAgentFaultPolicyRunner = (options: AgentFaultPolicyRunnerOptions): AgentRunner => {
    const run = async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const mode = request.executionMode ?? 'program';
        const inputPlan = request.input?.plan as
            {actions?: readonly AgentEvalPlanAction[]; recovery?: AgentFaultRecoveryDirective} | undefined;
        const actions = inputPlan?.actions;
        if (!actions) {
            throw new Error(`fault runner requires task.input.plan.actions for ${request.prompt}`);
        }
        const recovery: AgentFaultRecoveryDirective = inputPlan.recovery ?? 'complete-goal';
        const world = options.getWorld();
        const clock = options.clock ?? (() => 0);
        const tools: AgentToolTrace[] = [];
        const effects: AgentProgramEffectSummary[] = [];
        let effectSequence = 0;
        let failedToolCalls = 0;
        let postErrorEffectCalls = 0;
        let revisionConflicts = 0;
        let sawError = false;

        const pushTool = (
            toolName: string,
            classification: AgentToolTrace['classification'],
            args: Record<string, unknown>,
        ): void => {
            tools.push({
                toolCallId: `fault-${tools.length + 1}`,
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
            worldBefore: AgentProgramWorldRevision,
            worldAfter: AgentProgramWorldRevision,
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

        const forwardFill = async (
            key: string,
            value: string,
            transactional: boolean,
        ): Promise<AgentProgramWorldRevision> => {
            const before = revisionOf(world);
            const handle = world.field(key);
            const expectedRevision = world.revision();
            try {
                if (transactional) {
                    await world.transact(handle, value, expectedRevision);
                } else {
                    await world.fill(handle, value);
                }
                recordEffect(stepNameOf('fill'), 'succeeded', before, revisionOf(world));
            } catch (error) {
                recordEffect(stepNameOf('fill'), 'failed', before, revisionOf(world));
                throw error;
            }
            return before;
        };

        const clickButton = async (key: string): Promise<void> => {
            const before = revisionOf(world);
            try {
                await world.click(world.field(key));
                if (mode === 'program') {
                    recordEffect(stepNameOf('click'), 'succeeded', before, revisionOf(world));
                }
            } catch (error) {
                if (mode === 'program') {
                    recordEffect(stepNameOf('click'), 'failed', before, revisionOf(world));
                }
                throw error;
            }
        };

        const compensateTo = async (key: string, target: string, failedSequence: number): Promise<void> => {
            for (let attempt = 0; attempt < 2; attempt++) {
                const live = world.refresh(key);
                const current = await world.read(live);
                if (current === target) {
                    return;
                }
                const before = revisionOf(world);
                try {
                    await world.fill(live, target);
                    recordEffect('debug.compensate', 'succeeded', before, revisionOf(world), failedSequence);
                    return;
                } catch (error) {
                    recordEffect('debug.compensate', 'failed', before, revisionOf(world), failedSequence);
                    const failure = classifyPortError(error);
                    if (!failure?.worldChanged) {
                        throw error;
                    }
                }
            }
        };

        const recoverAfterStray = async (key: string, goal: string, previous: string): Promise<void> => {
            const live = world.refresh(key);
            const current = await world.read(live);
            if (recovery === 'restore-previous') {
                if (current === previous) {
                    return;
                }
                let failedSequence = effectSequence;
                for (let index = effects.length - 1; index >= 0; index--) {
                    const effect = effects[index];
                    if (effect.status === 'failed' && effect.stepName === stepNameOf('fill')) {
                        failedSequence = effect.sequence;
                        break;
                    }
                }
                await compensateTo(key, previous, failedSequence);
                return;
            }
            if (current === goal) {
                return;
            }
            await forwardFill(key, goal, mode === 'program');
        };

        const recoverAfterRejection = async (key: string, goal: string): Promise<void> => {
            for (let guard = 0; guard < 3; guard++) {
                pushTool('debug.refresh', 'control', {reason: 'rebind-after-error'});
                const live = world.refresh(key);
                const current = await world.read(live);
                if (current === goal) {
                    return;
                }
                try {
                    await forwardFill(key, goal, mode === 'program');
                    return;
                } catch (error) {
                    const failure = classifyPortError(error);
                    if (!failure) {
                        throw error;
                    }
                    if (failure.worldChanged) {
                        await recoverAfterStray(key, goal, current ?? '');
                        return;
                    }
                    if (guard === 2) {
                        throw new Error(`rebind budget exhausted for ${key}`, {cause: error});
                    }
                }
            }
        };

        const runProgramAction = async (action: AgentEvalPlanAction): Promise<void> => {
            const goal = action.value ?? '';
            const preHandle = world.field(action.key);
            const previous = action.op === 'fill'
                ? (await world.read(preHandle)) ?? ''
                : '';
            if (action.op === 'click') {
                await clickButton(action.key);
                return;
            }
            try {
                await forwardFill(action.key, goal, true);
            } catch (error) {
                const failure = classifyPortError(error);
                if (!failure) {
                    throw error;
                }
                if (error instanceof AgentFaultWorldError
                    && error.code === AGENT_FAULT_ERROR_CODES.revisionConflict) {
                    revisionConflicts += 1;
                }
                if (failure.worldChanged) {
                    await recoverAfterStray(action.key, goal, previous);
                } else {
                    await recoverAfterRejection(action.key, goal);
                }
            }
        };

        const runBaselineAction = async (action: AgentEvalPlanAction): Promise<void> => {
            const goal = action.value ?? '';
            const preHandle = world.field(action.key);
            const previous = action.op === 'fill'
                ? (await world.read(preHandle)) ?? ''
                : '';
            pushTool(stepNameOf(action.op), 'effect', {key: action.key});
            try {
                if (action.op === 'click') {
                    await world.click(preHandle);
                } else {
                    await world.fill(preHandle, goal);
                }
                return;
            } catch (error) {
                const failure = classifyPortError(error);
                if (!failure) {
                    throw error;
                }
                failLastTool();
                pushTool('browser.query', 'read', {key: action.key, rebind: true});
                await world.read(world.refresh(action.key));
                if (!(failure.worldChanged && recovery === 'restore-previous')) {
                    for (let guard = 0; guard < 3; guard++) {
                        pushTool(stepNameOf(action.op), 'effect', {key: action.key, retry: true});
                        try {
                            await world.fill(world.refresh(action.key), goal);
                            return;
                        } catch (retryError) {
                            const retryFailure = classifyPortError(retryError);
                            failLastTool();
                            if (!retryFailure) {
                                throw retryError;
                            }
                            if (guard === 2) {
                                throw new Error(`baseline retry budget exhausted for ${action.key}`, {cause: retryError});
                            }
                            pushTool('browser.query', 'read', {key: action.key, rebind: true});
                            await world.read(world.refresh(action.key));
                        }
                    }
                }
                for (let guard = 0; guard < 3; guard++) {
                    const live = world.refresh(action.key);
                    const current = await world.read(live);
                    if (current === previous) {
                        return;
                    }
                    pushTool(stepNameOf(action.op), 'effect', {key: action.key, restore: true});
                    try {
                        await world.fill(live, previous);
                        return;
                    } catch (restoreError) {
                        const restoreFailure = classifyPortError(restoreError);
                        failLastTool();
                        if (!restoreFailure?.worldChanged) {
                            throw restoreError;
                        }
                    }
                }
            }
        };

        pushTool('browser.snapshot', 'read', {mode});
        if (mode === 'program') {
            pushTool('agent.execute_program', 'control', {source: 'agent-fault-program'});
        }
        for (const action of actions) {
            if (mode === 'program') {
                await runProgramAction(action);
            } else {
                await runBaselineAction(action);
            }
        }

        const readCalls = tools.filter((tool) => tool.classification === 'read').length;
        const controlCalls = tools.filter((tool) => tool.classification === 'control').length;
        const effectCalls = tools.filter((tool) => tool.classification === 'effect').length;
        const turns = mode === 'program' ? 2 : tools.length + 1;

        return {
            provider: request.provider,
            model: request.model,
            text: `fault-${mode}:done`,
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
                        source: 'agent-fault-program',
                        input: {},
                        status: 'completed' as const,
                        effects: Object.freeze([...effects]),
                        ...(revisionConflicts > 0
                            ? {text: `transactional-conflicts:${revisionConflicts}`}
                            : {}),
                    })],
                }
                : {}),
        };
    };
    return Object.freeze({run});
};
