import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

type IdNode = {
    key: string;
    role: string;
    name?: string;
    backendId?: string;
    children: IdNode[];
};

type AssignedId = {
    key: string;
    id: string;
};

type AssignFn = (root: IdNode) => AssignedId[];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const sha10 = (value: string) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);

const normalize = (value: string | undefined): string => (value || '').trim().toLowerCase();

const currentLikeAssign: AssignFn = (root) => {
    const used = new Map<string, number>();
    const out: AssignedId[] = [];

    const walk = (node: IdNode, parentContext: string) => {
        const role = normalize(node.role);
        const name = normalize(node.name).slice(0, 80);
        const base = `${role}|${name}|${parentContext}|${node.children.length}`;
        const candidate = `${role || 'node'}_${sha10(base)}`;
        const count = (used.get(candidate) || 0) + 1;
        used.set(candidate, count);
        const id = count === 1 ? candidate : `${candidate}_${count}`;
        out.push({ key: node.key, id });

        const context = ['form', 'table', 'dialog', 'list', 'toolbar', 'section', 'article', 'main'].includes(role)
            ? `${role}:${name}`
            : parentContext;
        for (const child of node.children) {walk(child, context);}
    };

    walk(root, 'root');
    return out;
};

const pathAwareAssign: AssignFn = (root) => {
    const out: AssignedId[] = [];

    const walk = (node: IdNode, path: string) => {
        const role = normalize(node.role);
        const name = normalize(node.name).slice(0, 80);
        const base = `${role}|${name}|${path}|${node.children.length}`;
        const id = `${role || 'node'}_${sha10(base)}`;
        out.push({ key: node.key, id });
        node.children.forEach((child, index) => walk(child, `${path}/${role}[${index}]`));
    };

    walk(root, 'root');
    return out;
};

const backendPreferredAssign: AssignFn = (root) => {
    const out: AssignedId[] = [];
    const used = new Set<string>();

    const walk = (node: IdNode, path: string) => {
        const role = normalize(node.role) || 'node';
        const backendId = normalize(node.backendId);
        let id: string;
        if (backendId) {
            id = `${role}_b${backendId}`;
        } else {
            const name = normalize(node.name).slice(0, 80);
            id = `${role}_${sha10(`${role}|${name}|${path}|${node.children.length}`)}`;
        }

        if (used.has(id)) {
            // deterministic tie-breaker (rare fallback)
            id = `${id}_${sha10(`${path}|${node.key}`)}`;
        }
        used.add(id);
        out.push({ key: node.key, id });
        node.children.forEach((child, index) => walk(child, `${path}/${role}[${index}]`));
    };

    walk(root, 'root');
    return out;
};

const toMap = (rows: AssignedId[]) => new Map(rows.map((row) => [row.key, row.id]));

const isUnique = (rows: AssignedId[]) => {
    const ids = rows.map((item) => item.id);
    return new Set(ids).size === ids.length;
};

const isStableByKey = (left: AssignedId[], right: AssignedId[]) => {
    const l = toMap(left);
    const r = toMap(right);
    for (const [key, id] of l) {
        if (!r.has(key)) {continue;}
        if (r.get(key) !== id) {return false;}
    }
    return true;
};

const baseTree = (): IdNode => ({
    key: 'root',
    role: 'root',
    backendId: '1',
    children: [
        {
            key: 'main',
            role: 'main',
            backendId: '10',
            children: [
                { key: 'cta-a', role: 'button', name: 'Buy', backendId: '101', children: [] },
                { key: 'cta-b', role: 'button', name: 'Buy', backendId: '102', children: [] },
                { key: 'cta-c', role: 'button', name: 'Buy', backendId: '103', children: [] },
            ],
        },
    ],
});

const reorderedTree = (): IdNode => {
    const tree = clone(baseTree());
    const main = tree.children[0];
    if (!main) {return tree;}
    main.children = [main.children[1], main.children[0], main.children[2]].filter(Boolean) as IdNode[];
    return tree;
};

const textChangedTree = (): IdNode => {
    const tree = clone(baseTree());
    const main = tree.children[0];
    if (!main) {return tree;}
    const ctaA = main.children.find((child) => child.key === 'cta-a');
    if (ctaA) {ctaA.name = 'Buy now';}
    return tree;
};

test('id algorithm validation samples: uniqueness and stability comparison', () => {
    const fixtures = {
        base: baseTree(),
        reordered: reorderedTree(),
        textChanged: textChangedTree(),
    };

    const algorithms: Record<string, AssignFn> = {
        currentLike: currentLikeAssign,
        pathAware: pathAwareAssign,
        backendPreferred: backendPreferredAssign,
    };

    const report = Object.entries(algorithms).map(([name, assign]) => {
        const base = assign(clone(fixtures.base));
        const reordered = assign(clone(fixtures.reordered));
        const textChanged = assign(clone(fixtures.textChanged));
        return {
            name,
            unique: isUnique(base),
            stableOnReorder: isStableByKey(base, reordered),
            stableOnTextChange: isStableByKey(base, textChanged),
        };
    });

    for (const item of report) {
        assert.equal(item.unique, true, `${item.name} should stay unique`);
    }

    const current = report.find((item) => item.name === 'currentLike');
    const backend = report.find((item) => item.name === 'backendPreferred');
    assert.ok(current);
    assert.ok(backend);

    // Validation sample: current-like algorithm is sensitive to reorder / text drift.
    assert.equal(current!.stableOnReorder, false);
    assert.equal(current!.stableOnTextChange, false);

    // Validation sample: backend-based algorithm stays stable for these cases.
    assert.equal(backend!.stableOnReorder, true);
    assert.equal(backend!.stableOnTextChange, true);
});
