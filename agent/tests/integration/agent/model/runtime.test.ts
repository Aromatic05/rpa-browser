import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenAICompatibleAgentModelRuntime} from '../../../../src/agent/model/runtime';

test('OpenAI-compatible model runtime keeps credentials out of model metadata', async () => {
    const runtime = createOpenAICompatibleAgentModelRuntime({
        provider: 'bailian',
        model: 'deepseek-flash',
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret-key',
    });
    const binding = runtime.resolve('bailian', 'deepseek-flash');
    assert.ok(binding);
    assert.equal(binding.model.provider, 'bailian');
    assert.equal(binding.model.id, 'deepseek-flash');
    assert.equal(binding.model.baseUrl, 'https://example.test/v1');
    assert.equal(Object.hasOwn(binding.model, 'apiKey'), false);
    assert.equal(await binding.getApiKey?.('bailian'), 'secret-key');
    assert.equal(await binding.getApiKey?.('other'), undefined);
    assert.equal(runtime.resolve('bailian', 'other'), null);
});
