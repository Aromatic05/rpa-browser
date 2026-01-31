import { mkdir, copyFile } from 'fs/promises';
import path from 'path';

const root = new URL('.', import.meta.url).pathname;
const distDir = path.join(root, 'dist');

await mkdir(distDir, { recursive: true });
await mkdir(path.join(distDir, 'pages'), { recursive: true });
await copyFile(path.join(root, 'manifest.json'), path.join(distDir, 'manifest.json'));
await copyFile(path.join(root, 'panel.html'), path.join(distDir, 'panel.html'));
await copyFile(path.join(root, 'pages', 'start.html'), path.join(distDir, 'pages', 'start.html'));
await copyFile(path.join(root, 'pages', 'start.css'), path.join(distDir, 'pages', 'start.css'));
await copyFile(path.join(root, 'pages', 'start.js'), path.join(distDir, 'pages', 'start.js'));
