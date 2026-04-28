import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow } from '../../src/workflow';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import type { StepUnion } from '../../src/runner/steps/types';

const createDeps = (calls: Array<{ name: string; args: Record<string, unknown> }>): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceId: 'ws-workflow',
                tabId: 'tab-workflow',
                tabToken: 'tk-workflow',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.query': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { kind: 'nodeId', nodeId: 'buyer-input' } };
                    },
                    'browser.fill': async (step: StepUnion) => {
                        calls.push({ name: step.name, args: step.args as Record<string, unknown> });
                        return { stepId: step.id, ok: true, data: { filled: true } };
                    },
                }) as any,
        } as any,
    }) as RunStepsDeps;

const createWorkflowScene = (root: string, scene: string, dsl: string, extra = '') => {
    const sceneDir = path.join(root, scene);
    fs.mkdirSync(path.join(sceneDir, 'dsl'), { recursive: true });
    fs.writeFileSync(
        path.join(sceneDir, 'workflow.yaml'),
        `version: 1
id: order-create
entry:
  dsl: dsl/main.dsl
  inputs: dsl/inputs.example.yaml
workspace:
  binding: workspace.yaml
${extra}
`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(sceneDir, 'workspace.yaml'),
        `version: 1
workspace:
  strategy: createOnly
  entryUrl: http://localhost/orders
`,
        'utf8',
    );
    fs.writeFileSync(path.join(sceneDir, 'dsl/main.dsl'), dsl, 'utf8');
    fs.writeFileSync(path.join(sceneDir, 'dsl/inputs.example.yaml'), 'user:\n  name: fixture\nusername: fixtureUser\n', 'utf8');
    return sceneDir;
};

test('runWorkflow loads workflow and runs dsl with input', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
    createWorkflowScene(
        tmp,
        'order',
        `
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}
fill buyer with input.user.name
`,
    );

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await runWorkflow(
        {
            scene: 'order',
            input: { user: { name: 'alice' } },
        },
        {
            workflowsDir: tmp,
            runStepsDeps: createDeps(calls),
            pageRegistry: {
                createWorkspace: async () => ({ workspaceId: 'ws-1', tabId: 'tab-1' }),
                resolveTabToken: () => 'tk-1',
                createWorkspaceShell: () => ({ workspaceId: 'workflow:order' }),
                resolvePage: async () => ({ url: () => 'about:blank', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
        },
    );

    assert.deepEqual(calls.map((item) => item.name), ['browser.query', 'browser.fill']);
    assert.equal(result.scope.input.user?.name, 'alice');
});

test('runWorkflow injects manifest.entry.inputs when request.input is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
    createWorkflowScene(
        tmp,
        'order',
        `
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}
fill buyer with input.user.name
`,
    );
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await runWorkflow(
        { scene: 'order' },
        {
            workflowsDir: tmp,
            runStepsDeps: createDeps(calls),
            pageRegistry: {
                createWorkspace: async () => ({ workspaceId: 'ws-1', tabId: 'tab-1' }),
                resolveTabToken: () => 'tk-1',
                resolvePage: async () => ({ url: () => 'about:blank', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
        },
    );
    assert.equal(result.scope.input.user?.name, 'fixture');
});

test('runWorkflow checkpoint call fails when checkpoint is not declared', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
    createWorkflowScene(
        tmp,
        'order',
        `
use checkpoint "ensure-login"
`,
    );

    await assert.rejects(
        () =>
            runWorkflow(
                { scene: 'order' },
                {
                    workflowsDir: tmp,
                    runStepsDeps: createDeps([]),
                    pageRegistry: {
                        createWorkspace: async () => ({ workspaceId: 'ws-1', tabId: 'tab-1' }),
                        resolveTabToken: () => 'tk-1',
                        createWorkspaceShell: () => ({ workspaceId: 'workflow:order' }),
                        resolvePage: async () => ({ url: () => 'about:blank', goto: async () => {} }),
                    } as any,
                    restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
                },
            ),
        /ERR_WORKFLOW_CHECKPOINT_NOT_DECLARED|workflow checkpoint not declared/,
    );
});

test('runWorkflow use checkpoint resolves from workflow checkpoints directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
    const sceneDir = createWorkflowScene(
        tmp,
        'order',
        `
use checkpoint "ensure-login" with {
  username: input.username
}
`,
        `checkpoints:
  - checkpoints/ensure-login`,
    );
    const cpDir = path.join(sceneDir, 'checkpoints/ensure-login');
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(
        path.join(cpDir, 'checkpoint.yaml'),
        `version: 1
checkpoint:
  id: ensure-login
  trigger:
    matchRules:
      - errorCode: ERR_SAMPLE
  output:
    loginState:
      ref: input.username
`,
        'utf8',
    );

    const result = await runWorkflow(
        {
            scene: 'order',
            input: { username: 'root' },
        },
        {
            workflowsDir: tmp,
            runStepsDeps: createDeps([]),
            pageRegistry: {
                createWorkspace: async () => ({ workspaceId: 'ws-1', tabId: 'tab-1' }),
                resolveTabToken: () => 'tk-1',
                createWorkspaceShell: () => ({ workspaceId: 'workflow:order' }),
                resolvePage: async () => ({ url: () => 'about:blank', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
        },
    );

    assert.equal(result.scope.output.loginState, 'root');
});

test('runWorkflow declared checkpoint path missing file reports ERR_WORKFLOW_CHECKPOINT_NOT_FOUND', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
    const sceneDir = createWorkflowScene(
        tmp,
        'order',
        `
snapshot
`,
        `checkpoints:
  - checkpoints/ensure-login`,
    );
    fs.mkdirSync(path.join(sceneDir, 'checkpoints/ensure-login'), { recursive: true });
    await assert.rejects(
        () =>
            runWorkflow(
                { scene: 'order' },
                {
                    workflowsDir: tmp,
                    runStepsDeps: createDeps([]),
                    pageRegistry: {
                        createWorkspace: async () => ({ workspaceId: 'ws-1', tabId: 'tab-1' }),
                        resolveTabToken: () => 'tk-1',
                        resolvePage: async () => ({ url: () => 'about:blank', goto: async () => {} }),
                    } as any,
                    restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
                },
            ),
        /ERR_WORKFLOW_CHECKPOINT_NOT_FOUND|workflow checkpoint file not found/,
    );
});
