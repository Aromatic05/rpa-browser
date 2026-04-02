import type { Page } from 'playwright';

export const getDomTree = async (page: Page): Promise<unknown> => {
    // trace 层只提供基础 DOM 结构，不负责语义推断与压缩策略。
    // 当前保持轻量递归，后续按需要补充字段和裁剪规则。
    try {
        return await page.evaluate(() => {
            const maxDepth = 6;

            const walk = (node: Element, depth: number): Record<string, unknown> => {
                const text = (node.textContent || '').trim().slice(0, 120);
                const children =
                    depth >= maxDepth
                        ? []
                        : Array.from(node.children).map((child) => walk(child, depth + 1));

                return {
                    tag: node.tagName.toLowerCase(),
                    role: node.getAttribute('role') || undefined,
                    text: text || undefined,
                    children,
                };
            };

            const root = document.documentElement;
            if (!root) return null;
            return walk(root, 0);
        });
    } catch {
        // 占位：后续补错误观测与降级策略。
        return null;
    }
};
