import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall, Type} from '@earendil-works/pi-ai';
import type {AgentTool, PrepareNextTurnContext} from '@earendil-works/pi-agent-core';
import {createReactAgentRunner} from '../../../../src/agent/execution/react_runner';
import {AgentContextBudgetExceededError} from '../../../../src/agent/tools/context/budget';

const fauxModelRuntime = (faux: ReturnType<typeof createFauxCore>) => ({
    resolve: (provider: string, model: string) => provider === 'faux' && model === 'baseline'
        ? {model: faux.getModel(), streamFn: faux.streamSimple}
        : null,
});

const hugeSnapshotTool = (size = 30_000): AgentTool => ({
    name: 'browser.snapshot',
    label: 'browser.snapshot',
    description: 'Inspect the page.',
    parameters: Type.Object({}),
    execute: async () => ({content: [{type: 'text', text: 's'.repeat(size)}], details: {ok: true}}),
});

const sideEffectTool = (counter: {calls: number}): AgentTool => ({
    name: 'browser.fill',
    label: 'browser.fill',
    description: 'Fill a field.',
    parameters: Type.Object({}),
    execute: async () => {
        counter.calls += 1;
        return {content: [{type: 'text', text: 'filled'}], details: {ok: true}};
    },
});

const countingStreamFn = (faux: ReturnType<typeof createFauxCore>, calls: {count: number}) =>
    (async (model: Parameters<typeof faux.streamSimple>[0], context: Parameters<typeof faux.streamSimple>[1], options: Parameters<typeof faux.streamSimple>[2]) => {
        calls.count += 1;
        return faux.streamSimple(model, context, options);
    }) as unknown as typeof faux.streamSimple;

test('overflowing the runner context budget stops before another model call', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.snapshot', {})),
        fauxAssistantMessage('would be the second model call'),
    ]);
    const streamCalls = {count: 0};
    const runner = createReactAgentRunner({
        tools: [hugeSnapshotTool()],
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: countingStreamFn(faux, streamCalls)}
                : null,
        },
        contextBudget: {maxChars: 5000},
    });

    await assert.rejects(
        () => runner.run({prompt: 'Inspect the page.', provider: 'faux', model: 'baseline'}),
        (error: unknown) => {
            if (!(error instanceof AgentContextBudgetExceededError)) {return false;}
            assert.equal(error.limitChars, 5000);
            assert.ok(error.chars > 5000);
            assert.equal(error.turn, 1);
            return true;
        },
    );
    assert.equal(streamCalls.count, 1);
});

test('overflowing the budget blocks a later tool side effect in the same batch', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall('browser.snapshot', {}), fauxToolCall('browser.fill', {})]),
        fauxAssistantMessage('unreachable'),
    ]);
    const fillCounter = {calls: 0};
    const streamCalls = {count: 0};
    const runner = createReactAgentRunner({
        tools: [hugeSnapshotTool(), sideEffectTool(fillCounter)],
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: countingStreamFn(faux, streamCalls)}
                : null,
        },
        contextBudget: {maxChars: 5000},
    });

    await assert.rejects(
        () => runner.run({prompt: 'Inspect then fill.', provider: 'faux', model: 'baseline'}),
        (error: unknown) => error instanceof AgentContextBudgetExceededError,
    );
    assert.equal(fillCounter.calls, 0);
    assert.equal(streamCalls.count, 1);
});

test('accumulated context limit failure is deterministic and typed', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.snapshot', {})),
        fauxAssistantMessage('done'),
    ]);
    const runner = createReactAgentRunner({
        tools: [hugeSnapshotTool(20_000)],
        modelRuntime: fauxModelRuntime(faux),
        contextBudget: {maxChars: 5000},
    });

    await assert.rejects(
        () => runner.run({prompt: 'Inspect.', provider: 'faux', model: 'baseline'}),
        (error: unknown) => {
            if (!(error instanceof AgentContextBudgetExceededError)) {return false;}
            assert.equal(error.name, 'AgentContextBudgetExceededError');
            assert.ok(error.bytes > 0);
            assert.match(error.message, /exceeds limit 5000 chars/);
            return true;
        },
    );
});

test('defaults preserve current behavior: large results complete without a budget failure', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.snapshot', {})),
        fauxAssistantMessage('done'),
    ]);
    const streamCalls = {count: 0};
    const runner = createReactAgentRunner({
        tools: [hugeSnapshotTool(200_000)],
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: countingStreamFn(faux, streamCalls)}
                : null,
        },
    });

    const result = await runner.run({prompt: 'Inspect.', provider: 'faux', model: 'baseline'});
    assert.equal(result.text, 'done');
    assert.equal(streamCalls.count, 2);
    assert.ok((result.trace.context?.lastChars ?? 0) > 200_000);
    assert.equal(result.trace.context?.turns.length, 2);
});

test('runner context accounting is deterministic across identical runs', async () => {
    const runOnce = async () => {
        const faux = createFauxCore({api: 'faux', provider: 'faux', models: [{id: 'baseline'}]});
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall('browser.list_tabs', {}, {id: 'fixed-tool-1'})),
            fauxAssistantMessage('ok'),
        ]);
        const runner = createReactAgentRunner({
            tools: [{
                name: 'browser.list_tabs',
                label: 'browser.list_tabs',
                description: 'List tabs.',
                parameters: Type.Object({}),
                execute: async () => ({content: [{type: 'text', text: '1'}], details: {ok: true}}),
            }],
            modelRuntime: fauxModelRuntime(faux),
        });
        return (await runner.run({prompt: 'How many tabs?', provider: 'faux', model: 'baseline'})).trace.context;
    };

    const first = await runOnce();
    const second = await runOnce();
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual(first, second);
    assert.equal(first.turns.length, 2);
});

test('program-planner style prepareNextTurn composition inherits the generic budget boundary', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.snapshot', {})),
        fauxAssistantMessage('done'),
    ]);
    let prepareInvoked = 0;
    const prepareProgramContext = async ({context}: PrepareNextTurnContext) => {
        prepareInvoked += 1;
        return {
            context: {...context, systemPrompt: 'terminal'.padEnd(20_000, 'T')},
        };
    };
    const runner = createReactAgentRunner({
        tools: [hugeSnapshotTool(100)],
        modelRuntime: fauxModelRuntime(faux),
        prepareNextTurnWithContext: prepareProgramContext,
        contextBudget: {maxChars: 3000},
    });

    await assert.rejects(
        () => runner.run({prompt: 'Inspect.', provider: 'faux', model: 'baseline'}),
        (error: unknown) => error instanceof AgentContextBudgetExceededError,
    );
    assert.ok(prepareInvoked >= 1);
});

test('program-planner style tool/system-prompt swapping still works under the budget boundary', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.snapshot', {})),
        fauxAssistantMessage(fauxToolCall('program.control', {})),
        fauxAssistantMessage('program completed'),
    ]);
    const controlCalls = {count: 0};
    const controlTool: AgentTool = {
        name: 'program.control',
        label: 'program.control',
        description: 'Control a retained program.',
        parameters: Type.Object({}),
        execute: async () => {
            controlCalls.count += 1;
            return {content: [{type: 'text', text: 'controlled'}], details: {ok: true}};
        },
    };
    const prepareProgramContext = async ({context}: PrepareNextTurnContext) => {
        const reachedTerminal = context.messages.some(
            (message) => message.role === 'toolResult' && message.toolName === 'browser.snapshot',
        );
        if (reachedTerminal) {
            return {context: {...context, tools: [controlTool], systemPrompt: 'terminal prompt'}};
        }
        return {context};
    };
    const runner = createReactAgentRunner({
        tools: [hugeSnapshotTool(100)],
        modelRuntime: fauxModelRuntime(faux),
        prepareNextTurnWithContext: prepareProgramContext,
        contextBudget: {maxChars: 10_000_000},
    });

    const result = await runner.run({prompt: 'Inspect and control.', provider: 'faux', model: 'baseline'});
    assert.equal(result.text, 'program completed');
    assert.equal(controlCalls.count, 1);
    assert.equal(result.trace.context?.turns.length, 3);
});

const queryTool = (description: string): AgentTool => ({
    name: 'browser.query',
    label: 'browser.query',
    description,
    parameters: Type.Object({}),
    execute: async () => ({content: [{type: 'text', text: 'row'}], details: {ok: true}}),
});

test('huge internal tool details never affect the model-visible context size', async () => {
    const runOnce = async (details: unknown) => {
        const faux = createFauxCore({api: 'faux', provider: 'faux', models: [{id: 'baseline'}]});
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall('browser.query', {}, {id: 'fixed-tool-1'})),
            fauxAssistantMessage('ok'),
        ]);
        const tool: AgentTool = {
            name: 'browser.query',
            label: 'browser.query',
            description: 'Query.',
            parameters: Type.Object({}),
            execute: async () => ({content: [{type: 'text', text: 'row'}], details}),
        };
        const runner = createReactAgentRunner({
            tools: [tool],
            modelRuntime: fauxModelRuntime(faux),
        });
        const result = await runner.run({prompt: 'Query.', provider: 'faux', model: 'baseline'});
        return result.trace.context;
    };

    const small = await runOnce({ok: true});
    const huge = await runOnce({ok: true, blob: 'x'.repeat(1_000_000)});
    assert.deepEqual(huge, small);
});

test('a large active tool schema inflates measured size and can trip the cap before model invocation', async () => {
    const faux = createFauxCore({api: 'faux', provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.query', {}, {id: 'fixed-tool-1'})),
        fauxAssistantMessage('unreachable'),
    ]);
    const streamCalls = {count: 0};
    const runner = createReactAgentRunner({
        tools: [queryTool('d'.repeat(200_000))],
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: countingStreamFn(faux, streamCalls)}
                : null,
        },
        contextBudget: {maxChars: 5000},
    });

    await assert.rejects(
        () => runner.run({prompt: 'Query.', provider: 'faux', model: 'baseline'}),
        (error: unknown) => error instanceof AgentContextBudgetExceededError,
    );
    assert.equal(streamCalls.count, 0);
});

test('dynamic program-first tool swapping changes the measured model-visible size', async () => {
    const faux = createFauxCore({api: 'faux', provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.snapshot', {}, {id: 'fixed-snap-1'})),
        fauxAssistantMessage(fauxToolCall('browser.query', {}, {id: 'fixed-query-1'})),
        fauxAssistantMessage('done'),
    ]);
    let prepareCount = 0;
    const prepareProgramContext = async ({context}: PrepareNextTurnContext) => {
        prepareCount += 1;
        if (prepareCount === 2) {
            return {context: {...context, tools: [queryTool('t'.repeat(150_000))]}};
        }
        return {context};
    };
    const runner = createReactAgentRunner({
        tools: [queryTool('small schema')],
        modelRuntime: fauxModelRuntime(faux),
        prepareNextTurnWithContext: prepareProgramContext,
        contextBudget: {maxChars: 10_000_000},
    });

    const result = await runner.run({prompt: 'Inspect and swap tools.', provider: 'faux', model: 'baseline'});
    const turns = result.trace.context?.turns ?? [];
    assert.equal(turns.length, 3);
    assert.ok(prepareCount >= 3);
    assert.ok(
        (turns[1]?.chars ?? 0) > (turns[0]?.chars ?? 0) + 100_000,
        `tool swap did not inflate turn 2 context: ${turns[0]?.chars} -> ${turns[1]?.chars}`,
    );
});

test('bounded tool result content is the only model-visible payload', async () => {
    const runOnce = async (content: string, details: unknown) => {
        const faux = createFauxCore({api: 'faux', provider: 'faux', models: [{id: 'baseline'}]});
        faux.setResponses([
            fauxAssistantMessage(fauxToolCall('browser.query', {}, {id: 'fixed-tool-1'})),
            fauxAssistantMessage('ok'),
        ]);
        const tool: AgentTool = {
            name: 'browser.query',
            label: 'browser.query',
            description: 'Query.',
            parameters: Type.Object({}),
            execute: async () => ({content: [{type: 'text', text: content}], details}),
        };
        const runner = createReactAgentRunner({
            tools: [tool],
            modelRuntime: fauxModelRuntime(faux),
        });
        const result = await runner.run({prompt: 'Query.', provider: 'faux', model: 'baseline'});
        return result.trace.context?.lastChars ?? 0;
    };

    const smallDetails = {ok: true};
    const hugeDetails = {ok: true, blob: 'x'.repeat(1_000_000)};
    assert.equal(await runOnce('c'.repeat(5000), hugeDetails), await runOnce('c'.repeat(5000), smallDetails));
    assert.ok(await runOnce('c'.repeat(10_000), smallDetails) > await runOnce('c'.repeat(5000), smallDetails));
});