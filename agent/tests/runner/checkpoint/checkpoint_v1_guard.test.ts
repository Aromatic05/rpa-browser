import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const agentRoot = process.cwd();
const repoRoot = path.resolve(agentRoot, '..');

const readAgentFile = async (relativePath: string) => await fs.readFile(path.join(agentRoot, relativePath), 'utf-8');
const readRepoFile = async (relativePath: string) => await fs.readFile(path.join(repoRoot, relativePath), 'utf-8');

test('StepName guard', async () => {
    const source = await readAgentFile('src/runner/steps/types.ts');

    for (const forbidden of [
        'browser.query_entity',
        'browser.resolve_entity_target',
        'browser.list_entities',
        'browser.get_entity',
        'browser.find_entities',
        'browser.add_entity',
        'browser.delete_entity',
        'browser.rename_entity',
    ]) {
        assert.equal(source.includes(forbidden), false, `unexpected StepName token: ${forbidden}`);
    }

    for (const required of ['browser.entity', 'browser.query', 'browser.checkpoint']) {
        assert.equal(source.includes(required), true, `missing StepName token: ${required}`);
    }
});

test('action entity target guard', async () => {
    const source = await readAgentFile('src/runner/steps/types.ts');

    assert.equal(source.includes('entityTarget'), false);
    assert.match(source, /'browser\.click':\s*\{/);
    assert.match(source, /'browser\.fill':\s*\{/);
    assert.match(source, /'browser\.select_option':\s*\{/);
});

test('checkpoint fixture guard', async () => {
    const fixturesDir = path.join(agentRoot, 'tests/fixtures/checkpoints');
    const fileNames = (await fs.readdir(fixturesDir)).sort();

    for (const fileName of fileNames.filter((name) => name.endsWith('.checkpoints.yaml'))) {
        const source = await fs.readFile(path.join(fixturesDir, fileName), 'utf-8');
        for (const forbidden of ['{{', '}}', 'rawContext', 'locatorCandidates', 'replayHints', 'preferredEntityRules', 'fallbacks', 'hint:']) {
            assert.equal(source.includes(forbidden), false, `${fileName} must not include ${forbidden}`);
        }
        for (const required of ['trigger:', 'matchRules:', 'ref: local.']) {
            assert.equal(source.includes(required), true, `${fileName} must include ${required}`);
        }
    }

    for (const fileName of fileNames.filter((name) => name.endsWith('.checkpoint_hints.yaml'))) {
        const source = await fs.readFile(path.join(fixturesDir, fileName), 'utf-8');
        for (const required of ['preferredEntityRules', 'fallbacks']) {
            assert.equal(source.includes(required), true, `${fileName} must include ${required}`);
        }
    }
});

test('artifacts guard', async () => {
    const trackedAndUntracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf-8',
    })
        .split('\n')
        .filter(Boolean);

    assert.equal(
        trackedAndUntracked.some((filePath) => filePath.includes('agent/.artifacts/checkpoints/examples')),
        false,
    );

    const gitignore = await readRepoFile('.gitignore');
    assert.equal(gitignore.includes('agent/.artifacts'), true);
});

test('query naming guard', async () => {
    const resolverSource = await readAgentFile('src/runner/steps/executors/snapshot/core/business_entity_resolver.ts');
    const stepTypesSource = await readAgentFile('src/runner/steps/types.ts');

    for (const source of [resolverSource, stepTypesSource]) {
        assert.equal(source.includes('table.hasNextPage'), true);
        assert.equal(source.includes('table.nextPageTarget'), true);
        assert.equal(source.includes('table.hasNextPage'), false);
        assert.equal(source.includes('table.nextPageTarget'), false);
    }
});

test('serialization guard', async () => {
    const stepTypesSource = await readAgentFile('src/runner/steps/types.ts');
    const resolveTargetSource = await readAgentFile('src/runner/steps/helpers/resolve_target.ts');
    const serializationSource = await readAgentFile('src/runner/serialization/types.ts');
    const serializationTestSource = await readAgentFile('tests/runner/serialization/serialization_yaml.test.ts');

    assert.equal(stepTypesSource.includes('export type Target'), false);
    assert.equal(stepTypesSource.includes('target?: Target'), false);
    assert.equal(stepTypesSource.includes('@deprecated'), false);

    for (const stepName of [
        'browser.take_screenshot',
        'browser.click',
        'browser.fill',
        'browser.type',
        'browser.select_option',
        'browser.hover',
        'browser.scroll',
    ]) {
        assert.equal(stepTypesSource.includes(`'${stepName}': {\n        id?: string;`), false, `${stepName} should not use id target field`);
        assert.equal(stepTypesSource.includes(`'${stepName}': {\n        nodeId?: string;`), true, `${stepName} should expose nodeId`);
        assert.equal(stepTypesSource.includes(`'${stepName}': {\n        nodeId?: string;\n        selector?: string;`), true, `${stepName} should expose selector`);
        assert.equal(stepTypesSource.includes(`selector?: string;\n        resolveId?: string;`), true, `${stepName} should expose resolveId`);
    }
    assert.equal(stepTypesSource.includes(`'browser.press_key': {\n        key: string;\n        id?: string;`), false);
    assert.equal(stepTypesSource.includes(`'browser.press_key': {\n        key: string;\n        nodeId?: string;`), true);
    assert.equal(stepTypesSource.includes(`'browser.press_key': {\n        key: string;\n        nodeId?: string;\n        selector?: string;`), true);
    assert.equal(stepTypesSource.includes(`'browser.press_key': {\n        key: string;\n        nodeId?: string;\n        selector?: string;\n        resolveId?: string;`), true);

    const dragBlock = /'browser\.drag_and_drop': \{[\s\S]*?\n    \}/m.exec(stepTypesSource)?.[0] || '';
    for (const required of ['sourceNodeId?: string;', 'sourceSelector?: string;', 'sourceResolveId?: string;', 'destNodeId?: string;', 'destSelector?: string;', 'destResolveId?: string;']) {
        assert.equal(dragBlock.includes(required), true, `drag_and_drop missing ${required}`);
    }

    assert.equal(resolveTargetSource.includes(`source: 'nodeId' | 'selector' | 'resolve'`), true);
    assert.equal(resolveTargetSource.includes(`source: 'selector' | 'id' | 'hint'`), false);

    for (const required of ['assertNoCoreHintFields', 'assertNoLegacyActionTargetFields', 'resolve', 'rawContext', 'locatorCandidates', 'replayHints', 'StepResolveFile', 'SerializedStep']) {
        assert.equal(serializationSource.includes(required), true, `serialization types missing ${required}`);
    }
    for (const required of ['SingleCheckpointFile', 'CheckpointResolveFile', 'validateSingleCheckpointFileForSerialization', 'validateCheckpointResolveFileForSerialization']) {
        assert.equal(serializationSource.includes(required), true, `serialization types missing ${required}`);
    }
    assert.equal(serializationSource.includes('StepHintFile'), false);
    assert.equal(serializationSource.includes('resolveId?: string;'), false);

    assert.equal(serializationTestSource.includes('steps\\[0\\]\\.args\\.target\\.rawContext'), true);
    assert.equal(serializationTestSource.includes('checkpoints\\[0\\]\\.content\\[0\\]\\.step\\.args\\.hint'), true);
    assert.equal(serializationSource.includes('use nodeId instead'), true);
});
