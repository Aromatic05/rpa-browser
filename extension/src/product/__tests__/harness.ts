import { JSDOM } from 'jsdom';
import { mountProductUI } from '../shell/mount.js';
import type { ProductUIHandle } from '../shell/mount.js';
import type {
    AgentTaskView,
    CommandPort,
    InteractionRequest,
    LibrarySummary,
    WorkspaceProductView,
} from '../model/contracts.js';

export type CommandCall = { name: string; args: unknown[] };

export const createCommandRecorder = (): { commands: CommandPort; calls: CommandCall[] } => {
    const calls: CommandCall[] = [];
    const record = (name: string) => (...args: unknown[]): void => {
        calls.push({ name, args });
    };
    const commands: CommandPort = {
        startTask: record('startTask'),
        stopTask: record('stopTask'),
        openTeach: record('openTeach'),
        openAnnotate: record('openAnnotate'),
        closeAnnotate: record('closeAnnotate'),
        openCurrentActivity: record('openCurrentActivity'),
        startTeach: record('startTeach'),
        stopTeach: record('stopTeach'),
        saveTeach: record('saveTeach'),
        discardTeach: record('discardTeach'),
        newTask: record('newTask'),
        retry: record('retry'),
        saveAutomation: record('saveAutomation'),
        viewDetails: record('viewDetails'),
        replayDemonstration: record('replayDemonstration'),
        editPageKnowledge: record('editPageKnowledge'),
        selectHistoryEntry: record('selectHistoryEntry'),
        approve: record('approve'),
        deny: record('deny'),
        answerClarification: record('answerClarification'),
        chooseRecovery: record('chooseRecovery'),
        beginHumanGuidance: record('beginHumanGuidance'),
        returnControl: record('returnControl'),
        reconnect: record('reconnect'),
        navigate: record('navigate'),
        collapse: record('collapse'),
        openDeveloper: record('openDeveloper'),
        closeDeveloper: record('closeDeveloper'),
        resize: record('resize'),
    };
    return { commands, calls };
};

export type MountOptions = {
    initialWidth?: number;
    now?: () => number;
    renderDeveloperSurface?: (root: HTMLElement) => void;
};

export type MountResult = {
    dom: JSDOM;
    handle: ProductUIHandle;
    root: HTMLElement;
    shadow: ShadowRoot;
    host: HTMLElement;
    launcher: HTMLButtonElement;
    panel: HTMLElement;
    body: HTMLElement;
    commands: CommandPort;
    calls: CommandCall[];
    cleanup: () => void;
};

export const mount = (view: WorkspaceProductView, opts: MountOptions = {}): MountResult => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/orders' });
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
        HTMLOptionElement: globalThis.HTMLOptionElement,
        Event: globalThis.Event,
        KeyboardEvent: globalThis.KeyboardEvent,
        Node: globalThis.Node,
        location: globalThis.location,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        HTMLOptionElement: dom.window.HTMLOptionElement,
        Event: dom.window.Event,
        KeyboardEvent: dom.window.KeyboardEvent,
        Node: dom.window.Node,
        location: dom.window.location,
    });
    const { commands, calls } = createCommandRecorder();
    const handle = mountProductUI({
        view,
        commands,
        initialWidth: opts.initialWidth,
        now: opts.now,
        renderDeveloperSurface: opts.renderDeveloperSurface,
    });
    const host = document.getElementById('rpa-product-panel') as HTMLElement;
    const shadow = host.shadowRoot as ShadowRoot;
    const launcher = shadow.querySelector('[data-rpa-product-launcher]') as HTMLButtonElement;
    const panel = shadow.querySelector('[data-rpa-product-panel]') as HTMLElement;
    const body = shadow.querySelector('.rpa-body') as HTMLElement;
    return {
        dom,
        handle,
        root: shadow.querySelector('.rpa-root') as HTMLElement,
        shadow,
        host,
        launcher,
        panel,
        body,
        commands,
        calls,
        cleanup: () => {
            handle.unmount();
            Object.assign(globalThis, previous);
            dom.window.close();
        },
    };
};

export const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

export const openPanel = (fixture: MountResult): void => {
    fixture.launcher.click();
};

export const bodyText = (fixture: MountResult): string => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- textContent is nullish per lib.dom
    return fixture.body.textContent ?? '';
};

export const footerText = (fixture: MountResult): string => {
    const footer = fixture.shadow.querySelector('.rpa-footer');
    if (!footer) {
        return '';
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- textContent is nullish per lib.dom
    return footer.textContent ?? '';
};

export const typeInto = (fixture: MountResult, field: string, value: string): void => {
    const found = fixture.shadow.querySelector(`[data-rpa-product-field="${field}"]`);
    if (!found) {
        throw new Error(`field ${field} not found`);
    }
    const input = found as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    input.value = value;
    input.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }));
};

export const keydown = (fixture: MountResult, key: string): void => {
    fixture.dom.window.document.dispatchEvent(
        new fixture.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
};

export const emptyLibrary = (): LibrarySummary => ({
    automations: [],
    procedures: [],
    recoveries: [],
    demonstrations: [],
    pageKnowledge: [],
});

export const idleView = (): WorkspaceProductView => ({
    workspace: 'ws-1',
    reservation: 'idle',
    connection: 'connected',
    librarySummary: emptyLibrary(),
    history: [],
});

export const runningTask = (overrides: Partial<AgentTaskView> = {}): AgentTaskView => ({
    taskId: 'task-1',
    status: 'running',
    phase: undefined,
    title: 'Order form fill',
    promptSummary: 'Fill the order form and submit the delivery address',
    timeline: [
        { kind: 'task_created', summary: 'Task started', at: 1000 },
        { kind: 'activity', summary: 'Observing the page', at: 2000 },
    ],
    reportAvailable: false,
    resumable: false,
    ...overrides,
});

export const runningView = (overrides: Partial<AgentTaskView> = {}): WorkspaceProductView => ({
    workspace: 'ws-1',
    reservation: 'task',
    connection: 'connected',
    activeTask: runningTask(overrides),
    librarySummary: emptyLibrary(),
    history: [],
});

export const waitingView = (interaction: InteractionRequest): WorkspaceProductView => ({
    workspace: 'ws-1',
    reservation: 'task',
    connection: 'connected',
    activeTask: runningTask({ status: 'waiting_for_user', interaction }),
    librarySummary: emptyLibrary(),
    history: [],
});

export const libraryView = (reservation: WorkspaceProductView['reservation'] = 'idle'): WorkspaceProductView => ({
    workspace: 'ws-1',
    reservation,
    connection: 'connected',
    ...(reservation === 'task' ? { activeTask: runningTask() } : {}),
    librarySummary: {
        automations: [{ name: 'Submit weekly report', description: 'Generates and sends the weekly report.' }],
        procedures: [{ name: 'Ensure login' }],
        recoveries: [{ name: 'Renew session' }],
        demonstrations: [{ name: 'New vendor onboarding', stepCount: 12 }],
        pageKnowledge: [
            { profileName: 'orders', label: 'Orders page', pageKind: 'form', urlPattern: '/orders', entityCount: 1 },
        ],
    },
    history: [],
});