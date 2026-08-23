import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentToolsFromHandlers} from '../../../../src/agent/tools/adapter';

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
