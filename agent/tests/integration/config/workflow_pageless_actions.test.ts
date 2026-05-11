import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import type { Action } from '../../src/actions/action_protocol';
import { createRecordingState } from '../../src/record/recording';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workflowsRoot = path.resolve(__dirname, '../../.artifacts/workflows');

test('workflow.init does not require tab target in action dispatcher', async (t) => {
    const scene = `pageless-${Date.now()}`;
    const sceneDir = path.join(workflowsRoot, scene);
    t.after(() => {
        fs.rmSync(sceneDir, { recursive: true, force: true });
    });

    const dispatcher = createActionDispatcher({
        pageRegistry: {
            getActiveWorkspace: () => null,
        } as any,
        runtime: {} as any,
        recordingState: createRecordingState(),
        log: () => undefined,
        replayOptions: {} as any,
        navDedupeWindowMs: 0,
    });

    const action: Action = {
        v: 1,
        id: 'wf-init-1',
        type: 'workflow.init',
        payload: { scene },
    };

    const reply = await dispatcher.dispatch(action);
    assert.equal(reply.type, 'workflow.init.result');
    assert.equal((reply.payload as any).scene, scene);
    assert.equal((reply.payload as any).created, true);
});
