import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunnerConfig } from '../../../src/platform/config/defaults';
import {loadRunnerConfig} from '../../../src/platform/config/loader';
import {parseSecretRef, secretRefToRefString} from '../../../src/platform/config/secret_ref';

const withRunnerFile = (json: unknown, run: (configPath: string) => void): void => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-config-'));
    const configPath = path.join(directory, 'runner.json');
    try {
        writeFileSync(configPath, JSON.stringify(json));
        run(configPath);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
};

const withEnv = (vars: Record<string, string>, run: () => void): void => {
    const previous = new Map<string, string | undefined>();
    for (const name of Object.keys(vars)) {previous.set(name, process.env[name]);}
    for (const [name, value] of Object.entries(vars)) {process.env[name] = value;}
    try {
        run();
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) {delete process.env[name];} else {process.env[name] = value;}
        }
    }
};

test('agent defaults preserve current delivery behavior', () => {
    const agent = defaultRunnerConfig.agent;
    assert.deepEqual(agent.model, {
        provider: '', model: '', baseUrl: '', apiKeyRef: 'env:RPA_AGENT_API_KEY',
    });
    assert.deepEqual(agent.service, {
        host: '127.0.0.1', port: 0, agentPath: '/agent', healthPath: '/health',
    });
    assert.deepEqual(agent.governance, {
        maxTurns: 50,
        maxToolCalls: 200,
        maxWorldEffects: 50,
        maxPostErrorEffects: 5,
        maxRecoveryAttempts: 3,
        wallClockDeadlineMs: 5 * 60 * 1000,
        irreversibleApproval: 'deny',
    });
    assert.equal(agent.sessions.storageRoot, '.artifacts/sessions');
    assert.equal(agent.sessions.retention.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(agent.reports.root, '.artifacts/reports');
    assert.equal(agent.auth.enabled, false);
    assert.equal(agent.auth.tokenRef, 'env:RPA_AGENT_AUTH_TOKEN');
    assert.equal(agent.interaction, 'interactive');
});

test('agent partial file overrides keep default siblings and drop unknown keys', () => {
    withRunnerFile({
        agent: {
            governance: {maxTurns: 12, bogus: 1},
            sessions: {retention: {maxAgeMs: 3_600_000}},
            service: {bogon: true},
        },
    }, (configPath) => {
        const agent = loadRunnerConfig({configPath}).agent;
        assert.equal(agent.governance.maxTurns, 12);
        assert.equal(agent.governance.maxToolCalls, 200);
        assert.equal(agent.governance.irreversibleApproval, 'deny');
        assert.equal(agent.sessions.retention.maxAgeMs, 3_600_000);
        assert.equal(agent.sessions.retention.maxCount, 100);
        assert.equal(agent.service.host, '127.0.0.1');
        assert.equal('bogus' in agent.governance, false);
        assert.equal('bogon' in agent.service, false);
    });
});

test('agent fully configured model defaults load', () => {
    withRunnerFile({
        agent: {
            model: {
                provider: 'openai',
                model: 'gpt-4.1',
                baseUrl: 'https://api.openai.com/v1',
                apiKeyRef: 'env:TEST_API_KEY',
            },
        },
    }, (configPath) => {
        const agent = loadRunnerConfig({configPath}).agent;
        assert.equal(agent.model.provider, 'openai');
        assert.equal(agent.model.model, 'gpt-4.1');
        assert.equal(agent.model.baseUrl, 'https://api.openai.com/v1');
        assert.equal(agent.model.apiKeyRef, 'env:TEST_API_KEY');
    });
});

test('agent rejects invalid governance budgets', () => {
    for (const governance of [
        {maxTurns: 0},
        {maxToolCalls: 2.5},
        {maxPostErrorEffects: -1},
    ]) {
        withRunnerFile({agent: {governance}}, (configPath) => {
            assert.throws(() => loadRunnerConfig({configPath}), /agent\.governance/);
        });
    }
});

test('agent rejects invalid approval and auth config', () => {
    withRunnerFile({agent: {governance: {irreversibleApproval: 'always-allow'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.governance\.irreversibleApproval/);
    });
    withRunnerFile({agent: {auth: {tokenRef: 'plain-secret'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.auth\.tokenRef/);
    });
    withRunnerFile({agent: {auth: {tokenRef: 'env:bad name'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.auth\.tokenRef/);
    });
    withRunnerFile({agent: {model: {apiKeyRef: 'env:'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.model\.apiKeyRef/);
    });
});

test('agent rejects partially configured model defaults', () => {
    withRunnerFile({agent: {model: {provider: 'openai'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.model/);
    });
});

test('agent rejects non-object agent shapes', () => {
    for (const shape of [{agent: null}, {agent: 5}, {agent: 'oops'}]) {
        withRunnerFile(shape, (configPath) => {
            assert.throws(() => loadRunnerConfig({configPath}), /agent config must be an object/);
        });
    }
});

test('agent rejects unsafe or malformed path shapes', () => {
    withRunnerFile({agent: {sessions: {storageRoot: ''}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.sessions\.storageRoot/);
    });
    withRunnerFile({agent: {reports: {root: 'a\u0000b'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.reports\.root/);
    });
    withRunnerFile({agent: {service: {agentPath: 'agent'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.service\.agentPath/);
    });
    withRunnerFile({agent: {service: {healthPath: '/health/../secret'}}}, (configPath) => {
        assert.throws(() => loadRunnerConfig({configPath}), /agent\.service\.healthPath/);
    });
    withRunnerFile({agent: {sessions: {storageRoot: '../shared/sessions'}}}, (configPath) => {
        const agent = loadRunnerConfig({configPath}).agent;
        assert.equal(agent.sessions.storageRoot, '../shared/sessions');
    });
});

test('agent environment overrides take precedence over file and defaults', () => {
    withRunnerFile({agent: {
        governance: {maxTurns: 10, maxToolCalls: 400},
        interaction: 'interactive',
        auth: {enabled: false},
    }}, (configPath) => {
        withEnv({
            RUNNER_AGENT_GOVERNANCE_MAX_TURNS: '99',
            RUNNER_AGENT_INTERACTION: 'headless',
            RUNNER_AGENT_AUTH_ENABLED: 'true',
            RUNNER_AGENT_AUTH_TOKEN_REF: 'env:TEST_AGENT_TOKEN',
            RUNNER_AGENT_SESSION_MAX_COUNT: '7',
            RUNNER_AGENT_PROVIDER: 'openai',
            RUNNER_AGENT_MODEL: 'gpt-4.1',
            RUNNER_AGENT_BASE_URL: 'https://api.openai.com/v1',
            RUNNER_AGENT_API_KEY_REF: 'file:.secrets/model.token',
        }, () => {
            const agent = loadRunnerConfig({configPath}).agent;
            assert.equal(agent.governance.maxTurns, 99);
            assert.equal(agent.governance.maxToolCalls, 400);
            assert.equal(agent.interaction, 'headless');
            assert.equal(agent.auth.enabled, true);
            assert.equal(agent.auth.tokenRef, 'env:TEST_AGENT_TOKEN');
            assert.equal(agent.sessions.retention.maxCount, 7);
            assert.equal(agent.model.provider, 'openai');
            assert.equal(agent.model.model, 'gpt-4.1');
            assert.deepEqual(agent.model.apiKeyRef, 'file:.secrets/model.token');
            assert.equal(agent.sessions.storageRoot, '.artifacts/sessions');
        });
    });
});

test('agent rejects non-numeric and invalid environment overrides', () => {
    withEnv({RUNNER_AGENT_GOVERNANCE_MAX_TURNS: 'abc'}, () => {
        assert.throws(() => loadRunnerConfig(), /agent\.governance\.maxTurns/);
    });
    withEnv({RUNNER_AGENT_SERVICE_PORT: '70000'}, () => {
        assert.throws(() => loadRunnerConfig(), /agent\.service\.port/);
    });
    withEnv({RUNNER_AGENT_INTERACTION: 'auto'}, () => {
        assert.throws(() => loadRunnerConfig(), /agent\.interaction/);
    });
});

test('agent serialized config contains references, never secret values', () => {
    const serialized = JSON.stringify(defaultRunnerConfig.agent);
    assert.match(serialized, /env:RPA_AGENT_API_KEY/);
    assert.match(serialized, /env:RPA_AGENT_AUTH_TOKEN/);
    assert.doesNotMatch(serialized, /sk-test-secret/);

    withRunnerFile({
        agent: {
            model: {
                provider: 'openai',
                model: 'gpt-4.1',
                baseUrl: 'https://api.openai.com/v1',
                apiKeyRef: 'file:.secrets/model.token',
            },
            auth: {enabled: true, tokenRef: 'file:.secrets/agent.token'},
        },
    }, (configPath) => {
        const out = JSON.stringify(loadRunnerConfig({configPath}).agent);
        assert.match(out, /file:\.secrets\/model\.token/);
        assert.match(out, /file:\.secrets\/agent\.token/);
        assert.doesNotMatch(out, /sk-test-secret/);
        assert.equal(out.includes('"apiKey"'), false);
        assert.equal(out.includes('"token"'), false);
    });
});

test('secret ref helpers encode and parse env and file references', () => {
    assert.deepEqual(parseSecretRef('env:RPA_AGENT_API_KEY'), {kind: 'env', envName: 'RPA_AGENT_API_KEY'});
    assert.deepEqual(parseSecretRef('file:.secrets/agent.token'), {kind: 'file', filePath: '.secrets/agent.token'});
    assert.equal(secretRefToRefString({kind: 'env', envName: 'X'}), 'env:X');
    assert.equal(secretRefToRefString({kind: 'file', filePath: 'p'}), 'file:p');
    assert.throws(() => parseSecretRef(''), /secretRef/);
    assert.throws(() => parseSecretRef('env:-bad'), /secretRef/);
    assert.throws(() => parseSecretRef('raw'), /secretRef/);
});