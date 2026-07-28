import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotRoot = path.join(agentRoot, 'src/snapshot');

const expectedBranches: Record<string, readonly string[]> = {
    '.': ['components', 'indexes', 'observation', 'rules'],
    observation: ['analysis', 'capture', 'model', 'replay'],
    indexes: ['locator', 'ownership', 'relation'],
    components: ['control', 'form', 'shared', 'table'],
    rules: ['matching', 'model', 'runtime'],
    'components/control': ['action', 'assembly', 'capture', 'model'],
    'components/form': ['assembly', 'capture', 'model', 'replay'],
    'components/table': ['assembly', 'model'],
};

const moduleRanks: Record<string, number> = {
    'observation/model': 0,
    'indexes/relation': 1,
    'indexes/locator': 1,
    'indexes/ownership': 1,
    'observation/analysis': 2,
    'observation/capture': 3,
    'observation/replay': 3,
    'components/shared': 4,
    'components/control/model': 5,
    'components/control/assembly': 6,
    'components/control/capture': 7,
    'components/control/action': 8,
    'components/form/model': 9,
    'components/form/assembly': 10,
    'components/form/capture': 11,
    'components/form/replay': 11,
    'components/table/model': 12,
    'components/table/assembly': 13,
    'rules/model': 14,
    'rules/matching': 15,
    'rules/runtime': 16,
};

const legacyDirectoryNames = new Set([
    'analysis',
    'capture',
    'component',
    'control',
    'entity_rule',
    'form',
    'laboratory',
    'locator',
    'ownership',
    'relation',
]);

const listDirectories = (directory: string): string[] => fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const listFiles = (directory: string): string[] => fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

const walkTypescript = (directory: string): string[] => fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {return walkTypescript(target);}
        return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
    });

const moduleOf = (filePath: string): string | null => {
    const relative = path.relative(snapshotRoot, filePath).split(path.sep);
    if (relative[0] === 'observation' && relative.length >= 3) {return relative.slice(0, 2).join('/');}
    if (relative[0] === 'indexes' && relative.length >= 3) {return relative.slice(0, 2).join('/');}
    if (relative[0] === 'rules' && relative.length >= 3) {return relative.slice(0, 2).join('/');}
    if (relative[0] === 'components' && relative[1] === 'shared') {return 'components/shared';}
    if (relative[0] === 'components'
        && (relative[1] === 'control' || relative[1] === 'form' || relative[1] === 'table')
        && relative.length >= 4) {
        return relative.slice(0, 3).join('/');
    }
    return null;
};

const resolveRelativeImport = (sourceFile: string, specifier: string): string | null => {
    const base = path.resolve(path.dirname(sourceFile), specifier);
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) {return candidate;}
    }
    return null;
};

test('snapshot folders contain peer modules at each branch', () => {
    assert.deepEqual(listFiles(snapshotRoot), ['index.ts']);
    for (const [relative, expected] of Object.entries(expectedBranches)) {
        const directory = relative === '.' ? snapshotRoot : path.join(snapshotRoot, relative);
        assert.deepEqual(listDirectories(directory), [...expected].sort(), relative);
        assert.deepEqual(listFiles(directory), ['index.ts'], relative);
    }

    for (const modulePath of Object.keys(moduleRanks)) {
        const directory = path.join(snapshotRoot, modulePath);
        assert.equal(listDirectories(directory).length, 0, `${modulePath} must be a leaf module`);
        assert.ok(listFiles(directory).every((name) => name.endsWith('.ts')), modulePath);
    }

    assert.equal(fs.existsSync(path.join(agentRoot, 'src/entity_rules')), false);
    assert.equal(fs.existsSync(path.join(snapshotRoot, 'entity_rule')), false);
    for (const name of listDirectories(snapshotRoot)) {
        assert.equal(legacyDirectoryNames.has(name), false, `legacy top-level snapshot directory: ${name}`);
    }
});

test('snapshot dependencies point inward and never reverse layer direction', () => {
    const importPattern = /(?:from\s+|import\s*\()(['"])(\.[^'"]+)\1/g;
    for (const sourceFile of walkTypescript(snapshotRoot)) {
        if (path.basename(sourceFile) === 'index.ts') {continue;}
        const sourceModule = moduleOf(sourceFile);
        assert.ok(sourceModule, `unclassified snapshot source: ${path.relative(snapshotRoot, sourceFile)}`);
        const sourceRank = moduleRanks[sourceModule];
        const source = fs.readFileSync(sourceFile, 'utf8');

        for (const match of source.matchAll(importPattern)) {
            const specifier = match[2];
            const targetFile = resolveRelativeImport(sourceFile, specifier);
            assert.ok(targetFile, `${path.relative(snapshotRoot, sourceFile)} has unresolved import ${specifier}`);

            if (!targetFile.startsWith(snapshotRoot + path.sep)) {
                assert.equal(sourceModule, 'rules/runtime', `${sourceModule} must not import project code outside snapshot`);
                continue;
            }

            const targetModule = moduleOf(targetFile);
            if (!targetModule) {continue;}
            const targetRank = moduleRanks[targetModule];
            assert.ok(
                targetRank <= sourceRank,
                `${sourceModule} must not depend on higher layer ${targetModule}: ${path.relative(snapshotRoot, sourceFile)}`,
            );
        }
    }
});
