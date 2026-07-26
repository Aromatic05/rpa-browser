import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initialState,
    enterAnnotation,
    openLoaded,
    pickReceived,
    draftEdited,
    checkCompleted,
    saveCompleted,
    failed,
    exitAnnotation,
    undo,
    redo,
} from '../state/annotator_state.js';
import type {
    AnnotatorOpenResult,
    CanvasDraft,
    CheckResultByAnnotation,
} from '../types.js';

const makeDraft = (name: string): CanvasDraft => ({
    version: 1,
    profileName: name,
    page: { kind: 'table' },
    entities: [],
    preserved: {},
});

const makeOpenResult = (overrides: Partial<AnnotatorOpenResult> = {}): AnnotatorOpenResult => ({
    workspaceName: 'ws-1',
    tabName: 'tab-1',
    url: 'http://test/page',
    pageKind: 'table',
    profileName: 'profile-a',
    canvasDraft: makeDraft('profile-a'),
    artifactRevision: 'rev-001',
    visualTargetRefs: [],
    ...overrides,
});

test('initialState has idle mode and empty history', () => {
    const s = initialState();
    assert.equal(s.mode, 'idle');
    assert.equal(s.canvasDraft, null);
    assert.equal(s.dirty, false);
    assert.deepEqual(s.history, { past: [], future: [] });
    assert.equal(s.error, null);
});

test('enterAnnotation sets loading mode and clears error', () => {
    const s = enterAnnotation({ ...initialState(), error: 'boom' });
    assert.equal(s.mode, 'loading');
    assert.equal(s.error, null);
});

test('openLoaded sets draft, revision, pageIdentity, profileName and editing mode', () => {
    const result = makeOpenResult({ artifactRevision: 'rev-9' });
    const s = openLoaded(initialState(), result);
    assert.equal(s.mode, 'editing');
    assert.equal(s.canvasDraft, result.canvasDraft);
    assert.equal(s.artifactRevision, 'rev-9');
    assert.equal(s.profileName, 'profile-a');
    assert.deepEqual(s.pageIdentity, { workspaceName: 'ws-1', tabName: 'tab-1', url: 'http://test/page' });
    assert.equal(s.dirty, false);
    assert.deepEqual(s.history, { past: [], future: [] });
});

test('openLoaded resets dirty/history/latestCheck even if previously dirty', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    s = draftEdited(s, makeDraft('edited'));
    assert.equal(s.dirty, true);
    s = openLoaded(s, makeOpenResult({ artifactRevision: 'rev-2' }));
    assert.equal(s.dirty, false);
    assert.equal(s.artifactRevision, 'rev-2');
    assert.deepEqual(s.history, { past: [], future: [] });
});

test('draftEdited pushes previous draft onto past, clears future, sets dirty', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    const original = s.canvasDraft;
    const edited = makeDraft('edited');
    s = draftEdited(s, edited);
    assert.equal(s.canvasDraft, edited);
    assert.equal(s.dirty, true);
    assert.equal(s.history.past.length, 1);
    assert.equal(s.history.past[0], original);
    assert.deepEqual(s.history.future, []);
    assert.equal(s.latestCheck, null);
});

test('pickReceived updates currentEntityId/currentAnnotationId and stays in editing', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    s = pickReceived(s, { entityId: 'ent-1', annotationId: 'ann-1' });
    assert.equal(s.currentEntityId, 'ent-1');
    assert.equal(s.currentAnnotationId, 'ann-1');
    assert.equal(s.mode, 'editing');
});

test('checkCompleted sets latestCheck and stale flag', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    const results: CheckResultByAnnotation[] = [
        { canvasAnnotationId: 'a1', status: 'unique', matchCount: 1, expected: 'unique', message: 'ok', nodeIds: ['n1'] },
    ];
    s = checkCompleted(s, { results, stale: true });
    assert.equal(s.latestCheck, results);
    assert.equal(s.stale, true);
    assert.equal(s.mode, 'editing');
});

test('saveCompleted clears dirty, updates revision, resets history', () => {
    let s = openLoaded(initialState(), makeOpenResult({ artifactRevision: 'rev-1' }));
    s = draftEdited(s, makeDraft('edited'));
    assert.equal(s.dirty, true);
    s = saveCompleted(s, 'rev-2');
    assert.equal(s.dirty, false);
    assert.equal(s.artifactRevision, 'rev-2');
    assert.deepEqual(s.history, { past: [], future: [] });
});

test('undo restores previous draft and moves current to future', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    const first = s.canvasDraft!;
    s = draftEdited(s, makeDraft('second'));
    s = draftEdited(s, makeDraft('third'));
    assert.equal(s.history.past.length, 2);
    s = undo(s);
    assert.equal(s.canvasDraft!.profileName, 'second');
    assert.equal(s.history.past.length, 1);
    assert.equal(s.history.past[0], first);
    assert.equal(s.history.future.length, 1);
    assert.equal(s.dirty, true);
});

test('undo is a no-op when past is empty', () => {
    const s = openLoaded(initialState(), makeOpenResult());
    const after = undo(s);
    assert.equal(after, s);
});

test('redo replays a future draft', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    s = draftEdited(s, makeDraft('second'));
    s = undo(s);
    assert.equal(s.canvasDraft!.profileName, 'profile-a');
    s = redo(s);
    assert.equal(s.canvasDraft!.profileName, 'second');
    assert.equal(s.history.future.length, 0);
});

test('redo is a no-op when future is empty', () => {
    const s = openLoaded(initialState(), makeOpenResult());
    const after = redo(s);
    assert.equal(after, s);
});

test('failed from loading transitions back to idle and records error', () => {
    let s = enterAnnotation(initialState());
    s = failed(s, 'open rejected');
    assert.equal(s.mode, 'idle');
    assert.equal(s.error, 'open rejected');
});

test('failed from editing stays editing', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    s = failed(s, 'save rejected');
    assert.equal(s.mode, 'editing');
    assert.equal(s.error, 'save rejected');
});

test('exitAnnotation sets idle but keeps draft', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    const draft = s.canvasDraft;
    s = exitAnnotation(s);
    assert.equal(s.mode, 'idle');
    assert.equal(s.canvasDraft, draft);
});

test('undo/redo preserve latestCheck=null after edit', () => {
    let s = openLoaded(initialState(), makeOpenResult());
    const results: CheckResultByAnnotation[] = [
        { canvasAnnotationId: 'a1', status: 'unique', matchCount: 1, expected: 'unique', message: '', nodeIds: [] },
    ];
    s = checkCompleted(s, { results, stale: false });
    assert.equal(s.latestCheck, results);
    s = draftEdited(s, makeDraft('next'));
    assert.equal(s.latestCheck, null);
});
