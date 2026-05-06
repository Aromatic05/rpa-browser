import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../src/workflow';
import type { WorkflowRecording } from '../../src/workflow';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

test('recording codec persists replay-required step meta fields in steps.yaml', () => {
    const workflowName = uniqueName('recording-meta');
    try {
        const workflow = createWorkflowOnFs(workflowName);
        const artifact: WorkflowRecording = {
            kind: 'recording',
            name: 'rec-meta',
            recording: {
                version: 1,
                recordingName: 'rec-meta',
                workspaceName: 'ws-1',
                activeTabRef: 'tab-1',
                initialTabs: [{ tabName: 'tab-1', tabRef: 'tab-1', url: 'https://a.test', title: 'A', active: true }],
                tabs: [{ tabName: 'tab-1', url: 'https://a.test' }],
            },
            steps: [{
                id: 's-meta',
                name: 'browser.click',
                args: { selector: '#a' },
                meta: {
                    source: 'record',
                    ts: 123,
                    workspaceName: 'ws-1',
                    tabName: 'tab-1',
                    tabRef: 'tab-1',
                    urlAtRecord: 'https://a.test',
                },
            } as any],
            stepResolves: {},
        };
        workflow.save(artifact);
        const loaded = loadWorkflowFromFs(workflowName).get('rec-meta', { kind: 'recording' });
        assert.equal(loaded?.kind, 'recording');
        assert.equal(loaded?.steps[0]?.meta?.tabName, 'tab-1');
        assert.equal(loaded?.steps[0]?.meta?.tabRef, 'tab-1');
        assert.equal(loaded?.steps[0]?.meta?.urlAtRecord, 'https://a.test');
        assert.equal(loaded?.steps[0]?.meta?.source, 'record');
        assert.equal(loaded?.steps[0]?.meta?.ts, 123);
        assert.equal(loaded?.steps[0]?.meta?.workspaceName, 'ws-1');
    } finally {
        deleteWorkflowFromFs(workflowName);
    }
});
