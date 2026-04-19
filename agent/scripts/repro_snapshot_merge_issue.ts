import path from 'node:path';
import type { Page } from 'playwright';
import { collectRawData } from '../src/runner/steps/executors/snapshot/stages/collect';
import { fuseDomAndA11y } from '../src/runner/steps/executors/snapshot/stages/fusion';
import { generateSemanticSnapshot } from '../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { getNodeAttr } from '../src/runner/steps/executors/snapshot/core/runtime_store';
import type { DomTreeNode } from '../src/runner/trace/dom/getDomTree';
import type { UnifiedNode } from '../src/runner/steps/executors/snapshot/core/types';
import { createContextManager, resolvePaths } from '../src/runtime/context_manager';

type TargetPaths = {
    checkboxPath?: string;
    radioPath?: string;
    selectPath?: string;
};

const PAGE_URL = 'https://shop.yingdao.com/webOperations/index';

const main = async () => {
    process.env.RPA_BROWSER_MODE = 'extension';
    process.env.RPA_USER_DATA_DIR = path.resolve(process.cwd(), '.user-data-repro');
    const paths = resolvePaths();
    const contextManager = createContextManager({
        extensionPaths: paths.extensionPaths,
        userDataDir: paths.userDataDir,
    });
    const context = await contextManager.getContext();
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    await inspect('before-interaction', page);

    await page.click('input[type="checkbox"][value="red"]');
    await page.click('input[type="radio"][value="2"]');
    await page.selectOption('select', '2');
    await page.waitForTimeout(250);

    await inspect('after-interaction', page);

    await context.close();
};

const inspect = async (label: string, page: Page) => {
    const raw = await collectRawData(page, { captureRuntimeState: true, waitMode: 'interaction' });
    const runtimeMap = raw.runtimeStateMap || {};
    const domRoot = raw.domTree as DomTreeNode | null;
    const paths = resolveTargetPaths(domRoot);
    const fused = fuseDomAndA11y(raw.domTree, raw.a11yTree, raw.runtimeStateMap);
    const snapshot = await generateSemanticSnapshot(page, { captureRuntimeState: true, waitMode: 'interaction' });

    const domState = await page.evaluate(() => {
        const checkbox = document.querySelector('input[type="checkbox"][value="red"]') as HTMLInputElement | null;
        const radio = document.querySelector('input[type="radio"][value="2"]') as HTMLInputElement | null;
        const select = document.querySelector('select') as HTMLSelectElement | null;
        return {
            checkbox: checkbox?.checked ?? null,
            radio2: radio?.checked ?? null,
            selectValue: select?.value ?? null,
            selectText: select?.selectedOptions?.[0]?.textContent?.trim() ?? null,
        };
    });
    const domStructure = await page.evaluate((script) => {
        try {
            return (0, eval)(script);
        } catch (error) {
            return { error: String(error) };
        }
    }, `(() => {
        const inspect = (el) => {
            if (!el) return null;
            const root = el.getRootNode();
            const chain = [];
            let cursor = el;
            for (let i = 0; i < 6 && cursor; i += 1) {
                chain.push((cursor.tagName || '').toLowerCase());
                cursor = cursor.parentElement;
            }
            return {
                tag: (el.tagName || '').toLowerCase(),
                inShadowRoot: root instanceof ShadowRoot,
                rootType: root && root.constructor ? root.constructor.name : typeof root,
                parentChain: chain,
            };
        };
        return {
            checkbox: inspect(document.querySelector('input[type="checkbox"][value="red"]')),
            radio: inspect(document.querySelector('input[type="radio"][value="2"]')),
            select: inspect(document.querySelector('select')),
        };
    })()`);

    let evaluateProbe: { ok: boolean; value?: unknown; error?: string };
    try {
        const value = await page.evaluate(() => {
            function probeFn() {
                return 2;
            }
            return probeFn();
        });
        evaluateProbe = { ok: true, value };
    } catch (error) {
        evaluateProbe = { ok: false, error: String(error) };
    }

    const fusedCheckbox = paths.checkboxPath ? findById(fused.root, paths.checkboxPath) : undefined;
    const fusedRadio = paths.radioPath ? findById(fused.root, paths.radioPath) : undefined;
    const fusedSelect = paths.selectPath ? findById(fused.root, paths.selectPath) : undefined;

    const snapCheckbox = findNode(snapshot.root, (node) => node.role === 'checkbox' && (node.name || '').trim() === 'red');
    const snapRadio = findNode(snapshot.root, (node) => node.role === 'radio' && (node.name || '').trim() === 'B');
    const snapSelect = findNode(snapshot.root, (node) => node.role === 'combobox' && (node.name || '').includes('苹果'));

    const report = {
        label,
        domState,
        evaluateProbe,
        domStructure,
        targetPaths: paths,
        runtimeSummary: {
            total: Object.keys(runtimeMap).length,
            sampleKeys: Object.keys(runtimeMap).slice(0, 8),
            checkboxCandidates: findRuntimeCandidates(runtimeMap, (row) => row.tag === 'input' && row.type === 'checkbox' && row.value === 'red'),
            radioCandidates: findRuntimeCandidates(runtimeMap, (row) => row.tag === 'input' && row.type === 'radio' && row.value === '2'),
            selectCandidates: findRuntimeCandidates(runtimeMap, (row) => row.tag === 'select'),
        },
        runtimeRows: {
            checkbox: paths.checkboxPath ? runtimeMap[paths.checkboxPath] : undefined,
            radio: paths.radioPath ? runtimeMap[paths.radioPath] : undefined,
            select: paths.selectPath ? runtimeMap[paths.selectPath] : undefined,
        },
        fusedAttrs: {
            checkbox: fusedCheckbox ? readAttrs(fusedCheckbox) : undefined,
            radio: fusedRadio ? readAttrs(fusedRadio) : undefined,
            select: fusedSelect ? readAttrs(fusedSelect) : undefined,
        },
        snapshotNodes: {
            checkbox: snapCheckbox ? { id: snapCheckbox.id, name: snapCheckbox.name, content: snapCheckbox.content, attrs: readAttrs(snapCheckbox) } : null,
            radio: snapRadio ? { id: snapRadio.id, name: snapRadio.name, content: snapRadio.content, attrs: readAttrs(snapRadio) } : null,
            select: snapSelect ? { id: snapSelect.id, name: snapSelect.name, content: snapSelect.content, attrs: readAttrs(snapSelect) } : null,
        },
    };

    console.log(JSON.stringify(report, null, 2));
};

const findRuntimeCandidates = (
    runtimeMap: Record<string, any>,
    predicate: (row: any) => boolean,
): Array<{ pathKey: string; value?: string; checked?: string; selected?: string; parentKey?: string }> => {
    const hits: Array<{ pathKey: string; value?: string; checked?: string; selected?: string; parentKey?: string }> = [];
    for (const [pathKey, row] of Object.entries(runtimeMap)) {
        if (!predicate(row)) continue;
        hits.push({
            pathKey,
            value: row.value,
            checked: row.checked,
            selected: row.selected,
            parentKey: row.parentKey,
        });
    }
    return hits.slice(0, 5);
};

const readAttrs = (node: UnifiedNode) => ({
    type: getNodeAttr(node, 'type'),
    value: getNodeAttr(node, 'value'),
    checked: getNodeAttr(node, 'checked'),
    selected: getNodeAttr(node, 'selected'),
    ariaChecked: getNodeAttr(node, 'aria-checked'),
    ariaSelected: getNodeAttr(node, 'aria-selected'),
    class: getNodeAttr(node, 'class'),
});

const resolveTargetPaths = (root: DomTreeNode | null): TargetPaths => {
    const paths: TargetPaths = {};
    if (!root) return paths;
    walkDom(root, (node) => {
        const tag = (node.tag || '').toLowerCase();
        const attrs = node.attrs || {};
        if (!paths.checkboxPath && tag === 'input' && attrs.type === 'checkbox' && attrs.value === 'red') {
            paths.checkboxPath = node.id;
        }
        if (!paths.radioPath && tag === 'input' && attrs.type === 'radio' && attrs.value === '2') {
            paths.radioPath = node.id;
        }
        if (!paths.selectPath && tag === 'select') {
            paths.selectPath = node.id;
        }
    });
    return paths;
};

const walkDom = (node: DomTreeNode, visitor: (node: DomTreeNode) => void) => {
    visitor(node);
    for (const child of node.children) walkDom(child, visitor);
};

const findById = (root: UnifiedNode, id: string): UnifiedNode | undefined => {
    if (root.id === id) return root;
    for (const child of root.children) {
        const hit = findById(child, id);
        if (hit) return hit;
    }
    return undefined;
};

const findNode = (root: UnifiedNode, predicate: (node: UnifiedNode) => boolean): UnifiedNode | undefined => {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const hit = findNode(child, predicate);
        if (hit) return hit;
    }
    return undefined;
};

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
