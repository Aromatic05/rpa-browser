import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkflowRecordingDir, saveWorkflowRecordingArtifacts } from '../../src/record/persistence';
import type { StepUnion } from '../../src/runner/steps/types';

test('saveWorkflowRecordingArtifacts writes into workflow records directory with manifest', async () => {
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
    assert.equal(dir.endsWith(path.join('workflows', 'order', 'records', 'recording-main')), true);
});

test('resolveWorkflowRecordingDir prefers records and supports legacy steps compatibility', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-record-'));
    const recordsDir = path.join(tmp, 'workflows', 'order', 'records', 'main');
    const legacyDir = path.join(tmp, 'workflows', 'order', 'steps', 'main');
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });
    const resolved = await resolveWorkflowRecordingDir(tmp, 'order', 'main');
    assert.equal(resolved, recordsDir);

    await fs.rm(recordsDir, { recursive: true, force: true });
    const resolvedLegacy = await resolveWorkflowRecordingDir(tmp, 'order', 'main');
    assert.equal(resolvedLegacy, legacyDir);
});
