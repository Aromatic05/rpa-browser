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
        assert.equal(source.includes('table.has_next_page'), false);
        assert.equal(source.includes('table.next_page_target'), false);
    }
});

test('serialization guard', async () => {
    const serializationSource = await readAgentFile('src/runner/serialization/types.ts');
    const serializationTestSource = await readAgentFile('tests/runner/serialization/serialization_yaml.test.ts');

    for (const required of ['assertNoCoreHintFields', 'resolve', 'rawContext', 'locatorCandidates', 'replayHints']) {
        assert.equal(serializationSource.includes(required), true, `serialization types missing ${required}`);
    }

    assert.equal(serializationTestSource.includes('steps\\[0\\]\\.args\\.target\\.rawContext'), true);
    assert.equal(serializationTestSource.includes('checkpoints\\[0\\]\\.content\\[0\\]\\.step\\.args\\.hint'), true);
});
