import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkflowRecordingDir, saveWorkflowRecordingArtifacts } from '../../../src/record/persistence';
import type { StepUnion } from '../../../src/runner/steps/types';

test('saveWorkflowRecordingArtifacts writes into workflow recordings directory with manifest', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-record-'));
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.snapshot',
            args: {},
        } as StepUnion,
    ];
    const dir = await saveWorkflowRecordingArtifacts({
        artifactsRootDir: tmp,
        scene: 'order',
        recordingName: 'recording-main',
        workspaceName: 'ws-1',
        entryUrl: 'http://localhost/orders',
        steps,
        stepResolves: {},
    });

    assert.equal(fss.existsSync(path.join(dir, 'steps.yaml')), true);
    assert.equal(fss.existsSync(path.join(dir, 'step_resolve.yaml')), true);
    assert.equal(fss.existsSync(path.join(dir, 'manifest.yaml')), true);
    assert.equal(dir.endsWith(path.join('workflows', 'order', 'recordings', 'recording-main')), true);
});

test('resolveWorkflowRecordingDir resolves only the canonical recordings directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-record-'));
    const recordingsDir = path.join(tmp, 'workflows', 'order', 'recordings', 'main');
    await fs.mkdir(recordingsDir, { recursive: true });
    const resolved = await resolveWorkflowRecordingDir(tmp, 'order', 'main');
    assert.equal(resolved, recordingsDir);

    await fs.rm(recordingsDir, { recursive: true, force: true });
    await assert.rejects(
        () => resolveWorkflowRecordingDir(tmp, 'order', 'main'),
        /workflow recording not found/,
    );
});
