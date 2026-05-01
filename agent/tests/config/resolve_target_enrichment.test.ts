import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../../src/runner/steps/helpers/resolve_target';
import { executeBrowserClick } from '../../src/runner/steps/executors/click';
import { executeBrowserFill } from '../../src/runner/steps/executors/fill';
import { executeBrowserSelectOption } from '../../src/runner/steps/executors/select_option';
import type { Step } from '../../src/runner/steps/types';
import { setNodeAttr } from '../../src/runner/steps/executors/snapshot/core/runtime_store';

const createBinding = (snapshot?: Record<string, unknown>) => {
    const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const binding = {
        workspaceName: 'ws-test',
        page: {},
        traceCtx: { cache: { latestSnapshot: snapshot } },
        traceTools: {
            'trace.locator.waitForVisible': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'waitForVisible', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.scrollIntoView': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'scrollIntoView', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.click': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'click', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.focus': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'focus', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.fill': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'fill', payload });
                return { ok: true, data: {} };
            },
            'trace.locator.selectOption': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'selectOption', payload });
                return { ok: true, data: { selected: ['v'] } };
            },
            'trace.locator.readSelectState': async (payload: Record<string, unknown>) => {
                calls.push({ name: 'readSelectState', payload });
                return { ok: true, data: { selectedValues: ['v'], selectedLabels: ['审批中'] } };
            },
        },
    } as any;

    const deps = {
        runtime: {
            ensureActivePage: async () => binding,
        },
        config: {
            waitPolicy: {
                visibleTimeoutMs: 800,
                interactionTimeoutMs: 1200,
            },
            humanPolicy: {
                enabled: false,
                clickDelayMsRange: { min: 0, max: 0 },
                typeDelayMsRange: { min: 0, max: 0 },
                scrollDelayMsRange: { min: 0, max: 0 },
            },
            confidencePolicy: {
                enabled: false,
                minScore: 0,
                roleWeight: 0,
                nameWeight: 0,
                textWeight: 0,
                selectorBonus: 0,
            },
        },
    } as any;

    return { binding, deps, calls };
};

const createSnapshotForId = () => {
    const root = { id: 'root', role: 'root', children: [] as any[] };
    const form = { id: 'form_1', role: 'form', children: [] as any[] };
    const node = { id: 'node_1', role: 'button', children: [] as any[] };
    const deleteNode = { id: 'node_delete', role: 'button', children: [] as any[] };
    root.children.push(form);
    form.children.push(node, deleteNode);
    setNodeAttr(form as any, 'tag', 'form');
    setNodeAttr(node as any, 'tag', 'button');
    setNodeAttr(node as any, 'id', 'submit-btn');
    setNodeAttr(node as any, 'backendDOMNodeId', '42');
    setNodeAttr(deleteNode as any, 'tag', 'button');
    setNodeAttr(deleteNode as any, 'id', 'delete-btn');
    setNodeAttr(deleteNode as any, 'backendDOMNodeId', '43');
    setNodeAttr(node as any, 'fieldKey', 'submit');
    setNodeAttr(node as any, 'actionIntent', 'submit');
    setNodeAttr(deleteNode as any, 'fieldKey', 'operation');
    setNodeAttr(deleteNode as any, 'actionIntent', 'delete');

    return {
        root,
        nodeIndex: {
            root,
            form_1: form,
            node_1: node,
            node_delete: deleteNode,
        },
        attrIndex: {
            form_1: {},
            node_1: { fieldKey: 'submit', actionIntent: 'submit' },
            node_delete: { fieldKey: 'operation', actionIntent: 'delete' },
        },
        entityIndex: {
            entities: {
                ent_form_1: {
                    id: 'ent_form_1',
                    type: 'region',
                    kind: 'form',
                    nodeId: 'form_1',
                    name: 'Main Form',
                },
            },
            byNodeId: {
                form_1: [{ type: 'region', entityId: 'ent_form_1', role: 'container' }],
                node_1: [{ type: 'region', entityId: 'ent_form_1', role: 'descendant' }],
                node_delete: [{ type: 'region', entityId: 'ent_form_1', role: 'descendant' }],
            },
        },
        locatorIndex: {
            node_1: {
                origin: { primaryDomId: '42' },
                direct: { kind: 'css', query: '#submit-btn', source: 'id' },
            },
            node_delete: {
                origin: { primaryDomId: '43' },
                direct: { kind: 'css', query: '#delete-btn', source: 'id' },
            },
            form_1: {
                origin: { primaryDomId: '40' },
                direct: { kind: 'css', query: '#form-main', source: 'id' },
            },
        },
        businessEntityOverlay: {
            byRuleId: {},
            byEntityId: {
                ent_form_1: {
                    businessTag: 'order.form.main',
                    businessName: 'Order Form',
                },
            },
            nodeHintsByNodeId: {
                node_1: {
                    entityNodeId: 'form_1',
                    entityKind: 'form',
                    fieldKey: 'submit',
                    actionIntent: 'submit',
                },
                node_delete: {
                    entityNodeId: 'form_1',
                    entityKind: 'form',
                    fieldKey: 'operation',
                    actionIntent: 'delete',
                },
            },
        },
    };
};

test('resolveTarget selector path keeps direct source', async () => {
    const { binding } = createBinding();
    const resolved = await resolveTarget(binding, { selector: '#legacy' });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, '#legacy');
    assert.equal(resolved.target.resolution.source, 'selector');
});

test('resolveTarget nodeId path resolves from snapshot locator index', async () => {
    const { binding } = createBinding(createSnapshotForId());
    const resolved = await resolveTarget(binding, { nodeId: 'node_1' });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, '#submit-btn');
    assert.equal(resolved.target.resolution.source, 'nodeId');
});

test('resolveTarget resolve path resolves from resolve.hint.raw.selector', async () => {
    const { binding } = createBinding();
    const resolved = await resolveTarget(binding, {
        resolve: { hint: { raw: { selector: '#from-hint' } } },
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, '#from-hint');
    assert.equal(resolved.target.resolution.source, 'resolve');
});

test('resolveTarget applies ResolvePolicy preferScoped + requireVisible', async () => {
    const { binding } = createBinding(createSnapshotForId());
    const resolved = await resolveTarget(binding, {
        resolve: {
            hint: {
                locator: {
                    direct: { kind: 'css', query: 'button.submit' },
                    scope: { id: 'form_1', kind: 'form' },
                },
            },
            policy: {
                preferScoped: true,
                requireVisible: true,
            },
        },
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, 'form:nth-of-type(1) button.submit:visible');
});

test('resolveTarget no longer supports A11yHint-only fallback path', async () => {
    const { binding } = createBinding();
    const resolved = await resolveTarget(binding, {
        resolve: {
            hint: {
                target: { role: 'button', name: 'Save', text: 'Save' },
            },
        },
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) {return;}
    assert.equal(resolved.error?.code, 'ERR_NOT_FOUND');
});

test('resolveTarget resolves from resolve.hint.entity.businessTag', async () => {
    const { binding } = createBinding(createSnapshotForId());
    const resolved = await resolveTarget(binding, {
        resolve: {
            hint: {
                entity: {
                    businessTag: 'order.form.main',
                },
            },
        },
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, '#form-main');
});

test('resolveTarget resolves from resolve.hint.entity.fieldKey', async () => {
    const { binding } = createBinding(createSnapshotForId());
    const resolved = await resolveTarget(binding, {
        resolve: {
            hint: {
                entity: {
                    fieldKey: 'submit',
                },
            },
        },
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, '#submit-btn');
});

test('resolveTarget resolves from resolve.hint.entity.actionIntent', async () => {
    const { binding } = createBinding(createSnapshotForId());
    const resolved = await resolveTarget(binding, {
        resolve: {
            hint: {
                entity: {
                    actionIntent: 'delete',
                },
            },
        },
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.selector, '#delete-btn');
});

test('click executor resolves from step.resolve.hint', async () => {
    const { deps, calls } = createBinding();
    const step: Step<'browser.click'> = {
        id: 'click-hint',
        name: 'browser.click',
        args: {},
        meta: { source: 'play', ts: Date.now() },
        resolve: { hint: { raw: { selector: '#click-from-resolve' } } },
    };

    const result = await executeBrowserClick(step, deps, 'ws-test');
    assert.equal(result.ok, true);

    const clickCall = calls.find((call) => call.name === 'click');
    assert.ok(clickCall);
    assert.equal(clickCall?.payload.selector, '#click-from-resolve');
});

test('fill executor resolves from step.resolve.hint', async () => {
    const { deps, calls } = createBinding();
    const step: Step<'browser.fill'> = {
        id: 'fill-hint',
        name: 'browser.fill',
        args: { value: 'hello' },
        meta: { source: 'play', ts: Date.now() },
        resolve: { hint: { raw: { selector: '#fill-from-resolve' } } },
    };

    const result = await executeBrowserFill(step, deps, 'ws-test');
    assert.equal(result.ok, true);

    const fillCall = calls.find((call) => call.name === 'fill');
    assert.ok(fillCall);
    assert.equal(fillCall?.payload.selector, '#fill-from-resolve');
});

test('select_option executor resolves from step.resolve.hint', async () => {
    const { deps, calls } = createBinding();
    const step: Step<'browser.select_option'> = {
        id: 'select-hint',
        name: 'browser.select_option',
        args: { values: ['审批中'] },
        meta: { source: 'play', ts: Date.now() },
        resolve: { hint: { raw: { selector: '#select-from-resolve' } } },
    };

    const result = await executeBrowserSelectOption(step, deps, 'ws-test');
    assert.equal(result.ok, true);

    const selectCall = calls.find((call) => call.name === 'selectOption');
    assert.ok(selectCall);
    assert.equal(selectCall?.payload.selector, '#select-from-resolve');
});
