import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../../src/workflow';
import { createDslCodec } from '../../../src/workflow/dsl';
import { workflowRootDir, workflowsRootDir } from '../../../src/workflow/fs';
import { runStepList, type RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

const recording = (name: string, steps: StepUnion[] = [], stepResolves = {}) => ({
    kind: 'recording' as const,
    name,
    recording: {
        version: 1 as const,
        recordingName: name,
        workspaceName: 'ws',
        activeTabRef: 'tab-1',
        initialTabs: [{ tabName: 'tab-1', tabRef: 'tab-1', url: 'https://example.test', title: 'Example', active: true }],
        tabs: [{ tabName: 'tab-1', url: 'https://example.test' }],
    },
    steps,
    stepResolves,
});

test('workflow artifact names reject traversal on read, write, and delete without escaping the workflow root', () => {
    const name = uniqueName('artifact-name');
    const escaped = path.join(workflowsRootDir(), `${name}-escaped.dsl`);
    const escapedWorkflow = path.resolve(workflowsRootDir(), '..', `${name}-workflow`);
    cleanup(name);
    fs.rmSync(escaped, { force: true });
    fs.rmSync(escapedWorkflow, { recursive: true, force: true });
    try {
        assert.throws(() => createWorkflowOnFs(`../${name}-workflow`));
        const workflow = createWorkflowOnFs(name);
        assert.throws(() => workflow.save({ kind: 'dsl', name: `../${name}-escaped`, content: 'wait 1', stepResolves: {} }));
        assert.throws(() => workflow.get(`../${name}-escaped`, { kind: 'dsl' }));
        assert.throws(() => workflow.delete(`../${name}-escaped`, { kind: 'dsl' }));
        assert.equal(fs.existsSync(escaped), false);
        assert.equal(fs.existsSync(escapedWorkflow), false);
    } finally {
        cleanup(name);
        fs.rmSync(escaped, { force: true });
        fs.rmSync(escapedWorkflow, { recursive: true, force: true });
    }
});

test('workflow manifest entry.dsl is authoritative for default DSL actions and missing entries fail', async () => {
    const name = uniqueName('entry-dsl');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({ kind: 'dsl', name: 'first', content: 'wait 1', stepResolves: {} });
        workflow.save({ kind: 'dsl', name: 'chosen', content: 'wait 2', stepResolves: {} });
        const manifestPath = path.join(workflowRootDir(name), 'workflow.yaml');
        const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8')) as { entry: { dsl: string } };
        manifest.entry.dsl = 'chosen';
        fs.writeFileSync(manifestPath, YAML.stringify(manifest), 'utf8');

        const { registry } = createWorkspaceHarness();
        const workspace = registry.createWorkspace(name, loadWorkflowFromFs(name));
        const got = await workspace.router.handle({ v: 1, id: 'get-entry', type: 'dsl.get', workspaceName: name } as any, workspace as any, registry as any);
        assert.equal((got.reply.payload as { dslName: string; content: string }).dslName, 'chosen');
        assert.equal((got.reply.payload as { content: string }).content, 'wait 2');

        const saved = await workspace.router.handle({ v: 1, id: 'save-entry', type: 'dsl.save', workspaceName: name, payload: { content: '' } } as any, workspace as any, registry as any);
        assert.equal((saved.reply.payload as { dslName: string }).dslName, 'chosen');
        const ran = await workspace.router.handle({ v: 1, id: 'run-entry', type: 'dsl.run', workspaceName: name } as any, workspace as any, registry as any);
        assert.equal(ran.reply.type, 'dsl.run.result');

        fs.rmSync(path.join(workflowRootDir(name), 'dsls', 'chosen.dsl'));
        await assert.rejects(
            () => workspace.router.handle({ v: 1, id: 'missing-entry', type: 'dsl.get', workspaceName: name } as any, workspace as any, registry as any),
            (error: any) => error?.code === 'ERR_NOT_FOUND',
        );
        fs.writeFileSync(manifestPath, YAML.stringify({ ...manifest, entry: {} }), 'utf8');
        assert.throws(() => loadWorkflowFromFs(name), (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_MANIFEST');
    } finally {
        cleanup(name);
    }
});

test('workflow manifest rejects identity mismatches and duplicate catalog entries', () => {
    const name = uniqueName('manifest-integrity');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({ kind: 'dsl', name: 'main', content: 'wait 1', stepResolves: {} });
        const manifestPath = path.join(workflowRootDir(name), 'workflow.yaml');
        const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            name: string;
            catalog: unknown[];
        };
        fs.writeFileSync(manifestPath, YAML.stringify({ ...manifest, name: 'other-workflow' }), 'utf8');
        assert.throws(
            () => loadWorkflowFromFs(name),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_MANIFEST',
        );

        fs.writeFileSync(manifestPath, YAML.stringify({
            ...manifest,
            catalog: [...manifest.catalog, structuredClone(manifest.catalog[0])],
        }), 'utf8');
        assert.throws(
            () => loadWorkflowFromFs(name),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_MANIFEST',
        );
    } finally {
        cleanup(name);
    }
});

test('invalid optional recording and checkpoint sidecars fail artifact loading instead of becoming empty objects', () => {
    const name = uniqueName('invalid-sidecar');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save(recording('recording-1'));
        workflow.save({
            kind: 'checkpoint', name: 'checkpoint-1',
            checkpoint: { id: 'checkpoint-1', trigger: { matchRules: [{ errorCode: 'ERR_NOT_FOUND' }] } },
            stepResolves: {}, hints: {},
        } as any);
        fs.writeFileSync(path.join(workflowRootDir(name), 'recordings', 'recording-1', 'step_resolve.yaml'), 'version: wrong\n');
        fs.writeFileSync(path.join(workflowRootDir(name), 'checkpoints', 'checkpoint-1', 'checkpoint_hints.yaml'), 'version: wrong\n');
        const reloaded = loadWorkflowFromFs(name);
        assert.throws(
            () => reloaded.get('recording-1', { kind: 'recording' }),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.throws(
            () => reloaded.get('checkpoint-1', { kind: 'checkpoint' }),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
    } finally {
        cleanup(name);
    }
});

test('DSL codec loads resolve sidecars through the production artifact boundary and deletes both files', () => {
    const name = uniqueName('dsl-resolve-sidecar');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        const dslDir = path.join(workflowRootDir(name), 'dsls');
        workflow.save({kind: 'dsl', name: 'missing', content: 'wait 1', stepResolves: {}});
        fs.rmSync(path.join(dslDir, 'missing.resolve.yaml'));
        assert.deepEqual((loadWorkflowFromFs(name).get('missing', {kind: 'dsl'}) as any)?.stepResolves, {});

        const stepResolves = {dismissBanner: {hint: {raw: {selector: '#dismiss'}}}} as any;
        workflow.save({kind: 'dsl', name: 'secondary', content: 'click recorded.dismissBanner', stepResolves});
        assert.deepEqual((loadWorkflowFromFs(name).get('secondary', {kind: 'dsl'}) as any)?.stepResolves, stepResolves);

        fs.writeFileSync(path.join(dslDir, 'secondary.resolve.yaml'), 'version: wrong\n');
        const reloaded = loadWorkflowFromFs(name);
        assert.throws(() => reloaded.get('secondary', {kind: 'dsl'}), (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT');
        assert.throws(() => reloaded.list({kind: 'dsl'}), (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT');
        assert.throws(() => createDslCodec(name).list(), (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT');

        fs.writeFileSync(path.join(dslDir, 'secondary.resolve.yaml'), YAML.stringify({version: 1, resolves: stepResolves}));
        reloaded.delete('secondary', {kind: 'dsl'});
        assert.equal(fs.existsSync(path.join(dslDir, 'secondary.dsl')), false);
        assert.equal(fs.existsSync(path.join(dslDir, 'secondary.resolve.yaml')), false);
    } finally {
        cleanup(name);
    }
});

test('dsl.save persists owned resolves for reload and dsl.run injects them into the executor', async () => {
    const name = uniqueName('dsl-owned-resolve-run');
    cleanup(name);
    try {
        const observed: StepUnion[] = [];
        const deps = completeRunStepsDeps({
            runtime: {ensureActivePage: async () => ({workspaceName: name, tabName: 'tab', traceCtx: {cache: {}}})},
            config: {} as any,
            pluginHost: {getExecutors: () => ({
                'browser.click': async (step: StepUnion) => {
                    observed.push(step);
                    return {stepId: step.id, ok: true};
                },
            })} as any,
        });
        const workflow = createWorkflowOnFs(name);
        const {registry} = createWorkspaceHarness({runStepsDeps: deps});
        const workspace = registry.createWorkspace(name, workflow);
        const sidecar = {dismissBanner: {hint: {raw: {selector: '#dismiss'}}}} as any;
        await workspace.router.handle({
            v: 1, id: 'save-resolve', type: 'dsl.save', workspaceName: name,
            payload: {content: 'use resolves "main" as recorded\nclick recorded.dismissBanner', stepResolves: sidecar},
        } as any, workspace as any, registry as any);

        const reloaded = loadWorkflowFromFs(name);
        assert.equal((reloaded.get('main', {kind: 'dsl'}) as any)?.stepResolves.dismissBanner?.hint?.raw?.selector, '#dismiss');
        const {registry: reloadedRegistry} = createWorkspaceHarness({runStepsDeps: deps});
        const reloadedWorkspace = reloadedRegistry.createWorkspace(name, reloaded);
        await reloadedWorkspace.router.handle({
            v: 1, id: 'run-resolve', type: 'dsl.run', workspaceName: name,
        } as any, reloadedWorkspace as any, reloadedRegistry as any);
        assert.equal(observed.length, 1);
        assert.equal(observed[0].resolve?.hint?.raw?.selector, '#dismiss');
        assert.equal((observed[0].args as {resolveId?: string}).resolveId, undefined);
    } finally {
        cleanup(name);
    }
});

test('dsl.save preserves omitted sidecars and rejects invalid candidates before persistence', async () => {
    const name = uniqueName('dsl-save-sidecar');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({
            kind: 'dsl', name: 'main', content: 'wait 1',
            stepResolves: {dismissBanner: {hint: {raw: {selector: '#dismiss'}}}} as any,
        });
        const {registry} = createWorkspaceHarness();
        const workspace = registry.createWorkspace(name, workflow);
        await workspace.router.handle({
            v: 1, id: 'preserve-sidecar', type: 'dsl.save', workspaceName: name, payload: {content: 'wait 2'},
        } as any, workspace as any, registry as any);
        assert.equal((loadWorkflowFromFs(name).get('main', {kind: 'dsl'}) as any)?.stepResolves.dismissBanner?.hint?.raw?.selector, '#dismiss');

        await assert.rejects(() => workspace.router.handle({
            v: 1, id: 'invalid-sidecar', type: 'dsl.save', workspaceName: name,
            payload: {content: 'wait 3', stepResolves: {dismissBanner: {}}},
        } as any, workspace as any, registry as any));
        const afterFailure = loadWorkflowFromFs(name).get('main', {kind: 'dsl'});
        assert.equal((afterFailure as any)?.content, 'wait 2');
        assert.equal((afterFailure as any)?.stepResolves.dismissBanner?.hint?.raw?.selector, '#dismiss');

        fs.writeFileSync(path.join(workflowRootDir(name), 'dsls', 'main.resolve.yaml'), 'version: wrong\n');
        await workspace.router.handle({
            v: 1,
            id: 'repair-sidecar',
            type: 'dsl.save',
            workspaceName: name,
            payload: {
                content: 'use resolves "main" as recorded\nclick recorded.dismissBanner',
                stepResolves: {dismissBanner: {hint: {raw: {selector: '#repaired'}}}},
            },
        } as any, workspace as any, registry as any);
        const repaired = loadWorkflowFromFs(name).get('main', {kind: 'dsl'});
        assert.equal((repaired as any)?.stepResolves.dismissBanner?.hint?.raw?.selector, '#repaired');
    } finally {
        cleanup(name);
    }
});

test('persisted recordings retain resolveId associations through production load and replay execution', async () => {
    const name = uniqueName('recording-resolve');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        const { registry, recordingState } = createWorkspaceHarness();
        const workspace = registry.createWorkspace(name, workflow);
        workspace.tabs.createTab({ tabName: 'tab-1' });
        const token = `unsaved:${name}`;
        recordingState.workspaceUnsavedRecording.set(name, token);
        recordingState.recordings.set(token, [{ id: 'click-1', name: 'browser.click', args: { selector: '#submit' } } as StepUnion]);
        recordingState.recordingEnhancements.set(token, {
            'click-1': { version: 1, resolveHint: { raw: { selector: '#submit' } }, resolvePolicy: { requireVisible: true } },
        });
        recordingState.recordingManifests.set(token, {
            recordingToken: token, workspaceName: name, activeTabRef: 'tab-1', entryUrl: 'https://example.test',
            initialTabs: [{ tabName: 'tab-1', tabRef: 'tab-1', url: 'https://example.test', title: 'Example', active: true }],
            startedAt: Date.now(), tabs: [{ tabName: 'tab-1', tabRef: 'tab-1', firstSeenAt: Date.now(), lastSeenAt: Date.now() }],
        });
        const saved = await workspace.router.handle({
            v: 1, id: 'record-save', type: 'record.save', workspaceName: name,
            payload: { recordingName: 'recording-1', includeStepResolve: true },
        } as any, workspace as any, registry as any);
        assert.equal(saved.reply.type, 'record.save.result');
        const loaded = loadWorkflowFromFs(name).get('recording-1', { kind: 'recording' });
        assert.equal(loaded?.kind, 'recording');
        const observed: StepUnion[] = [];
        const deps: RunStepsDeps = completeRunStepsDeps({
            pluginHost: { getExecutors: () => ({
                'browser.click': async (step: StepUnion) => { observed.push(step); return { stepId: step.id, ok: true }; },
            }) } as any,
        });
        const result = await runStepList('ws', loaded!.steps, deps, { stopOnError: true, stepResolves: loaded!.stepResolves });
        assert.equal(result.checkpoint.status, 'completed');
        assert.equal(observed[0]?.resolve?.hint?.raw?.selector, '#submit');
        assert.equal((observed[0]?.args as { resolveId?: string }).resolveId, undefined);
    } finally {
        cleanup(name);
    }
});
