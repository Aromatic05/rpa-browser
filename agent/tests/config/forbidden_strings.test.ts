import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SKIP = new Set(['.git', 'node_modules']);
const FORBIDDEN = [['tab', 'Token'].join(''), ['workspace', 'Id'].join('')];

const walk = (dir: string, out: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) {continue;}
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        } else {
            out.push(full);
        }
    }
};

test('forbidden address strings are absent', () => {
    const files: string[] = [];
    walk(ROOT, files);
    const hits: Array<{ file: string; token: string }> = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const token of FORBIDDEN) {
            if (text.includes(token)) {
                hits.push({ file: path.relative(ROOT, file), token });
            }
        }
    }
    assert.equal(hits.length, 0, JSON.stringify(hits.slice(0, 20), null, 2));
});
