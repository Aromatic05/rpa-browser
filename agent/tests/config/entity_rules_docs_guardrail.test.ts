import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const docsDir = path.resolve(process.cwd(), '../docs');
const legacyPathPattern = /agent\/\.artifacts\/entity_rules\/profiles(?:\/<profile>|\b|\*)/;

test('docs only mention legacy entity rule artifact path as fallback or legacy', () => {
    const markdownFiles = listMarkdownFiles(docsDir);
    const violations: string[] = [];

    for (const filePath of markdownFiles) {
        const source = fs.readFileSync(filePath, 'utf-8');
        const lines = source.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!legacyPathPattern.test(line)) {continue;}

            const lower = line.toLowerCase();
            if (lower.includes('legacy') || lower.includes('fallback')) {continue;}
            violations.push(`${path.relative(path.resolve(process.cwd(), '..'), filePath)}:${index + 1}`);
        }
    }

    assert.deepEqual(violations, []);
});

const listMarkdownFiles = (dirPath: string): string[] => {
    const output: string[] = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const nextPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            output.push(...listMarkdownFiles(nextPath));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
            output.push(nextPath);
        }
    }
    return output.sort((left, right) => left.localeCompare(right));
};
