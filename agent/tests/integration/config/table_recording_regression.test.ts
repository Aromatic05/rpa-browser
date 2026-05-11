import test from 'node:test';
import assert from 'node:assert/strict';
import {
    awaitRecordingEnhancements,
    appendWorkspaceRecordingEvent,
    createRecordingState,
    disableWorkspaceRecording,
    enableWorkspaceRecording,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
} from '../../src/record/recording';
import { resolveTarget } from '../../src/runner/steps/helpers/resolve_target';

const createBindingForRows = (rows: number) => {
    const root: any = { id: 'root', role: 'root', children: [] };
    const nodeIndex: Record<string, any> = { root };
    const locatorIndex: Record<string, any> = {};
    const attrIndex: Record<string, any> = {};
    for (let i = 1; i <= rows; i += 1) {
        const id = `row_${i}`;
        const node = { id, role: 'textbox', name: '', children: [] as any[] };
        root.children.push(node);
        nodeIndex[id] = node;
        locatorIndex[id] = {
            origin: { primaryDomId: `dom-${i}` },
            direct: { kind: 'css', query: `table tr:nth-of-type(${i}) input`, source: 'path' },
        };
        attrIndex[id] = { tag: 'input', class: 'ant-input' };
    }

    return {
        workspaceName: 'ws-test',
        tabName: 'tab-test',
        page: { url: () => 'https://example.test/table' },
        traceCtx: {
            cache: {
                latestSnapshot: {
                    snapshotMeta: {
                        mode: 'full',
                        snapshotId: 'snap-table-1',
                        pageIdentity: { workspaceName: 'ws-test', tabName: 'tab-test', url: 'https://example.test/table' },
                    },
                    root,
                    nodeIndex,
                    locatorIndex,
                    attrIndex,
                    entityIndex: { entities: {}, byNodeId: {} },
                    contentStore: {},
                },
            },
        },
        traceTools: {},
    } as any;
};

const resolveCtx = (binding: any) => ({
    deps: { runtime: { resolveBinding: async () => binding } } as any,
    workspaceName: 'ws-test',
    reason: 'table-regression',
    stepId: 's-table',
    stepName: 'browser.fill',
});

test('table recording regression keeps per-row selectors and replay selector consistency', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');

    for (let row = 1; row <= 8; row += 1) {
        const selector = `table tr:nth-of-type(${row}) input`;
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: row * 10,
            type: 'input',
            selector,
            value: `${row}`,
            targetHint: 'input',
            a11yHint: { role: 'textbox' },
            targetAttrs: { tag: 'input', class: 'ant-input', name: `price-${row}`, placeholder: '请输入价格' },
            targetState: { focused: true, disabled: false, readonly: false, ariaDisabled: 'false' },
            locatorCandidates: [
                { kind: 'css', selector },
                { kind: 'role', role: 'textbox', name: `price-${row}`, exact: true },
                { kind: 'placeholder', text: '请输入价格', exact: true },
                { kind: 'attr', selector: `[name=\"price-${row}\"]`, exact: true },
            ] as any,
        }, 1200);
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: row * 10 + 1,
            type: 'change',
            selector,
            value: `${row}-final`,
            targetHint: 'input',
            a11yHint: { role: 'textbox' },
            targetAttrs: { tag: 'input', class: 'ant-input', name: `price-${row}`, placeholder: '请输入价格' },
            targetState: { focused: true, disabled: false, readonly: false, ariaDisabled: 'false' },
            locatorCandidates: [
                { kind: 'css', selector },
                { kind: 'role', role: 'textbox', name: `price-${row}`, exact: true },
                { kind: 'placeholder', text: '请输入价格', exact: true },
                { kind: 'attr', selector: `[name=\"price-${row}\"]`, exact: true },
            ] as any,
        }, 1200);
    }

    disableWorkspaceRecording(state, 'ws-1');
    await awaitRecordingEnhancements(state, 'ws-1');
    const bundle = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
    const fills = bundle.steps.filter((step) => step.name === 'browser.fill');

    assert.equal(fills.length, 8);
    const selectors = fills.map((step) => (step.args as any).selector);
    assert.equal(new Set(selectors).size, 8);
    for (let row = 1; row <= 8; row += 1) {
        assert.equal(selectors.includes(`table tr:nth-of-type(${row}) input`), true);
    }

    const binding = createBindingForRows(8);
    for (const step of fills) {
        const selector = (step.args as any).selector as string;
        const enhancement = bundle.enrichments[step.id];
        assert.equal(Boolean(enhancement?.resolveHint?.capture), true);
        assert.equal(Boolean(enhancement?.resolvePolicy), true);
        assert.equal(enhancement?.resolveHint?.target?.nodeId, undefined);
        assert.equal(enhancement?.resolveHint?.target?.primaryDomId, undefined);
        assert.equal(enhancement?.resolveHint?.locator?.direct?.query, undefined);
        assert.equal(Boolean(enhancement?.resolveHint?.target?.attrs?.name), true);
        assert.equal(typeof enhancement?.resolveHint?.target?.state?.focused, 'boolean');
        const candidates = enhancement?.resolveHint?.raw?.locatorCandidates || [];
        assert.equal(candidates.some((item) => item.kind === 'css' && item.selector === selector), false);
        assert.equal(
            candidates.some((item) => item.kind === 'label')
            || candidates.some((item) => item.kind === 'placeholder')
            || candidates.some((item) => item.kind === 'role')
            || candidates.some((item) => item.kind === 'attr')
            || candidates.some((item) => item.kind === 'testid'),
            true,
        );
        const resolved = await resolveTarget(binding, {
            selector,
            resolve: enhancement?.resolveHint || enhancement?.resolvePolicy
                ? {
                    hint: enhancement?.resolveHint,
                    policy: enhancement?.resolvePolicy,
                }
                : undefined,
        }, resolveCtx(binding));
        assert.equal(resolved.ok, true);
        if (!resolved.ok) {continue;}
        assert.equal((resolved.target.resolution.audit.finalSelector || '').replace(/:visible$/, ''), selector);
    }
});
