import { mkdir, copyFile, readFile, writeFile } from 'fs/promises';
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
await writeFile(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(
  path.join(distDir, 'rpa-build.json'),
  `${JSON.stringify({buildId, manifestVersion, builtAt: new Date().toISOString()}, null, 2)}\n`,
  'utf8',
);
await copyFile(path.join(root, 'newtab.html'), path.join(distDir, 'newtab.html'));
