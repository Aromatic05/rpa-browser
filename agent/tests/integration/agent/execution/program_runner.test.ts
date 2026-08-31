import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';

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
            summary: {
                ...program,
                status: 'completed',
                text: 'program complete',
            },
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
    assert.equal(result.trace.metrics.controlCalls, 1);
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
            ? {summary: {...program, status: 'invalid', error: {code: 'ERR_DSL_PARSE', message: 'bad source'}}}
            : {summary: {...program, status: 'completed', text: 'ok'}};
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
        return {summary: {...program, status: 'completed', text: 'ok'}};
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

test('program-first runner rejects model request failures instead of returning an empty success', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: 'connect ECONNREFUSED 127.0.0.1:43179',
        }),
    ]);
    let executed = false;
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            executed = true;
            return {summary: {...program, status: 'completed', text: 'should not run'}};
        },
        modelRuntime: runtime(faux),
    });

    await assert.rejects(
        () => runner.run({prompt: 'Summarize this page', provider: 'faux', model: 'planner'}),
        (error: unknown) => {
            const failure = error as {code?: string; message?: string};
            assert.equal(failure.code, 'ERR_AGENT_MODEL_REQUEST_FAILED');
            assert.match(failure.message ?? '', /ECONNREFUSED/);
            return true;
        },
    );
    assert.equal(executed, false);
});

test('program-first runner controls a retained barrier in the same ReAct session', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice'},
        })),
        fauxAssistantMessage(fauxToolCall('debug.cross_barrier', {})),
        fauxAssistantMessage('Transaction completed and can now be verified.'),
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
    const pause = {
        continuationId: 'continuation-1',
        reason: 'barrier' as const,
        location: {programId: 'main', path: 'body.0', kind: 'fill'},
        scope: {input: {}, vars: {}, output: {}},
        world: {
            workspaceName: 'ws',
            tabName: 'main',
            pageUrl: 'https://example.test/',
            revision: {pageEpoch: 'page-1', captureRevision: 1},
        },
        effect: {
            stepId: 'fill-1',
            stepName: 'browser.fill',
            args: {nodeId: 'buyer', value: 'alice'},
            semantics: {reversibility: 'unknown'},
        },
    } as any;
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => ({
            summary: {...program, status: 'paused', effects: []},
            debug: {session, pause},
        }),
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.equal(crossed, 1);
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), [
        'agent.execute_program',
        'debug.cross_barrier',
    ]);
    assert.equal(result.trace.metrics.controlCalls, 2);
    assert.equal(result.trace.metrics.failedToolCalls, 0);
    assert.equal(result.programs?.[0].status, 'completed');
    assert.equal(result.programs?.[0].text, '{"filled":"alice"}');
});

test('structured source executes directly without planner prompt smuggling', async () => {
    let called = false;
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            called = true;
            return {summary: {...program, status: 'completed', text: 'direct'}};
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
