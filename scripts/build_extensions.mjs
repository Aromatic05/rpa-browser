import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildId = (process.env.RPA_EXTENSION_BUILD_ID || '').trim() ||
    `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;

const run = (args) => new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
        cwd: root,
        env: {...process.env, RPA_EXTENSION_BUILD_ID: buildId},
        stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(`pnpm ${args.join(' ')} failed: code=${String(code)} signal=${String(signal)}`));
    });
});

await run(['--filter', './extension', 'build']);
await run(['--filter', './start_extension', 'build']);

const stampDir = path.join(root, '.dev');
const stampPath = path.join(stampDir, 'extension-build.json');
const tempPath = `${stampPath}.${process.pid}.tmp`;
const buildInfo = {
    buildId,
    builtAt: new Date().toISOString(),
    mainExtensionPath: path.join(root, 'extension', 'dist'),
    startExtensionPath: path.join(root, 'start_extension', 'dist'),
};
await mkdir(stampDir, {recursive: true});
await writeFile(tempPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
await rename(tempPath, stampPath);
console.log(`[rpa-extension] built ${buildId}`);
