/**
 * Product shell: launcher + right-docked panel (spec §2-§4). Projection-driven:
 * `setView` re-renders from a `WorkspaceProductView`; user actions go through a
 * wrapped `CommandPort` so no raw RPC name ever reaches a component.
 */
import {
    button,
    createUiState,
    el,
    muted,
    sectionTitle,
    statusLine,
    stopButton,
    type SurfaceContext,
    type UiState,
} from '../components/common.js';
import type { CommandPort, ProductSurface, WorkspaceProductView } from '../model/contracts.js';
import { interactionWaitingKind, isActiveActivity, isTerminalStatus } from '../model/projection.js';
import { renderHistorySurface } from '../surfaces/result.js';
import { renderAnnotateSurface, renderHomeSurface, renderTeachSurface } from '../surfaces/home.js';
import { renderLibrarySurface } from '../surfaces/library.js';
import { renderTaskSurface } from '../surfaces/task.js';
import { productStyles } from './styles.js';

const ROOT_ID = 'rpa-product-panel';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;
const MAX_WIDTH = 520;

const clampWidth = (width: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

export type ProductUIOptions = {
    view: WorkspaceProductView;
    commands: CommandPort;
    initialWidth?: number;
    renderDeveloperSurface?: (root: HTMLElement) => void;
    now?: () => number;
};

export type ProductUIHandle = {
    setView(view: WorkspaceProductView): void;
    setDeveloperEnabled(enabled: boolean): void;
    unmount(): void;
    open(): void;
    close(): void;
};

const noopHandle = (): ProductUIHandle => ({
    setView: () => undefined,
    setDeveloperEnabled: () => undefined,
    unmount: () => undefined,
    open: () => undefined,
    close: () => undefined,
});

export const mountProductUI = (opts: ProductUIOptions): ProductUIHandle => {
    if (document.getElementById(ROOT_ID)) {
        return noopHandle();
    }

    const state: {
        view: WorkspaceProductView;
        ui: UiState;
        surface: ProductSurface;
        width: number;
        collapsed: boolean;
        productStateKey: string;
        surfaceHistory: ProductSurface[];
    } = {
        view: opts.view,
        ui: createUiState(),
        surface: 'home',
        width: clampWidth(opts.initialWidth ?? DEFAULT_WIDTH),
        collapsed: true,
        productStateKey: '',
        surfaceHistory: [],
    };

    const now = opts.now ?? (() => Date.now());

    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute('data-rpa-panel', 'product');
    host.setAttribute('data-rpa-snapshot-ignore', 'true');
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.right = '0';
    host.style.height = '100vh';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = productStyles;
    const root = el('div', 'rpa-root');
    shadow.append(style, root);

    const launcher = document.createElement('button');
    launcher.className = 'rpa-launcher';
    launcher.dataset.rpaProductLauncher = 'true';
    launcher.setAttribute('data-rpa-snapshot-ignore', 'true');
    launcher.setAttribute('aria-label', 'Open Agent');
    launcher.setAttribute('title', 'Open Agent');

    const panel = document.createElement('div');
    panel.className = 'rpa-panel';
    panel.dataset.rpaProductPanel = 'true';
    panel.setAttribute('data-rpa-snapshot-ignore', 'true');
    panel.hidden = true;

    const resizeHandle = el('div', 'rpa-resize');
    resizeHandle.dataset.rpaProductResize = 'true';
    const header = el('div', 'rpa-header');
    const connectionBanner = el('div', 'rpa-connection-banner');
    connectionBanner.hidden = true;
    const body = el('div', 'rpa-body');
    const footer = el('div', 'rpa-footer');

    panel.append(resizeHandle, header, connectionBanner, body, footer);
    root.append(launcher, panel);
    document.documentElement.appendChild(host);

    const applyPanelWidth = (): void => {
        const viewport = typeof window.innerWidth === 'number' ? window.innerWidth : DEFAULT_WIDTH;
        const effective = viewport < 640 ? Math.min(state.width, Math.max(MIN_WIDTH, viewport)) : state.width;
        panel.style.width = `${String(effective)}px`;
    };

    const openPanel = (): void => {
        state.collapsed = false;
        launcher.hidden = true;
        panel.hidden = false;
        applyPanelWidth();
        renderAll();
        focusComposerIfHome();
    };

    const collapsePanel = (): void => {
        state.collapsed = true;
        panel.hidden = true;
        launcher.hidden = false;
        renderLauncher();
    };

    const navigateTo = (surface: ProductSurface, recordHistory = true): void => {
        if (surface === 'task' && !state.view.activeTask) {
            return;
        }
        if (surface === state.surface) {
            return;
        }
        if (recordHistory) {
            state.surfaceHistory.push(state.surface);
            if (state.surfaceHistory.length > 12) {
                state.surfaceHistory.shift();
            }
        }
        state.surface = surface;
        renderAll();
    };

    const navigateBack = (): void => {
        while (state.surfaceHistory.length > 0) {
            const previous = state.surfaceHistory.pop();
            if (!previous) {break;}
            if (previous === 'task' && !state.view.activeTask) {continue;}
            state.surface = previous;
            renderAll();
            return;
        }
        state.surface = 'home';
        renderAll();
    };

    const routeToActive = (): void => {
        if (state.view.reservation === 'playback') {
            state.surface = 'library';
        } else if (state.view.reservation === 'teach') {
            state.surface = 'teach';
        } else if (state.view.reservation === 'annotate') {
            state.surface = 'annotate';
        } else {
            state.surface = 'task';
        }
        renderAll();
    };

    const defaultSurfaceFor = (view: WorkspaceProductView): ProductSurface => {
        if (view.reservation === 'playback') {
            return 'library';
        }
        if (view.reservation === 'teach') {
            return 'teach';
        }
        if (view.reservation === 'annotate') {
            return 'annotate';
        }
        if (view.activeTask) {
            return 'task';
        }
        return 'home';
    };

    const enableDev = (): void => {
        state.ui.devEnabled = true;
        state.ui.devConfirm = false;
        state.surface = 'developer';
        opts.commands.openDeveloper();
        renderAll();
    };

    const disableDev = (): void => {
        state.ui.devEnabled = false;
        state.ui.devConfirm = false;
        state.surface = defaultSurfaceFor(state.view);
        opts.commands.closeDeveloper();
        renderAll();
    };

    const commands: CommandPort = {
        ...opts.commands,
        openTeach: () => {
            opts.commands.openTeach();
            navigateTo('teach');
        },
        openAnnotate: () => {
            opts.commands.openAnnotate();
            navigateTo('annotate');
        },
        openCurrentActivity: () => {
            opts.commands.openCurrentActivity();
            routeToActive();
        },
        newTask: () => {
            state.ui.composer = '';
            state.ui.automationSaveOpen = false;
            state.ui.automationName = '';
            opts.commands.newTask();
            navigateTo('home');
        },
        collapse: () => {
            collapsePanel();
            opts.commands.collapse();
        },
        navigate: (surface: ProductSurface) => {
            navigateTo(surface);
        },
    };

    const buildContext = (): SurfaceContext => ({
        view: state.view,
        commands,
        ui: state.ui,
        rerender: renderAll,
        now,
    });

    const renderConnectionBanner = (): void => {
        connectionBanner.innerHTML = '';
        if (state.view.connection !== 'disconnected') {
            connectionBanner.hidden = true;
            return;
        }
        connectionBanner.hidden = false;
        connectionBanner.append(statusLine('●', 'Disconnected', 'muted'));
        const copy = el('span', undefined, ['Showing last known state. Nothing changed while offline.']);
        connectionBanner.append(copy);
        connectionBanner.append(
            button('Retry', () => { commands.reconnect(); }, 'ghost', { dataAction: 'reconnect' }),
        );
    };

    const renderDeveloperSurface = (surfaceRoot: HTMLElement): void => {
        surfaceRoot.dataset.rpaProductSurface = 'developer';
        const dev = el('div', 'rpa-dev-surface');
        dev.append(
            sectionTitle('Developer mode'),
            muted('Provider, model, execution mode, session ids, raw reports and internal actions live here.'),
        );
        surfaceRoot.append(dev);
        opts.renderDeveloperSurface?.(surfaceRoot);
    };

    const renderBody = (): void => {
        body.innerHTML = '';
        if (state.surface === 'developer') {
            renderDeveloperSurface(body);
            return;
        }
        body.dataset.rpaProductSurface = state.surface;
        const ctx = buildContext();
        switch (state.surface) {
            case 'home':
                renderHomeSurface(body, ctx);
                break;
            case 'task':
                renderTaskSurface(body, ctx);
                break;
            case 'library':
                renderLibrarySurface(body, ctx);
                break;
            case 'history':
                renderHistorySurface(body, ctx);
                break;
            case 'teach':
                renderTeachSurface(body, ctx);
                break;
            case 'annotate':
                renderAnnotateSurface(body, ctx);
                break;
            default:
                renderHomeSurface(body, ctx);
                break;
        }
    };

    const renderLauncher = (): void => {
        launcher.innerHTML = '';
        launcher.textContent = 'A';
        const dot = el('span', 'rpa-launcher-dot');
        const waiting = interactionWaitingKind(state.view);
        const teaching = state.view.authoring?.teach?.phase === 'recording';
        const annotating = state.view.authoring?.annotate?.canvasOpen === true;
        let ariaLabel = 'Open Agent';
        if (state.view.connection === 'disconnected') {
            dot.classList.add('rpa-launcher-dot--disconnected');
            ariaLabel = 'Agent disconnected';
        } else if (teaching) {
            dot.classList.add('rpa-launcher-dot--teach');
            ariaLabel = 'Recording in progress';
        } else if (waiting) {
            dot.classList.add('rpa-launcher-dot--waiting');
            ariaLabel = 'Agent needs your input';
        } else if (annotating) {
            ariaLabel = 'Annotating';
        } else if (state.view.activeTask?.status === 'running') {
            dot.classList.add('rpa-launcher-dot--running');
            ariaLabel = 'Agent running';
        } else if (state.view.activeTask?.status === 'paused') {
            dot.classList.add('rpa-launcher-dot--waiting');
            ariaLabel = 'Agent paused';
        }
        launcher.append(dot);
        if (waiting) {
            const badge = el('span', 'rpa-launcher-badge', ['1']);
            launcher.append(badge);
        }
        launcher.classList.toggle('rpa-launcher--dev', state.ui.devEnabled);
        launcher.setAttribute('aria-label', ariaLabel);
        launcher.setAttribute('title', ariaLabel);
    };

    const renderHeader = (): void => {
        header.innerHTML = '';
        const authoringLocked = state.view.reservation === 'teach' || state.view.reservation === 'annotate';
        if (state.surface !== 'home') {
            header.append(
                button('← Back', navigateBack, 'ghost', {
                    className: 'rpa-header-action',
                    dataAction: 'back',
                    ariaLabel: 'Back',
                }),
            );
        }
        if (authoringLocked) {
            const title = state.view.reservation === 'teach' ? 'Teach the agent' : 'Annotate this page';
            header.append(el('div', 'rpa-brand', [title]));
            const tools = el('div', 'rpa-header-tools');
            tools.append(
                button('Collapse', collapsePanel, 'ghost', {
                    className: 'rpa-header-action',
                    dataAction: 'collapse-panel',
                    ariaLabel: 'Collapse sidebar',
                }),
            );
            header.append(tools);
            return;
        }
        header.append(el('div', 'rpa-brand', ['Agent']));
        const nav = el('div', 'rpa-nav');
        const navItems: Array<{ key: ProductSurface; label: string; enabled: boolean }> = [
            { key: 'home', label: 'Home', enabled: true },
            { key: 'task', label: 'Task', enabled: state.view.activeTask !== undefined },
            { key: 'library', label: 'Library', enabled: true },
            { key: 'history', label: 'History', enabled: true },
        ];
        for (const item of navItems) {
            const navBtn = document.createElement('button');
            navBtn.type = 'button';
            navBtn.className = 'rpa-nav-btn';
            navBtn.textContent = item.label;
            navBtn.dataset.rpaProductNav = item.key;
            if (state.surface === item.key) {
                navBtn.classList.add('active');
            }
            if (!item.enabled) {
                navBtn.disabled = true;
            }
            navBtn.addEventListener('click', () => { navigateTo(item.key); });
            nav.append(navBtn);
        }
        header.append(nav);
        const tools = el('div', 'rpa-header-tools');
        const activeTask = state.view.activeTask;
        if (activeTask && !isTerminalStatus(activeTask.status)) {
            if (activeTask.status === 'running') {
                tools.append(
                    button('Pause', () => { commands.pauseTask(); }, 'ghost', {
                        className: 'rpa-header-action',
                        dataAction: 'pause-task',
                        ariaLabel: 'Pause task',
                    }),
                );
            } else if (activeTask.status === 'paused') {
                tools.append(
                    button('Resume', () => { commands.resumeTask(); }, 'primary', {
                        className: 'rpa-header-action',
                        dataAction: 'resume-task',
                        ariaLabel: 'Resume task',
                    }),
                );
            }
            tools.append(stopButton(buildContext()));
        }
        const devBtn = document.createElement('button');
        devBtn.type = 'button';
        devBtn.className = 'rpa-icon-btn';
        devBtn.textContent = '⚙';
        devBtn.dataset.rpaProductDev = 'true';
        devBtn.setAttribute('aria-label', 'Developer mode');
        devBtn.setAttribute('title', 'Developer mode');
        devBtn.addEventListener('click', () => {
            if (state.ui.devEnabled) {
                navigateTo('developer');
            } else {
                state.ui.devConfirm = true;
                renderAll();
            }
        });
        if (state.ui.devEnabled) {
            devBtn.classList.add('active');
        }
        tools.append(devBtn);
        tools.append(
            button('Collapse', collapsePanel, 'ghost', {
                className: 'rpa-header-action',
                dataAction: 'collapse-panel',
                ariaLabel: 'Collapse sidebar',
            }),
        );
        header.append(tools);
    };

    const renderFooter = (): void => {
        footer.innerHTML = '';
        footer.hidden = !state.ui.devEnabled && !state.ui.devConfirm;
        if (footer.hidden) {
            return;
        }
        const disclosure = el('div', 'rpa-dev-disclosure');
        disclosure.dataset.rpaProductDevDisclosure = 'true';
        disclosure.append(
            el('span', undefined, [state.ui.devEnabled ? 'Developer mode: on' : 'Developer mode: off']),
        );
        const action = state.ui.devEnabled
            ? button('Disable', () => { disableDev(); }, 'ghost', { dataAction: 'disable-dev' })
            : button(
                  state.ui.devConfirm ? 'Confirm enable' : 'Enable',
                  () => {
                      if (state.ui.devConfirm) {
                          enableDev();
                      } else {
                          state.ui.devConfirm = true;
                          renderAll();
                      }
                  },
                  'ghost',
                  { dataAction: 'enable-dev' },
              );
        disclosure.append(action);
        footer.append(disclosure);
    };

    const renderAll = (): void => {
        launcher.hidden = !state.collapsed;
        panel.hidden = state.collapsed;
        renderConnectionBanner();
        renderHeader();
        renderBody();
        renderFooter();
        renderLauncher();
        applyPanelWidth();
    };

    const focusComposerIfHome = (): void => {
        if (state.surface === 'home' && !isActiveActivity(state.view)) {
            const composer = body.querySelector<HTMLTextAreaElement>('[data-rpa-product-composer]');
            composer?.focus();
        }
    };

    launcher.addEventListener('click', () => {
        openPanel();
    });

    let dragging = false;
    let dragStartX = 0;
    let dragStartWidth = 0;
    resizeHandle.addEventListener('pointerdown', (event: PointerEvent) => {
        if (state.collapsed) {
            return;
        }
        dragging = true;
        dragStartX = event.clientX;
        dragStartWidth = state.width;
        event.preventDefault();
    });
    const onPointerMove = (event: PointerEvent): void => {
        if (!dragging) {
            return;
        }
        const delta = dragStartX - event.clientX;
        state.width = clampWidth(dragStartWidth + delta);
        applyPanelWidth();
    };
    const onPointerUp = (): void => {
        if (!dragging) {
            return;
        }
        dragging = false;
        opts.commands.resize(state.width);
    };
    const onWindowResize = (): void => {
        applyPanelWidth();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('resize', onWindowResize);

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || state.collapsed) {
            return;
        }
        if (state.ui.stopArmed) {
            state.ui.stopArmed = false;
            if (state.ui.stopArmTimer !== null) {
                clearTimeout(state.ui.stopArmTimer);
                state.ui.stopArmTimer = null;
            }
            renderAll();
            return;
        }
        if (state.ui.devConfirm) {
            state.ui.devConfirm = false;
            renderAll();
            return;
        }
        if (state.ui.denyOpen) {
            state.ui.denyOpen = false;
            renderAll();
            return;
        }
        const composer = body.querySelector<HTMLTextAreaElement>('[data-rpa-product-composer]');
        if (composer && composer === document.activeElement) {
            composer.blur();
            return;
        }
        collapsePanel();
    };
    document.addEventListener('keydown', onKeyDown, true);

    const setView = (view: WorkspaceProductView): void => {
        const key = `${view.reservation}|${view.activeTask?.status ?? ''}`;
        const previousKey = state.productStateKey;
        state.view = view;
        state.productStateKey = key;
        const userSelectedSurface =
            state.surface === 'library' || state.surface === 'history' || state.surface === 'developer';
        if (previousKey !== key && !userSelectedSurface) {
            state.surface = defaultSurfaceFor(view);
        }
        renderAll();
    };

    const setDeveloperEnabled = (enabled: boolean): void => {
        state.ui.devEnabled = enabled;
        state.ui.devConfirm = false;
        if (enabled && state.surface !== 'developer') {
            state.surface = 'developer';
        } else if (!enabled && state.surface === 'developer') {
            state.surface = defaultSurfaceFor(state.view);
        }
        renderAll();
    };

    const unmount = (): void => {
        if (state.ui.stopArmTimer !== null) {
            clearTimeout(state.ui.stopArmTimer);
        }
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('resize', onWindowResize);
        host.remove();
    };

    setView(opts.view);

    return {
        setView,
        setDeveloperEnabled,
        unmount,
        open: openPanel,
        close: collapsePanel,
    };
};
