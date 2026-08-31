import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createAgentModelSettings} from '../../../../src/agent/model/settings';
import {createSecretRefResolver, envOf, nodeFileSystem} from '../../../../src/platform/security';

const emptyModel = {
    provider: '',
    model: '',
    baseUrl: '',
    apiKeyRef: 'env:RPA_AGENT_API_KEY',
};

test('first-run model setup persists only a secret reference and updates the live runtime', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-model-setup-'));
    try {
        const resolver = createSecretRefResolver({
            env: envOf({}),
            fs: nodeFileSystem(),
            baseDir,
            requirePrivateFileMode: true,
        });
        const settings = createAgentModelSettings({initial: emptyModel, secretResolver: resolver, baseDir});
        assert.deepEqual(settings.status(), {configured: false, credentialConfigured: false});

        const status = await settings.configure({
            provider: 'openai-compatible',
            model: 'model-x',
            baseUrl: 'https://example.test/v1/',
            apiKey: 'secret-value',
        });
        assert.deepEqual(status, {
            configured: true,
            credentialConfigured: true,
            provider: 'openai-compatible',
            model: 'model-x',
            baseUrl: 'https://example.test/v1',
        });

        const configText = await fs.readFile(path.join(baseDir, '.rpa', 'runner_config.json'), 'utf8');
        assert.equal(configText.includes('secret-value'), false, 'runner config must never contain the API key');
        const persisted = JSON.parse(configText) as any;
        assert.match(persisted.agent.model.apiKeyRef, /^file:/);

        const secretPath = path.join(baseDir, '.rpa', 'secrets', 'model-api-key');
        assert.equal((await fs.stat(secretPath)).mode & 0o077, 0, 'model secret must not be group/world readable');
        assert.equal((await fs.readFile(secretPath, 'utf8')).trim(), 'secret-value');

        const binding = settings.runtime.resolve('openai-compatible', 'model-x');
        assert.ok(binding, 'new model is available without restarting the Agent');
        assert.equal(await binding.getApiKey?.('openai-compatible'), 'secret-value');
        assert.deepEqual(settings.defaults(), {provider: 'openai-compatible', model: 'model-x'});
    } finally {
        await fs.rm(baseDir, {recursive: true, force: true});
    }
});

test('updating model identity can retain an already configured credential', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-model-setup-retain-'));
    try {
        const resolver = createSecretRefResolver({
            env: envOf({}),
            fs: nodeFileSystem(),
            baseDir,
            requirePrivateFileMode: true,
        });
        const settings = createAgentModelSettings({initial: emptyModel, secretResolver: resolver, baseDir});
        await settings.configure({provider: 'p', model: 'm1', baseUrl: 'https://example.test/v1', apiKey: 'secret'});
        const status = await settings.configure({provider: 'p', model: 'm2', baseUrl: 'https://example.test/v1'});
        assert.equal(status.credentialConfigured, true);
        assert.equal(await settings.runtime.resolve('p', 'm2')?.getApiKey?.('p'), 'secret');
    } finally {
        await fs.rm(baseDir, {recursive: true, force: true});
    }
});
