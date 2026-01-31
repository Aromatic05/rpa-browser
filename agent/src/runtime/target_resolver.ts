/**
 * target_resolver：将命令中的 Target 转换为 Playwright Locator。
 *
 * 依赖关系：
 * - 上游：runner/execute 与 actions 调用 resolveTarget
 * - 下游：依赖 Playwright Page/Frame/Locator
 *
 * 关键约束：
 * - 必须能在 workspace/tab scope 下找到正确 Page
 * - Target.selector 是必填；不在此层解析语义定位（保持职责单一）
 */
import type { Frame, Locator, Page } from 'playwright';
import type { Target } from '../runner/commands';
import type { PageRegistry, WorkspaceScope } from './page_registry';

export type ResolvedTarget = {
    page: Page;
    frame: Frame;
    locator: Locator;
};

/**
 * 根据 frameHint 在页面内定位 Frame。优先匹配 name，再匹配 url。
 */
const findFrame = (page: Page, frameHint?: string) => {
    if (!frameHint) return page.mainFrame();
    const frames = page.frames();
    const lowered = frameHint.toLowerCase();
    return (
        frames.find((frame) => frame.name().toLowerCase().includes(lowered)) ||
        frames.find((frame) => frame.url().toLowerCase().includes(lowered)) ||
        page.mainFrame()
    );
};

/**
 * 解析 Target 并返回 locator；当 page 未直接传入时，
 * 根据 scope 或 tabToken 从 registry 解析。
 */
export const resolveTarget = async ({
    page,
    tabToken,
    scope,
    target,
    pageRegistry,
}: {
    page?: Page;
    tabToken?: string;
    scope?: WorkspaceScope;
    target: Target;
    pageRegistry: PageRegistry;
}): Promise<ResolvedTarget> => {
    if (!target?.selector) {
        throw new Error('missing target.selector');
    }
    const resolvedPage =
        page || (scope ? await pageRegistry.resolvePage(scope) : tabToken ? await pageRegistry.getPage(tabToken) : undefined);
    if (!resolvedPage) {
        throw new Error('missing page');
    }
    const frame = findFrame(resolvedPage, target.frame);
    const locator = frame.locator(target.selector);
    return { page: resolvedPage, frame, locator };
};
