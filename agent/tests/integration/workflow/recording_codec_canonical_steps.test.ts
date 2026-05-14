import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../src/workflow';
import { workflowRootDir } from '../../src/workflow/fs';
import type { WorkflowRecording } from '../../src/workflow';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

test('recording codec persists canonical tab steps without runtime meta', () => {
    const workflowName = uniqueName('recording-canonical');
    try {
        const workflow = createWorkflowOnFs(workflowName);
        const artifact: WorkflowRecording = {
            kind: 'recording',
            name: 'rec-canonical',
            recording: {
                version: 1,
                recordingName: 'rec-canonical',
                workspaceName: 'ws-1',
                activeTabRef: 'tab-1',
                initialTabs: [{ tabName: 'tab-1', tabRef: 'tab-1', url: 'https://a.test', title: 'A', active: true }],
                tabs: [{ tabName: 'tab-1', url: 'https://a.test' }],
            },
            steps: [
                { id: 'c', name: 'browser.create_tab', args: {}, meta: { source: 'record', tabName: 'tab-2' } },
                { id: 's', name: 'browser.switch_tab', args: { tabName: 'tab-2' }, meta: { source: 'record', tabName: 'tab-2' } },
                { id: 'g', name: 'browser.goto', args: { url: 'https://b.test' }, meta: { source: 'record', tabName: 'tab-2', urlAtRecord: 'https://b.test' } },
            ] as any,
            stepResolves: {},
        };
        workflow.save(artifact);
        const stepsYaml = fs.readFileSync(path.join(workflowRootDir(workflowName), 'recordings', 'rec-canonical', 'steps.yaml'), 'utf8');
        assert.equal(stepsYaml.includes('meta:'), false);
        assert.equal(stepsYaml.includes('tabRef:'), false);
        assert.equal(stepsYaml.includes('urlAtRecord:'), false);
        const parsed = YAML.parse(stepsYaml) as { steps: Array<{ name: string; args: Record<string, unknown> }> };
        assert.deepEqual(parsed.steps.map((step) => step.args), [
            {},
            { tabName: 'tab-2' },
            { url: 'https://b.test' },
        ]);
        const loaded = loadWorkflowFromFs(workflowName).get('rec-canonical', { kind: 'recording' });
        assert.equal(loaded?.kind, 'recording');
        assert.equal(loaded?.steps[0]?.meta, undefined);
    } finally {
        deleteWorkflowFromFs(workflowName);
    }
});
