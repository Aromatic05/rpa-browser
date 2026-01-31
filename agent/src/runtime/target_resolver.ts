import type { Frame, Locator, Page } from 'playwright';
import type { Target } from '../runner/commands';
import type { PageRegistry, WorkspaceScope } from './page_registry';

export type ResolvedTarget = {
    page: Page;
    frame: Frame;
    locator: Locator;
};

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
