import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRunnerConfig } from '../../../src/config/defaults';

// 样例目标：确保核心默认配置可读且包含关键治理开关。
test('default runner config exposes stable governance defaults', () => {
    assert.equal(defaultRunnerConfig.waitPolicy.defaultTimeoutMs, 1000);
    assert.equal(defaultRunnerConfig.retryPolicy.enabled, false);
    assert.equal(defaultRunnerConfig.checkpointPolicy.enabled, true);
    assert.ok(defaultRunnerConfig.mcpPolicy.disableTools.includes('browser.read_console'));
});
