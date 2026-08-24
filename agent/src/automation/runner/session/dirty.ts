const MUTATING_STEPS = new Set([
    'browser.goto',
    'browser.go_back',
    'browser.reload',
    'browser.click',
    'browser.fill',
    'browser.type',
    'browser.select_option',
    'browser.press_key',
    'browser.drag_and_drop',
]);

const MUTATING_MOUSE_ACTIONS = new Set(['down', 'up', 'click', 'dblclick']);

export const shouldMarkPageSessionDirtyByStep = (
    stepName: string,
    args: Readonly<Record<string, unknown>>,
): boolean => {
    if (MUTATING_STEPS.has(stepName)) {return true;}
    if (stepName === 'browser.evaluate') {return args.mutatesPage === true;}
    if (stepName === 'browser.mouse') {
        return typeof args.action === 'string' && MUTATING_MOUSE_ACTIONS.has(args.action);
    }
    return false;
};
