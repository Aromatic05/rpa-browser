import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRawData, waitForSnapshotReady } from '../../../src/runner/steps/executors/snapshot/stages/collect';

test('waitForSnapshotReady uses lightweight settle for interaction mode', async () => {
    const states: Array<'domcontentloaded' | 'networkidle'> = [];
    let evaluateCount = 0;
    const page = {
        waitForLoadState: async (state: 'domcontentloaded' | 'networkidle') => {
            states.push(state);
        },
        evaluate: async () => {
            evaluateCount += 1;
        },
    };

    await waitForSnapshotReady(page as any, 'interaction');

    assert.deepEqual(states, []);
    assert.equal(evaluateCount, 1);
});

test('waitForSnapshotReady keeps full load-state wait for navigation mode', async () => {
    const states: Array<'domcontentloaded' | 'networkidle'> = [];
    let evaluateCount = 0;
    const page = {
        waitForLoadState: async (state: 'domcontentloaded' | 'networkidle') => {
            states.push(state);
        },
        evaluate: async () => {
            evaluateCount += 1;
        },
    };

    await waitForSnapshotReady(page as any, 'navigation');

    assert.deepEqual(states, ['domcontentloaded', 'networkidle']);
    assert.equal(evaluateCount, 2);
});

test('collectRawData orders collector before DOMSnapshot and A11y, with deferred cleanup', async () => {
    const events: string[] = [];
    const fakeCdp = {
        send: async (method: string) => {
            if (method === 'DOMSnapshot.captureSnapshot') {
                events.push('dom');
                return {
                    documents: [
                        {
                            nodes: {
                                parentIndex: [-1, 0, 1, 2],
                                nodeType: [9, 1, 1, 1],
                                nodeName: [0, 1, 2, 3],
                                nodeValue: [0, 0, 0, 0],
                                backendNodeId: [0, 11, 12, 13],
                                attributes: [[], [], [], [4, 5]],
                            },
                            layout: {
                                nodeIndex: [1, 2, 3],
                                bounds: [
                                    [0, 0, 1280, 800],
                                    [0, 0, 1280, 800],
                                    [24, 40, 120, 30],
                                ],
                            },
                        },
                    ],
                    strings: ['#document', 'HTML', 'BODY', 'INPUT', 'data-rpa-state-id', 'sid-1'],
                };
            }
            if (method === 'Accessibility.enable') {
                return {};
            }
            if (method === 'Accessibility.getFullAXTree') {
                events.push('a11y');
                return {
                    nodes: [{ nodeId: 'ax0', role: { value: 'WebArea' }, backendDOMNodeId: 11 }],
                };
            }
            return {};
        },
        detach: async () => {},
    };

    const page = {
        waitForLoadState: async () => {},
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
        evaluate: async (fn: unknown, arg?: unknown) => {
            const marker = typeof fn === 'function' ? String(fn) : '';
            if (marker.includes('[contenteditable]')) {
                events.push('collector');
                return [{ stateId: 'sid-1', tag: 'input', value: 'alice' }];
            }
            if (typeof arg === 'string' && arg.includes('data-rpa-state-id')) {
                events.push('cleanup');
                return true;
            }
            events.push('settle');
            return undefined;
        },
    };

    const raw = await collectRawData(page as any, {
        captureRuntimeState: true,
        waitMode: 'interaction',
    });

    assert.equal(raw.runtimeStateMap?.['sid-1']?.value, 'alice');
    assert.ok((events.indexOf('collector') >= 0 ? events.indexOf('collector') : Number.MAX_SAFE_INTEGER) < events.indexOf('dom'));
    assert.ok(events.indexOf('dom') < events.indexOf('a11y'));
    assert.equal(events.includes('cleanup'), false);

    await raw.runtimeStateCleanup?.();
    assert.equal(events.includes('cleanup'), true);
});

test('collectRawData tolerates runtime collector failure and keeps snapshot flow', async () => {
    const events: string[] = [];
    const fakeCdp = {
        send: async (method: string) => {
            if (method === 'DOMSnapshot.captureSnapshot') {
                events.push('dom');
                return {
                    documents: [
                        {
                            nodes: {
                                parentIndex: [-1, 0, 1],
                                nodeType: [9, 1, 1],
                                nodeName: [0, 1, 2],
                                nodeValue: [0, 0, 0],
                                backendNodeId: [0, 11, 12],
                                attributes: [[], [], []],
                            },
                            layout: {
                                nodeIndex: [1, 2],
                                bounds: [
                                    [0, 0, 1280, 800],
                                    [0, 0, 1280, 800],
                                ],
                            },
                        },
                    ],
                    strings: ['#document', 'HTML', 'BODY'],
                };
            }
            if (method === 'Accessibility.enable') {
                return {};
            }
            if (method === 'Accessibility.getFullAXTree') {
                events.push('a11y');
                return {
                    nodes: [{ nodeId: 'ax0', role: { value: 'WebArea' }, backendDOMNodeId: 11 }],
                };
            }
            return {};
        },
        detach: async () => {},
    };

    const page = {
        waitForLoadState: async () => {},
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
        evaluate: async (fn: unknown, arg?: unknown) => {
            const marker = typeof fn === 'function' ? String(fn) : '';
            if (marker.includes('[contenteditable]')) {
                events.push('collector-fail');
                throw new Error('collector failed');
            }
            if (typeof arg === 'string' && arg.includes('data-rpa-state-id')) {
                events.push('cleanup');
                return true;
            }
            return undefined;
        },
    };

    const raw = await collectRawData(page as any, {
        captureRuntimeState: true,
        waitMode: 'interaction',
    });

    assert.deepEqual(raw.runtimeStateMap, {});
    assert.ok(raw.domTree);
    assert.ok(raw.a11yTree);
    assert.equal(events.includes('collector-fail'), true);
    assert.equal(events.includes('dom'), true);
    assert.equal(events.includes('a11y'), true);

    await raw.runtimeStateCleanup?.();
    assert.equal(events.includes('cleanup'), true);
});
