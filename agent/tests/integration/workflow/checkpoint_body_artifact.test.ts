import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { createCheckpointCodec } from '../../../src/automation/workflow/checkpoint';

const withWorkflowRoot = (run: (root: string) => void): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-checkpoint-body-'));
    const previous = process.env.RPA_WORKFLOW_ROOT;
    process.env.RPA_WORKFLOW_ROOT = root;
    try {
        run(root);
    } finally {
        if (previous === undefined) {delete process.env.RPA_WORKFLOW_ROOT;}
        else {process.env.RPA_WORKFLOW_ROOT = previous;}
        fs.rmSync(root, {recursive: true, force: true});
    }
};

const checkpointFile = (checkpoint: Record<string, unknown>): string => YAML.stringify({version: 1, checkpoint});

test('checkpoint body artifacts preserve legacy checkpoints and reject missing or orphan bodies', () => {
    withWorkflowRoot((root) => {
        const codec = createCheckpointCodec('workflow-a');
        const legacy = {kind: 'checkpoint' as const, name: 'legacy', checkpoint: {id: 'legacy', kind: 'procedure' as const, trigger: {matchRules: []}}, stepResolves: {}, hints: {}};
        codec.save(legacy);
        assert.equal(codec.load('legacy')?.bodyDsl, undefined);

        const base = path.join(root, 'workflow-a', 'checkpoints');
        const missingDir = path.join(base, 'missing');
        fs.mkdirSync(missingDir, {recursive: true});
        fs.writeFileSync(path.join(missingDir, 'checkpoint.yaml'), checkpointFile({id: 'missing', kind: 'procedure', trigger: {matchRules: []}, body: {language: 'dsl', source: 'body.dsl'}}));
        assert.throws(() => codec.load('missing'), (error: unknown) =>
            error instanceof Error && error.cause instanceof Error && /checkpoint body\.dsl is required/.test(error.cause.message));

        const orphanDir = path.join(base, 'orphan');
        fs.mkdirSync(orphanDir, {recursive: true});
        fs.writeFileSync(path.join(orphanDir, 'checkpoint.yaml'), checkpointFile({id: 'orphan', kind: 'procedure', trigger: {matchRules: []}}));
        fs.writeFileSync(path.join(orphanDir, 'body.dsl'), 'output ignored = input.value');
        assert.throws(() => codec.load('orphan'), (error: unknown) =>
            error instanceof Error && error.cause instanceof Error && /orphan checkpoint body\.dsl/.test(error.cause.message));
    });
});

test('checkpoint body artifacts reject invalid body metadata', () => {
    withWorkflowRoot((root) => {
        const codec = createCheckpointCodec('workflow-b');
        const dir = path.join(root, 'workflow-b', 'checkpoints', 'invalid');
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, 'checkpoint.yaml'), checkpointFile({
            id: 'invalid', kind: 'procedure', trigger: {matchRules: []}, body: {language: 'dsl', source: 'wrong.dsl'},
        }));
        fs.writeFileSync(path.join(dir, 'body.dsl'), 'output done = input.value');
        assert.throws(() => codec.load('invalid'), (error: unknown) =>
            error instanceof Error && error.cause instanceof Error && /invalid checkpoint body metadata/.test(error.cause.message));
    });
});

test('checkpoint DSL bodies reject legacy procedure fields before writes', () => {
    withWorkflowRoot((root) => {
        const codec = createCheckpointCodec('workflow-c');
        assert.throws(() => codec.save({
            kind: 'checkpoint', name: 'ambiguous', stepResolves: {}, hints: {}, bodyDsl: 'output done = input',
            checkpoint: {
                id: 'ambiguous', kind: 'procedure', trigger: {matchRules: []}, body: {language: 'dsl', source: 'body.dsl'}, content: [],
            },
        }), /body\.dsl cannot be combined with legacy content/);
        assert.equal(fs.existsSync(path.join(root, 'workflow-c', 'checkpoints', 'ambiguous', 'checkpoint.yaml')), false);
    });
});
