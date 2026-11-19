import test from 'node:test';
import assert from 'node:assert/strict';
import {requireArtifactName} from '../../../src/automation/workflow/fs';

test('artifact names support Chinese while excluding paths and control characters', () => {
    for (const name of ['跨页录入','每周报表-2026','customer_form-1']) {assert.equal(requireArtifactName(name),name);}
    for (const name of ['../跨页录入','a/b','a\\b','..','a:b','a\n']) {assert.throws(() => requireArtifactName(name));}
});
