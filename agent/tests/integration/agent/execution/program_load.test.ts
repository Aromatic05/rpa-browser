import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgram} from '../../../../src/agent/execution/program/contracts';
import type {AgentProgramSaveRequest} from '../../../../src/agent/execution/program/persistence';

const runtime = (faux: ReturnType<typeof createFauxCore>) => ({
    resolve: (provider: string, model: string) => provider === 'faux-load' && model === 'load'
        ? {model: faux.getModel(), streamFn: faux.streamSimple}
        : null,
});

test('Program-first Agent loads an artifact, edits and executes its source, then CAS-saves the completed revision', async () => {
    const faux = createFauxCore({provider: 'faux-load', models: [{id: 'load'}]});
    const originalSource = 'output value = input.before';
    const editedSource = 'output value = input.after';
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.load_program', {name: 'existing'})),
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: editedSource,
            input: {after: 'updated'},
        })),
        fauxAssistantMessage(fauxToolCall('agent.save_program', {
            name: 'existing',
            expectedRevision: 'revision-existing',
        })),
        fauxAssistantMessage('Loaded, edited, verified, and saved the existing Program.'),
    ]);
    const executions: AgentProgram[] = [];
    const saves: AgentProgramSaveRequest[] = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        programLibrary: {
            list: async () => [],
            load: async (name) => name === 'existing'
                ? {
                    status: 'loaded',
                    program: {
                        name,
                        source: originalSource,
                        artifactRevision: 'revision-existing',
                        resolveSymbols: [],
                    },
                }
                : {status: 'not_found', name},
        },
        executeProgram: async (program) => {
            executions.push(program);
            return {summary: {...program, status: 'completed', text: '{"value":"updated"}', effects: []}};
        },
        saveProgram: async (request) => {
            saves.push(request);
            return {status: 'saved', name: request.name, artifactRevision: 'revision-next'};
        },
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({
        prompt: 'Load existing, change its output to input.after, run it, and overwrite the same artifact.',
        provider: 'faux-load',
        model: 'load',
    });

    assert.deepEqual(executions, [{source: editedSource, input: {after: 'updated'}}]);
    assert.deepEqual(saves, [{
        name: 'existing',
        source: editedSource,
        expectedRevision: 'revision-existing',
    }]);
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), [
        'agent.load_program',
        'agent.execute_program',
        'agent.save_program',
    ]);
    assert.equal(result.trace.metrics.readCalls, 1);
    assert.equal(result.trace.metrics.controlCalls, 2);
    assert.equal(result.trace.metrics.failedToolCalls, 0);
    assert.equal(result.programs?.[0].materializedSource, editedSource);
    assert.deepEqual(result.savedPrograms, [{name: 'existing', artifactRevision: 'revision-next'}]);
});
