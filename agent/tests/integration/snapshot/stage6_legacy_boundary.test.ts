import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const productionRoots = [
    path.join(agentDirectory, 'src'),
    path.join(repositoryDirectory, 'extension/src'),
    path.join(repositoryDirectory, 'start_extension/src'),
    path.join(repositoryDirectory, 'shared'),
];

const forbiddenPaths = [
    'agent/src/runner/steps/executors/snapshot',
    'agent/src/runner/steps/executors/entity_context.ts',
    'agent/src/runner/steps/helpers/resolve_target.ts',
    'agent/src/runner/steps/resolve_builder.ts',
    'agent/src/runner/trace/runtime/getRuntimeStateMap.ts',
];

const forbiddenProductionTokens = [
    'businessEntityOverlay',
    'ruleEntityOverlay',
    'latestSnapshot',
    'snapshotSessionStore',
    'resolveEntityElement',
    'FinalEntityView',
    'SAME_KIND_NEST_DROP',
    'TABLE_PER_FAMILY_LIMIT',
    'RUNNER_CONFIDENCE_',
    'focus_only',
    'recordSnapshotCache',
    'SNAPSHOT_CACHE_TTL_MS',
];

const forbiddenImportFragments = [
    '/executors/snapshot/',
    '/snapshot/core/',
    '/snapshot/pipeline/',
    '/snapshot/stages/',
    '/entity_context',
    '/resolve_builder',
];

test('Stage 6 keeps retired V1 runtime paths absent', () => {
    for (const relativePath of forbiddenPaths) {
        assert.equal(
            fs.existsSync(path.join(repositoryDirectory, relativePath)),
            false,
            `retired V1 path returned: ${relativePath}`,
        );
    }
});

test('Stage 6 production sources contain no V1 cache overlay or matcher contracts', () => {
    for (const file of productionFiles()) {
        const source = fs.readFileSync(file, 'utf8');
        for (const token of forbiddenProductionTokens) {
            assert.equal(source.includes(token), false, `${relative(file)} contains retired token ${token}`);
        }
        for (const specifier of relativeImports(source)) {
            for (const fragment of forbiddenImportFragments) {
                assert.equal(
                    specifier.includes(fragment),
                    false,
                    `${relative(file)} imports retired V1 module ${specifier}`,
                );
            }
        }
    }
});

test('Stage 6 production relative imports resolve to tracked source modules', () => {
    const missing: string[] = [];
    for (const file of productionFiles()) {
        const source = fs.readFileSync(file, 'utf8');
        for (const specifier of relativeImports(source)) {
            if (!resolveImport(file, specifier)) {
                missing.push(`${relative(file)} -> ${specifier}`);
            }
        }
    }
    assert.deepEqual(missing, []);
});




test('Snapshot viewer consumes only V2 projection contracts', () => {
    const viewerRoot = path.join(agentDirectory, 'debug/snapshot-viewer');
    const viewerFiles = [
        path.join(viewerRoot, 'server/snapshotApi.ts'),
        path.join(viewerRoot, 'src/App.vue'),
        path.join(viewerRoot, 'src/types.ts'),
    ];
    const forbidden = [
        'executors/snapshot/stages',
        'executors/snapshot/pipeline',
        'generateSemanticSnapshot',
        'unifiedGraph',
        'nodeIndex',
        'entityIndex',
        'locatorIndex',
        'bboxIndex',
        'attrIndex',
        'contentStore',
        'businessEntityOverlay',
        'ruleEntityOverlay',
    ];
    for (const file of viewerFiles) {
        const source = fs.readFileSync(file, 'utf8');
        for (const token of forbidden) {
            assert.equal(source.includes(token), false, `${relative(file)} contains V1 viewer token ${token}`);
        }
    }
    const types = fs.readFileSync(path.join(viewerRoot, 'src/types.ts'), 'utf8');
    assert.equal(types.includes('schemaVersion: 2'), true);
    const server = fs.readFileSync(path.join(viewerRoot, 'server/snapshotApi.ts'), 'utf8');
    for (const required of ['captureControlSnapshot', 'PageSnapshotSessionStore', 'buildSnapshotProjection']) {
        assert.equal(server.includes(required), true, `viewer server is missing V2 entry ${required}`);
    }
});

test('Stage 6 acceptance documents match the current release evidence', () => {
    const plan = fs.readFileSync(path.join(repositoryDirectory, 'docs/Development/SnapshotEntityRecognitionV2Plan.md'), 'utf8');
    const handoff = fs.readFileSync(
        path.join(repositoryDirectory, 'docs/Development/reports/SnapshotV2Stage6Handoff.md'),
        'utf8',
    );
    const combined = `${plan}\n${handoff}`;

    for (const staleClaim of [
        '610 findings', '156 errors', '454 warnings', 'Snapshot：129/129',
        'Snapshot：135/135', '614 tests / 612 pass', '630 tests / 628 pass',
        'E2E：4/4', 'entity-rules              31/31',
    ]) {
        assert.equal(combined.includes(staleClaim), false, `stale acceptance claim remains: ${staleClaim}`);
    }
    for (const requiredEvidence of [
        'Snapshot：136/136',
        '638 tests / 636 pass / 0 fail / 2 skipped',
        'E2E：5/5',
        'SnapshotV2Stage45PerformanceBaseline.json',
        'table_required_matrix_browser.test.ts',
        'record 与 runner 共享 PageSession',
        '0 errors / 0 warnings',
        'SnapshotV2V1ParityAudit.md',
        'V1 snapshot JSON shape',
        'Step/Checkpoint/task.run/DSL',
    ]) {
        assert.equal(combined.includes(requiredEvidence), true, `acceptance evidence missing: ${requiredEvidence}`);
    }
});

const productionFiles = (): string[] => productionRoots
    .filter((root) => fs.existsSync(root))
    .flatMap(walkTypescript)
    .sort();

const walkTypescript = (directory: string): string[] => fs
    .readdirSync(directory, {withFileTypes: true})
    .flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {return walkTypescript(target);}
        return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
    });

const relativeImports = (source: string): string[] => [...source.matchAll(
    /(?:from\s+|import\s*\()(['"])(\.[^'"]+)\1/gu,
)].map((match) => match[2]);

const resolveImport = (sourceFile: string, specifier: string): string | null => {
    const base = path.resolve(path.dirname(sourceFile), specifier);
    const extensionless = /\.(?:js|mjs|cjs)$/u.test(base)
        ? base.replace(/\.(?:js|mjs|cjs)$/u, '')
        : base;
    for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.d.ts`,
        `${extensionless}.ts`,
        `${extensionless}.tsx`,
        `${extensionless}.d.ts`,
        path.join(base, 'index.ts'),
        path.join(extensionless, 'index.ts'),
        path.join(extensionless, 'index.d.ts'),
    ]) {
        if (fs.existsSync(candidate)) {return candidate;}
    }
    return null;
};

const relative = (file: string): string => path.relative(repositoryDirectory, file);
