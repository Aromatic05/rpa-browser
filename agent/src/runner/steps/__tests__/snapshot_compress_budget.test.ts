import test from 'node:test';
import assert from 'node:assert/strict';
import { compress } from '../executors/snapshot/stages/compress';
import { setNodeAttrs, setNodeContent } from '../executors/snapshot/core/runtime_store';
import type { UnifiedNode } from '../executors/snapshot/core/types';

const createNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const countNodes = (root: UnifiedNode): number => {
    let total = 0;
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        total += 1;
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }
    return total;
};

const collectIds = (root: UnifiedNode): Set<string> => {
    const ids = new Set<string>();
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        ids.add(current.id);
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }
    return ids;
};

const buildLargeList = (itemCount: number, activeIndex?: number): UnifiedNode => {
    const root = createNode('list-root', 'list');
    setNodeAttrs(root, { tag: 'ul', class: 'orders-list' });

    for (let index = 0; index < itemCount; index += 1) {
        const title = createNode(`list-item-${index}-title`, 'text');
        setNodeAttrs(title, { tag: 'span' });
        setNodeContent(title, `订单-${index}`);

        const meta = createNode(`list-item-${index}-meta`, 'text');
        setNodeAttrs(meta, { tag: 'span' });
        setNodeContent(meta, index % 2 === 0 ? '待处理' : '已完成');

        const item = createNode(`list-item-${index}`, 'listitem', [title, meta]);
        setNodeAttrs(item, {
            tag: 'li',
            class: 'orders-list-item',
            'data-active': index === activeIndex ? 'true' : '',
        });
        root.children.push(item);
    }

    return root;
};

const buildLargeTable = (rowCount: number, colCount: number, actionRow: number): UnifiedNode => {
    const table = createNode('table-root', 'table');
    setNodeAttrs(table, { tag: 'table', class: 'orders-table data-table' });

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = createNode(`row-${rowIndex}`, 'row');
        setNodeAttrs(row, { tag: 'tr' });

        for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
            const cell = createNode(`cell-${rowIndex}-${colIndex}`, 'cell');
            setNodeAttrs(cell, { tag: 'td' });
            setNodeContent(cell, `R${rowIndex}-C${colIndex}`);

            if (rowIndex === actionRow && colIndex === 1) {
                const action = createNode('action-btn', 'button');
                action.name = '编辑';
                setNodeAttrs(action, { tag: 'button' });
                cell.children.push(action);
            }

            row.children.push(cell);
        }

        table.children.push(row);
    }

    return table;
};

test('template collapse keeps first/last/active items while reducing repetitive siblings', () => {
    const root = buildLargeList(90, 37);
    const out = compress(root);
    assert.ok(out);

    const directIds = new Set(out.children.map((child) => child.id));
    assert.ok(directIds.has('list-item-0'));
    assert.ok(directIds.has('list-item-37'));
    assert.ok(directIds.has('list-item-89'));
    assert.ok(out.children.length <= 12, `expected capped sibling count, got ${out.children.length}`);
});

test('information budget pruning drops bulk noise but keeps important interactive node', () => {
    const root = buildLargeTable(200, 4, 120);
    const before = countNodes(root);

    const out = compress(root);
    assert.ok(out);

    const after = countNodes(out);
    const ids = collectIds(out);

    assert.ok(after < before * 0.7, `expected significant pruning, before=${before}, after=${after}`);
    assert.ok(ids.has('action-btn'), 'important interactive node should be preserved');
});

test('region-type budgets keep more table context than list context for similar scale', () => {
    const tableRoot = buildLargeTable(90, 4, -1);
    const listRoot = buildLargeList(220);

    const tableOut = compress(tableRoot);
    const listOut = compress(listRoot);
    assert.ok(tableOut);
    assert.ok(listOut);

    const tableCount = countNodes(tableOut);
    const listCount = countNodes(listOut);

    assert.ok(
        tableCount > listCount,
        `expected table budget to retain more nodes, table=${tableCount}, list=${listCount}`,
    );
});
