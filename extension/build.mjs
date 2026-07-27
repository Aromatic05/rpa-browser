import { mkdir, copyFile, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDir = path.join(root, 'dist');

await mkdir(distDir, { recursive: true });
await copyFile(path.join(root, 'manifest.json'), path.join(distDir, 'manifest.json'));

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
