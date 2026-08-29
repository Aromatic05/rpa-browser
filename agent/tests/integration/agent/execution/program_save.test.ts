import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import type {AgentProgramSaveRequest} from '../../../../src/agent/execution/program/persistence';

const source = 'output ok = input.ok';

const executor: AgentProgramExecutor = async (program) => ({
    summary: {...program, status: 'completed', text: '{"ok":true}', effects: []},
});

const runtime = (faux: ReturnType<typeof createFauxCore>) => ({
    resolve: (provider: string, model: string) => provider === 'faux-save' && model === 'save'
        ? {model: faux.getModel(), streamFn: faux.streamSimple}
        : null,
});

test('successful Program execution never persists automatically even when a saver is configured', async () => {
    const faux = createFauxCore({provider: 'faux-save', models: [{id: 'save'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source, input: {ok: true}})),
        fauxAssistantMessage('Completed without publishing.'),
    ]);
    const saves: AgentProgramSaveRequest[] = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: executor,
        saveProgram: async (request) => {
            saves.push(request);
            return {status: 'saved', name: request.name, artifactRevision: 'unexpected'};
        },
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({
        prompt: 'Run the task once. Do not save it.',
        provider: 'faux-save',
        model: 'save',
    });

    assert.deepEqual(saves, []);
    assert.equal(result.savedPrograms, undefined);
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), ['agent.execute_program']);
});

test('explicit Program save handles revision conflict before a CAS overwrite', async () => {
    const faux = createFauxCore({provider: 'faux-save', models: [{id: 'save'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source, input: {ok: true}})),
        fauxAssistantMessage(fauxToolCall('agent.save_program', {name: 'generated'})),
        fauxAssistantMessage(fauxToolCall('agent.save_program', {
            name: 'generated',
            expectedRevision: 'revision-current',
        })),
        fauxAssistantMessage('Saved after observing the current revision.'),
    ]);
    const saves: AgentProgramSaveRequest[] = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: executor,
        saveProgram: async (request) => {
            saves.push(request);
            return request.expectedRevision === undefined
                ? {status: 'conflict', name: request.name, currentRevision: 'revision-current'}
                : {status: 'saved', name: request.name, artifactRevision: 'revision-next'};
        },
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({
        prompt: 'Run the task and explicitly overwrite the generated artifact after observing its revision.',
        provider: 'faux-save',
        model: 'save',
    });

    assert.deepEqual(saves, [
        {name: 'generated', source},
        {name: 'generated', source, expectedRevision: 'revision-current'},
    ]);
    assert.deepEqual(result.savedPrograms, [{
        name: 'generated',
        artifactRevision: 'revision-next',
    }]);
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), [
        'agent.execute_program',
        'agent.save_program',
        'agent.save_program',
    ]);
    assert.equal(result.trace.metrics.failedToolCalls, 0);
});
