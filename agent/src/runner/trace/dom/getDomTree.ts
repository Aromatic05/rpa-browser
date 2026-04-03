import type { Page } from 'playwright';

export type DomTreeNode = {
    id: string;
    tag: string;
    text?: string;
    children: DomTreeNode[];
    bbox?: { x: number; y: number; width: number; height: number };
    attrs?: Record<string, string>;
};

export const getDomTree = async (page: Page): Promise<DomTreeNode | null> => {
    // 第一阶段最小实现：产出稳定、可调试的 DOM 树，不做复杂清洗。
    try {
        // 用字符串脚本避免构建产物中的 __name 注入破坏 page.evaluate。
        return await page.evaluate(DOM_TREE_EVAL_SCRIPT);
    } catch {
        // 第一阶段失败时返回空树，避免阻塞上层流程。
        return null;
    }
};

const DOM_TREE_EVAL_SCRIPT = `(() => {
    const attrWhiteList = new Set([
        'id',
        'class',
        'name',
        'type',
        'role',
        'aria-label',
        'placeholder',
        'href',
        'value',
    ]);

    const pickAttrs = (el) => {
        const attrs = {};
        for (const attr of Array.from(el.attributes)) {
            if (!attrWhiteList.has(attr.name)) continue;
            attrs[attr.name] = attr.value;
        }
        return Object.keys(attrs).length > 0 ? attrs : undefined;
    };

    const ownText = (el) => {
        const text = Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim();
        return text || undefined;
    };

    const pickBbox = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) return undefined;
        return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    };

    const walk = (el, id) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return null;

        const children = [];
        let childIndex = 0;
        for (const child of Array.from(el.children)) {
            const childNode = walk(child, id + '.' + childIndex);
            childIndex += 1;
            if (childNode) children.push(childNode);
        }

        return {
            id,
            tag,
            text: ownText(el),
            children,
            bbox: pickBbox(el),
            attrs: pickAttrs(el),
        };
    };

    const root = document.documentElement || document.body;
    if (!root) return null;
    return walk(root, 'n0');
})()`;
