/**
 * Shared DOM helpers and per-surface UI state for the product surfaces.
 * Thin, projection-only view utilities; mutating behavior always goes through
 * the typed CommandPort.
 */
import type {
    CommandPort,
    ProductSurface,
    TeachKind,
    WorkspaceProductView,
} from '../model/contracts.js';

export type UiState = {
    composer: string;
    teachKind: TeachKind;
    businessArea: string;
    denyOpen: boolean;
    denyError: boolean;
    denyReason: string;
    requestedAlternative: string;
    selectedRecovery: string | null;
    clarificationToken: string;
    clarificationValue: string;
    clarificationError: string | null;
    stopArmed: boolean;
    stopArmTimer: ReturnType<typeof setTimeout> | null;
    devEnabled: boolean;
    devConfirm: boolean;
    selectedHistoryId: string | null;
    automationSaveOpen: boolean;
    automationName: string;
    demonstrationName: string;
};

export const createUiState = (): UiState => ({
    composer: '',
    teachKind: 'procedure',
    businessArea: '',
    denyOpen: false,
    denyError: false,
    denyReason: '',
    requestedAlternative: '',
    selectedRecovery: null,
    clarificationToken: '',
    clarificationValue: '',
    clarificationError: null,
    stopArmed: false,
    stopArmTimer: null,
    devEnabled: false,
    devConfirm: false,
    selectedHistoryId: null,
    automationSaveOpen: false,
    automationName: '',
    demonstrationName: '',
});

export type SurfaceContext = {
    view: WorkspaceProductView;
    commands: CommandPort;
    ui: UiState;
    rerender: () => void;
    now: () => number;
};

export const el = (tag: string, className?: string, children?: Array<Node | string>): HTMLElement => {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (children) {
        node.append(...children);
    }
    return node;
};

export const elAttrs = (
    tag: string,
    className: string | undefined,
    attrs: Record<string, string>,
    children?: Array<Node | string>,
): HTMLElement => {
    const node = el(tag, className, children);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    return node;
};

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export type ButtonOptions = {
    disabled?: boolean;
    className?: string;
    ariaLabel?: string;
    dataAction?: string;
};

export const button = (
    label: string,
    onClick: () => unknown,
    variant: ButtonVariant = 'ghost',
    opts: ButtonOptions = {},
): HTMLButtonElement => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.className = `rpa-btn rpa-btn--${variant}${opts.className ? ` ${opts.className}` : ''}`;
    if (opts.disabled) {
        node.disabled = true;
    }
    if (opts.ariaLabel) {
        node.setAttribute('aria-label', opts.ariaLabel);
    }
    if (opts.dataAction) {
        node.dataset.rpaProductAction = opts.dataAction;
    }
    node.addEventListener('click', () => {
        void onClick();
    });
    return node;
};

export const icon = (glyph: string): HTMLElement => {
    const node = h('span', 'rpa-icon');
    node.setAttribute('aria-hidden', 'true');
    node.textContent = glyph;
    return node;
};

export const h = (tag: string, className?: string, children?: Array<Node | string>): HTMLElement => {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (children) {
        node.append(...children);
    }
    return node;
};

export const statusLine = (glyph: string, text: string, tone: string, pulse = false): HTMLElement => {
    const node = h('span', `rpa-status rpa-status--${tone}`);
    if (pulse) {
        node.classList.add('rpa-pulse');
    }
    node.append(icon(glyph), h('span', 'rpa-status-text', [text]));
    return node;
};

export const card = (children: Array<Node | string>): HTMLElement => {
    const node = h('div', 'rpa-card');
    node.append(...children);
    return node;
};

export const cardTitle = (text: string): HTMLElement => {
    const node = h('h3', 'rpa-card-title');
    node.textContent = text;
    return node;
};

export const sectionTitle = (text: string): HTMLElement => {
    const node = h('h2', 'rpa-section-title');
    node.textContent = text;
    return node;
};

export const muted = (text: string): HTMLElement => {
    const node = h('div', 'rpa-muted');
    node.textContent = text;
    return node;
};

export const hint = (text: string): HTMLElement => {
    const node = h('div', 'rpa-hint');
    node.textContent = text;
    return node;
};

export const emptyState = (text: string): HTMLElement => {
    const node = h('div', 'rpa-empty');
    node.textContent = text;
    return node;
};

export const fieldLabel = (text: string): HTMLElement => {
    const node = h('label', 'rpa-field-label');
    node.textContent = text;
    return node;
};

export const detailsBlock = (summary: string, lines: string[]): HTMLElement => {
    const details = h('details', 'rpa-details');
    const summaryNode = h('summary', undefined, [summary]);
    details.append(summaryNode);
    if (lines.length > 0) {
        const list = h('ul', 'rpa-details-list');
        for (const line of lines) {
            list.append(h('li', undefined, [line]));
        }
        details.append(list);
    }
    return details;
};

export const isMutationDisabled = (ctx: SurfaceContext): boolean => ctx.view.connection !== 'connected';

export const clearStopTimer = (ctx: SurfaceContext): void => {
    if (ctx.ui.stopArmTimer !== null) {
        clearTimeout(ctx.ui.stopArmTimer);
        ctx.ui.stopArmTimer = null;
    }
};

/** Two-step destructive Stop (spec §6/§7): armed for 3s before confirmation. */
export const stopButton = (ctx: SurfaceContext): HTMLButtonElement => {
    const disabled = isMutationDisabled(ctx);
    if (ctx.ui.stopArmed) {
        return button(
            'Confirm stop',
            () => {
                ctx.ui.stopArmed = false;
                clearStopTimer(ctx);
                ctx.commands.stopTask();
            },
            'danger',
            { disabled, dataAction: 'confirm-stop', ariaLabel: 'Confirm stop this task' },
        );
    }
    return button(
        'Stop',
        () => {
            if (disabled) {
                return;
            }
            ctx.ui.stopArmed = true;
            ctx.ui.stopArmTimer = setTimeout(() => {
                ctx.ui.stopArmed = false;
                ctx.ui.stopArmTimer = null;
                ctx.rerender();
            }, 3000);
            ctx.rerender();
        },
        'danger',
        { disabled, dataAction: 'stop', ariaLabel: 'Stop this task' },
    );
};

export const surfaceDataAttr = (surface: ProductSurface): Record<string, string> => ({
    'data-rpa-product-surface': surface,
});