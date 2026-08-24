export type BrowserOperationClassification = 'read' | 'effect';
export type BrowserOperationStaticClassification = BrowserOperationClassification | 'dynamic';

const classifications = new Map<string, BrowserOperationStaticClassification>([
    ['browser.get_page_info', 'read'],
    ['browser.list_tabs', 'read'],
    ['browser.snapshot', 'read'],
    ['browser.capture_resolve', 'read'],
    ['browser.get_content', 'read'],
    ['browser.read_console', 'read'],
    ['browser.read_network', 'read'],
    ['browser.take_screenshot', 'read'],
    ['browser.assert', 'read'],
    ['browser.query', 'read'],
    ['browser.compute', 'read'],
    ['browser.entity', 'dynamic'],
    ['browser.goto', 'effect'],
    ['browser.go_back', 'effect'],
    ['browser.reload', 'effect'],
    ['browser.create_tab', 'effect'],
    ['browser.switch_tab', 'effect'],
    ['browser.close_tab', 'effect'],
    ['browser.evaluate', 'effect'],
    ['browser.click', 'effect'],
    ['browser.fill', 'effect'],
    ['browser.type', 'effect'],
    ['browser.select_option', 'effect'],
    ['browser.batch', 'effect'],
    ['browser.hover', 'effect'],
    ['browser.scroll', 'effect'],
    ['browser.press_key', 'effect'],
    ['browser.drag_and_drop', 'effect'],
    ['browser.mouse', 'effect'],
    ['browser.checkpoint', 'effect'],
]);

const readEntityOperations = new Set(['list', 'get', 'find']);

export const getBrowserOperationStaticClassification = (
    name: string,
): BrowserOperationStaticClassification | undefined => classifications.get(name);

export const classifyBrowserOperation = (
    name: string,
    args: unknown,
): BrowserOperationClassification => {
    const classification = classifications.get(name);
    if (classification === 'read' || classification === 'effect') {return classification;}
    if (classification === 'dynamic' && name === 'browser.entity') {
        if (args && typeof args === 'object' && !Array.isArray(args)) {
            const op = (args as Record<string, unknown>).op;
            if (typeof op === 'string' && readEntityOperations.has(op)) {return 'read';}
        }
    }
    return 'effect';
};
