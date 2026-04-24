import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSemanticSnapshotFromRaw } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';

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
                            backendDOMNodeId: '10',
                            attrs: { tag: 'main', backendDOMNodeId: '10' },
                            children: [
                                {
                                    id: 'n0.1.0.0',
                                    tag: 'a',
                                    text: 'GitHub',
                                    backendDOMNodeId: '20',
                                    attrs: { tag: 'a', href: 'https://github.com/CatOS-Home/CatOS', backendDOMNodeId: '20' },
                                    children: [
                                        {
                                            id: 'n0.1.0.0.0',
                                            tag: '::after',
                                            backendDOMNodeId: '21',
                                            attrs: { tag: '::after', backendDOMNodeId: '21' },
                                            children: [],
                                        },
                                        {
                                            id: 'n0.1.0.0.1',
                                            tag: 'svg',
                                            backendDOMNodeId: '22',
                                            attrs: { tag: 'svg', class: 'iconExternalLink_nPIU', backendDOMNodeId: '22' },
                                            children: [
                                                {
                                                    id: 'n0.1.0.0.1.0',
                                                    tag: 'path',
                                                    backendDOMNodeId: '23',
                                                    attrs: { tag: 'path', backendDOMNodeId: '23' },
                                                    children: [],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
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
                { role: 'main', backendDOMNodeId: '10' },
                { role: 'link', name: 'GitHub', backendDOMNodeId: '20' },
            ],
        },
    };

    const snapshot = generateSemanticSnapshotFromRaw(raw as any);

    let headCount = 0;
    let pseudoCount = 0;
    let svgCount = 0;
    let pathCount = 0;
    const linkNodes: any[] = [];
    walk(snapshot.root, (node) => {
        const role = (node.role || '').toLowerCase();
        const tag = (node.attrs?.tag || '').toLowerCase();
        if (role === 'head') {headCount += 1;}
        if (role === '::after' || tag === '::after') {pseudoCount += 1;}
        if (role === 'svg' || tag === 'svg') {svgCount += 1;}
        if (role === 'path' || tag === 'path') {pathCount += 1;}
        if (role === 'link') {linkNodes.push(node);}
    });

    assert.equal(headCount, 0, 'head subtree should be fully removed from final snapshot');
    assert.equal(pseudoCount, 0, 'pseudo nodes should be removed after body region compression');
    assert.equal(svgCount, 0, 'svg implementation nodes should be removed after body region compression');
    assert.equal(pathCount, 0, 'path implementation nodes should be removed after body region compression');
    assert.equal(linkNodes.length, 1, 'body region should still be processed and keep semantic link node');
    assert.equal(linkNodes[0].children.length, 0, 'link node should trim implementation descendants');
});
