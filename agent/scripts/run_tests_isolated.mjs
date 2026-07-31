import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
    throw new Error('run_tests_isolated requires Node test arguments');
}

const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-test-workflows-'));
const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {...process.env, RPA_WORKFLOW_ROOT: workflowRoot},
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
    await fs.rm(workflowRoot, {recursive: true, force: true});
}

process.exitCode = exitCode;
