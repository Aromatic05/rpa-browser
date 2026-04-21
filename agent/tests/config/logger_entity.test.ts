import test from 'node:test';
import assert from 'node:assert/strict';
import { getLogger, initLogger } from '../../src/logging/logger';
import { loadRunnerConfig } from '../../src/config/loader';

test('logger supports entity log type and emits with trace console policy', () => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    config.observability.traceConsoleEnabled = true;
    config.observability.traceLogLevel = 'info';
    config.observability.traceFileEnabled = false;

    initLogger(config);

    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
        logs.push(args);
    };

    try {
        const logger = getLogger('entity');
        logger.info('entity.rules.match.hit', { profile: 'oa-ant-orders', ruleId: 'main' });
    } finally {
        console.log = originalLog;
    }

    assert.equal(logs.length > 0, true);
    assert.equal(String(logs[0]?.[0]).includes('[entity]'), true);
});
