import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {workflowRootDir, workflowsRootDir} from '../../../src/workflow/fs';

test('workflow storage honors RPA_WORKFLOW_ROOT', () => {
    const previous = process.env.RPA_WORKFLOW_ROOT;
    const configuredRoot = path.join(os.tmpdir(), 'rpa-workflow-root-isolation');
    process.env.RPA_WORKFLOW_ROOT = configuredRoot;
    try {
        assert.equal(workflowsRootDir(), path.resolve(configuredRoot));
        assert.equal(workflowRootDir('isolated-workflow'), path.join(path.resolve(configuredRoot), 'isolated-workflow'));
    } finally {
        if (previous === undefined) {
            delete process.env.RPA_WORKFLOW_ROOT;
        } else {
            process.env.RPA_WORKFLOW_ROOT = previous;
        }
    }
});
