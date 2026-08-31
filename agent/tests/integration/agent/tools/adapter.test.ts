import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAgentToolsFromHandlers,
    createWorkspaceAgentReadTools,
} from '../../../../src/agent/tools/adapter';
import {DEFAULT_TOOL_RESULT_SIZES} from '../../../../src/agent/tools/context/limit';

test('agent tool adapter preserves schema/description and delegates execution', async () => {
    const calls: unknown[] = [];
    const [tool] = createAgentToolsFromHandlers(
        [{
            name: 'browser.query',
            description: 'Query browser state.',
            inputSchema: {
                type: 'object',
                properties: {value: {type: 'string'}},
                required: ['value'],
            },
        }],
        {
            'browser.query': async (args) => {
                calls.push(args);
                return {ok: true, results: [{stepId: 's1', ok: true, data: {value: 1}}]};
            },
        },
    );

    assert.equal(tool.name, 'browser.query');
    assert.equal(tool.description, 'Query browser state.');
    const result = await tool.execute('call-1', {value: 'x'});
    assert.deepEqual(calls, [{value: 'x'}]);
    assert.deepEqual(result.details, {
        ok: true,
        results: [{stepId: 's1', ok: true, data: {value: 1}}],
    });
    assert.match((result.content[0] as {text: string}).text, /"value":1/);
});

test('agent tool adapter throws useful browser errors so pi marks the tool call failed', async () => {
    const [tool] = createAgentToolsFromHandlers(
        [{name: 'browser.query', description: 'Query.', inputSchema: {type: 'object'}}],
        {
            'browser.query': async () => ({
                ok: false,
                results: [{stepId: 's1', ok: false, error: {code: 'ERR_AMBIGUOUS', message: 'three matches'}}],
                error: {code: 'ERR_AMBIGUOUS', message: 'three matches', details: {count: 3}},
            }),
        },
    );

    await assert.rejects(
        () => tool.execute('call-1', {}),
        (error: unknown) => error instanceof Error
            && error.message.includes('ERR_AMBIGUOUS')
            && error.message.includes('three matches')
            && error.message.includes('count'),
    );
});

test('huge snapshot model-visible content is bounded while details retain the full result', async () => {
    const projection = {
        nodeId: 'root',
        scopeId: 'main',
        tag: 'button',
        role: 'button',
        name: 'root',
        children: Array.from({length: 5000}, (_, index) => ({
            nodeId: `node-${index}`,
            scopeId: 'main',
            tag: 'button',
            role: 'button',
            name: `label-${index}`,
            text: 'synthetic text '.repeat(4),
            children: [],
        })),
    };
    const [tool] = createAgentToolsFromHandlers(
        [{name: 'browser.snapshot', description: 'Inspect.', inputSchema: {type: 'object'}}],
        {
            'browser.snapshot': async () => ({
                ok: true,
                results: [{stepId: 'step-snap', ok: true, data: projection}],
            }),
        },
    );

    const result = await tool.execute('call-1', {});
    const cap = DEFAULT_TOOL_RESULT_SIZES['browser.snapshot']?.maxVisibleChars ?? Infinity;
    const text = (result.content[0] as {text: string}).text;
    assert.ok(text.length <= cap);
    assert.deepEqual(result.details, {
        ok: true,
        results: [{stepId: 'step-snap', ok: true, data: projection}],
    });
    const parsed = JSON.parse(text) as {
        truncated: boolean;
        content: {results: Array<{stepId: string; data: {nodeId: string; children: Array<{nodeId: string}>}}>};
    };
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.content.results[0]?.stepId, 'step-snap');
    assert.equal(parsed.content.results[0]?.data.nodeId, 'root');
    assert.equal(parsed.content.results[0]?.data.children[0]?.nodeId, 'node-0');
});

test('small tool results remain byte-identical in model-visible content', async () => {
    const small = {ok: true, results: [{stepId: 's1', ok: true, data: {count: 3}}]};
    const [tool] = createAgentToolsFromHandlers(
        [{name: 'browser.query', description: 'Query.', inputSchema: {type: 'object'}}],
        {'browser.query': async () => small},
    );
    const result = await tool.execute('call-1', {});
    assert.equal((result.content[0] as {text: string}).text, JSON.stringify(small));
});

test('tool errors with huge nested results stay bounded and identify the failure', async () => {
    const [tool] = createAgentToolsFromHandlers(
        [{name: 'browser.query', description: 'Query.', inputSchema: {type: 'object'}}],
        {
            'browser.query': async () => ({
                ok: false,
                results: [{stepId: 's1', ok: false, error: {code: 'ERR_HUGE', message: 'huge '.repeat(30_000)}}],
                error: {code: 'ERR_HUGE', message: 'huge '.repeat(30_000)},
            }),
        },
    );

    await assert.rejects(
        () => tool.execute('call-1', {}),
        (error: unknown) => {
            if (!(error instanceof Error)) {return false;}
            const parsed = JSON.parse(error.message) as {truncated: boolean; content: {error: {code: string}}};
            return parsed.truncated === true && parsed.content.error.code === 'ERR_HUGE';
        },
    );
});

test('workspace read-tool adapter keeps the read-only surface and applies the default budget', () => {
    const tools = createWorkspaceAgentReadTools({
        workspace: {name: 'ws', tabs: {} as never},
    });
    assert.ok(tools.length > 0);
    assert.equal(tools.some((tool) => tool.name === 'browser.click'), false);
    assert.equal(tools.some((tool) => tool.name === 'browser.snapshot'), true);
});
