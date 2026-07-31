import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAnnotatorSessionController,
    type AnnotatorSessionHandle,
} from '../annotator_session_controller.js';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {resolve = next;});
    return {promise, resolve};
};

const createHandle = () => {
    const calls: string[] = [];
    const handle: AnnotatorSessionHandle = {
        show: () => {calls.push('show');},
        hide: () => {calls.push('hide');},
        open: () => {calls.push('open');},
        exit: () => {calls.push('exit');},
        setInteractionMode: (mode) => {calls.push(`mode:${mode}`);},
    };
    return {handle, calls};
};

test('editor, rule inspection and checkpoint preview use distinct interaction policies', async () => {
    const {handle, calls} = createHandle();
    const opened: Record<string, unknown>[] = [];
    const editorActive: boolean[] = [];
    const controller = createAnnotatorSessionController({
        ensureHandle: async () => handle,
        open: async (payload) => {
            opened.push(payload);
            return {type: 'entity_rules.annotator.open.result', payload: {canvasDraft: null}};
        },
        pageUrl: () => 'https://example.test/orders',
        onEditorActiveChange: (active) => {editorActive.push(active);},
    });

    await controller.openEditor('orders');
    assert.deepEqual(calls.slice(0, 4), ['exit', 'mode:edit', 'show', 'open']);
    assert.deepEqual(editorActive, [true]);
    assert.equal(opened[0].profileName, 'orders');

    await controller.previewRule({profileName: 'orders', businessTag: 'orders.table', entityKind: 'table'});
    assert.deepEqual(calls.slice(4, 8), ['exit', 'mode:inspect', 'show', 'open']);
    assert.deepEqual(editorActive, [true, false]);
    assert.equal(opened[1].businessTag, 'orders.table');

    await controller.previewCheckpoint({profileName: 'orders', businessTag: 'orders.query', entityKind: 'form'});
    assert.deepEqual(calls.slice(8, 12), ['exit', 'mode:passthrough', 'show', 'open']);
    assert.equal(opened[2].businessTag, 'orders.query');
});

test('closing a preview invalidates a delayed open reply', async () => {
    const {handle, calls} = createHandle();
    const pending = deferred<{type: string; payload: unknown}>();
    const controller = createAnnotatorSessionController({
        ensureHandle: async () => handle,
        open: async () => await pending.promise,
        pageUrl: () => 'https://example.test/orders',
    });

    const opening = controller.previewRule({
        profileName: 'orders',
        businessTag: 'orders.table',
        entityKind: 'table',
    });
    await Promise.resolve();
    controller.close('rule-preview');
    pending.resolve({type: 'entity_rules.annotator.open.result', payload: {canvasDraft: {}}});
    await opening;

    assert.equal(calls.filter((call) => call === 'open').length, 0);
    assert.deepEqual(calls.slice(-3), ['mode:edit', 'exit', 'hide']);
    assert.equal(controller.owner(), null);
});

test('owner-scoped cleanup cannot close another active annotator session', async () => {
    const {handle, calls} = createHandle();
    const controller = createAnnotatorSessionController({
        ensureHandle: async () => handle,
        open: async () => ({type: 'entity_rules.annotator.open.result', payload: {canvasDraft: null}}),
        pageUrl: () => 'https://example.test/orders',
    });

    await controller.previewCheckpoint({
        profileName: 'errors',
        businessTag: 'session.expired',
        entityKind: 'panel',
    });
    const before = calls.length;
    controller.close('rule-preview');
    assert.equal(calls.length, before);
    assert.equal(controller.owner(), 'checkpoint-preview');
});

test('failed preview opens return false and leave no active owner', async () => {
    const {handle, calls} = createHandle();
    const errors: unknown[] = [];
    const controller = createAnnotatorSessionController({
        ensureHandle: async () => handle,
        open: async () => ({
            type: 'entity_rules.annotator.open.failed',
            payload: {message: 'profile does not apply'},
        }),
        pageUrl: () => 'https://example.test/orders',
        onError: (_owner, error) => {errors.push(error);},
    });

    const opened = await controller.previewRule({
        profileName: 'orders',
        businessTag: 'orders.table',
        entityKind: 'table',
    });

    assert.equal(opened, false);
    assert.equal(controller.owner(), null);
    assert.equal(calls.includes('open'), false);
    assert.equal(calls.at(-1), 'hide');
    assert.equal(errors.length, 1);
});
