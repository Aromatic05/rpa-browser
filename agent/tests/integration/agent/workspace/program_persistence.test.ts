import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createWorkspaceHarness} from '../../../helpers/workspace_harness';
import {createWorkflowOnFs} from '../../../../src/automation/workflow';
import {createWorkspaceProgramSaver} from '../../../../src/agent/workspace/program_persistence';

const unique = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

test('workspace Program saver uses create-CAS, observed-revision overwrite, and shared DSL validation', async () => {
    const {registry, runStepsDeps} = createWorkspaceHarness();
    const workspaceName = unique('agent-program-save');
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    const save = createWorkspaceProgramSaver({workspaceName, deps: runStepsDeps});

    const created = await save({
        name: 'generated',
        source: 'output value = input.first',
    });
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') {throw new Error('expected initial save');}
    const initial = workspace.workflow.get('generated', {kind: 'dsl'});
    assert.equal(initial?.kind, 'dsl');
    if (initial?.kind !== 'dsl') {throw new Error('expected generated DSL');}
    assert.equal(initial.content, 'output value = input.first');
    assert.deepEqual(initial.stepResolves, {});

    const unobservedOverwrite = await save({
        name: 'generated',
        source: 'output value = input.second',
    });
    assert.deepEqual(unobservedOverwrite, {
        status: 'conflict',
        name: 'generated',
        currentRevision: created.artifactRevision,
    });
    const afterConflict = workspace.workflow.get('generated', {kind: 'dsl'});
    assert.equal(afterConflict?.kind === 'dsl' ? afterConflict.content : null, 'output value = input.first');

    const overwritten = await save({
        name: 'generated',
        source: 'output value = input.second',
        expectedRevision: created.artifactRevision,
    });
    assert.equal(overwritten.status, 'saved');
    if (overwritten.status !== 'saved') {throw new Error('expected CAS overwrite');}
    assert.notEqual(overwritten.artifactRevision, created.artifactRevision);
    const afterOverwrite = workspace.workflow.get('generated', {kind: 'dsl'});
    assert.equal(afterOverwrite?.kind === 'dsl' ? afterOverwrite.content : null, 'output value = input.second');

    await assert.rejects(
        () => save({name: 'invalid-generated', source: 'this is not valid dsl !!!'}),
        (error: unknown) => error instanceof Error
            && 'code' in error
            && typeof (error as {code?: unknown}).code === 'string'
            && (error as {code: string}).code.startsWith('ERR_DSL_'),
    );
    assert.equal(workspace.workflow.get('invalid-generated', {kind: 'dsl'}), null);
});
