import {copyFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(
    agentRoot,
    'src',
    'automation',
    'recording',
    'capture',
    'payload.bundle.js',
);
const outputDir = path.join(agentRoot, '.dist', 'resources', 'recording');
const output = path.join(outputDir, 'payload.bundle.js');

await mkdir(outputDir, {recursive: true});
await copyFile(source, output);
