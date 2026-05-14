import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkflow } from '../../src/workflow';
import { DslRuntimeError } from '../../src/dsl/diagnostics/errors';

const mkScene = (root: string, scene: string, workflowYaml: string, dslSource?: string) => {
    const sceneDir = path.join(root, scene);
    fs.mkdirSync(path.join(sceneDir, 'dsl'), { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'workflow.yaml'), workflowYaml, 'utf8');
    if (dslSource !== undefined) {
        fs.writeFileSync(path.join(sceneDir, 'dsl/main.dsl'), dslSource, 'utf8');
    }
    return sceneDir;
};

test('loadWorkflow loads workflow yaml and dsl source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
  inputs: dsl/inputs.example.yaml
`,
        'snapshot',
    );
    fs.writeFileSync(path.join(tmp, 'order', 'dsl', 'inputs.example.yaml'), 'user:\n  name: "alice"\n', 'utf8');
    const loaded = loadWorkflow('order', tmp);
    assert.equal(loaded.scene, 'order');
    assert.equal(loaded.dslSource.trim(), 'snapshot');
    assert.equal(loaded.inputsPath?.endsWith('dsl/inputs.example.yaml'), true);
});

test('loadWorkflow throws when entry.dsl is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
`,
    );
    assert.throws(() => loadWorkflow('order', tmp), (err: unknown) => err instanceof DslRuntimeError && err.code === 'ERR_WORKFLOW_DSL_NOT_FOUND');
});

test('loadWorkflow rejects path escape', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: ../outside.dsl
`,
        'snapshot',
    );
    assert.throws(() => loadWorkflow('order', tmp), (err: unknown) => err instanceof DslRuntimeError && err.code === 'ERR_WORKFLOW_PATH_ESCAPE');
});

test('loadWorkflow keeps optional inputs empty and builds records/checkpoints index', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    const sceneDir = mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
records:
  - records/main
checkpoints:
  - checkpoints/ensure-login
`,
        'snapshot',
    );
    fs.mkdirSync(path.join(sceneDir, 'records/main'), { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'records/main', 'steps.yaml'), 'version: 1\nsteps: []\n', 'utf8');
    fs.mkdirSync(path.join(sceneDir, 'checkpoints/ensure-login'), { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'checkpoints/ensure-login', 'checkpoint.yaml'), 'version: 1\ncheckpoint:\n  id: ensure-login\n', 'utf8');
    const loaded = loadWorkflow('order', tmp);
    assert.deepEqual(loaded.records, ['records/main']);
    assert.equal(loaded.checkpoints[0].id, 'ensure-login');
});

test('loadWorkflow rejects top-level inputs field', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
inputs: dsl/inputs.example.yaml
`,
        'snapshot',
    );
    assert.throws(() => loadWorkflow('order', tmp), (err: unknown) => err instanceof DslRuntimeError && err.code === 'ERR_WORKFLOW_INVALID_MANIFEST');
});

test('loadWorkflow throws ERR_WORKFLOW_RECORD_NOT_FOUND when steps.yaml missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    const sceneDir = mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
records:
  - records/main
`,
        'snapshot',
    );
    fs.mkdirSync(path.join(sceneDir, 'records/main'), { recursive: true });
    assert.throws(() => loadWorkflow('order', tmp), (err: unknown) => err instanceof DslRuntimeError && err.code === 'ERR_WORKFLOW_RECORD_NOT_FOUND');
});

test('loadWorkflow throws ERR_WORKFLOW_CHECKPOINT_NOT_FOUND when checkpoint.yaml missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-loader-'));
    const sceneDir = mkScene(
        tmp,
        'order',
        `
version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
checkpoints:
  - checkpoints/ensure-login
`,
        'snapshot',
    );
    fs.mkdirSync(path.join(sceneDir, 'checkpoints/ensure-login'), { recursive: true });
    assert.throws(() => loadWorkflow('order', tmp), (err: unknown) => err instanceof DslRuntimeError && err.code === 'ERR_WORKFLOW_CHECKPOINT_NOT_FOUND');
});
