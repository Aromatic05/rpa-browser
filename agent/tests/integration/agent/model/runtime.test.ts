import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEnvironmentAgentModelRuntime,
    createOpenAICompatibleAgentModelRuntime,
    createOpenAICompatibleAgentModelRuntimeWithCredential,
    ModelCredentialError,
} from '../../../../src/agent/model/runtime';

const AGENT_ENV_KEYS = [
    'RPA_AGENT_PROVIDER',
    'RPA_AGENT_MODEL',
    'RPA_AGENT_BASE_URL',
    'RPA_AGENT_API_KEY',
] as const;

const withAgentEnv = async <T>(
    values: Readonly<Partial<Record<(typeof AGENT_ENV_KEYS)[number], string | undefined>>>,
    run: () => Promise<T> | T,
): Promise<T> => {
    const saved = new Map(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
        for (const key of AGENT_ENV_KEYS) {
            const value = values[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        return await run();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
};

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

test('lazy credential runtime defers API key resolution to invocation, once per call', async () => {
    const calls: string[] = [];
    const runtime = createOpenAICompatibleAgentModelRuntimeWithCredential({
        provider: 'bailian',
        model: 'deepseek-flash',
        baseUrl: 'https://example.test/v1',
        getApiKey: async (provider) => {
            calls.push(provider);
            return provider === 'bailian' ? 'resolved-key' : undefined;
        },
    });

    assert.equal(calls.length, 0, 'composing must not resolve the API key');

    const binding = runtime.resolve('bailian', 'deepseek-flash');
    assert.ok(binding);
    assert.equal(calls.length, 0, 'resolving a binding must not resolve the API key');

    assert.equal(await binding.getApiKey?.('bailian'), 'resolved-key');
    assert.equal(calls.length, 1, 'first getApiKey resolves exactly once');

    assert.equal(await binding.getApiKey?.('bailian'), 'resolved-key');
    assert.equal(calls.length, 2, 'each getApiKey call resolves independently');
});

test('provider/model mismatch does not resolve the credential and returns no binding', async () => {
    let resolveCount = 0;
    const runtime = createOpenAICompatibleAgentModelRuntimeWithCredential({
        provider: 'bailian',
        model: 'deepseek-flash',
        baseUrl: 'https://example.test/v1',
        getApiKey: async () => {
            resolveCount += 1;
            return 'resolved-key';
        },
    });

    assert.equal(runtime.resolve('bailian', 'other-model'), null);
    assert.equal(runtime.resolve('other-provider', 'deepseek-flash'), null);
    assert.equal(resolveCount, 0, 'mismatched provider/model must not trigger resolution');

    const binding = runtime.resolve('bailian', 'deepseek-flash');
    assert.ok(binding);
    assert.equal(await binding.getApiKey?.('other-provider'), undefined);
    assert.equal(resolveCount, 0, 'provider-mismatched getApiKey must not trigger resolution');
});

test('a rejected credential resolver fails closed at invocation without echoing the ref value', async () => {
    const runtime = createOpenAICompatibleAgentModelRuntimeWithCredential({
        provider: 'bailian',
        model: 'deepseek-flash',
        baseUrl: 'https://example.test/v1',
        getApiKey: async () => {
            throw new ModelCredentialError('MODEL_API_KEY_UNRESOLVABLE', 'model API key could not be resolved');
        },
    });
    const binding = runtime.resolve('bailian', 'deepseek-flash');
    assert.ok(binding);
    await assert.rejects(binding.getApiKey?.('bailian') as Promise<unknown>, (error: unknown) =>
        error instanceof ModelCredentialError && error.code === 'MODEL_API_KEY_UNRESOLVABLE');
});

test('concurrent lazy getApiKey calls are isolated and each resolve once', async () => {
    const calls: string[] = [];
    const runtime = createOpenAICompatibleAgentModelRuntimeWithCredential({
        provider: 'bailian',
        model: 'deepseek-flash',
        baseUrl: 'https://example.test/v1',
        getApiKey: async (provider) => {
            calls.push(provider);
            return provider === 'bailian' ? 'resolved-key' : undefined;
        },
    });
    const binding = runtime.resolve('bailian', 'deepseek-flash');
    assert.ok(binding);
    const outcomes = await Promise.all(
        Array.from({length: 20}, () => binding.getApiKey?.('bailian')),
    );
    for (const value of outcomes) {
        assert.equal(value, 'resolved-key');
    }
    assert.equal(calls.length, 20, 'each concurrent call resolves independently');
});

test('environment runtime materializes RPA_AGENT_API_KEY only at getApiKey and never caches it', async () => {
    await withAgentEnv({
        RPA_AGENT_PROVIDER: 'bailian',
        RPA_AGENT_MODEL: 'deepseek-flash',
        RPA_AGENT_BASE_URL: 'https://example.test/v1',
        RPA_AGENT_API_KEY: undefined,
    }, async () => {
        const runtime = createEnvironmentAgentModelRuntime();
        const binding = runtime.resolve('bailian', 'deepseek-flash');
        assert.ok(binding);
        assert.equal(binding.model.provider, 'bailian');
        assert.equal(Object.hasOwn(binding.model, 'apiKey'), false);

        assert.equal(
            await binding.getApiKey?.('bailian'),
            undefined,
            'creating the runtime must not read RPA_AGENT_API_KEY',
        );

        process.env.RPA_AGENT_API_KEY = 'first-key';
        assert.equal(await binding.getApiKey?.('bailian'), 'first-key');

        process.env.RPA_AGENT_API_KEY = 'second-key';
        assert.equal(
            await binding.getApiKey?.('bailian'),
            'second-key',
            'a change to RPA_AGENT_API_KEY between calls must be observed, proving no cache',
        );
    });
});

test('environment runtime fails closed at invocation when the API key is missing or empty', async () => {
    await withAgentEnv({
        RPA_AGENT_PROVIDER: 'bailian',
        RPA_AGENT_MODEL: 'deepseek-flash',
        RPA_AGENT_BASE_URL: 'https://example.test/v1',
        RPA_AGENT_API_KEY: undefined,
    }, async () => {
        const runtime = createEnvironmentAgentModelRuntime();
        assert.ok(runtime.resolve('bailian', 'deepseek-flash'));
        assert.equal(
            await runtime.resolve('bailian', 'deepseek-flash')?.getApiKey?.('bailian'),
            undefined,
            'missing key returns undefined per the pi-agent contract, without exposing anything',
        );

        process.env.RPA_AGENT_API_KEY = '   ';
        assert.equal(
            await runtime.resolve('bailian', 'deepseek-flash')?.getApiKey?.('bailian'),
            undefined,
            'whitespace-only key is treated as missing',
        );
    });
});

test('environment runtime provider mismatch does not materialize the API key', async () => {
    await withAgentEnv({
        RPA_AGENT_PROVIDER: 'bailian',
        RPA_AGENT_MODEL: 'deepseek-flash',
        RPA_AGENT_BASE_URL: 'https://example.test/v1',
        RPA_AGENT_API_KEY: 'secret-key',
    }, async () => {
        const runtime = createEnvironmentAgentModelRuntime();
        assert.equal(runtime.resolve('bailian', 'other-model'), null);
        assert.equal(runtime.resolve('other-provider', 'deepseek-flash'), null);

        const binding = runtime.resolve('bailian', 'deepseek-flash');
        assert.ok(binding);
        assert.equal(await binding.getApiKey?.('other-provider'), undefined);
        assert.equal(await binding.getApiKey?.('bailian'), 'secret-key');
    });
});

test('environment runtime stays unbound when provider/model/baseUrl are incomplete', async () => {
    await withAgentEnv({
        RPA_AGENT_PROVIDER: 'bailian',
        RPA_AGENT_MODEL: '',
        RPA_AGENT_BASE_URL: 'https://example.test/v1',
        RPA_AGENT_API_KEY: 'secret-key',
    }, async () => {
        const runtime = createEnvironmentAgentModelRuntime();
        assert.equal(runtime.resolve('bailian', 'anything'), null);
    });

    await withAgentEnv({
        RPA_AGENT_PROVIDER: undefined,
        RPA_AGENT_MODEL: undefined,
        RPA_AGENT_BASE_URL: undefined,
        RPA_AGENT_API_KEY: undefined,
    }, async () => {
        const runtime = createEnvironmentAgentModelRuntime();
        assert.equal(runtime.resolve('anything', 'anything'), null);
    });
});
