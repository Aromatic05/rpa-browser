import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve(import.meta.dirname, '../../../src');
const contexts = ['agent', 'app', 'automation', 'interface', 'platform', 'program', 'security'] as const;
type Context = typeof contexts[number];

const allowedDependencies: Record<Context, ReadonlySet<Context>> = {
    security: new Set(),
    platform: new Set(['security']),
    program: new Set(),
    interface: new Set(['platform', 'security']),
    automation: new Set(['interface', 'platform', 'program', 'security']),
    agent: new Set(['automation', 'interface', 'platform', 'program', 'security']),
    app: new Set(['agent', 'automation', 'interface', 'platform', 'program', 'security']),
};

const walkTypescript = (directory: string): string[] => fs
    .readdirSync(directory, {withFileTypes: true})
    .flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {return walkTypescript(target);}
        return entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) ? [target] : [];
    });

const resolveImport = (sourceFile: string, specifier: string): string | null => {
    const base = path.resolve(path.dirname(sourceFile), specifier);
    for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, 'index.ts'),
        path.join(base, 'index.tsx'),
    ]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {return candidate;}
    }
    return null;
};

const contextOf = (filePath: string): Context | null => {
    const relative = path.relative(sourceRoot, filePath).split(path.sep)[0];
    return contexts.includes(relative as Context) ? relative as Context : null;
};

test('source root exposes only bounded contexts and no flat implementation files', () => {
    const entries = fs.readdirSync(sourceRoot, {withFileTypes: true});
    assert.equal(entries.some((entry) => entry.isFile()), false);
    assert.deepEqual(
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
        [...contexts].sort(),
    );
});

test('bounded context imports preserve the architectural dependency direction', () => {
    const importPattern = /(?:from\s+|import\s*\()(['"])(\.[^'"]+)\1/g;
    for (const sourceFile of walkTypescript(sourceRoot)) {
        const sourceContext = contextOf(sourceFile);
        assert.ok(sourceContext, `unclassified source: ${path.relative(sourceRoot, sourceFile)}`);
        const source = fs.readFileSync(sourceFile, 'utf8');
        for (const match of source.matchAll(importPattern)) {
            const targetFile = resolveImport(sourceFile, match[2]);
            if (!targetFile || !targetFile.startsWith(sourceRoot + path.sep)) {continue;}
            const targetContext = contextOf(targetFile);
            if (!targetContext || targetContext === sourceContext) {continue;}
            assert.equal(
                allowedDependencies[sourceContext].has(targetContext),
                true,
                `${sourceContext} must not depend on ${targetContext}: ${path.relative(sourceRoot, sourceFile)} -> ${path.relative(sourceRoot, targetFile)}`,
            );
        }
    }
});
