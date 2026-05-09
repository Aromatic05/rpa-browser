/**
 * RunnerConfig 测试：
 * - 默认加载
 * - env 覆盖
 * - 合并规则稳定
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRunnerConfig } from '../../src/config/loader';

test('load default config', () => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    assert.ok(config.waitPolicy.defaultTimeoutMs > 0);
    assert.equal(config.waitPolicy.highlightBeforeActionMs, 250);
    assert.equal(config.humanPolicy.enabled, true);
    assert.equal(config.observability.traceFileEnabled, true);
    assert.equal(config.observability.actionFileEnabled, true);
    assert.equal(config.observability.traceConsoleEnabled, false);
    assert.equal(config.observability.actionConsoleEnabled, true);
    assert.equal(config.observability.recordConsoleEnabled, true);
    assert.equal(config.observability.recordFileEnabled, true);
    assert.equal(config.checkpointPolicy.enabled, true);
    assert.ok(config.checkpointPolicy.filePath.length > 0);
});

test('env overrides', () => {
    process.env.RUNNER_DEFAULT_TIMEOUT_MS = '1234';
    process.env.RUNNER_RETRY_ENABLED = 'true';
    process.env.RUNNER_CHECKPOINT_ENABLED = 'false';
    process.env.RUNNER_HIGHLIGHT_BEFORE_ACTION_MS = '111';
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    assert.equal(config.waitPolicy.defaultTimeoutMs, 1234);
    assert.equal(config.retryPolicy.enabled, true);
    assert.equal(config.checkpointPolicy.enabled, false);
    assert.equal(config.waitPolicy.highlightBeforeActionMs, 111);
    delete process.env.RUNNER_DEFAULT_TIMEOUT_MS;
    delete process.env.RUNNER_RETRY_ENABLED;
    delete process.env.RUNNER_CHECKPOINT_ENABLED;
    delete process.env.RUNNER_HIGHLIGHT_BEFORE_ACTION_MS;
});

test('merge file config', () => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    assert.ok(config.waitPolicy.navigationTimeoutMs > 0);
});
