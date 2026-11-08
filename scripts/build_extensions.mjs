import {randomUUID} from 'node:crypto';
import {cp, mkdir, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnPnpm} from './dev_cdp_runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildId = (process.env.RPA_EXTENSION_BUILD_ID || '').trim() ||
    `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;

const run = (args) => new Promise((resolve, reject) => {
    const child = spawnPnpm(args, {
        cwd: root,
        env: {...process.env, RPA_EXTENSION_BUILD_ID: buildId},
        stdio: 'inherit',
        detached: false,
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

const stampDir = path.join(root, '.dev');
const versionsDir = path.join(stampDir, 'extensions');
const versionDir = path.join(versionsDir, buildId);
const mainExtensionPath = path.join(versionDir, 'main');
const stampPath = path.join(stampDir, 'extension-build.json');
const tempPath = `${stampPath}.${process.pid}.tmp`;

await rm(versionDir, {recursive: true, force: true});
await mkdir(versionDir, {recursive: true});
await cp(path.join(root, 'extension', 'dist'), mainExtensionPath, {recursive: true});

const buildInfo = {
    buildId,
    builtAt: new Date().toISOString(),
    mainExtensionPath,
};
await mkdir(stampDir, {recursive: true});
await writeFile(tempPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
await rename(tempPath, stampPath);

const retained = 3;
const versions = (await readdir(versionsDir, {withFileTypes: true}))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
await Promise.all(versions.slice(retained).map(async (name) => {
    await rm(path.join(versionsDir, name), {recursive: true, force: true});
}));

console.log(`[rpa-extension] built ${buildId}`);
