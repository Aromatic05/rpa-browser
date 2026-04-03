import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseDomAndA11y } from '../executors/snapshot/fusion';

type DomNode = {
    id: string;
    tag: string;
    text?: string;
    attrs?: Record<string, string>;
    children: DomNode[];
};

type A11yNode = {
    role?: string;
    name?: string;
    children?: A11yNode[];
};

const countNodes = (node: { children?: unknown[] } | null | undefined): number => {
    if (!node) return 0;
    const children: unknown[] = Array.isArray(node.children) ? node.children : [];
    return 1 + children.reduce<number>((sum, child) => sum + countNodes(child as any), 0);
};

const findNode = (node: any, id: string): any => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
        const matched = findNode(child, id);
        if (matched) return matched;
    }
    return null;
};

test('fuseDomAndA11y should keep dom node count', () => {
    const domTree: DomNode = {
        id: 'n0',
        tag: 'html',
        children: [
            {
                id: 'n0.0',
                tag: 'head',
                children: [
                    { id: 'n0.0.0', tag: 'title', text: 'Site', children: [] },
                    { id: 'n0.0.1', tag: 'meta', children: [] },
                ],
            },
            {
                id: 'n0.1',
                tag: 'body',
                children: [
                    {
                        id: 'n0.1.0',
                        tag: 'nav',
                        children: [
                            { id: 'n0.1.0.0', tag: 'a', text: 'Docs', children: [] },
                            { id: 'n0.1.0.1', tag: 'a', text: 'Blog', children: [] },
                        ],
                    },
                    {
                        id: 'n0.1.1',
                        tag: 'main',
                        children: [
                            { id: 'n0.1.1.0', tag: 'button', text: 'Start', children: [] },
                            { id: 'n0.1.1.1', tag: 'section', children: [] },
                        ],
                    },
                ],
            },
        ],
    };

    const a11yTree: A11yNode = {
        role: 'RootWebArea',
        children: [
            { role: 'none' },
            { role: 'generic' },
            {
                role: 'navigation',
                children: [
                    { role: 'link', name: 'Docs' },
                    { role: 'StaticText', name: 'Docs' },
                    { role: 'InlineTextBox', name: 'Docs' },
                    { role: 'link', name: 'Blog' },
                ],
            },
            {
                role: 'main',
                children: [
                    { role: 'button', name: 'Start' },
                    { role: 'region', name: 'Feature' },
                ],
            },
        ],
    };

    const graph = fuseDomAndA11y(domTree, a11yTree);

    assert.equal(countNodes(graph.root), countNodes(domTree));
});

test('fuseDomAndA11y should keep structural containers and avoid weak a11y role pollution', () => {
    const domTree: DomNode = {
        id: 'n0',
        tag: 'html',
        children: [
            {
                id: 'n0.0',
                tag: 'head',
                children: [{ id: 'n0.0.0', tag: 'title', text: 'X', children: [] }],
            },
            {
                id: 'n0.1',
                tag: 'body',
                children: [
                    {
                        id: 'n0.1.0',
                        tag: 'nav',
                        children: [{ id: 'n0.1.0.0', tag: 'a', text: 'Doc', children: [] }],
                    },
                ],
            },
        ],
    };

    const a11yTree: A11yNode = {
        role: 'RootWebArea',
        children: [
            { role: 'none' },
            { role: 'StaticText', name: 'noise' },
            { role: 'InlineTextBox', name: 'noise' },
            { role: 'navigation' },
            { role: 'link', name: 'Doc' },
        ],
    };

    const graph = fuseDomAndA11y(domTree, a11yTree);

    assert.equal(findNode(graph.root, 'n0')?.role, 'html');
    assert.equal(findNode(graph.root, 'n0.0')?.role, 'head');
    assert.equal(findNode(graph.root, 'n0.1')?.role, 'body');
    assert.equal(findNode(graph.root, 'n0.1.0')?.role, 'navigation');
    assert.equal(findNode(graph.root, 'n0.1.0.0')?.role, 'link');
    assert.equal(findNode(graph.root, 'n0.1.0.0')?.name, 'Doc');
});

test('fuseDomAndA11y should use a11y role to annotate div content nodes without changing structure', () => {
    const domTree: DomNode = {
        id: 'n0',
        tag: 'html',
        children: [
            {
                id: 'n0.0',
                tag: 'body',
                children: [
                    {
                        id: 'n0.0.0',
                        tag: 'div',
                        children: [
                            {
                                id: 'n0.0.0.0',
                                tag: 'div',
                                children: [{ id: 'n0.0.0.0.0', tag: 'a', text: 'Donate', children: [] }],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    const a11yTree: A11yNode = {
        role: 'RootWebArea',
        children: [
            { role: 'none' },
            { role: 'generic' },
            { role: 'navigation', name: 'Main Nav' },
            { role: 'link', name: 'Donate' },
        ],
    };

    const graph = fuseDomAndA11y(domTree, a11yTree);
    assert.equal(countNodes(graph.root), countNodes(domTree));
    assert.equal(findNode(graph.root, 'n0')?.role, 'html');
    assert.equal(findNode(graph.root, 'n0.0')?.role, 'body');
    assert.equal(findNode(graph.root, 'n0.0.0')?.role, 'navigation');
    assert.equal(findNode(graph.root, 'n0.0.0')?.name, 'Main Nav');
    assert.equal(findNode(graph.root, 'n0.0.0.0')?.role, 'div');
    assert.equal(findNode(graph.root, 'n0.0.0.0.0')?.role, 'link');
    assert.equal(findNode(graph.root, 'n0.0.0.0.0')?.name, 'Donate');
});

test('fuseDomAndA11y should not build container name from descendant text', () => {
    const domTree: DomNode = {
        id: 'n0',
        tag: 'div',
        children: [{ id: 'n0.0', tag: 'a', text: 'Read more', children: [] }],
    };
    const a11yTree: A11yNode = {
        role: 'generic',
        children: [{ role: 'link', name: 'Read more' }],
    };

    const graph = fuseDomAndA11y(domTree, a11yTree);

    assert.equal(findNode(graph.root, 'n0')?.name, undefined);
    assert.equal(findNode(graph.root, 'n0.0')?.name, 'Read more');
});

test('fuseDomAndA11y should downgrade long a11y name into content', () => {
    const longName =
        'This paragraph explains how to configure advanced options, and it should not be treated as a short control label.';
    const domTree: DomNode = {
        id: 'n0',
        tag: 'p',
        children: [],
    };
    const a11yTree: A11yNode = {
        role: 'paragraph',
        name: longName,
    };

    const graph = fuseDomAndA11y(domTree, a11yTree);
    assert.equal(graph.root.name, undefined);
    assert.equal(graph.root.content, longName);
});

test('fuseDomAndA11y should expose link href as target', () => {
    const domTree: DomNode = {
        id: 'n0',
        tag: 'a',
        text: 'Open Docs',
        attrs: { href: 'https://example.com/docs' },
        children: [],
    };
    const a11yTree: A11yNode = {
        role: 'link',
        name: 'Open Docs',
    };

    const graph = fuseDomAndA11y(domTree, a11yTree);
    assert.equal(graph.root.role, 'link');
    assert.equal(graph.root.name, 'Open Docs');
    assert.equal(graph.root.content, 'Open Docs');
    assert.equal(graph.root.target?.ref, 'https://example.com/docs');
    assert.equal(graph.root.target?.kind, 'url');
});
