import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import type {AgentTraceSnapshot} from '../../../../src/agent/trace/collector';

const trace = (metrics: Partial<AgentTraceSnapshot['metrics']> = {}): AgentTraceSnapshot => ({
    metrics: {
        turns: 0,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
        ...metrics,
    },
    tools: [],
});

const runtime = (faux: ReturnType<typeof createFauxCore>) => ({
    resolve: (provider: string, model: string) => provider === 'faux' && model === 'planner'
        ? {model: faux.getModel(), streamFn: faux.streamSimple}
        : null,
});

test('program-first runner makes program execution the only mutation control', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice'},
        })),
        fauxAssistantMessage('Completed through the program transaction.'),
    ]);
    const programs: Array<{source: string; input: Readonly<Record<string, unknown>>}> = [];
    const execute: AgentProgramExecutor = async (program) => {
        programs.push(program);
        return {
            ...program,
            status: 'completed',
            text: 'program complete',
            trace: trace({turns: 2, controlCalls: 3}),
        };
    };
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: execute,
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.equal(result.executionMode, 'program');
    assert.equal(result.text, 'Completed through the program transaction.');
    assert.equal(result.programs?.[0].status, 'completed');
    assert.deepEqual(programs, [{
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: 'alice'},
    }]);
    assert.equal(result.trace.metrics.controlCalls, 4);
    assert.equal(result.trace.metrics.effectCalls, 0);
});

test('program-first runner permits compile repair before execution starts', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source: 'not valid dsl'})),
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source: 'output ok = input.ok', input: {ok: true}})),
        fauxAssistantMessage('Recompiled and completed.'),
    ]);
    let calls = 0;
    const execute: AgentProgramExecutor = async (program) => {
        calls += 1;
        return calls === 1
            ? {...program, status: 'invalid', error: {code: 'ERR_DSL_PARSE', message: 'bad source'}}
            : {...program, status: 'completed', text: 'ok', trace: trace()};
    };
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: execute,
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Produce output', provider: 'faux', model: 'planner'});

    assert.equal(calls, 2);
    assert.deepEqual(result.programs?.map((program) => program.status), ['invalid', 'completed']);
});

test('program-first runner rejects starting a second transaction after execution began', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source: 'output ok = input.ok', input: {ok: true}})),
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source: 'output second = input.ok', input: {ok: true}})),
        fauxAssistantMessage('Kept the original transaction.'),
    ]);
    let calls = 0;
    const execute: AgentProgramExecutor = async (program) => {
        calls += 1;
        return {...program, status: 'completed', text: 'ok', trace: trace()};
    };
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: execute,
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Produce output', provider: 'faux', model: 'planner'});

    assert.equal(calls, 1);
    assert.deepEqual(result.programs?.map((program) => program.status), ['completed']);
    assert.equal(result.trace.metrics.failedToolCalls, 1);
    assert.equal(result.text, 'Kept the original transaction.');
});

test('structured source executes directly without planner prompt smuggling', async () => {
    let called = false;
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            called = true;
            return {...program, status: 'completed', text: 'direct', trace: trace({controlCalls: 1})};
        },
        modelRuntime: {resolve: () => null},
    });

    const result = await runner.run({
        prompt: 'Run supplied program',
        provider: 'unused',
        model: 'unused',
        source: 'output ok = input.ok',
        input: {ok: true},
    });

    assert.equal(called, true);
    assert.equal(result.text, 'direct');
    assert.equal(result.executionMode, 'program');
    assert.equal(result.programs?.length, 1);
});
