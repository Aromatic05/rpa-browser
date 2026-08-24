import {
    classifyBrowserOperation,
    getBrowserOperationStaticClassification,
    type BrowserOperationClassification,
    type BrowserOperationStaticClassification,
} from '../../automation/runner/steps/effects';

export type AgentToolClassification = BrowserOperationClassification | 'control';
type AgentToolStaticClassification = BrowserOperationStaticClassification;

export type AgentBrowserTool = {
    name: string;
    classification: AgentToolStaticClassification;
};

const agentBrowserToolNames = [
    'browser.list_tabs',
    'browser.get_page_info',
    'browser.snapshot',
    'browser.capture_resolve',
    'browser.get_content',
    'browser.entity',
    'browser.query',
    'browser.read_console',
    'browser.read_network',
    'browser.take_screenshot',
    'browser.create_tab',
    'browser.switch_tab',
    'browser.close_tab',
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
] as const;

export const AGENT_BROWSER_TOOLS: readonly AgentBrowserTool[] = agentBrowserToolNames.map((name) => ({
    name,
    classification: getBrowserOperationStaticClassification(name) ?? 'effect',
}));

export const resolveAgentBrowserToolNames = (): Set<string> =>
    new Set(AGENT_BROWSER_TOOLS.map((tool) => tool.name));

export const classifyAgentToolCall = (name: string, args: unknown): AgentToolClassification =>
    classifyBrowserOperation(name, args);
