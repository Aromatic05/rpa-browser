import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
if (args.length === 0) {
    throw new Error('run_tests_isolated requires Node test arguments');
}

const processRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-test-processes-'));
const isolationImport = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'test_process_isolation.mjs',
);
const child = spawn(process.execPath, ['--import', isolationImport, ...args], {
    cwd: process.cwd(),
    env: {...process.env, RPA_TEST_PROCESS_ROOT: processRoot},
    stdio: 'inherit',
});

const forwardSignal = (signal) => {
    if (!child.killed) {
        child.kill(signal);
    }
};
process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));

let exitCode = 1;
try {
    exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                resolve(1);
                return;
            }
            resolve(code ?? 1);
        });
    });
} finally {
    await fs.rm(processRoot, {recursive: true, force: true});
}

process.exitCode = exitCode;
