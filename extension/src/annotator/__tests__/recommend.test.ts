import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterCandidatesForAnnotationType,
    recommendAnnotationTypes,
} from '../recommend/recommend_types.js';
import type {PickCandidate} from '../types.js';

const baseCandidate = (overrides: Partial<PickCandidate>): PickCandidate => ({
    level: 'control',
    nodeId: 'n1',
    score: 70,
    ...overrides,
});

test('form input (textbox) yields field recommendation', () => {
    const candidate = baseCandidate({role: 'textbox'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['field', 'ignore']);
});

test('form select (combobox) yields field recommendation', () => {
    const candidate = baseCandidate({role: 'combobox'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['field', 'ignore']);
});

test('form button (role=button) yields action recommendation', () => {
    const candidate = baseCandidate({role: 'button'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['action', 'ignore']);
});

test('link (role=link) yields action recommendation', () => {
    const candidate = baseCandidate({role: 'link'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['action', 'ignore']);
});

test('candidate with actionIntent yields action recommendation', () => {
    const candidate = baseCandidate({role: 'button', actionIntent: 'delete'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['action', 'ignore']);
});

test('table header cell with currentEntityKind=table yields column recommendation', () => {
    const candidate = baseCandidate({level: 'field', role: 'columnheader'});
    assert.deepEqual(recommendAnnotationTypes(candidate, 'table'), ['column', 'ignore']);
});

test('table gridcell with currentEntityKind=table yields column recommendation', () => {
    const candidate = baseCandidate({level: 'field', role: 'gridcell'});
    assert.deepEqual(recommendAnnotationTypes(candidate, 'table'), ['column', 'ignore']);
});

test('field-level candidate without table context yields field recommendation', () => {
    const candidate = baseCandidate({level: 'field', role: 'gridcell'});
    assert.deepEqual(recommendAnnotationTypes(candidate, 'form'), ['field', 'ignore']);
});

test('row candidate yields row_action recommendation', () => {
    const candidate = baseCandidate({level: 'row', role: 'row'});
    assert.deepEqual(recommendAnnotationTypes(candidate, 'table'), ['row_action', 'ignore']);
});

test('pagination candidate detected via proposedTargets relation', () => {
    const candidate = baseCandidate({
        role: 'button',
        text: '下一页',
        proposedTargets: [{relation: 'pagination'}],
    });
    assert.deepEqual(recommendAnnotationTypes(candidate), ['pagination', 'action', 'ignore']);
});

test('pagination candidate detected via text hint', () => {
    const candidate = baseCandidate({role: 'button', text: 'next page'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['pagination', 'action', 'ignore']);
});

test('region candidate with entityRef yields entity/group recommendation', () => {
    const candidate = baseCandidate({
        level: 'region',
        role: 'region',
        entityRef: {
            entityId: 'e1',
            nodeId: 'n1',
            kind: 'form',
            type: 'region',
        },
    });
    assert.deepEqual(recommendAnnotationTypes(candidate), ['entity', 'group', 'ignore']);
});

test('group candidate yields entity/group recommendation', () => {
    const candidate = baseCandidate({level: 'group', role: 'group'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['entity', 'group', 'ignore']);
});

test('generic container falls back to entity/group/ignore', () => {
    const candidate = baseCandidate({level: 'control', role: 'generic'});
    assert.deepEqual(recommendAnnotationTypes(candidate), ['entity', 'group', 'ignore']);
});


test('filterCandidatesForAnnotationType keeps only targets matching the user-selected business role', () => {
    const field = baseCandidate({nodeId: 'field', role: 'textbox'});
    const action = baseCandidate({nodeId: 'action', role: 'button'});
    const region = baseCandidate({nodeId: 'region', level: 'region', role: 'region'});
    assert.deepEqual(
        filterCandidatesForAnnotationType([field, action, region], 'table', 'field').map((item) => item.nodeId),
        ['field'],
    );
    assert.deepEqual(
        filterCandidatesForAnnotationType([field, action, region], 'table', 'action').map((item) => item.nodeId),
        ['action'],
    );
});
