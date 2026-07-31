import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('root package scripts only address existing workspace directories', () => {
    for (const [name, command] of Object.entries(packageJson.scripts)) {
        const matches = [...String(command).matchAll(/pnpm\s+-C\s+([^\s]+)/g)];
        for (const match of matches) {
            const directory = path.resolve(root, match[1]);
            assert.equal(
                existsSync(path.join(directory, 'package.json')),
                true,
                `script ${name} points to missing package directory ${match[1]}`,
            );
        }
    }
});

test('root typecheck delegates to package typecheck contracts', () => {
    assert.equal(packageJson.scripts['typecheck:agent'], 'pnpm --filter ./agent typecheck');
    assert.equal(packageJson.scripts['typecheck:extension'], 'pnpm --filter ./extension typecheck');
});

test('documentation index only lists existing documents', () => {
    const source = readFileSync(path.join(root, 'docs/README.md'), 'utf8');
    const references = [...source.matchAll(/`((?:Contract|Runtime|Architecture|Development)\/[^`]+\.md)`/g)]
        .map((match) => match[1]);
    assert.ok(references.length > 0);
    for (const reference of references) {
        assert.equal(existsSync(path.join(root, 'docs', reference)), true, `missing indexed document: ${reference}`);
    }
});
