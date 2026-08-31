import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import {
    type CheckpointFile,
    type CheckpointHintFile,
    type StepFile,
    type StepResolveFile,
    validateCheckpointFileForSerialization,
    validateStepFileForSerialization,
    validateStepResolveFileForSerialization,
} from '../../../../src/automation/runner/serialization/types';

const examplesDir = path.resolve(process.cwd(), 'tests/fixtures/checkpoints');

test('steps.yaml schema keeps execution semantics only', () => {
    const stepFile = parse(`
version: 1
steps:
  - id: resolveBuyer
    name: browser.query
    args:
      op: entity.target
      businessTag: order.form.main
      target:
        kind: form.field
        fieldKey: buyer
  - id: fillBuyer
    name: browser.fill
    args:
      resolveId: resolveBuyerField
      nodeId: "{{resolveBuyer.data.nodeId}}"
      value: 张三
`) as StepFile;

    assert.doesNotThrow(() => validateStepFileForSerialization(stepFile));
});

test('steps.yaml rejects runtime fields and inline hint payloads', () => {
    const resolveStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      nodeId: buyer-input
      value: 张三
    resolve:
      hint:
        entity:
          businessTag: order.form.main
`) as StepFile;
    const rawContextStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      nodeId: buyer-input
      value: 张三
      rawContext:
        url: /orders
`) as StepFile;
    const metaStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      nodeId: buyer-input
      value: 张三
    meta:
      source: script
`) as StepFile;
    const nestedRawContextStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      target:
        nodeId: buyer-input
        rawContext:
          source: recorder
      value: 张三
`) as StepFile;
    const locatorCandidatesStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      id: buyer-input
      value: 张三
      locatorCandidates:
        - kind: css
          selector: "#buyer"
`) as StepFile;
    const legacyIdStepFile = parse(`
version: 1
steps:
  - id: clickBuyer
    name: browser.click
    args:
      id: buyer-input
`) as StepFile;
    const topLevelResolveIdStepFile = parse(`
version: 1
steps:
  - id: clickBuyer
    name: browser.click
    resolveId: resolveBuyer
    args:
      nodeId: buyer-input
`) as StepFile;

    assert.throws(() => validateStepFileForSerialization(resolveStepFile), /steps\[0\]\.resolve/);
    assert.throws(() => validateStepFileForSerialization(rawContextStepFile), /steps\[0\]\.args\.rawContext/);
    assert.throws(() => validateStepFileForSerialization(metaStepFile), /steps\[0\]\.meta/);
    assert.throws(() => validateStepFileForSerialization(nestedRawContextStepFile), /steps\[0\]\.args\.target\.rawContext/);
    assert.throws(() => validateStepFileForSerialization(locatorCandidatesStepFile), /steps\[0\]\.args\.locatorCandidates/);
    assert.throws(() => validateStepFileForSerialization(legacyIdStepFile), /use nodeId instead/);
    assert.throws(() => validateStepFileForSerialization(topLevelResolveIdStepFile), /args\.resolveId instead/);
});

test('step_resolve.yaml schema stores sidecar resolve data by resolveId', () => {
    const resolveFile = parse(`
version: 1
resolves:
  resolveBuyerField:
    hint:
      entity:
        businessTag: order.form.main
        fieldKey: buyer
      raw:
        selector: "#buyer-input"
    policy:
      requireVisible: true
`) as StepResolveFile;

    assert.doesNotThrow(() => validateStepResolveFileForSerialization(resolveFile));
    assert.equal(resolveFile.version, 1);
    assert.equal(typeof resolveFile.resolves.resolveBuyerField?.hint?.entity?.businessTag, 'string');
    assert.equal(resolveFile.resolves.resolveBuyerField?.policy?.requireVisible, true);
});

test('checkpoints.yaml schema requires trigger.matchRules and keeps hints external', () => {
    const checkpointFile = parse(`
version: 1
checkpoints:
  - id: recover-order-form-submit
    kind: recovery
    trigger:
      matchRules:
        - stepName: browser.click
        - errorCode: ERR_NOT_FOUND
    content:
      - id: resolveSubmit
        name: browser.query
        args:
          op: entity.target
          businessTag: order.form.main
          target:
            kind: form.action
            actionIntent: submit
    policy:
      maxAttempts: 1
      retryOriginal: false
`) as CheckpointFile;

    assert.doesNotThrow(() => validateCheckpointFileForSerialization(checkpointFile));
});

test('procedure checkpoints may omit automatic recovery triggers', () => {
    const procedureFile = parse(`
version: 1
checkpoints:
  - id: legacy-procedure
    kind: procedure
    content: []
`) as CheckpointFile;

    assert.doesNotThrow(() => validateCheckpointFileForSerialization(procedureFile));
});

test('checkpoints.yaml rejects misplaced trigger fields', () => {
    const withTopLevel = parse(`
version: 1
checkpoints:
  - id: recover-bad
    matchRules:
      - errorCode: ERR_NOT_FOUND
    content: []
`) as CheckpointFile;
    const withPolicyTrigger = parse(`
version: 1
checkpoints:
  - id: recover-bad-2
    trigger:
      matchRules:
        - errorCode: ERR_NOT_FOUND
    policy:
      trigger:
        matchRules:
          - stepName: browser.click
    content: []
`) as CheckpointFile;

    assert.throws(() => validateCheckpointFileForSerialization(withTopLevel), /trigger\.matchRules/);
    assert.throws(() => validateCheckpointFileForSerialization(withPolicyTrigger), /checkpoint root/);
});

test('checkpoints.yaml rejects recovery checkpoints without an explicit match rule', () => {
    const catchAll = parse(`
version: 1
checkpoints:
  - id: catch-all
    kind: recovery
    trigger:
      matchRules: []
    content: []
`) as CheckpointFile;

    assert.throws(
        () => validateCheckpointFileForSerialization(catchAll),
        /recovery checkpoint catch-all must include at least one trigger\.matchRules entry/,
    );
});

test('checkpoints.yaml rejects unsupported checkpoint kinds instead of persisting silent no-ops', () => {
    for (const kind of ['guard', 'recoverry']) {
        const invalidKind = parse(`
version: 1
checkpoints:
  - id: unsupported-kind
    kind: ${kind}
    trigger:
      matchRules:
        - errorCode: ERR_NOT_FOUND
    content: []
`) as CheckpointFile;

        assert.throws(
            () => validateCheckpointFileForSerialization(invalidKind),
            /checkpoint unsupported-kind kind must be procedure or recovery/,
        );
    }
});

test('checkpoints.yaml normalizes legacy stopOnFailure=true and rejects unsupported false semantics', () => {
    const legacy = parse(`
version: 1
checkpoints:
  - id: legacy-stop
    kind: recovery
    trigger:
      matchRules:
        - errorCode: ERR_NOT_FOUND
    policy:
      stopOnFailure: true
    content: []
`) as CheckpointFile;
    const unsupported = parse(`
version: 1
checkpoints:
  - id: unsupported-stop
    kind: recovery
    trigger:
      matchRules:
        - errorCode: ERR_NOT_FOUND
    policy:
      stopOnFailure: false
    content: []
`) as CheckpointFile;

    validateCheckpointFileForSerialization(legacy);
    assert.equal('stopOnFailure' in (legacy.checkpoints[0].policy || {}), false);
    assert.throws(
        () => validateCheckpointFileForSerialization(unsupported),
        /checkpoint unsupported-stop policy\.stopOnFailure=false is unsupported/,
    );
});

test('checkpoints.yaml rejects malformed runtime controls and match rules', () => {
    const base = (): CheckpointFile => ({
        version: 1,
        checkpoints: [{
            id: 'invalid-control',
            kind: 'recovery',
            trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}]},
            content: [],
        }],
    });
    const cases: Array<{mutate: (checkpoint: any) => void; message: RegExp}> = [
        {mutate: (checkpoint) => { checkpoint.enabled = 'false'; }, message: /enabled must be a boolean/},
        {mutate: (checkpoint) => { checkpoint.priority = Number.NaN; }, message: /priority must be a finite number/},
        {mutate: (checkpoint) => { checkpoint.policy = {maxAttempts: -1}; }, message: /maxAttempts must be a non-negative integer/},
        {mutate: (checkpoint) => { checkpoint.policy = {maxAttempts: 1.5}; }, message: /maxAttempts must be a non-negative integer/},
        {mutate: (checkpoint) => { checkpoint.policy = {retryOriginal: 'yes'}; }, message: /retryOriginal must be a boolean/},
        {mutate: (checkpoint) => { checkpoint.policy = {unknown: true}; }, message: /unsupported policy field: unknown/},
        {mutate: (checkpoint) => { checkpoint.trigger.matchRules = [{}]; }, message: /match rule must contain exactly one supported condition/},
        {mutate: (checkpoint) => { checkpoint.trigger.matchRules = [{errorCode: 'ERR', extra: true}]; }, message: /match rule must contain exactly one supported condition/},
        {mutate: (checkpoint) => { checkpoint.trigger.matchRules = [{errorCode: ''}]; }, message: /errorCode must be a non-empty string/},
        {mutate: (checkpoint) => { checkpoint.trigger.matchRules = [{entityExists: {query: 42}}]; }, message: /entityExists.query must be a string/},
    ];

    for (const item of cases) {
        const file = base();
        item.mutate(file.checkpoints[0]);
        assert.throws(() => validateCheckpointFileForSerialization(file), item.message);
    }
});

test('checkpoints.yaml rejects nested rawContext, hint, and locatorCandidates in core content', () => {
    const rawContextCheckpointFile = parse(`
version: 1
checkpoints:
  - id: recover-order-form-submit
    trigger:
      matchRules:
        - stepName: browser.click
    content:
      - id: resolveSubmit
        name: browser.query
        args:
          op: entity.target
          businessTag: order.form.main
          rawContext:
            source: recorder
          target:
            kind: form.action
            actionIntent: submit
`) as CheckpointFile;
    const hintCheckpointFile = parse(`
version: 1
checkpoints:
  - id: recover-order-form-submit
    trigger:
      matchRules:
        - stepName: browser.click
    content:
      - type: act
        step:
          name: browser.click
          args:
            resolveId: resolveSubmit
            hint:
              target:
                role: button
                name: 提交
            nodeId:
              ref: local.submitTarget.nodeId
`) as CheckpointFile;
    const locatorCandidatesCheckpointFile = parse(`
version: 1
checkpoints:
  - id: recover-order-form-submit
    trigger:
      matchRules:
        - stepName: browser.click
    content:
      - type: act
        step:
          name: browser.click
          args:
            resolveId: resolveSubmit
            locatorCandidates:
              - kind: css
                selector: "#submit"
            nodeId:
              ref: local.submitTarget.nodeId
`) as CheckpointFile;
    const topLevelResolveIdCheckpointFile = parse(`
version: 1
checkpoints:
  - id: recover-order-form-submit
    trigger:
      matchRules:
        - stepName: browser.click
    content:
      - type: act
        step:
          name: browser.click
          resolveId: resolveSubmit
          args:
            nodeId:
              ref: local.submitTarget.nodeId
`) as CheckpointFile;

    assert.throws(
        () => validateCheckpointFileForSerialization(rawContextCheckpointFile),
        /checkpoints\[0\]\.content\[0\]\.args\.rawContext/,
    );
    assert.throws(
        () => validateCheckpointFileForSerialization(hintCheckpointFile),
        /checkpoints\[0\]\.content\[0\]\.step\.args\.hint/,
    );
    assert.throws(
        () => validateCheckpointFileForSerialization(locatorCandidatesCheckpointFile),
        /checkpoints\[0\]\.content\[0\]\.step\.args\.locatorCandidates/,
    );
    assert.throws(
        () => validateCheckpointFileForSerialization(topLevelResolveIdCheckpointFile),
        /step\.resolveId; use .*step\.args\.resolveId instead/,
    );
});

test('checkpoint_hints.yaml schema stores sidecar hints by checkpointId', () => {
    const hintFile = parse(`
version: 1
hints:
  recover-order-form-submit:
    why: 提交按钮结构不稳定
    scope:
      businessTag: order.form.main
    fallbacks:
      - kind: role
        role: button
        name: 提交
    notes:
      - use business entity fallback first
`) as CheckpointHintFile;

    assert.equal(hintFile.version, 1);
    assert.equal(hintFile.hints['recover-order-form-submit']?.scope?.businessTag, 'order.form.main');
    assert.equal(Array.isArray(hintFile.hints['recover-order-form-submit']?.fallbacks), true);
    assert.equal(Array.isArray(hintFile.hints['recover-order-form-submit']?.notes), true);
});

test('checkpoint example yaml files round-trip without leaking hints into core files', async () => {
    const coreExampleNames = ['order_form_submit.checkpoints.yaml', 'order_list_row_action.checkpoints.yaml'];
    const hintExampleNames = ['order_form_submit.checkpoint_hints.yaml', 'order_list_row_action.checkpoint_hints.yaml'];

    for (const fileName of coreExampleNames) {
        const source = await fs.readFile(path.join(examplesDir, fileName), 'utf-8');
        const parsed = parse(source) as CheckpointFile;
        validateCheckpointFileForSerialization(parsed);

        const roundTripped = parse(stringify(parsed)) as CheckpointFile;
        validateCheckpointFileForSerialization(roundTripped);

        const serialized = stringify(roundTripped);
        assert.equal(serialized.includes('{{'), false);
        assert.equal(serialized.includes('}}'), false);
        assert.equal(serialized.includes('rawContext'), false);
        assert.equal(serialized.includes('fallbacks'), false);
        assert.equal(serialized.includes('locatorCandidates'), false);
        assert.equal(serialized.includes('replayHints'), false);
        assert.equal(serialized.includes('ref: local.'), true);
    }

    for (const fileName of hintExampleNames) {
        const source = await fs.readFile(path.join(examplesDir, fileName), 'utf-8');
        const parsed = parse(source) as CheckpointHintFile;
        const roundTripped = parse(stringify(parsed)) as CheckpointHintFile;
        assert.equal(roundTripped.version, 1);
        assert.equal(typeof roundTripped.hints, 'object');
    }
});
