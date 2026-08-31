import { copyFile, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {buildIdToManifestVersion} from '../scripts/extension_version.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDir = path.join(root, 'dist');
const buildId = (process.env.RPA_EXTENSION_BUILD_ID || '').trim() || `direct-${Date.now()}`;
const manifestVersion = buildIdToManifestVersion(buildId);

await mkdir(distDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
manifest.version = manifestVersion;
manifest.version_name = buildId;
await writeFile(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
await writeFile(
    path.join(distDir, 'rpa-build.json'),
    `${JSON.stringify({buildId, manifestVersion, builtAt: new Date().toISOString()}, null, 2)}\n`,
    'utf8',
);
await copyFile(path.join(root, 'newtab.html'), path.join(distDir, 'newtab.html'));

const serviceWorkerPath = path.join(distDir, 'entry', 'sw.js');
const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
await writeFile(serviceWorkerPath, `// rpa-extension-build:${buildId}\n${serviceWorker}`, 'utf8');


const annotatorDir = path.join(distDir, 'annotator');
const annotatorCssPath = path.join(annotatorDir, 'annotator.css');
const annotatorJsPath = path.join(annotatorDir, 'annotator.js');
const componentCss = await readFile(annotatorCssPath, 'utf8');
const annotatorJs = await readFile(annotatorJsPath, 'utf8');
await writeFile(
    annotatorJsPath,
    `globalThis.__rpaAnnotatorComponentCss = ${JSON.stringify(componentCss)};\n${annotatorJs}`,
);
await unlink(annotatorCssPath);
