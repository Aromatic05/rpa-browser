import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import {createMemoryCredentialResolver, createCredentialRef, serializeCredentialRef} from '../../../../src/security/credentials';
import {SecurityError} from '../../../../src/security/errors';
import type {AgentProgramSaveRequest} from '../../../../src/agent/execution/program/persistence';
import {
    isCredentialRefString,
    materializeCredentialInput,
} from '../../../../src/agent/execution/program/credentials';

const CANARY = 'tok_canary_3f9a2c_d0e1f2';

const apiTokenRef = () => createCredentialRef({id: 'env:API_TOKEN', kind: 'token', provider: 'env'});

const runtime = (faux: ReturnType<typeof createFauxCore>) => ({
    resolve: (provider: string, model: string) => provider === 'faux' && model === 'planner'
        ? {model: faux.getModel(), streamFn: faux.streamSimple}
        : null,
});

const resolvableApiToken = () => createMemoryCredentialResolver({'env:API_TOKEN': CANARY});

for (const value of [
    {name: 'null object', value: '{"id":1}'},
    {name: 'bool object', value: '{"id":true}'},
    {name: 'empty id', value: '{"id":"  "}'},
    {name: 'unknown fields', value: '{"id":"env:X","value":"nope"}'},
    {name: 'unknown kind', value: '{"id":"env:X","kind":"nope"}'},
    {name: 'non-canonical ordering', value: '{"id":"env:X","provider":"env","kind":"token"}'},
]) {
    test(`isCredentialRefString rejects ${value.name}`, () => {
        assert.equal(isCredentialRefString(value.value), false);
    });
}

test('isCredentialRefString accepts only the canonical ref encoding', () => {
    const refString = serializeCredentialRef(apiTokenRef());
    assert.equal(isCredentialRefString(refString), true);
    assert.equal(isCredentialRefString('ordinary text'), false);
    assert.equal(isCredentialRefString(42), false);
    assert.equal(isCredentialRefString(null), false);
    assert.equal(isCredentialRefString(['x']), false);
});

test('materializeCredentialInput resolves nested refs and preserves ordinary scalars', async () => {
    const materialized = await materializeCredentialInput({
        token: serializeCredentialRef(apiTokenRef()),
        username: 'alice',
        retries: 3,
        enabled: true,
        flags: [null, 'plain'],
        nested: {token: serializeCredentialRef(apiTokenRef()), value: 'plain'},
    }, resolvableApiToken());
    assert.deepEqual(materialized, {
        token: CANARY,
        username: 'alice',
        retries: 3,
        enabled: true,
        flags: [null, 'plain'],
        nested: {token: CANARY, value: 'plain'},
    });
});

test('materializeCredentialInput fails on unknown refs before any resolution succeeds', async () => {
    await assert.rejects(
        () => materializeCredentialInput({token: serializeCredentialRef(apiTokenRef())}, createMemoryCredentialResolver({})),
        (error) => error instanceof SecurityError && error.code === 'ERR_SECURITY_CREDENTIAL_NOT_FOUND',
    );
});

test('canary secret reaches the executor only, never the faux model context nor the summary', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    const contexts: string[] = [];
    faux.setResponses([
        (context) => {
            contexts.push(JSON.stringify(context));
            return fauxAssistantMessage(fauxToolCall('agent.execute_program', {
                source: 'fill input.target with input.value',
                input: {target: {nodeId: 'buyer'}, value: serializeCredentialRef(apiTokenRef())},
            }));
        },
        (context) => {
            contexts.push(JSON.stringify(context));
            return fauxAssistantMessage('Completed through the program transaction.');
        },
    ]);
    const materializedPrograms: Array<{source: string; input: Readonly<Record<string, unknown>>}> = [];
    const execute: AgentProgramExecutor = async (program) => {
        materializedPrograms.push(program);
        return {summary: {...program, status: 'completed', text: 'program complete'}};
    };
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: execute,
        credentialResolver: resolvableApiToken(),
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    const refString = serializeCredentialRef(apiTokenRef());
    const escapedRef = refString.replaceAll('"', '\\"');
    assert.ok(contexts.length >= 2, 'expected at least the tool-call and result model contexts');
    for (const context of contexts) {
        assert.ok(!context.includes(CANARY), `faux model context leaked the canary secret: ${context}`);
    }
    assert.ok(contexts[1].includes(escapedRef), 'faux model context must carry the reference only');
    assert.ok(!contexts[1].includes(CANARY), 'the reference-only model context still leaked the canary secret');
    assert.deepEqual(materializedPrograms, [{
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: CANARY},
    }]);
    const summary = result.programs?.[0];
    assert.equal(summary?.status, 'completed');
    assert.deepEqual(summary?.input, {target: {nodeId: 'buyer'}, value: refString});
    assert.ok(result.text !== undefined);
    assert.ok(!JSON.stringify(result).includes(CANARY), 'runner result leaked the canary secret');
});

test('direct source execution materializes refs and keeps summaries reference-only', async () => {
    const refString = serializeCredentialRef(apiTokenRef());
    const materializedPrograms: Array<{source: string; input: Readonly<Record<string, unknown>>}> = [];
    const execute: AgentProgramExecutor = async (program) => {
        materializedPrograms.push(program);
        return {summary: {...program, status: 'completed', text: 'direct'}};
    };
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: execute,
        credentialResolver: resolvableApiToken(),
        modelRuntime: {resolve: () => null},
    });

    const result = await runner.run({
        prompt: 'Run supplied program',
        provider: 'unused',
        model: 'unused',
        source: 'output ok = input.ok',
        input: {ok: true, token: refString, nested: {token: refString}},
    });

    assert.deepEqual(materializedPrograms, [{
        source: 'output ok = input.ok',
        input: {ok: true, token: CANARY, nested: {token: CANARY}},
    }]);
    const summary = result.programs?.[0];
    assert.deepEqual(summary?.input, {ok: true, token: refString, nested: {token: refString}});
    assert.equal(summary?.source, 'output ok = input.ok');
    assert.equal(summary?.materializedSource, 'output ok = input.ok');
    assert.ok(!JSON.stringify(result).includes(CANARY), 'runner result leaked the canary secret');
});

test('saved Program and its materialized source never contain the resolved secret', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: serializeCredentialRef(apiTokenRef())},
        })),
        fauxAssistantMessage(fauxToolCall('agent.save_program', {name: 'login'})),
        fauxAssistantMessage('Saved the completed Program.'),
    ]);
    const materializedPrograms: Array<{input: Readonly<Record<string, unknown>>}> = [];
    const saves: Array<{name: string; source: string}> = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            materializedPrograms.push(program);
            return {summary: {...program, status: 'completed', text: 'program complete'}};
        },
        saveProgram: async (request: AgentProgramSaveRequest) => {
            saves.push({name: request.name, source: request.source});
            return {status: 'saved', name: request.name, artifactRevision: 'revision-1'};
        },
        credentialResolver: resolvableApiToken(),
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill and save', provider: 'faux', model: 'planner'});

    assert.deepEqual(materializedPrograms, [{
        source: 'fill input.target with input.value',
        input: {target: {nodeId: 'buyer'}, value: CANARY},
    }]);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].source, 'fill input.target with input.value');
    assert.ok(!saves[0].source.includes(CANARY), 'saved Program source leaked the canary secret');
    assert.equal(result.savedPrograms?.[0]?.name, 'login');
    assert.equal(result.savedPrograms?.[0]?.artifactRevision, 'revision-1');
    assert.ok(!JSON.stringify(result).includes(CANARY), 'runner result leaked the canary secret');
});

test('unknown credential ref fails before any mutation regardless of injected resolver', async () => {
    const missing = createMemoryCredentialResolver({});
    const executeSpy: Array<{source: string}> = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            executeSpy.push(program);
            return {summary: {...program, status: 'completed', text: 'unreachable'}};
        },
        credentialResolver: missing,
        modelRuntime: {resolve: () => null},
    });

    await assert.rejects(
        () => runner.run({
            prompt: 'Run supplied program',
            provider: 'unused',
            model: 'unused',
            source: 'output ok = input.ok',
            input: {token: serializeCredentialRef(apiTokenRef())},
        }),
        (error) => error instanceof SecurityError && error.code === 'ERR_SECURITY_CREDENTIAL_NOT_FOUND',
    );
    assert.deepEqual(executeSpy, [], 'executor must not run when a ref is unresolvable');
});

test('without an injected resolver any credential ref is denied before mutation', async () => {
    const executeSpy: Array<{source: string}> = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            executeSpy.push(program);
            return {summary: {...program, status: 'completed', text: 'unreachable'}};
        },
        modelRuntime: {resolve: () => null},
    });

    await assert.rejects(
        () => runner.run({
            prompt: 'Run supplied program',
            provider: 'unused',
            model: 'unused',
            source: 'output ok = input.ok',
            input: {token: serializeCredentialRef(apiTokenRef())},
        }),
        (error) => error instanceof SecurityError && error.code === 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE',
    );
    assert.deepEqual(executeSpy, [], 'executor must not run when no resolver is configured');
});

test('an unresolvable ref submitted by the model fails the tool call without reaching the executor', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: serializeCredentialRef(apiTokenRef())},
        })),
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice'},
        })),
        fauxAssistantMessage('Retried with a plain value.'),
    ]);
    const executeSpy: Array<{source: string}> = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            executeSpy.push(program);
            return {summary: {...program, status: 'completed', text: 'ok'}};
        },
        credentialResolver: createMemoryCredentialResolver({}),
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.equal(executeSpy.length, 1, 'only the retry program may reach the executor');
    assert.equal(result.trace.metrics.failedToolCalls, 1);
    assert.equal(result.programs?.[0]?.status, 'completed');
});

test('ordinary scalar input passes through unchanged and never touches the resolver', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'fill input.target with input.value',
            input: {target: {nodeId: 'buyer'}, value: 'alice', retries: 3, enabled: true, flags: [null, 'x']},
        })),
        fauxAssistantMessage('Completed.'),
    ]);
    const programInputs: Array<Readonly<Record<string, unknown>>> = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: async (program) => {
            programInputs.push(program.input);
            return {summary: {...program, status: 'completed', text: 'ok'}};
        },
        credentialResolver: {
            resolve: async () => {throw new Error('resolve must not be called for scalar input');},
            has: () => {throw new Error('has must not be called for scalar input');},
            describe: () => '',
        },
        modelRuntime: runtime(faux),
    });

    const result = await runner.run({prompt: 'Fill buyer', provider: 'faux', model: 'planner'});

    assert.deepEqual(programInputs, [{
        target: {nodeId: 'buyer'},
        value: 'alice',
        retries: 3,
        enabled: true,
        flags: [null, 'x'],
    }]);
    assert.equal(result.programs?.[0]?.status, 'completed');
});