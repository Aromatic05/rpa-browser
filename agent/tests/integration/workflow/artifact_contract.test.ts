import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import { copyWorkflowOnFs, createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs, renameWorkflowOnFs } from '../../../src/workflow';
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

const entityRules = (name: string) => ({
    kind: 'entity_rules' as const,
    name,
    page: {kind: 'form' as const, urlPattern: 'example\\.test'},
    match: {
        version: 2 as const,
        rules: [{
            ruleId: 'root',
            source: 'region' as const,
            expect: 'unique' as const,
            match: {kind: 'form'},
        }],
    },
    annotation: {
        version: 2 as const,
        bindings: [{ruleId: 'root', entityKey: 'exampleForm', businessTag: 'example.form'}],
    },
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
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
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

test('missing required recording and checkpoint files are reported as corrupt artifacts', () => {
    const name = uniqueName('missing-required-artifact-file');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save(recording('recording-missing-steps'));
        workflow.save({
            kind: 'checkpoint',
            name: 'checkpoint-missing-metadata',
            checkpoint: {
                id: 'checkpoint-missing-metadata',
                kind: 'recovery',
                trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            },
            stepResolves: {},
            hints: {},
        } as any);
        fs.rmSync(path.join(workflowRootDir(name), 'recordings', 'recording-missing-steps', 'steps.yaml'));
        fs.rmSync(path.join(workflowRootDir(name), 'checkpoints', 'checkpoint-missing-metadata', 'checkpoint.yaml'));

        const reloaded = loadWorkflowFromFs(name);
        assert.throws(
            () => reloaded.get('recording-missing-steps', {kind: 'recording'}),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.throws(
            () => reloaded.get('checkpoint-missing-metadata', {kind: 'checkpoint'}),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.throws(
            () => reloaded.list({kind: 'recording'}),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.throws(
            () => reloaded.list({kind: 'checkpoint'}),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
    } finally {
        cleanup(name);
    }
});

test('manifest catalog entries with missing artifact roots are reported as corrupt', () => {
    const name = uniqueName('missing-catalog-artifact');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({kind: 'dsl', name: 'secondary', content: 'wait 1', stepResolves: {}});
        workflow.save(recording('recording-gone'));
        workflow.save({
            kind: 'checkpoint',
            name: 'procedure-gone',
            checkpoint: {id: 'procedure-gone', kind: 'procedure', content: []},
            stepResolves: {},
            hints: {},
        });
        workflow.save(entityRules('rules-gone'));

        fs.rmSync(path.join(workflowRootDir(name), 'dsls', 'secondary.dsl'));
        fs.rmSync(path.join(workflowRootDir(name), 'recordings', 'recording-gone'), {recursive: true});
        fs.rmSync(path.join(workflowRootDir(name), 'checkpoints', 'procedure-gone'), {recursive: true});
        fs.rmSync(path.join(workflowRootDir(name), 'entity_rules', 'rules-gone'), {recursive: true});

        const reloaded = loadWorkflowFromFs(name);
        const missing = [
            {kind: 'dsl' as const, name: 'secondary'},
            {kind: 'recording' as const, name: 'recording-gone'},
            {kind: 'checkpoint' as const, name: 'procedure-gone'},
            {kind: 'entity_rules' as const, name: 'rules-gone'},
        ];
        for (const artifact of missing) {
            assert.throws(
                () => reloaded.get(artifact.name, {kind: artifact.kind}),
                (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
            );
            assert.throws(
                () => reloaded.list({kind: artifact.kind}),
                (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
            );
        }
    } finally {
        cleanup(name);
    }
});

test('workflow save and delete roll back artifacts when the manifest cannot be written', () => {
    const name = uniqueName('manifest-write-rollback');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({kind: 'dsl', name: 'existing', content: 'wait 1', stepResolves: {}});
        const manifestPath = path.join(workflowRootDir(name), 'workflow.yaml');
        const manifestSource = fs.readFileSync(manifestPath, 'utf8');
        fs.rmSync(manifestPath);
        fs.mkdirSync(manifestPath);

        assert.throws(() => workflow.save({
            kind: 'dsl',
            name: 'new-artifact',
            content: 'wait 2',
            stepResolves: {},
        }));
        assert.equal(
            fs.existsSync(path.join(workflowRootDir(name), 'dsls', 'new-artifact.dsl')),
            false,
        );
        assert.equal(workflow.get('new-artifact', {kind: 'dsl'}), null);

        assert.throws(() => workflow.delete('existing', {kind: 'dsl'}));
        assert.equal(
            fs.readFileSync(path.join(workflowRootDir(name), 'dsls', 'existing.dsl'), 'utf8'),
            'wait 1',
        );
        assert.equal(workflow.get('existing', {kind: 'dsl'})?.kind, 'dsl');

        fs.rmSync(manifestPath, {recursive: true});
        fs.writeFileSync(manifestPath, manifestSource, 'utf8');
        const reloaded = loadWorkflowFromFs(name);
        assert.equal(reloaded.get('new-artifact', {kind: 'dsl'}), null);
        assert.equal(reloaded.get('existing', {kind: 'dsl'})?.kind, 'dsl');
    } finally {
        cleanup(name);
    }
});

test('workflow rename and copy validate the source manifest before mutating directories', () => {
    const renameSource = uniqueName('rename-invalid-source');
    const renameTarget = uniqueName('rename-invalid-target');
    const copySource = uniqueName('copy-invalid-source');
    const copyTarget = uniqueName('copy-invalid-target');
    for (const name of [renameSource, renameTarget, copySource, copyTarget]) {cleanup(name);}
    try {
        createWorkflowOnFs(renameSource);
        createWorkflowOnFs(copySource);
        fs.writeFileSync(path.join(workflowRootDir(renameSource), 'workflow.yaml'), 'version: invalid\n', 'utf8');
        fs.writeFileSync(path.join(workflowRootDir(copySource), 'workflow.yaml'), 'version: invalid\n', 'utf8');

        assert.throws(
            () => renameWorkflowOnFs(renameSource, renameTarget),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_MANIFEST',
        );
        assert.equal(fs.existsSync(workflowRootDir(renameSource)), true);
        assert.equal(fs.existsSync(workflowRootDir(renameTarget)), false);

        assert.throws(
            () => copyWorkflowOnFs(copySource, copyTarget),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_MANIFEST',
        );
        assert.equal(fs.existsSync(workflowRootDir(copySource)), true);
        assert.equal(fs.existsSync(workflowRootDir(copyTarget)), false);
    } finally {
        for (const name of [renameSource, renameTarget, copySource, copyTarget]) {cleanup(name);}
    }
});

test('workflow rename and copy reject catalog corruption before mutating directories', () => {
    const renameSource = uniqueName('rename-corrupt-source');
    const renameTarget = uniqueName('rename-corrupt-target');
    const copySource = uniqueName('copy-corrupt-source');
    const copyTarget = uniqueName('copy-corrupt-target');
    for (const name of [renameSource, renameTarget, copySource, copyTarget]) {cleanup(name);}
    try {
        const renameWorkflow = createWorkflowOnFs(renameSource);
        renameWorkflow.save({kind: 'dsl', name: 'secondary', content: 'wait 1', stepResolves: {}});
        fs.rmSync(path.join(workflowRootDir(renameSource), 'dsls', 'secondary.dsl'));

        const copyWorkflow = createWorkflowOnFs(copySource);
        copyWorkflow.save(entityRules('broken-rules'));
        fs.rmSync(path.join(workflowRootDir(copySource), 'entity_rules', 'broken-rules', 'match.yaml'));

        assert.throws(
            () => renameWorkflowOnFs(renameSource, renameTarget),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.equal(fs.existsSync(workflowRootDir(renameSource)), true);
        assert.equal(fs.existsSync(workflowRootDir(renameTarget)), false);

        assert.throws(
            () => copyWorkflowOnFs(copySource, copyTarget),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.equal(fs.existsSync(workflowRootDir(copySource)), true);
        assert.equal(fs.existsSync(workflowRootDir(copyTarget)), false);
    } finally {
        for (const name of [renameSource, renameTarget, copySource, copyTarget]) {cleanup(name);}
    }
});

test('recording metadata identity and structure are validated before persistence and on reload', () => {
    const name = uniqueName('recording-metadata-integrity');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        const invalidName = 'invalid-recording';
        assert.throws(() => workflow.save({
            ...recording(invalidName),
            recording: {
                ...recording(invalidName).recording,
                activeTabRef: 42,
            },
        } as any));
        assert.equal(
            fs.existsSync(path.join(workflowRootDir(name), 'recordings', invalidName)),
            false,
        );
        assert.equal(workflow.list({kind: 'recording'}).length, 0);

        workflow.save(recording('identity-mismatch'));
        const metadataPath = path.join(
            workflowRootDir(name),
            'recordings',
            'identity-mismatch',
            'recording.yaml',
        );
        const metadata = YAML.parse(fs.readFileSync(metadataPath, 'utf8'));
        fs.writeFileSync(metadataPath, YAML.stringify({...metadata, recordingName: 'other-name'}), 'utf8');
        const reloaded = loadWorkflowFromFs(name);
        assert.throws(
            () => reloaded.get('identity-mismatch', {kind: 'recording'}),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
        assert.throws(
            () => reloaded.list({kind: 'recording'}),
            (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
        );
    } finally {
        cleanup(name);
    }
});

test('corrupt entity-rule files fail loading instead of disappearing from the workflow', () => {
    const name = uniqueName('entity-rules-corruption');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save(entityRules('invalid-page'));
        workflow.save(entityRules('missing-match'));
        fs.writeFileSync(
            path.join(workflowRootDir(name), 'entity_rules', 'invalid-page', 'page.yaml'),
            'kind: unsupported\n',
            'utf8',
        );
        fs.rmSync(path.join(workflowRootDir(name), 'entity_rules', 'missing-match', 'match.yaml'));

        const reloaded = loadWorkflowFromFs(name);
        for (const profileName of ['invalid-page', 'missing-match']) {
            assert.throws(
                () => reloaded.get(profileName, {kind: 'entity_rules'}),
                (error: any) => error?.code === 'ERR_WORKFLOW_INVALID_ARTIFACT',
            );
        }
        assert.throws(
            () => reloaded.list({kind: 'entity_rules'}),
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

test('checkpoint.get exposes persisted body DSL without bloating checkpoint.list', async () => {
    const name = uniqueName('checkpoint-get-body');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({
            kind: 'checkpoint',
            name: 'procedure-body',
            checkpoint: {
                id: 'procedure-body',
                kind: 'procedure',
                trigger: {matchRules: [{errorCode: 'ERR_UNUSED'}]},
                body: {language: 'dsl', source: 'body.dsl'},
            },
            stepResolves: {},
            hints: {},
            bodyDsl: 'wait 1',
        });
        const {registry} = createWorkspaceHarness();
        const workspace = registry.createWorkspace(name, workflow);

        const listed = await workspace.router.handle({
            v: 1, id: 'checkpoint-list', type: 'checkpoint.list', workspaceName: name,
        } as any, workspace as any, registry as any);
        const listItem = (listed.reply.payload as {checkpoints: Array<Record<string, unknown>>}).checkpoints[0];
        assert.equal(Object.hasOwn(listItem, 'bodyDsl'), false);

        const got = await workspace.router.handle({
            v: 1, id: 'checkpoint-get', type: 'checkpoint.get', workspaceName: name,
            payload: {checkpointId: 'procedure-body'},
        } as any, workspace as any, registry as any);
        assert.equal((got.reply.payload as {bodyDsl?: string}).bodyDsl, 'wait 1');
    } finally {
        cleanup(name);
    }
});

test('checkpoint.save persists DSL bodies and preserves them across metadata-only updates', async () => {
    const name = uniqueName('checkpoint-save-body');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        const {registry} = createWorkspaceHarness();
        const workspace = registry.createWorkspace(name, workflow);
        const checkpoint = {
            id: 'saved-body',
            kind: 'procedure',
            trigger: {matchRules: []},
            body: {language: 'dsl', source: 'body.dsl'},
        };
        const saved = await workspace.router.handle({
            v: 1,
            id: 'save-checkpoint-body',
            type: 'checkpoint.save',
            workspaceName: name,
            payload: {
                checkpoint,
                bodyDsl: 'output ready = input.ready',
                stepResolves: {
                    savedTarget: {hint: {raw: {selector: '#saved-target'}}},
                },
                hints: {
                    savedHint: {why: 'preserve this hint'},
                },
            },
        } as any, workspace as any, registry as any);
        assert.equal(saved.reply.type, 'checkpoint.save.result');

        await workspace.router.handle({
            v: 1,
            id: 'update-checkpoint-metadata',
            type: 'checkpoint.save',
            workspaceName: name,
            payload: {
                checkpoint: {...checkpoint, priority: 4},
            },
        } as any, workspace as any, registry as any);

        const loaded = await workspace.router.handle({
            v: 1,
            id: 'get-checkpoint-body',
            type: 'checkpoint.get',
            workspaceName: name,
            payload: {checkpointId: checkpoint.id},
        } as any, workspace as any, registry as any);
        assert.equal((loaded.reply.payload as {bodyDsl?: string}).bodyDsl, 'output ready = input.ready');
        assert.equal(
            (loaded.reply.payload as {checkpoint: {priority?: number}}).checkpoint.priority,
            4,
        );
        assert.equal(
            (loaded.reply.payload as {stepResolves: any}).stepResolves.savedTarget.hint.raw.selector,
            '#saved-target',
        );
        assert.equal(
            (loaded.reply.payload as {hints: any}).hints.savedHint.why,
            'preserve this hint',
        );

        await assert.rejects(() => workspace.router.handle({
            v: 1,
            id: 'save-missing-body',
            type: 'checkpoint.save',
            workspaceName: name,
            payload: {
                checkpoint: {...checkpoint, id: 'missing-body'},
            },
        } as any, workspace as any, registry as any));
        await assert.rejects(() => workspace.router.handle({
            v: 1,
            id: 'save-invalid-sidecar-type',
            type: 'checkpoint.save',
            workspaceName: name,
            payload: {
                checkpoint: {...checkpoint, id: 'invalid-sidecar-type'},
                bodyDsl: 'wait 1',
                stepResolves: [],
            },
        } as any, workspace as any, registry as any));
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
