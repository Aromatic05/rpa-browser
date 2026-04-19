import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compress } from '../executors/snapshot/stages/compress';
import { buildStructureEntityIndex } from '../executors/snapshot/stages/entity_index';
import { cloneTreeWithRuntime, normalizeText, setNodeAttrs, setNodeContent } from '../executors/snapshot/core/runtime_store';
import type { EntityIndex, UnifiedNode } from '../executors/snapshot/core/types';

type PerfPoint = {
    size: number;
    nodeCount: number;
    compressMs: number;
    entityIndexMs: number;
    entityCount: number;
};

const ENABLE_PERF_BASELINE = process.env.SNAPSHOT_PERF_BASELINE === '1';
const BASELINE_SIZES = [1000, 5000, 10000] as const;

const WARMUP_ROUNDS = parsePositiveInt(process.env.SNAPSHOT_PERF_WARMUP_ROUNDS, 1);
const BENCH_ROUNDS = parsePositiveInt(process.env.SNAPSHOT_PERF_BENCH_ROUNDS, 3);

const MAX_COMPRESS_RATIO_5K = parsePositiveFloat(process.env.SNAPSHOT_PERF_MAX_COMPRESS_RATIO_5K, 12);
const MAX_COMPRESS_RATIO_10K = parsePositiveFloat(process.env.SNAPSHOT_PERF_MAX_COMPRESS_RATIO_10K, 24);
const MAX_ENTITY_INDEX_RATIO_5K = parsePositiveFloat(process.env.SNAPSHOT_PERF_MAX_ENTITY_INDEX_RATIO_5K, 12);
const MAX_ENTITY_INDEX_RATIO_10K = parsePositiveFloat(process.env.SNAPSHOT_PERF_MAX_ENTITY_INDEX_RATIO_10K, 24);

test('snapshot perf baseline keeps near-linear scaling on 1k/5k/10k trees', { skip: !ENABLE_PERF_BASELINE }, () => {
    const points: PerfPoint[] = [];

    for (const size of BASELINE_SIZES) {
        const baseTree = buildSyntheticTableTree(size);
        const nodeCount = countNodes(baseTree);

        const compressMs = measureMedianMs(
            () => cloneTreeWithRuntime(baseTree),
            (tree) => {
                const out = compress(tree);
                assert.ok(out, 'compress should produce non-null tree');
            },
        );

        let entityCount = 0;
        const entityIndexMs = measureMedianMs(
            () => cloneTreeWithRuntime(baseTree),
            (tree) => {
                const index = buildStructureEntityIndex(tree);
                entityCount = countEntities(index);
            },
        );

        points.push({
            size,
            nodeCount,
            compressMs,
            entityIndexMs,
            entityCount,
        });
    }

    const point1k = mustFindPoint(points, 1000);
    const point5k = mustFindPoint(points, 5000);
    const point10k = mustFindPoint(points, 10000);

    const compressRatio5k = safeRatio(point5k.compressMs, point1k.compressMs);
    const compressRatio10k = safeRatio(point10k.compressMs, point1k.compressMs);
    const entityRatio5k = safeRatio(point5k.entityIndexMs, point1k.entityIndexMs);
    const entityRatio10k = safeRatio(point10k.entityIndexMs, point1k.entityIndexMs);

    assert.ok(
        compressRatio5k <= MAX_COMPRESS_RATIO_5K,
        `compress 5k/1k ratio too high: ${compressRatio5k.toFixed(2)} > ${MAX_COMPRESS_RATIO_5K.toFixed(2)}`,
    );
    assert.ok(
        compressRatio10k <= MAX_COMPRESS_RATIO_10K,
        `compress 10k/1k ratio too high: ${compressRatio10k.toFixed(2)} > ${MAX_COMPRESS_RATIO_10K.toFixed(2)}`,
    );
    assert.ok(
        entityRatio5k <= MAX_ENTITY_INDEX_RATIO_5K,
        `entity_index 5k/1k ratio too high: ${entityRatio5k.toFixed(2)} > ${MAX_ENTITY_INDEX_RATIO_5K.toFixed(2)}`,
    );
    assert.ok(
        entityRatio10k <= MAX_ENTITY_INDEX_RATIO_10K,
        `entity_index 10k/1k ratio too high: ${entityRatio10k.toFixed(2)} > ${MAX_ENTITY_INDEX_RATIO_10K.toFixed(2)}`,
    );

    for (const point of points) {
        assert.ok(point.entityCount > 0, `size=${point.size} should produce entity candidates`);
    }

    // 输出量化基线，便于后续回归对比。
    console.info(
        '[snapshot-perf-baseline]',
        JSON.stringify(
            {
                config: {
                    warmupRounds: WARMUP_ROUNDS,
                    benchRounds: BENCH_ROUNDS,
                },
                ratios: {
                    compress5kOver1k: Number(compressRatio5k.toFixed(4)),
                    compress10kOver1k: Number(compressRatio10k.toFixed(4)),
                    entityIndex5kOver1k: Number(entityRatio5k.toFixed(4)),
                    entityIndex10kOver1k: Number(entityRatio10k.toFixed(4)),
                },
                points: points.map((point) => ({
                    ...point,
                    compressMs: Number(point.compressMs.toFixed(3)),
                    entityIndexMs: Number(point.entityIndexMs.toFixed(3)),
                })),
            },
            null,
            2,
        ),
    );
});

const measureMedianMs = <T>(
    createInput: () => T,
    run: (input: T) => void,
): number => {
    for (let i = 0; i < WARMUP_ROUNDS; i += 1) {
        run(createInput());
    }

    const samples: number[] = [];
    for (let i = 0; i < BENCH_ROUNDS; i += 1) {
        const input = createInput();
        const start = performance.now();
        run(input);
        const end = performance.now();
        samples.push(end - start);
    }

    return median(samples);
};

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] || 0;
    }
    return ((sorted[middle - 1] || 0) + (sorted[middle] || 0)) / 2;
};

const buildSyntheticTableTree = (targetNodes: number): UnifiedNode => {
    let idSeq = 0;
    const createNode = (role: string, children: UnifiedNode[] = []): UnifiedNode => ({
        id: `perf-${idSeq++}`,
        role,
        children,
    });

    const root = createNode('root');
    const main = createNode('main');
    const table = createNode('table');
    root.children.push(main);
    main.children.push(table);

    setNodeAttrs(root, { tag: 'body' });
    setNodeAttrs(main, { tag: 'main', class: 'perf-main' });
    setNodeAttrs(table, { tag: 'table', class: 'perf-table dataset-table' });

    while (idSeq < targetNodes) {
        const rowIndex = table.children.length;
        const row = createNode('row');
        setNodeAttrs(row, { tag: 'tr', class: rowIndex % 2 === 0 ? 'row-even' : 'row-odd' });
        table.children.push(row);

        appendCell(row, createTextCell(createNode, rowIndex, 0));
        if (idSeq >= targetNodes) break;

        appendCell(row, createLinkCell(createNode, rowIndex, 1));
        if (idSeq >= targetNodes) break;

        appendCell(row, createButtonCell(createNode, rowIndex, 2));
        if (idSeq >= targetNodes) break;

        appendCell(row, createTextboxCell(createNode, rowIndex, 3));
        if (idSeq >= targetNodes) break;

        if (rowIndex % 20 === 0 && idSeq < targetNodes) {
            appendCell(row, createDecorativeCell(createNode));
        }
    }

    return root;
};

const appendCell = (row: UnifiedNode, cell: UnifiedNode) => {
    row.children.push(cell);
};

const createTextCell = (
    createNode: (role: string, children?: UnifiedNode[]) => UnifiedNode,
    rowIndex: number,
    colIndex: number,
): UnifiedNode => {
    const cell = createNode('cell');
    setNodeAttrs(cell, { tag: 'td', class: `col-${colIndex}` });
    setNodeContent(cell, normalizeText(`item-${rowIndex}`));
    return cell;
};

const createLinkCell = (
    createNode: (role: string, children?: UnifiedNode[]) => UnifiedNode,
    rowIndex: number,
    colIndex: number,
): UnifiedNode => {
    const cell = createNode('cell');
    setNodeAttrs(cell, { tag: 'td', class: `col-${colIndex}` });

    const link = createNode('link');
    link.name = `detail-${rowIndex}`;
    setNodeAttrs(link, {
        tag: 'a',
        href: `/perf/${rowIndex}`,
        class: 'cell-link',
    });

    cell.children.push(link);
    return cell;
};

const createButtonCell = (
    createNode: (role: string, children?: UnifiedNode[]) => UnifiedNode,
    rowIndex: number,
    colIndex: number,
): UnifiedNode => {
    const cell = createNode('cell');
    setNodeAttrs(cell, { tag: 'td', class: `col-${colIndex}` });

    const shell = createNode('span');
    setNodeAttrs(shell, { tag: 'span', class: 'btn-shell' });

    const button = createNode('button');
    button.name = rowIndex % 3 === 0 ? '编辑' : '查看';
    setNodeAttrs(button, {
        tag: 'button',
        class: rowIndex % 3 === 0 ? 'btn-edit' : 'btn-open',
    });

    shell.children.push(button);
    cell.children.push(shell);
    return cell;
};

const createTextboxCell = (
    createNode: (role: string, children?: UnifiedNode[]) => UnifiedNode,
    rowIndex: number,
    colIndex: number,
): UnifiedNode => {
    const cell = createNode('cell');
    setNodeAttrs(cell, { tag: 'td', class: `col-${colIndex}` });

    const textbox = createNode('textbox');
    setNodeAttrs(textbox, {
        tag: 'input',
        type: 'text',
        placeholder: `keyword-${rowIndex}`,
        value: rowIndex % 2 === 0 ? `v-${rowIndex}` : '',
    });

    cell.children.push(textbox);
    return cell;
};

const createDecorativeCell = (
    createNode: (role: string, children?: UnifiedNode[]) => UnifiedNode,
): UnifiedNode => {
    const cell = createNode('cell');
    setNodeAttrs(cell, { tag: 'td', class: 'col-decoration' });

    const shell = createNode('div');
    setNodeAttrs(shell, { tag: 'div', class: 'skeleton spinner' });

    const icon = createNode('i');
    setNodeAttrs(icon, { tag: 'i', class: 'icon loading' });

    shell.children.push(icon);
    cell.children.push(shell);
    return cell;
};

const countNodes = (node: UnifiedNode): number => {
    let total = 1;
    for (const child of node.children) {
        total += countNodes(child);
    }
    return total;
};

const countEntities = (entityIndex: EntityIndex): number => Object.keys(entityIndex.entities).length;

const mustFindPoint = (points: PerfPoint[], size: number): PerfPoint => {
    const hit = points.find((point) => point.size === size);
    assert.ok(hit, `missing perf point for size=${size}`);
    return hit;
};

const safeRatio = (numerator: number, denominator: number): number => {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return Number.POSITIVE_INFINITY;
    if (denominator <= 0) return Number.POSITIVE_INFINITY;
    return numerator / denominator;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function parsePositiveFloat(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}
