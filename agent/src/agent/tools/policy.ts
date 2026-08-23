export type AgentToolClassification = 'read' | 'effect';
type AgentToolStaticClassification = AgentToolClassification | 'dynamic';

export type AgentBrowserTool = {
    name: string;
    classification: AgentToolStaticClassification;
};

export const AGENT_BROWSER_TOOLS: readonly AgentBrowserTool[] = [
    {name: 'browser.list_tabs', classification: 'read'},
    {name: 'browser.get_page_info', classification: 'read'},
    {name: 'browser.snapshot', classification: 'read'},
    {name: 'browser.capture_resolve', classification: 'read'},
    {name: 'browser.get_content', classification: 'read'},
    {name: 'browser.entity', classification: 'dynamic'},
    {name: 'browser.query', classification: 'read'},
    {name: 'browser.read_console', classification: 'read'},
    {name: 'browser.read_network', classification: 'read'},
    {name: 'browser.take_screenshot', classification: 'read'},
    {name: 'browser.create_tab', classification: 'effect'},
    {name: 'browser.switch_tab', classification: 'effect'},
    {name: 'browser.close_tab', classification: 'effect'},
    {name: 'browser.goto', classification: 'effect'},
    {name: 'browser.go_back', classification: 'effect'},
    {name: 'browser.reload', classification: 'effect'},
    {name: 'browser.click', classification: 'effect'},
    {name: 'browser.fill', classification: 'effect'},
    {name: 'browser.type', classification: 'effect'},
    {name: 'browser.select_option', classification: 'effect'},
    {name: 'browser.batch', classification: 'effect'},
    {name: 'browser.hover', classification: 'effect'},
    {name: 'browser.scroll', classification: 'effect'},
    {name: 'browser.press_key', classification: 'effect'},
    {name: 'browser.drag_and_drop', classification: 'effect'},
] as const;

const toolClassifications = new Map(AGENT_BROWSER_TOOLS.map((tool) => [tool.name, tool.classification]));
const readEntityOperations = new Set(['list', 'get', 'find']);

export const resolveAgentBrowserToolNames = (): Set<string> =>
    new Set(AGENT_BROWSER_TOOLS.map((tool) => tool.name));

export const classifyAgentToolCall = (name: string, args: unknown): AgentToolClassification => {
    const classification = toolClassifications.get(name);
    if (classification === 'read' || classification === 'effect') {return classification;}
    if (classification === 'dynamic' && name === 'browser.entity') {
        if (args && typeof args === 'object' && !Array.isArray(args)) {
            const op = (args as Record<string, unknown>).op;
            if (typeof op === 'string' && readEntityOperations.has(op)) {return 'read';}
        }
    }
    return 'effect';
};
