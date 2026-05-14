import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type MatchResult = {
    filePath: string;
    pattern: RegExp;
    sample: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const IGNORE_DIRS = new Set(['node_modules', '.git', '.artifacts', 'test-results', '.runner-hot', '.runner-dist']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

const listFiles = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (IGNORE_DIRS.has(entry.name)) {
                continue;
            }
            files.push(...listFiles(path.join(dir, entry.name)));
            continue;
        }
        if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (SOURCE_EXTS.has(ext)) {
                files.push(path.join(dir, entry.name));
            }
        }
    }
    return files;
};

const scanPattern = (filePath: string, pattern: RegExp): MatchResult | null => {
    const text = fs.readFileSync(filePath, 'utf8');
    const match = text.match(pattern);
    if (!match) {
        return null;
    }
    return { filePath, pattern, sample: match[0] };
};

test('repo does not contain dirty duplicate tabName patterns', () => {
    const patterns: RegExp[] = [
        /tabName\s*,\s*tabName/,
        /tabName\s*:[ \t]*[^\n]*\n[ \t]*tabName\s*:/,
        /Pick<[^>\n]*'tabName'[^>\n]*'tabName'[^>\n]*>/,
        /pageIdentity\s*:\s*\{[\s\S]{0,160}tabName\s*:[^\n]*\n[ \t]*tabName\s*:/,
        /\btabName\s*:\s*[^,\n}]+,\s*tabName\s*:/,
    ];

    const files = listFiles(path.join(ROOT, 'src'));
    const matches: MatchResult[] = [];
    for (const filePath of files) {
        for (const pattern of patterns) {
            const hit = scanPattern(filePath, pattern);
            if (hit) {
                matches.push(hit);
            }
        }
    }

    if (matches.length === 0) {
        assert.ok(true);
        return;
    }

    const message = matches
        .map((item) => `pattern=${item.pattern} file=${path.relative(ROOT, item.filePath)} sample=${item.sample}`)
        .join('\n');
    assert.fail(`dirty patterns found:\n${message}`);
});
