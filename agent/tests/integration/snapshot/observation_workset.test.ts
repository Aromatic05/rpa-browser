import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzePageObservation,
    buildPageObservation,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../src/automation/snapshot';

test('part candidates do not each create a quotient and pass visits reflect actual work', () => {
    const capture = largeNativeTableCapture(50, 10);
    const analysis = analyzePageObservation(buildPageObservation(capture));
    const canonicalNodeCount = Object.keys(analysis.observation.nodes).length;

    assert.equal(analysis.report.candidates.part, 551);
    assert.equal(analysis.report.quotient.viewCount, 1);
    assert.equal(analysis.quotients[0]?.candidateAnchorNodeId, analysis.observation.captureIdToNodeId.table);
    assert.ok(analysis.report.passes.quotient.nodeVisits > canonicalNodeCount);
    assert.ok(analysis.report.passes.invariant.nodeVisits >= analysis.quotients[0].nodes.length);
});

test('candidate evidence reports the source that actually supplied a semantic role or host class', () => {
    const capture = largeNativeTableCapture(1, 1);
    const form: RawCapturedNode = {
        captureId: 'form-host',
        scopeId: 'main',
        parentCaptureId: 'body',
        childCaptureIds: [],
        tag: 'div',
        attributes: { role: 'form', class: 'ant-form' },
        activity: active(),
    };
    capture.nodes.push(form);
    capture.nodes.find((node) => node.captureId === 'body')?.childCaptureIds.push(form.captureId);

    const analysis = analyzePageObservation(buildPageObservation(capture));
    const formId = analysis.observation.captureIdToNodeId[form.captureId];
    const candidate = analysis.candidates.find((item) => item.anchorNodeId === formId);
    assert.ok(candidate);
    assert.equal(candidate.classification, 'host');
    assert.equal(candidate.kind, 'form');
    assert.equal(candidate.evidence.some((item) => item.code === 'candidate.structural.role.form' && item.source === 'dom'), true);
    assert.equal(candidate.evidence.some((item) => item.code === 'candidate.host.class.form' && item.source === 'dom'), true);
    assert.equal(candidate.evidence.some((item) => item.source === 'a11y'), false);
});

const largeNativeTableCapture = (rowCount: number, columnCount: number): RawPageCapture => {
    const nodes: RawCapturedNode[] = [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table']),
        node('table', 'table', 'body', ['tbody']),
        node('tbody', 'tbody', 'table', []),
    ];
    const tbody = nodes[3];
    for (let row = 0; row < rowCount; row += 1) {
        const rowId = `row-${row}`;
        tbody.childCaptureIds.push(rowId);
        const cellIds = Array.from({ length: columnCount }, (_, column) => `cell-${row}-${column}`);
        nodes.push(node(rowId, 'tr', 'tbody', cellIds));
        for (let column = 0; column < columnCount; column += 1) {
            nodes.push({
                ...node(cellIds[column], 'td', rowId, []),
                ownText: `${row}:${column}`,
            });
        }
    }
    return {
        identity: { pageEpoch: 'large-table', captureRevision: 1 },
        metadata: {
            schemaVersion: 1,
            source: 'fixed-fixture',
            capturedAt: '2026-07-28T00:00:00.000Z',
            framework: 'native',
            frameworkVersion: 'html',
        },
        completeness: { dom: 'complete', a11y: 'unavailable', runtime: 'unavailable', geometry: 'complete' },
        scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured' }],
        nodes,
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
};

const node = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes: {},
    geometry: { x: 0, y: 0, width: 10, height: 10 },
    activity: active(),
});

const active = () => ({
    hiddenByStyle: false,
    inert: false,
    selfHasBox: true,
    rendered: true,
});
