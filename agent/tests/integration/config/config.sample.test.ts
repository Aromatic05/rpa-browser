import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunnerConfig } from '../../../src/config/defaults';
import {loadRunnerConfig} from '../../../src/config/loader';

// 样例目标：确保核心默认配置可读且包含关键治理开关。
test('default runner config exposes stable governance defaults', () => {
    assert.equal(defaultRunnerConfig.waitPolicy.defaultTimeoutMs, 1000);
    assert.equal(defaultRunnerConfig.retryPolicy.enabled, false);
    assert.equal(defaultRunnerConfig.checkpointPolicy.enabled, true);
    assert.ok(defaultRunnerConfig.mcpPolicy.disableTools.includes('browser.read_console'));
});


test('runner config ignores retired and unknown fields from files and environment', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'runner-config-'));
    const configPath = path.join(directory, 'runner.json');
    const previous = process.env.RUNNER_CONFIDENCE_ENABLED;
    try {
        writeFileSync(configPath, JSON.stringify({
            confidencePolicy: {enabled: false, minScore: 0.99},
            unknownPolicy: {enabled: true},
            waitPolicy: {defaultTimeoutMs: 4321},
        }));
        process.env.RUNNER_CONFIDENCE_ENABLED = 'true';
        const config = loadRunnerConfig({configPath});
        assert.equal(config.waitPolicy.defaultTimeoutMs, 4321);
        assert.equal('confidencePolicy' in config, false);
        assert.equal('unknownPolicy' in config, false);
    } finally {
        if (previous === undefined) {
            delete process.env.RUNNER_CONFIDENCE_ENABLED;
        } else {
            process.env.RUNNER_CONFIDENCE_ENABLED = previous;
        }
        rmSync(directory, {recursive: true, force: true});
    }
});
