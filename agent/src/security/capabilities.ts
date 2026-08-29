import {SecurityError} from './errors';

export const CAPABILITIES = {
    AGENT_RUN: 'agent.run',
    BROWSER_READ: 'browser.read',
    BROWSER_MUTATE: 'browser.mutate',
    BROWSER_EVALUATE: 'browser.evaluate',
    TABS: 'tabs',
    PROGRAM_EXECUTE: 'program.execute',
    PROGRAM_SAVE: 'program.save',
    DEBUG_CONTROL: 'debug.control',
    CONTROL_EVAL: 'control.eval',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const CAPABILITY_LIST: readonly Capability[] = Object.freeze(Object.values(CAPABILITIES));

const capabilityValues = Object.freeze(new Set<string>(CAPABILITY_LIST));

export const isCapability = (value: unknown): value is Capability =>
    typeof value === 'string' && capabilityValues.has(value);

export const parseCapabilities = (values: Iterable<unknown>): ReadonlyArray<Capability> => {
    const accepted = new Set<Capability>();
    const rejected: string[] = [];
    for (const value of values) {
        if (isCapability(value)) {
            accepted.add(value);
            continue;
        }
        rejected.push(typeof value === 'string' ? value : String(value));
    }
    if (rejected.length > 0) {
        const shown = rejected.slice(0, 3).join(', ');
        const suffix = rejected.length > 3 ? ` (+${rejected.length - 3} more)` : '';
        throw new SecurityError('ERR_SECURITY_UNKNOWN_CAPABILITY', `unknown capabilities: ${shown}${suffix}`);
    }
    return Object.freeze([...accepted].sort());
};

const BROWSER_READ_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
    'browser.get_page_info',
    'browser.snapshot',
    'browser.capture_resolve',
    'browser.get_content',
    'browser.entity',
    'browser.query',
    'browser.read_console',
    'browser.read_network',
    'browser.take_screenshot',
]));

const BROWSER_MUTATE_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
    'browser.goto',
    'browser.go_back',
    'browser.reload',
    'browser.click',
    'browser.fill',
    'browser.type',
    'browser.select_option',
    'browser.batch',
    'browser.hover',
    'browser.scroll',
    'browser.press_key',
    'browser.drag_and_drop',
]));

const BROWSER_EVALUATE_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
    'browser.evaluate',
    'browser.mouse',
]));

const TAB_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
    'browser.create_tab',
    'browser.list_tabs',
    'browser.switch_tab',
    'browser.close_tab',
]));

export const capabilityForBrowserTool = (name: string): Capability | null => {
    if (BROWSER_READ_TOOLS.has(name)) {return CAPABILITIES.BROWSER_READ;}
    if (BROWSER_MUTATE_TOOLS.has(name)) {return CAPABILITIES.BROWSER_MUTATE;}
    if (BROWSER_EVALUATE_TOOLS.has(name)) {return CAPABILITIES.BROWSER_EVALUATE;}
    if (TAB_TOOLS.has(name)) {return CAPABILITIES.TABS;}
    return null;
};

const DEBUG_TOOL_PREFIX = 'debug.';

export const capabilityForTool = (name: string): Capability | null => {
    const browser = capabilityForBrowserTool(name);
    if (browser !== null) {return browser;}
    if (name === 'agent.run') {return CAPABILITIES.AGENT_RUN;}
    if (name === 'agent.execute_program') {return CAPABILITIES.PROGRAM_EXECUTE;}
    if (name === 'agent.save_program') {return CAPABILITIES.PROGRAM_SAVE;}
    if (name === 'control.eval') {return CAPABILITIES.CONTROL_EVAL;}
    if (name.startsWith(DEBUG_TOOL_PREFIX)) {return CAPABILITIES.DEBUG_CONTROL;}
    return null;
};

export const capabilityForActionType = (name: string): Capability | null => {
    if (name === 'agent.run') {return CAPABILITIES.AGENT_RUN;}
    if (name.startsWith('agent.sessions.')) {return CAPABILITIES.AGENT_RUN;}
    if (name === 'agent.start' || name === 'agent.stop' || name === 'agent.status') {
        return CAPABILITIES.AGENT_RUN;
    }
    if (name.startsWith('tab.')) {return CAPABILITIES.TABS;}
    if (name === 'dsl.run') {return CAPABILITIES.PROGRAM_EXECUTE;}
    if (name === 'dsl.save') {return CAPABILITIES.PROGRAM_SAVE;}
    if (name.startsWith(DEBUG_TOOL_PREFIX)) {return CAPABILITIES.DEBUG_CONTROL;}
    if (name === 'control.eval') {return CAPABILITIES.CONTROL_EVAL;}
    return null;
};