import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
        }, 1200);
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: row * 10 + 1,
            type: 'change',
            selector,
            value: `${row}-final`,
        }, 1200);
    }

    disableWorkspaceRecording(state, 'ws-1');
    const bundle = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
    const fills = bundle.steps.filter((step) => step.name === 'browser.fill');

    assert.equal(fills.length, 8);
    const selectors = fills.map((step) => (step.args as any).selector);
    assert.equal(new Set(selectors).size, 8);
    for (let row = 1; row <= 8; row += 1) {
        assert.equal(selectors.includes(`table tr:nth-of-type(${row}) input`), true);
    }

    const targetNodeIds = fills
        .map((step) => bundle.enrichments[step.id]?.target?.nodeId)
        .filter((item): item is string => Boolean(item));
    assert.equal(new Set(targetNodeIds).size, targetNodeIds.length);

    const binding = createBindingForRows(8);
    for (const step of fills) {
        const selector = (step.args as any).selector as string;
        const enhancement = bundle.enrichments[step.id];
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
        assert.equal(resolved.target.resolution.audit.finalSelector, selector);
    }
});
