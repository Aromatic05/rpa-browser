import test from 'node:test';
import assert from 'node:assert/strict';
import { setNodeAttrs } from '../executors/snapshot/core/runtime_store';
import type { EntityRecord, UnifiedNode } from '../executors/snapshot/core/types';
import { buildStructureEntityIndex } from '../executors/snapshot/stages/entity_index';

const node = (id: string, role: string, children: UnifiedNode[] = [], attrs: Record<string, string> = {}): UnifiedNode => {
    const next: UnifiedNode = {
        id,
        role,
        children,
    };
    if (Object.keys(attrs).length > 0) {
        setNodeAttrs(next, attrs);
    }
    return next;
};

const listEntityAnchors = (entities: EntityRecord[]): string[] => {
    const anchors: string[] = [];
    for (const entity of entities) {
        if (entity.kind !== 'list') continue;
        if (entity.type === 'region') anchors.push(entity.nodeId);
        if (entity.type === 'group') anchors.push(entity.containerId);
    }
    return anchors;
};

test('candidate selection should not keep complementary->navigation->list ancestor chain as entities', () => {
    const list = node(
        'list-node',
        'list',
        [
            node('item-1', 'listitem', [node('link-1', 'link', [], { tag: 'a', href: '/a' })], { tag: 'li' }),
            node('item-2', 'listitem', [node('link-2', 'link', [], { tag: 'a', href: '/b' })], { tag: 'li' }),
            node('item-3', 'listitem', [node('link-3', 'link', [], { tag: 'a', href: '/c' })], { tag: 'li' }),
            node('item-4', 'listitem', [node('link-4', 'link', [], { tag: 'a', href: '/d' })], { tag: 'li' }),
        ],
        { tag: 'ul' },
    );
    const navigation = node('navigation-node', 'navigation', [list], { tag: 'nav' });
    const complementary = node('complementary-node', 'complementary', [navigation], { tag: 'aside' });
    const root = node('root-node', 'root', [complementary], { tag: 'body' });

    const entityIndex = buildStructureEntityIndex(root);
    const entities = Object.values(entityIndex.entities);
    const anchors = new Set<string>([
        ...entities
            .filter((entity) => entity.type === 'region')
            .map((entity) => entity.nodeId),
        ...entities
            .filter((entity) => entity.type === 'group')
            .map((entity) => entity.containerId),
    ]);

    assert.equal(anchors.has('complementary-node'), false);
    assert.equal(anchors.has('navigation-node'), false);
    assert.equal(anchors.has('list-node'), true);
});

test('candidate selection should suppress heading-dominant article wrapper while keeping inner table', () => {
    const article = node(
        'article-node',
        'article',
        [
            node('h1', 'heading', [], { tag: 'h2' }),
            node('h2', 'heading', [], { tag: 'h3' }),
            node('h3', 'heading', [], { tag: 'h3' }),
            node('p1', 'paragraph', [], { tag: 'p' }),
            node(
                'inner-table',
                'table',
                [
                    node('row-1', 'row', [node('cell-1', 'cell', [], { tag: 'td' }), node('cell-2', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
                    node('row-2', 'row', [node('cell-3', 'cell', [], { tag: 'td' }), node('cell-4', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
                    node('row-3', 'row', [node('cell-5', 'cell', [], { tag: 'td' }), node('cell-6', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
                ],
                { tag: 'table' },
            ),
        ],
        { tag: 'article' },
    );
    const root = node('root', 'root', [article], { tag: 'main' });

    const entityIndex = buildStructureEntityIndex(root);
    const entities = Object.values(entityIndex.entities);
    const anchors = new Set<string>([
        ...entities
            .filter((entity) => entity.type === 'region')
            .map((entity) => entity.nodeId),
        ...entities
            .filter((entity) => entity.type === 'group')
            .map((entity) => entity.containerId),
    ]);

    assert.equal(anchors.has('article-node'), false);
    assert.equal(
        entities.some((entity) => entity.kind === 'table' && ((entity.type === 'region' && entity.nodeId === 'inner-table') || (entity.type === 'group' && entity.containerId === 'inner-table'))),
        true,
    );
});

test('candidate selection should keep inner nested table and suppress outer table shell', () => {
    const innerTable = node(
        'inner-table',
        'table',
        [
            node('inner-row-1', 'row', [node('inner-cell-1', 'cell', [], { tag: 'td' }), node('inner-cell-2', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
            node('inner-row-2', 'row', [node('inner-cell-3', 'cell', [], { tag: 'td' }), node('inner-cell-4', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
            node('inner-row-3', 'row', [node('inner-cell-5', 'cell', [], { tag: 'td' }), node('inner-cell-6', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
        ],
        { tag: 'table' },
    );
    const outerTable = node(
        'outer-table',
        'table',
        [
            node('outer-row-1', 'row', [node('outer-cell-1', 'cell', [innerTable], { tag: 'td' })], { tag: 'tr' }),
            node('outer-row-2', 'row', [node('outer-cell-2', 'cell', [], { tag: 'td' })], { tag: 'tr' }),
        ],
        { tag: 'table' },
    );
    const root = node('root', 'root', [outerTable], { tag: 'main' });

    const entityIndex = buildStructureEntityIndex(root);
    const entities = Object.values(entityIndex.entities);
    const anchors = new Set<string>([
        ...entities
            .filter((entity) => entity.type === 'region')
            .map((entity) => entity.nodeId),
        ...entities
            .filter((entity) => entity.type === 'group')
            .map((entity) => entity.containerId),
    ]);

    assert.equal(anchors.has('outer-table'), false);
    assert.equal(anchors.has('inner-table'), true);
});

test('candidate selection should not infer list entity from listitem count alone', () => {
    const weakList = node(
        'weak-list-shell',
        'section',
        [
            node('weak-item-1', 'listitem', [node('weak-head-1', 'heading', [], { tag: 'h3' })], { tag: 'div' }),
            node('weak-item-2', 'listitem', [node('weak-head-2', 'heading', [], { tag: 'h3' })], { tag: 'div' }),
            node('weak-item-3', 'listitem', [node('weak-head-3', 'heading', [], { tag: 'h3' })], { tag: 'div' }),
            node('weak-item-4', 'listitem', [node('weak-head-4', 'heading', [], { tag: 'h3' })], { tag: 'div' }),
            node('weak-item-5', 'listitem', [node('weak-head-5', 'heading', [], { tag: 'h3' })], { tag: 'div' }),
            node('weak-item-6', 'listitem', [node('weak-head-6', 'heading', [], { tag: 'h3' })], { tag: 'div' }),
        ],
        { tag: 'section' },
    );
    const root = node('root', 'root', [weakList], { tag: 'main' });

    const entityIndex = buildStructureEntityIndex(root);
    const entities = Object.values(entityIndex.entities);
    const listAnchors = listEntityAnchors(entities);

    assert.equal(listAnchors.includes('weak-list-shell'), false);
});

test('candidate selection should keep one table candidate per strong table family when page has many tables', () => {
    const wrappers: UnifiedNode[] = [];
    for (let i = 0; i < 24; i += 1) {
        const table = node(
            `table-${i}`,
            'table',
            [
                node(`table-${i}-row-1`, 'row', [node(`table-${i}-cell-1a`, 'cell', [], { tag: 'td' }), node(`table-${i}-cell-1b`, 'cell', [], { tag: 'td' })], { tag: 'tr' }),
                node(`table-${i}-row-2`, 'row', [node(`table-${i}-cell-2a`, 'cell', [], { tag: 'td' }), node(`table-${i}-cell-2b`, 'cell', [], { tag: 'td' })], { tag: 'tr' }),
                node(`table-${i}-row-3`, 'row', [node(`table-${i}-cell-3a`, 'cell', [], { tag: 'td' }), node(`table-${i}-cell-3b`, 'cell', [], { tag: 'td' })], { tag: 'tr' }),
            ],
            { tag: 'table' },
        );
        wrappers.push(
            node(
                `wrapper-${i}`,
                'generic',
                [table],
                { tag: 'div', class: 'example-table-wrapper' },
            ),
        );
    }
    const root = node('root', 'root', wrappers, { tag: 'main' });

    const entityIndex = buildStructureEntityIndex(root);
    const tableAnchors = Object.values(entityIndex.entities)
        .filter((entity) => entity.kind === 'table')
        .map((entity) => (entity.type === 'region' ? entity.nodeId : entity.containerId));

    const parentById = new Map<string, string | undefined>();
    const indexParents = (current: UnifiedNode, parentId: string | undefined) => {
        parentById.set(current.id, parentId);
        for (const child of current.children) {
            indexParents(child, current.id);
        }
    };
    indexParents(root, undefined);

    const isInSubtree = (ancestorId: string, nodeId: string): boolean => {
        let cursor: string | undefined = nodeId;
        while (cursor) {
            if (cursor === ancestorId) return true;
            cursor = parentById.get(cursor);
        }
        return false;
    };

    for (let i = 0; i < 24; i += 1) {
        const wrapperId = `wrapper-${i}`;
        assert.equal(
            tableAnchors.some((anchor) => isInSubtree(wrapperId, anchor)),
            true,
            `expected table entity under ${wrapperId}`,
        );
    }
});
