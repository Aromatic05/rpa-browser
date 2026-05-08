import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../../src/runner/steps/helpers/resolve_target';

const createBinding = () => ({
    workspaceName: 'ws-test',
    tabName: 'tab-test',
    page: { url: () => 'https://example.test/current' },
    traceCtx: {
        cache: {
            latestSnapshot: {
                snapshotMeta: {
                    mode: 'full',
                    snapshotId: 'snap-1',
                    pageIdentity: { workspaceName: 'ws-test', tabName: 'tab-test', url: 'https://example.test/current' },
                },
                root: { id: 'root', role: 'root', children: [] },
                nodeIndex: { root: { id: 'root', role: 'root', children: [] }, row_1: { id: 'row_1', role: 'textbox', children: [] } },
                locatorIndex: {
                    row_1: {
                        origin: { primaryDomId: 'dom-1' },
                        direct: { kind: 'css', query: 'table tr:nth-of-type(1) input', source: 'path' },
                    },
                },
                attrIndex: { row_1: { tag: 'input' } },
                entityIndex: { entities: {}, byNodeId: {} },
                contentStore: {},
            },
        },
    },
    traceTools: {},
}) as any;

const resolveCtx = (binding: any) => ({
    deps: { runtime: { resolveBinding: async () => binding } } as any,
    workspaceName: 'ws-test',
    reason: 'test',
    stepId: 's-test',
    stepName: 'browser.fill',
});

test('input.selector is preferred over low confidence record_enrichment resolve target', async () => {
    const binding = createBinding();
    const resolved = await resolveTarget(binding, {
        selector: 'table tr:nth-of-type(5) input',
        resolve: {
            hint: {
                target: { nodeId: 'row_1' },
                capture: {
                    source: 'record_enrichment',
                    confidence: 0.5,
                    reason: ['raw_selector_only'],
                    warnings: ['LOW_CONFIDENCE_RAW_ONLY'],
                },
            },
        },
    }, resolveCtx(binding));

    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.target.candidates[0]?.path, 'input.selector');
    assert.equal(resolved.target.resolution.audit.chosenPath, 'input.selector');
    const nodePathIndex = resolved.target.candidates.findIndex((item) => item.path === 'resolve.hint.target.nodeId');
    assert.equal(nodePathIndex > 0, true);
});
