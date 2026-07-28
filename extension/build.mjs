import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDir = path.join(root, 'dist');
const buildId = (process.env.RPA_EXTENSION_BUILD_ID || '').trim() || `direct-${Date.now()}`;

await mkdir(distDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
manifest.version_name = buildId;
await writeFile(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
await writeFile(
    path.join(distDir, 'rpa-build.json'),
    `${JSON.stringify({buildId, builtAt: new Date().toISOString()}, null, 2)}\n`,
    'utf8',
);
