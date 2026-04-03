import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSemanticSnapshotFromRaw } from '../executors/snapshot/snapshot';

const walk = (node: any, visitor: (node: any) => void) => {
    visitor(node);
    for (const child of node.children || []) {
        walk(child, visitor);
    }
};

test('pipeline should remove region when processRegion returns null (head subtree)', () => {
    const raw = {
        domTree: {
            id: 'n0',
            tag: 'html',
            children: [
                {
                    id: 'n0.0',
                    tag: 'head',
                    backendDOMNodeId: '8',
                    attrs: { tag: 'head', backendDOMNodeId: '8' },
                    children: [
                        {
                            id: 'n0.0.0',
                            tag: 'link',
                            backendDOMNodeId: '12',
                            attrs: { tag: 'link', href: '/css/app.css', backendDOMNodeId: '12' },
                            children: [],
                        },
                    ],
                },
                {
                    id: 'n0.1',
                    tag: 'body',
                    backendDOMNodeId: '9',
                    attrs: { tag: 'body', backendDOMNodeId: '9' },
                    children: [
                        {
                            id: 'n0.1.0',
                            tag: 'main',
                            text: '正文',
                            backendDOMNodeId: '10',
                            attrs: { tag: 'main', backendDOMNodeId: '10' },
                            children: [],
                        },
                    ],
                },
            ],
        },
        a11yTree: {
            role: 'RootWebArea',
            children: [
                { role: 'head', backendDOMNodeId: '8' },
                { role: 'body', backendDOMNodeId: '9' },
                { role: 'main', name: '正文', backendDOMNodeId: '10' },
            ],
        },
    };

    const snapshot = generateSemanticSnapshotFromRaw(raw as any);

    let headCount = 0;
    walk(snapshot.root, (node) => {
        if ((node.role || '').toLowerCase() === 'head') headCount += 1;
    });

    assert.equal(headCount, 0, 'head subtree should be fully removed from final snapshot');
});
