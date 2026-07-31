import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../../src/workflow';
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
    cleanup(name);
    fs.rmSync(escaped, { force: true });
    try {
        const workflow = createWorkflowOnFs(name);
        assert.throws(() => workflow.save({ kind: 'dsl', name: `../${name}-escaped`, content: 'wait 1' }));
        assert.throws(() => workflow.get(`../${name}-escaped`, { kind: 'dsl' }));
        assert.throws(() => workflow.delete(`../${name}-escaped`, { kind: 'dsl' }));
        assert.equal(fs.existsSync(escaped), false);
    } finally {
        cleanup(name);
        fs.rmSync(escaped, { force: true });
    }
});

test('workflow manifest entry.dsl is authoritative for default DSL actions and missing entries fail', async () => {
    const name = uniqueName('entry-dsl');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({ kind: 'dsl', name: 'first', content: 'wait 1' });
        workflow.save({ kind: 'dsl', name: 'chosen', content: 'wait 2' });
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
        assert.equal(reloaded.get('recording-1', { kind: 'recording' }), null);
        assert.equal(reloaded.get('checkpoint-1', { kind: 'checkpoint' }), null);
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
        assert.equal((observed[0]?.args as { resolveId?: string }).resolveId, 'recorded-1');
    } finally {
        cleanup(name);
    }
});
