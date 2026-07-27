import test from 'node:test';
import assert from 'node:assert/strict';
import {planAnnotationFromCandidate} from '../recommend/candidate_to_annotation.js';
import type {CanvasEntityDraft, PickCandidate} from '../types.js';

const makeEntity = (): CanvasEntityDraft => ({
    id: 'e1',
    source: 'region',
    kind: 'form',
    name: '表单',
    businessTag: 'form_tag',
    target: {},
    annotations: [],
    columns: [],
    origin: 'manual',
});

const makeCandidate = (overrides: Partial<PickCandidate>): PickCandidate => ({
    level: 'control',
    nodeId: 'n1',
    score: 70,
    role: 'textbox',
    text: '邮箱',
    proposedTargets: [{ariaContains: 'email'}],
    expect: 'unique',
    ...overrides,
});

test('planAnnotationFromCandidate uses recommended type for chosen annotation', () => {
    const entity = makeEntity();
    const candidate = makeCandidate({role: 'textbox'});
    const plan = planAnnotationFromCandidate(candidate, entity);
    assert.equal(plan.annotation.type, 'field');
    assert.equal(plan.annotation.origin, 'manual');
    assert.equal(plan.annotation.disposition, 'active');
    assert.deepEqual(plan.annotation.target, {ariaContains: 'email'});
});

test('planAnnotationFromCandidate derives businessKey from text and slugifies', () => {
    const entity = makeEntity();
    const candidate = makeCandidate({text: '用户邮箱'});
    const plan = planAnnotationFromCandidate(candidate, entity);
    assert.equal(plan.annotation.businessKey, '用户邮箱');
    assert.equal(plan.annotation.name, '用户邮箱');
});

test('planAnnotationFromCandidate avoids collisions with existing businessKeys', () => {
    const entity = {...makeEntity(), annotations: [{
        id: 'old',
        type: 'field',
        businessKey: '邮箱',
        target: {},
        origin: 'manual',
        disposition: 'active',
    }]};
    const candidate = makeCandidate({text: '邮箱'});
    const plan = planAnnotationFromCandidate(candidate, entity);
    assert.notEqual(plan.annotation.businessKey, '邮箱');
    assert.ok(plan.annotation.businessKey.startsWith('邮箱'));
});

test('planAnnotationFromCandidate respects explicit recommendedType when valid', () => {
    const entity = {...makeEntity(), kind: 'table'};
    const candidate = makeCandidate({level: 'field', role: 'gridcell'});
    const plan = planAnnotationFromCandidate(candidate, entity, 'column');
    assert.equal(plan.annotation.type, 'field');
    assert.ok(plan.recommendedTypes.includes('column'));
});

test('planAnnotationFromCandidate ignores invalid recommendedType and uses first recommendation', () => {
    const entity = makeEntity();
    const candidate = makeCandidate({role: 'textbox'});
    const plan = planAnnotationFromCandidate(candidate, entity, 'entity');
    assert.equal(plan.annotation.type, 'field');
});

test('planAnnotationFromCandidate forces one_or_more expect for row_action recommendation', () => {
    const entity = {...makeEntity(), kind: 'table'};
    const candidate = makeCandidate({level: 'row', role: 'row'});
    const plan = planAnnotationFromCandidate(candidate, entity, 'row_action');
    assert.equal(plan.expect, 'one_or_more');
    assert.equal(plan.annotation.type, 'action');
});

test('planAnnotationFromCandidate falls back when proposedTargets is empty', () => {
    const entity = makeEntity();
    const candidate = makeCandidate({proposedTargets: undefined, role: 'button'});
    const plan = planAnnotationFromCandidate(candidate, entity);
    assert.deepEqual(plan.annotation.target, {ariaContains: 'button'});
});
