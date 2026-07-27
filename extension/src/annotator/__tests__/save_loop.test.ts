import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runCheckLoop,
    runSaveLoop,
    runRecognizeLoop,
    restoreSessionDraft,
    persistSessionDraft,
    shouldEnterReselect,
    decideSelectAction,
    buildSessionKey,
} from '../state/annotator_loop.js';
import {
    initialState,
    openLoaded,
    draftEdited,
    type AnnotatorState,
} from '../state/annotator_state.js';
import type {AnnotatorClient} from '../protocol/annotator_client.js';
import type {
    AnnotatorOpenResult,
    CanvasDraft,
    CheckResultByAnnotation,
    PageIdentity,
} from '../types.js';
import {
    createSessionStore,
    type SessionStorageLike,
    type SessionStore,
} from '../state/session_store.js';

const makeDraft = (name: string): CanvasDraft => ({
    version: 1,
    profileName: name,
    page: { kind: 'table' },
    entities: [],
    preserved: {},
});

const makeRecognizedDraft = (name: string): CanvasDraft => ({
    ...makeDraft(name),
    entities: [
        {
            id: 'e0',
            source: 'region',
            kind: 'form',
            name: '客户信息',
            businessTag: 'form.customer',
            target: {kind: 'form', nameContains: '客户信息'},
            annotations: [],
            columns: [],
            origin: 'inferred',
        },
    ],
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

const page: PageIdentity = { workspaceName: 'ws-1', tabName: 'tab-1', url: 'http://test/page' };

const openState = (): AnnotatorState => openLoaded(initialState(), makeOpenResult());

const mockClient = (overrides: Partial<AnnotatorClient> = {}): AnnotatorClient => ({
    open: async () => makeOpenResult(),
    pick: async () => ({ candidateChain: [], matchedNodeIds: [], resolution: { nodeId: null, reason: 'none', matchedNodeIds: [] } }),
    recognize: async () => ({ canvasDraft: makeDraft('refreshed'), recognized: [], visualTargetRefs: [] }),
    visualize: async () => ({visualTargetRefs: []}),
    check: async () => ({ results: [], stale: false }),
    save: async () => ({ profileName: 'profile-a', artifactRevision: 'rev-002', saved: true }),
    ...overrides,
});

const createMemoryStorage = (): SessionStorageLike & { _store: Map<string, unknown> } => {
    const store = new Map<string, unknown>();
    return {
        _store: store,
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => {
            store.set(key, JSON.parse(JSON.stringify(value)));
        },
        remove: async (key) => {
            store.delete(key);
        },
    };
};

test('runCheckLoop applies checkCompleted on a successful check reply', async () => {
    const s = openState();
    const results: CheckResultByAnnotation[] = [
        { canvasAnnotationId: 'a1', status: 'unique', matchCount: 1, expected: 'unique', message: 'ok', nodeIds: ['n1'] },
    ];
    const client = mockClient({ check: async () => ({ results, stale: true }) });
    const next = await runCheckLoop(s, client);
    assert.deepEqual(next.latestCheck, results);
    assert.equal(next.stale, true);
    assert.equal(next.mode, 'editing');
    assert.equal(next.error, null);
});

test('runCheckLoop transitions to failed state when check throws', async () => {
    const s = openState();
    const client = mockClient({ check: async () => { throw new Error('boom'); } });
    const next = await runCheckLoop(s, client);
    assert.equal(next.latestCheck, null);
    assert.match(next.error || '', /检查失败：boom/);
});

test('runCheckLoop with no client transitions to failed state', async () => {
    const s = openState();
    const next = await runCheckLoop(s, null);
    assert.match(next.error || '', /client unavailable/);
});



test('runRecognizeLoop explains transport timeout in user-facing language', async () => {
    const s = draftEdited(openState(), makeRecognizedDraft('profile-a'));
    const client = mockClient({
        recognize: async () => {
            const error = new Error('request timeout') as Error & {code: string};
            error.code = 'TIMEOUT';
            throw error;
        },
    });
    const next = await runRecognizeLoop(s, client);
    assert.equal(next.error, '识别失败：本地 RPA 服务没有响应。请确认运行窗口仍然开启，然后重试。');
});
test('runSaveLoop clears session draft on save success', async () => {
    const storage = createMemoryStorage();
    const store: SessionStore = createSessionStore(storage);
    let s = openState();
    s = draftEdited(s, makeDraft('edited'));
    const key = buildSessionKey(s)!;
    await store.saveDraft(key, s.canvasDraft!, page);
    assert.ok((await store.loadDraft(key, page)) !== null, 'precondition: draft stored');

    const client = mockClient({ save: async () => ({ profileName: 'profile-a', artifactRevision: 'rev-002', saved: true }) });
    const next = await runSaveLoop(s, client, store);
    assert.equal(next.dirty, false);
    assert.equal(next.artifactRevision, 'rev-002');
    assert.equal(next.error, null);
    assert.equal(await store.loadDraft(key, page), null, 'session draft cleared after save');
});

test('runSaveLoop keeps a successful save successful when session cleanup fails', async () => {
    let s = openState();
    s = draftEdited(s, makeDraft('edited'));
    const store: SessionStore = {
        saveDraft: async () => undefined,
        loadDraft: async () => null,
        clearDraft: async () => { throw new Error('storage unavailable'); },
    };
    const next = await runSaveLoop(s, mockClient(), store);
    assert.equal(next.dirty, false);
    assert.equal(next.artifactRevision, 'rev-002');
    assert.equal(next.error, null);
});

test('runSaveLoop records failure message and keeps draft dirty when save rejects', async () => {
    const s = openState();
    const edited = draftEdited(s, makeDraft('edited'));
    const client = mockClient({ save: async () => { throw new Error('save blocked (revision_conflict)'); } });
    const next = await runSaveLoop(edited, client);
    assert.equal(next.dirty, true);
    assert.match(next.error || '', /save blocked \(revision_conflict\)/);
});

test('runRecognizeLoop applies protective-merged draft via draftEdited so it is undoable', async () => {
    const s = draftEdited(openState(), makeRecognizedDraft('profile-a'));
    const before = s.canvasDraft!;
    const merged = makeRecognizedDraft('refreshed');
    const visualTargetRefs = [{
        entityId: 'e0',
        nodeId: 'customer-form',
        role: 'entity' as const,
        canvasAnnotationId: 'entity:e0',
        bbox: {x: 10, y: 20, width: 300, height: 180},
    }];
    const client = mockClient({
        recognize: async () => ({canvasDraft: merged, recognized: [], visualTargetRefs}),
    });
    const next = await runRecognizeLoop(s, client);
    assert.equal(next.canvasDraft?.profileName, 'profile-a');
    assert.equal(next.canvasDraft?.page.urlPattern, '^http://test/page(?:[/?#]|$)');
    assert.equal(next.dirty, true);
    assert.equal(next.history.past.at(-1), before, 'previous draft retained for undo');
    assert.equal(next.latestCheck, null);
    assert.deepEqual(
        next.visualBindings,
        visualTargetRefs,
        'unsaved recognition geometry is immediately available to the canvas',
    );
});

test('runRecognizeLoop refuses to recognize before an entity scope is confirmed', async () => {
    const empty = openLoaded(initialState(), makeOpenResult({canvasDraft: null, profileName: null}));
    let calls = 0;
    const client = mockClient({recognize: async () => {
        calls += 1;
        return {canvasDraft: makeRecognizedDraft(''), recognized: [], visualTargetRefs: []};
    }});
    const next = await runRecognizeLoop(empty, client);
    assert.equal(calls, 0);
    assert.equal(next.canvasDraft, null);
    assert.equal(next.error, '识别失败：请先选择并确认实体区域。');
});

test('restoreSessionDraft restores an unsaved draft when page identity matches', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const s = openState();
    const key = buildSessionKey(s)!;
    const unsaved = makeDraft('unsaved-session');
    await store.saveDraft(key, unsaved, page);
    const next = await restoreSessionDraft(s, store);
    assert.deepEqual(next.canvasDraft, unsaved);
    assert.equal(next.dirty, true);
});

test('restoreSessionDraft returns state unchanged when no stored draft', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const s = openState();
    const next = await restoreSessionDraft(s, store);
    assert.equal(next, s);
});

test('persistSessionDraft writes the current draft under the session key', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const s = draftEdited(openState(), makeDraft('edited'));
    await persistSessionDraft(s, store);
    const key = buildSessionKey(s)!;
    const loaded = await store.loadDraft(key, page);
    assert.deepEqual(loaded, s.canvasDraft);
});

test('persistSessionDraft is best-effort: storage failures do not throw', async () => {
    const failing: SessionStorageLike = {
        get: async () => null,
        set: async () => { throw new Error('quota'); },
        remove: async () => { throw new Error('quota'); },
    };
    const store = createSessionStore(failing);
    const s = draftEdited(openState(), makeDraft('edited'));
    await persistSessionDraft(s, store);
});

test('shouldEnterReselect is true only for annotations whose check status is not unique', () => {
    const results: CheckResultByAnnotation[] = [
        { canvasAnnotationId: 'a1', status: 'unique', matchCount: 1, expected: 'unique', message: '', nodeIds: [] },
        { canvasAnnotationId: 'a2', status: 'missing', matchCount: 0, expected: 'unique', message: '', nodeIds: [] },
        { canvasAnnotationId: 'a3', status: 'multiple', matchCount: 3, expected: 'unique', message: '', nodeIds: [] },
    ];
    assert.equal(shouldEnterReselect('a1', results), false);
    assert.equal(shouldEnterReselect('a2', results), true);
    assert.equal(shouldEnterReselect('a3', results), true);
    assert.equal(shouldEnterReselect('a4', results), false);
    assert.equal(shouldEnterReselect('a1', null), false);
});

test('decideSelectAction never enters reselect for entity boxes even when status is non-unique', () => {
    const results: CheckResultByAnnotation[] = [
        { canvasAnnotationId: 'entity:e0', status: 'missing', matchCount: 0, expected: 'unique', message: '', nodeIds: [] },
        { canvasAnnotationId: 'a2', status: 'missing', matchCount: 0, expected: 'unique', message: '', nodeIds: [] },
    ];
    assert.deepEqual(decideSelectAction('entity:e0', results), { reselect: false });
    assert.deepEqual(decideSelectAction('a2', results), { reselect: true });
});

test('buildSessionKey returns null when pageIdentity is absent', () => {
    const s = initialState();
    assert.equal(buildSessionKey(s), null);
});
