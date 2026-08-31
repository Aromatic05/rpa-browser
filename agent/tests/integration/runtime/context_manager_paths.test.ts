import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {resolvePaths} from '../../../src/automation/runtime/browser/context_manager';

test('resolvePaths keeps the default Chromium profile outside the source tree', () => {
    const previous = process.env.RPA_USER_DATA_DIR;
    delete process.env.RPA_USER_DATA_DIR;
    try {
        const paths = resolvePaths();
        assert.equal(paths.userDataRoot, path.resolve(import.meta.dirname, '../../..', '.user-data'));
        assert.equal(paths.userDataRoot.includes(`${path.sep}src${path.sep}`), false);
    } finally {
        if (previous === undefined) {
            delete process.env.RPA_USER_DATA_DIR;
        } else {
            process.env.RPA_USER_DATA_DIR = previous;
        }
    }
});

test('resolvePaths preserves an explicit RPA_USER_DATA_DIR override', () => {
    const previous = process.env.RPA_USER_DATA_DIR;
    const override = path.resolve(import.meta.dirname, 'custom-profile-root');
    process.env.RPA_USER_DATA_DIR = override;
    try {
        assert.equal(resolvePaths().userDataRoot, override);
    } finally {
        if (previous === undefined) {
            delete process.env.RPA_USER_DATA_DIR;
        } else {
            process.env.RPA_USER_DATA_DIR = previous;
        }
    }
});
