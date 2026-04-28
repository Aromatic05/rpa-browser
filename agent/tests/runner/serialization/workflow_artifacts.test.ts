import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type {
    CheckpointHintFile,
    CheckpointResolveFile,
    SingleCheckpointFile,
    StepFile,
    StepResolveFile,
} from '../../../src/runner/serialization/types';
import {
    validateCheckpointResolveFileForSerialization,
    validateSingleCheckpointFileForSerialization,
    validateStepFileForSerialization,
    validateStepResolveFileForSerialization,
} from '../../../src/runner/serialization/types';

const workflowsDir = path.resolve(process.cwd(), 'tests/fixtures/workflows');

const workflowCases = [
    {
        scene: 'order-form',
        checkpointName: 'order-form-submit',
    },
    {
        scene: 'order-list',
        checkpointName: 'order-list-row-action',
    },
] as const;

test('workflow artifact fixture directories exist', async () => {
    for (const { scene, checkpointName } of workflowCases) {
        const sceneDir = path.join(workflowsDir, scene);
        const stepsDir = path.join(sceneDir, 'steps', 'recording-main');
        const checkpointDir = path.join(sceneDir, 'checkpoints', checkpointName);

        for (const target of [
            sceneDir,
            path.join(sceneDir, 'steps'),
            stepsDir,
            path.join(sceneDir, 'checkpoints'),
            checkpointDir,
        ]) {
            const stat = await fs.stat(target);
            assert.equal(stat.isDirectory(), true, `${target} should exist`);
        }
    }
});

test('workflow step artifacts validate against step schemas', async () => {
    for (const { scene } of workflowCases) {
        const stepsDir = path.join(workflowsDir, scene, 'steps', 'recording-main');
        const stepsSource = await fs.readFile(path.join(stepsDir, 'steps.yaml'), 'utf8');
        const resolveSource = await fs.readFile(path.join(stepsDir, 'step_resolve.yaml'), 'utf8');

        const stepsFile = parse(stepsSource) as StepFile;
        const resolveFile = parse(resolveSource) as StepResolveFile;

        assert.doesNotThrow(() => validateStepFileForSerialization(stepsFile));
        assert.doesNotThrow(() => validateStepResolveFileForSerialization(resolveFile));

        assert.equal(stepsSource.includes('meta:'), false);
        assert.equal(stepsSource.includes('resolve:'), false);
        assert.equal(stepsSource.includes('hint:'), false);
        assert.equal(stepsSource.includes('rawContext'), false);
        assert.equal(stepsSource.includes('locatorCandidates'), false);
        assert.equal(stepsSource.includes('replayHints'), false);
        assert.equal(stepsSource.includes('\nresolveId:'), false);
        assert.equal(stepsSource.includes('args:\n      resolveId:'), true);

        await assert.rejects(fs.stat(path.join(stepsDir, 'checkpoint_resolve.yaml')));
    }
});

test('workflow checkpoint artifacts validate against single-checkpoint schemas', async () => {
    for (const { scene, checkpointName } of workflowCases) {
        const checkpointDir = path.join(workflowsDir, scene, 'checkpoints', checkpointName);
        const checkpointSource = await fs.readFile(path.join(checkpointDir, 'checkpoint.yaml'), 'utf8');
        const resolveSource = await fs.readFile(path.join(checkpointDir, 'checkpoint_resolve.yaml'), 'utf8');
        const hintsSource = await fs.readFile(path.join(checkpointDir, 'checkpoint_hints.yaml'), 'utf8');

        const checkpointFile = parse(checkpointSource) as SingleCheckpointFile;
        const resolveFile = parse(resolveSource) as CheckpointResolveFile;
        const hintsFile = parse(hintsSource) as CheckpointHintFile;

        assert.doesNotThrow(() => validateSingleCheckpointFileForSerialization(checkpointFile));
        assert.doesNotThrow(() => validateCheckpointResolveFileForSerialization(resolveFile));

        assert.equal(checkpointFile.version, 1);
        assert.equal(typeof checkpointFile.checkpoint?.id, 'string');
        assert.equal(hintsFile.version, 1);
        assert.equal(typeof hintsFile.hints, 'object');

        for (const forbidden of ['resolve:', 'hint:', 'rawContext', 'locatorCandidates', 'replayHints']) {
            assert.equal(checkpointSource.includes(forbidden), false, `checkpoint.yaml must not include ${forbidden}`);
        }
        assert.equal(checkpointSource.includes('checkpoint:'), true);
        assert.equal(checkpointSource.includes('checkpoints:'), false);
        assert.equal(checkpointSource.includes('\n        resolveId:'), false);
        assert.equal(checkpointSource.includes('args:\n          resolveId:'), true);

        await assert.rejects(fs.stat(path.join(checkpointDir, 'step_resolve.yaml')));
        await assert.rejects(fs.stat(path.join(checkpointDir, 'checkpoints.yaml')));
    }
});
