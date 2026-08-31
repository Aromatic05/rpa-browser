import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall, Type, type Context} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import type {PausedDslDebugExecution} from '../../../../src/agent/debug/execution/contracts';
import type {WorldViewDescriptor} from '../../../../src/agent/worldview/contracts';

const runtime = (faux: ReturnType<typeof createFauxCore>) => ({
    resolve: (provider: string, model: string) => provider === 'faux' && model === 'planner'
        ? {model: faux.getModel(), streamFn: faux.streamSimple}
        : null,
});

const probeTool = (onCall: () => void): AgentTool => ({
    name: 'browser.list_tabs',
    label: 'browser.list_tabs',
    description: 'probe read',
    parameters: Type.Object({}),
    execute: async () => {
        onCall();
        return {content: [{type: 'text', text: '1'}], details: {ok: true}};
    },
});

const world = (): WorldViewDescriptor => ({
    workspaceName: 'ws',
    tabName: 'main',
    pageUrl: 'https://example.test/',
    revision: {pageEpoch: 'page-1', captureRevision: 1},
});

const invariantFailurePause = (continuationId: string): Extract<PausedDslDebugExecution, {reason: 'failure'}> => ({
    continuationId,
    reason: 'failure',
    location: {programId: 'main', path: 'body.0', kind: 'output', loops: [], callStack: []},
    scope: {input: {}, vars: {}, output: {}},
    world: world(),
    failure: {
        kind: 'invariant',
        code: 'ERR_DSL_ENSURE_FAILED',
        message: 'ensure failed',
        details: {expected: true, actual: false, condition: {}},
    },
});

const barrierPause = (continuationId: string, reversibility: 'unknown' | 'irreversible'): Extract<PausedDslDebugExecution, {reason: 'barrier'}> => ({
    continuationId,
    reason: 'barrier',
    location: {programId: 'main', path: 'body.0', kind: 'act', loops: [], callStack: []},
    scope: {input: {}, vars: {}, output: {}},
    world: world(),
    effect: {
        stepId: 'fill-1',
        stepName: 'browser.fill',
        args: {nodeId: 'buyer', value: 'alice'},
        semantics: {reversibility},
    },
});

test('program-first runner stops deterministically on the tool-call budget', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    let probeCalls = 0;
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage('unreachable final answer'),
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [probeTool(() => {probeCalls += 1;})],
        executeProgram: async (program) => ({summary: {...program, status: 'completed', text: 'ok'}}),
        modelRuntime: runtime(faux),
        governancePolicy: createGovernancePolicy({maxToolCalls: 2}),
    });

    const result = await runner.run({prompt: 'probe three times', provider: 'faux', model: 'planner'});

    assert.equal(probeCalls, 1);
    assert.equal(result.governance?.stopReason, 'max-tool-calls');
});

test('program-first runner stops deterministically on the turn budget', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    let probeCalls = 0;
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage('unreachable final answer'),
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [probeTool(() => {probeCalls += 1;})],
        executeProgram: async (program) => ({summary: {...program, status: 'completed', text: 'ok'}}),
        modelRuntime: runtime(faux),
        governancePolicy: createGovernancePolicy({maxTurns: 1}),
    });

    const result = await runner.run({prompt: 'probe across turns', provider: 'faux', model: 'planner'});

    assert.equal(probeCalls, 1);
    assert.equal(result.governance?.stopReason, 'max-turns');
});

test('irreversible effect is denied before the barrier is crossed', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice'},
        })),
        fauxAssistantMessage(fauxToolCall('debug.cross_barrier', {})),
        fauxAssistantMessage('unreachable after denial'),
    ]);
    let crossed = 0;
    const session = {
        materializeProgram: () => 'fill input.target with input.value',
        crossBarrier: async () => {
            crossed += 1;
            return {status: 'completed' as const, output: {filled: 'alice'}};
        },
        auditEffects: () => [],
    } as any;
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => ({
            summary: {...program, status: 'paused', effects: []},
            debug: {session, pause: barrierPause('continuation-1', 'irreversible')},
        }),
        modelRuntime: runtime(faux),
        governancePolicy: createGovernancePolicy({irreversibleApproval: 'deny'}),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.equal(crossed, 0);
    assert.equal(result.governance?.stopReason, 'irreversible-effect-denied');
});

test('irreversible effect awaits approval under require-human policy', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice'},
        })),
        fauxAssistantMessage(fauxToolCall('debug.cross_barrier', {})),
        fauxAssistantMessage('unreachable while awaiting approval'),
    ]);
    let crossed = 0;
    const session = {
        materializeProgram: () => 'fill input.target with input.value',
        crossBarrier: async () => {
            crossed += 1;
            return {status: 'completed' as const, output: {filled: 'alice'}};
        },
        auditEffects: () => [],
    } as any;
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => ({
            summary: {...program, status: 'paused', effects: []},
            debug: {session, pause: barrierPause('continuation-1', 'irreversible')},
        }),
        modelRuntime: runtime(faux),
        governancePolicy: createGovernancePolicy({irreversibleApproval: 'require-human'}),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.equal(crossed, 0);
    assert.equal(result.governance?.pendingApproval?.toolName, 'browser.fill');
    assert.equal(result.governance?.pendingApproval?.effectSequence, 1);
    assert.equal(result.governance?.stopReason, undefined);
});

test('recovery budget is consumed across repeated turns until exhaustion surfaces in guidance', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    const prompts: string[] = [];
    let pause = invariantFailurePause('continuation-1');
    const session = {
        materializeProgram: () => 'ensure compute eq(input.actual, input.expected)',
        auditEffects: () => [],
        patchProgram: () => {
            pause = invariantFailurePause('continuation-2');
            return {
                status: 'patched',
                patch: {},
                target: {programId: 'main', path: 'body.0', state: 'current'},
                pause,
            };
        },
    } as any;
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'ensure compute eq(input.actual, input.expected)',
            input: {actual: 1, expected: 2},
        })),
        (context: Context) => {
            prompts.push(context.systemPrompt ?? '');
            return fauxAssistantMessage(fauxToolCall('debug.patch_program', {
                programId: 'main',
                path: 'body.0',
                source: 'ensure compute eq(input.actual, input.actual)',
            }));
        },
        (context: Context) => {
            prompts.push(context.systemPrompt ?? '');
            return fauxAssistantMessage('Terminalized after budget exhaustion.');
        },
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => ({
            summary: {...program, status: 'paused', effects: []},
            debug: {session, pause},
        }),
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Enforce invariant', provider: 'faux', model: 'planner'});

    assert.equal(result.programs?.[0].status, 'paused');
    assert.match(prompts[0], /1 repairs remaining/);
    assert.match(prompts[1], /TERMINAL: TERMINAL_RECOVERY_BUDGET_EXHAUSTED/);
});

test('ordinary successful program run remains unchanged under default governance', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice'},
        })),
        fauxAssistantMessage('Completed through the program transaction.'),
    ]);
    const execute: AgentProgramExecutor = async (program) => ({
        summary: {...program, status: 'completed', text: 'program complete'},
    });
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: execute,
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.equal(result.executionMode, 'program');
    assert.equal(result.text, 'Completed through the program transaction.');
    assert.equal(result.programs?.[0].status, 'completed');
    assert.equal(result.governance, undefined);
    assert.equal(result.trace.metrics.controlCalls, 1);
    assert.equal(result.trace.metrics.effectCalls, 0);
});
