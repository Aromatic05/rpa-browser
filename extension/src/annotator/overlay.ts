import type {
    AnnotatorOverlayPort,
    AnnotatorPoint,
    AnnotatorProjection,
    AnnotatorTarget,
} from './contracts.js';

const ROOT_ID = 'rpa-annotator-overlay';
const PICK_SURFACE_ID = 'rpa-annotator-pick-surface';

export type CreateAnnotatorOverlayInput = {
    document: Document;
    onPick: (point: AnnotatorPoint) => void | Promise<void>;
};

export const createAnnotatorOverlay = (input: CreateAnnotatorOverlayInput): AnnotatorOverlayPort => {
    let root: HTMLDivElement | null = null;
    let pickSurface: HTMLDivElement | null = null;

    const ensureRoot = (): HTMLDivElement => {
        if (root?.isConnected) {return root;}
        input.document.getElementById(ROOT_ID)?.remove();
        root = input.document.createElement('div');
        root.id = ROOT_ID;
        root.setAttribute('data-rpa-snapshot-ignore', 'true');
        Object.assign(root.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '2147483645',
            pointerEvents: 'none',
            overflow: 'hidden',
        });
        input.document.documentElement.appendChild(root);
        return root;
    };

    const render = (projection: AnnotatorProjection): void => {
        const host = ensureRoot();
        host.replaceChildren();
        host.setAttribute('data-page-epoch', projection.identity.pageEpoch);
        host.setAttribute('data-capture-revision', String(projection.identity.captureRevision));
        for (const target of projection.targets) {
            renderTarget(input.document, host, target);
        }
    };

    const stopPicking = (): void => {
        pickSurface?.remove();
        pickSurface = null;
    };

    const startPicking = (): void => {
        stopPicking();
        pickSurface = input.document.createElement('div');
        pickSurface.id = PICK_SURFACE_ID;
        pickSurface.setAttribute('data-rpa-snapshot-ignore', 'true');
        Object.assign(pickSurface.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '2147483646',
            cursor: 'crosshair',
            background: 'transparent',
        });
        pickSurface.addEventListener('click', (event: MouseEvent) => {
            const point = {x: event.clientX, y: event.clientY};
            stopPicking();
            void input.onPick(point);
        }, {once: true, capture: true});
        input.document.documentElement.appendChild(pickSurface);
    };

    const dispose = (): void => {
        stopPicking();
        root?.remove();
        root = null;
    };

    return {render, startPicking, stopPicking, dispose};
};

const renderTarget = (
    document: Document,
    root: HTMLDivElement,
    target: AnnotatorTarget,
): void => {
    target.geometry.forEach((rect, index) => {
        const box = document.createElement('div');
        box.setAttribute('data-annotator-target-id', target.id);
        box.setAttribute('data-annotator-target-kind', target.kind);
        box.setAttribute('data-annotator-fragment-index', String(index));
        Object.assign(box.style, {
            position: 'absolute',
            left: `${String(rect.x)}px`,
            top: `${String(rect.y)}px`,
            width: `${String(rect.width)}px`,
            height: `${String(rect.height)}px`,
            boxSizing: 'border-box',
            border: targetBorder(target),
            background: target.kind === 'selection-scope' ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
            pointerEvents: 'none',
        });
        if (target.label) {
            const label = document.createElement('span');
            label.textContent = target.label;
            Object.assign(label.style, {
                position: 'absolute',
                left: '0',
                top: '-18px',
                maxWidth: '240px',
                padding: '2px 5px',
                borderRadius: '3px',
                background: 'rgba(15, 23, 42, 0.92)',
                color: '#f8fafc',
                font: '11px/14px ui-sans-serif, system-ui, sans-serif',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
            });
            box.appendChild(label);
        }
        root.appendChild(box);
    });
};

const targetBorder = (target: AnnotatorTarget): string => {
    if (target.kind === 'selection-scope') {return '2px solid #2563eb';}
    if (target.kind === 'structural-root') {return '2px dashed #7c3aed';}
    if (target.kind === 'host') {return '2px dotted #ea580c';}
    if (target.kind === 'semantic-binding') {return '2px solid #16a34a';}
    return '1px solid rgba(14, 116, 144, 0.9)';
};
