import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import {
    type CheckpointFile,
    type CheckpointHintFile,
    type StepFile,
    type StepHintFile,
    validateCheckpointFileForSerialization,
    validateStepFileForSerialization,
} from '../../../src/runner/serialization/types';

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
      id: "{{resolveBuyer.data.nodeId}}"
      value: 张三
`) as StepFile;

    assert.doesNotThrow(() => validateStepFileForSerialization(stepFile));
});

test('steps.yaml rejects resolve and inline hint payloads', () => {
    const resolveStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      id: buyer-input
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
      id: buyer-input
      value: 张三
      rawContext:
        url: /orders
`) as StepFile;
    const nestedRawContextStepFile = parse(`
version: 1
steps:
  - id: fillBuyer
    name: browser.fill
    args:
      target:
        id: buyer-input
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

    assert.throws(() => validateStepFileForSerialization(resolveStepFile), /steps\[0\]\.resolve/);
    assert.throws(() => validateStepFileForSerialization(rawContextStepFile), /steps\[0\]\.args\.rawContext/);
    assert.throws(() => validateStepFileForSerialization(nestedRawContextStepFile), /steps\[0\]\.args\.target\.rawContext/);
    assert.throws(() => validateStepFileForSerialization(locatorCandidatesStepFile), /steps\[0\]\.args\.locatorCandidates/);
});

test('step_hints.yaml schema stores sidecar hints by stepId', () => {
    const hintFile = parse(`
version: 1
hints:
  fillBuyer:
    entity:
      businessTag: order.form.main
      fieldKey: buyer
    target:
      role: textbox
      name: 采购人
    locatorCandidates:
      - kind: css
        query: "[data-testid='buyer-input']"
    recordedAt:
      url: http://127.0.0.1:5173/entity-rules/fixtures/order-form
      timestamp: 1710000000000
    rawContext:
      source: recorder
`) as StepHintFile;

    assert.equal(hintFile.version, 1);
    assert.equal(typeof hintFile.hints.fillBuyer?.entity?.businessTag, 'string');
    assert.equal(Array.isArray(hintFile.hints.fillBuyer?.locatorCandidates), true);
    assert.equal(typeof hintFile.hints.fillBuyer?.rawContext, 'object');
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
            hint:
              target:
                role: button
                name: 提交
            id:
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
            locatorCandidates:
              - kind: css
                selector: "#submit"
            id:
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
});

test('checkpoint_hints.yaml schema stores sidecar hints by checkpointId', () => {
    const hintFile = parse(`
version: 1
hints:
  recover-order-form-submit:
    why: 提交按钮结构不稳定
    scope:
      businessTag: order.form.main
    preferredEntityRules:
      - order_form_main
      - order_form_submit
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
    assert.equal(Array.isArray(hintFile.hints['recover-order-form-submit']?.preferredEntityRules), true);
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
        assert.equal(serialized.includes('preferredEntityRules'), false);
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
