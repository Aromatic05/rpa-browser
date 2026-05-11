import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunnerConfig } from '../../../src/config/defaults';
import { getLogger, initLogger, resolveLogPath } from '../../../src/logging/logger';

// 样例目标：验证 infra.error 会落盘为 JSONL（同步写入分支）。
test('infra error logger writes JSONL file to configured path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-logging-sample-'));
    const template = path.join(tempDir, 'infra-{ts}.log');
    const expectedPath = resolveLogPath(template);

    initLogger({
        ...defaultRunnerConfig,
        observability: {
            ...defaultRunnerConfig.observability,
            consoleLogLevel: 'error',
            fileLogLevel: 'debug',
            infraConsoleEnabled: false,
            infraFileEnabled: true,
            infraFilePath: template,
        },
    });

    const log = getLogger('infra');
    log.error('sample-error', { source: 'logging.sample.test' });

    assert.equal(fs.existsSync(expectedPath), true);
    const lines = fs.readFileSync(expectedPath, 'utf8').trim().split('\n');
    assert.equal(lines.length >= 1, true);

    const payload = JSON.parse(lines.at(-1) || '{}') as {
        type?: string;
        level?: string;
        message?: unknown[];
    };
    assert.equal(payload.type, 'infra');
    assert.equal(payload.level, 'error');
    assert.equal(Array.isArray(payload.message), true);
});
