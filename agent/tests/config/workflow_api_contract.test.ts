import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs, type WorkflowDummy, type WorkflowRecording } from '../../src/workflow';
import type { WorkflowDsl } from '../../src/workflow';
import type { WorkflowCheckpoint } from '../../src/workflow';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const cleanup = (name: string) => {
    try {
        deleteWorkflowFromFs(name);
    } catch {}
};

test('workflow exposes corrected facade signatures', () => {
    const workflowName = uniqueName('wf-api-signatures');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    assert.equal(typeof workflow.save, 'function');
    assert.equal(typeof workflow.get, 'function');
    assert.equal(typeof workflow.list, 'function');
    assert.equal(typeof workflow.delete, 'function');
    assert.equal('recordings' in (workflow as unknown as Record<string, unknown>), false);
    assert.equal('checkpoints' in (workflow as unknown as Record<string, unknown>), false);
    assert.equal('dsls' in (workflow as unknown as Record<string, unknown>), false);
    assert.equal('entityRules' in (workflow as unknown as Record<string, unknown>), false);
    cleanup(workflowName);
});

test('workflow save/get/list/delete works by kind+name and list returns catalog only', () => {
    const workflowName = uniqueName('wf-api-main');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);

    const dslDummy: WorkflowDummy = { kind: 'dsl' };
    const recordingDummy: WorkflowDummy = { kind: 'recording' };
    const checkpointDummy: WorkflowDummy = { kind: 'checkpoint' };

    const dsl: WorkflowDsl = { kind: 'dsl', name: 'main', content: 'snapshot' };
    const savedDsl = workflow.save(dsl);
    assert.equal(savedDsl.kind, 'dsl');

    const rec: WorkflowRecording = {
        kind: 'recording',
        name: 'main',
        recording: {
            version: 1,
            recordingName: 'main',
            workspaceName: workflowName,
            createdAt: Date.now(),
            stepCount: 1,
        },
        steps: [
            {
                id: 's-1',
                name: 'browser.snapshot',
                args: {},
            } as WorkflowRecording['steps'][number],
        ],
        stepResolves: {},
    };
    workflow.save(rec);

    const cp: WorkflowCheckpoint = {
        kind: 'checkpoint',
        name: 'guard-a',
        checkpoint: {
            id: 'guard-a',
            trigger: {
                matchRules: [{ errorCode: 'ERR_SAMPLE' }],
            },
            enabled: true,
            priority: 7,
        },
        stepResolves: {},
        hints: {},
    };
    workflow.save(cp);

    const gotDsl = workflow.get('main', dslDummy);
    const gotRec = workflow.get('main', recordingDummy);
    assert.equal(gotDsl?.kind, 'dsl');
    assert.equal(gotRec?.kind, 'recording');
    assert.equal(workflow.get('main', checkpointDummy), null);

    const dslCatalog = workflow.list(dslDummy);
    assert.equal(dslCatalog.length, 1);
    assert.equal(dslCatalog[0].kind, 'dsl');
    assert.equal('content' in (dslCatalog[0] as unknown as Record<string, unknown>), false);
    assert.equal('steps' in (dslCatalog[0] as unknown as Record<string, unknown>), false);

    const checkpointCatalog = workflow.list(checkpointDummy);
    assert.equal(checkpointCatalog.length, 1);
    assert.equal(checkpointCatalog[0].kind, 'checkpoint');
    assert.equal((checkpointCatalog[0] as { enabled?: boolean }).enabled, true);
    assert.equal((checkpointCatalog[0] as { priority?: number }).priority, 7);

    const removedDsl = workflow.delete('main', dslDummy);
    assert.equal(removedDsl, true);
    assert.equal(workflow.get('main', dslDummy), null);
    assert.equal(workflow.get('main', recordingDummy)?.kind, 'recording');

    const reloaded = loadWorkflowFromFs(workflowName);
    assert.equal(reloaded.list(recordingDummy).length, 1);
    assert.equal(reloaded.list(dslDummy).length, 0);

    cleanup(workflowName);
});

test('workflow artifact directories are normalized', () => {
    const workflowName = uniqueName('wf-api-dirs');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);

    workflow.save({ kind: 'dsl', name: 'main', content: 'snapshot' });
    workflow.save({
        kind: 'recording',
        name: 'rec-1',
        recording: {
            version: 1,
            recordingName: 'rec-1',
            workspaceName: workflowName,
        },
        steps: [],
        stepResolves: {},
    });
    workflow.save({
        kind: 'checkpoint',
        name: 'guard-1',
        checkpoint: {
            id: 'guard-1',
            trigger: {
                matchRules: [{ errorCode: 'ERR_SAMPLE' }],
            },
        },
        stepResolves: {},
        hints: {},
    });

    const fixtureMatch = YAML.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'tests/entity_rules/profiles/oa-ant-orders/match.yaml'), 'utf8'),
    ) as unknown;
    const fixtureAnnotation = YAML.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'tests/entity_rules/profiles/oa-ant-orders/annotation.yaml'), 'utf8'),
    ) as unknown;
    workflow.save({
        kind: 'entity_rules',
        name: 'profile-a',
        match: fixtureMatch,
        annotation: fixtureAnnotation,
    });

    const root = path.resolve(process.cwd(), 'agent/.artifacts/workflows', workflowName);
    assert.equal(fs.existsSync(path.join(root, 'recordings', 'rec-1', 'recording.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'recordings', 'rec-1', 'steps.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'recordings', 'rec-1', 'step_resolve.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'dsls', 'main.dsl')), true);
    assert.equal(fs.existsSync(path.join(root, 'checkpoints', 'guard-1', 'checkpoint.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'checkpoints', 'guard-1', 'checkpoint_resolve.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'checkpoints', 'guard-1', 'checkpoint_hints.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'entity_rules', 'profile-a', 'match.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'entity_rules', 'profile-a', 'annotation.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, 'steps', 'rec-1')), false);
    assert.equal(fs.existsSync(path.join(root, 'dsl', 'main.dsl')), false);
    assert.equal(fs.existsSync(path.resolve(process.cwd(), 'agent/.artifacts/entity_rules/profiles', 'profile-a')), false);

    cleanup(workflowName);
});
