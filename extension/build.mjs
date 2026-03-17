import { mkdir, copyFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDir = path.join(root, 'dist');

await mkdir(distDir, { recursive: true });
await copyFile(path.join(root, 'manifest.json'), path.join(distDir, 'manifest.json'));
