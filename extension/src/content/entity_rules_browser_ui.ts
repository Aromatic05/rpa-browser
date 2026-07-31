import type {
    EntityRuleEntityView,
    EntityRuleProfileSummary,
    EntityRuleProfileView,
    EntityRuleSelection,
} from '../../../shared/entity-rules-contract/index.js';
import type {Action} from '../shared/types.js';

export type EntityRulesBrowserUIOptions = {
    launchers: HTMLElement;
    surface: HTMLElement;
    before?: Node | null;
    pageUrl: () => string;
    sendAction: (type: string, payload?: Record<string, unknown>) => Promise<Action>;
    onCreate: () => void | Promise<void>;
    onEdit: (profileName: string) => void | Promise<void>;
    onPreview: (selection: EntityRuleSelection | null) => Promise<boolean>;
    onActiveChange?: (active: boolean) => void;
};

export type EntityRulesBrowserUIHandle = {
    setVisible: (visible: boolean) => void;
    refresh: () => Promise<void>;
    close: () => Promise<void>;
    unmount: () => void;
};

type BrowserPhase = 'closed' | 'list' | 'detail';

const KIND_LABELS: Record<string, string> = {
    form: '表单',
    table: '表格',
    dialog: '弹窗',
    list: '列表',
    panel: '区域',
    toolbar: '工具栏',
    kv: '详情信息',
};

export const mountEntityRulesBrowserUI = (
    options: EntityRulesBrowserUIOptions,
): EntityRulesBrowserUIHandle => {
    const style = document.createElement('style');
    style.textContent = `
      .rules-launch { height:38px; padding:0 14px; border:none; border-radius:999px; background:#0f766e; color:#fff; font-size:12px; font-weight:750; cursor:pointer; box-shadow:0 8px 20px rgba(15,118,110,.24); }
      .rules-launch:hover { background:#115e59; }
      .rules-browser { pointer-events:auto; position:fixed; right:16px; top:68px; z-index:2147483647; width:min(390px,calc(100vw - 24px)); max-height:calc(100vh - 84px); display:flex; flex-direction:column; border:1px solid rgba(148,163,184,.5); border-radius:14px; background:rgba(255,255,255,.99); color:#0f172a; box-shadow:0 18px 50px rgba(15,23,42,.26); overflow:hidden; }
      .rules-browser[hidden] { display:none; }
      .rules-browser header { display:flex; align-items:center; gap:8px; min-height:42px; padding:7px 8px 7px 12px; border-bottom:1px solid #e2e8f0; }
      .rules-browser header strong { flex:1; font-size:13px; }
      .rules-browser button { padding:6px 9px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#334155; font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif; cursor:pointer; }
      .rules-browser button.primary { border-color:#0f766e; background:#0f766e; color:#fff; }
      .rules-browser button.quiet { border-color:transparent; background:transparent; }
      .rules-browser button:disabled { opacity:.55; cursor:default; }
      .rules-body { padding:10px; overflow:auto; display:flex; flex-direction:column; gap:8px; }
      .rules-empty,.rules-error,.rules-note { padding:10px; border-radius:9px; background:#f8fafc; color:#64748b; font-size:12px; line-height:1.45; }
      .rules-error { background:#fff1f2; color:#9f1239; }
      .rule-card,.entity-card { display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid #e2e8f0; border-radius:10px; background:#fff; }
      .rule-card.current { border-color:#5eead4; background:#f0fdfa; }
      .rule-card.invalid { border-color:#fecdd3; background:#fff7f8; }
      .rule-card-head,.entity-card-head { display:flex; align-items:flex-start; gap:8px; }
      .rule-card-head strong,.entity-card-head strong { flex:1; font-size:13px; }
      .rule-meta { display:flex; flex-wrap:wrap; gap:5px; color:#64748b; font-size:11px; }
      .rule-badge { padding:2px 6px; border-radius:999px; background:#e2e8f0; color:#475569; }
      .rule-badge.current { background:#ccfbf1; color:#115e59; }
      .entity-items { display:flex; flex-wrap:wrap; gap:5px; }
      .entity-item { padding:3px 7px; border-radius:7px; background:#f1f5f9; color:#334155; font-size:11px; }
      .entity-card.selected { border-color:#2dd4bf; box-shadow:0 0 0 1px rgba(45,212,191,.18); }
      .rules-actions { display:flex; justify-content:flex-end; gap:7px; }
    `;
    options.surface.appendChild(style);

    const launcher = document.createElement('button');
    launcher.className = 'rules-launch';
    launcher.textContent = '规则';
    launcher.setAttribute('aria-label', '查看和编辑页面规则');
    launcher.setAttribute('data-rpa-rules-action', 'launch');
    options.launchers.insertBefore(launcher, options.before ?? null);

    const panel = document.createElement('section');
    panel.className = 'rules-browser';
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('data-rpa-snapshot-ignore', 'true');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.id = `rpa-rules-title-${crypto.randomUUID()}`;
    panel.setAttribute('aria-labelledby', title.id);
    const closeButton = button('×', 'quiet');
    closeButton.setAttribute('aria-label', '关闭规则');
    closeButton.setAttribute('data-rpa-rules-action', 'close');
    header.append(title, closeButton);
    const body = document.createElement('div');
    body.className = 'rules-body';
    panel.append(header, body);
    options.surface.appendChild(panel);

    let phase: BrowserPhase = 'closed';
    let rules: EntityRuleProfileSummary[] = [];
    let detail: EntityRuleProfileView | null = null;
    let selectedEntity: EntityRuleEntityView | null = null;
    let previewed: EntityRuleSelection | null = null;
    let busy = false;
    let error = '';
    let requestGeneration = 0;

    const setActive = (active: boolean): void => {
        phase = active ? (detail ? 'detail' : 'list') : 'closed';
        panel.hidden = !active;
        options.onActiveChange?.(active);
        if (active) {panel.focus({preventScroll: true});}
    };

    const clearPreview = async (): Promise<void> => {
        requestGeneration += 1;
        previewed = null;
        await options.onPreview(null);
    };

    const close = async (): Promise<void> => {
        await clearPreview();
        busy = false;
        error = '';
        detail = null;
        selectedEntity = null;
        setActive(false);
        render();
        if (!launcher.hidden) {launcher.focus({preventScroll: true});}
    };

    const run = async (
        type: string,
        payload?: Record<string, unknown>,
        generation = requestGeneration,
    ): Promise<Action | null> => {
        busy = true;
        error = '';
        render();
        try {
            const action = await options.sendAction(type, payload);
            if (generation !== requestGeneration) {return null;}
            if (action.type.endsWith('.failed')) {
                const response = isRecord(action.payload) ? action.payload : {};
                error = text(response.message) ?? text(response.error) ?? '操作失败';
                return null;
            }
            return action;
        } catch (reason) {
            if (generation !== requestGeneration) {return null;}
            error = reason instanceof Error ? reason.message : String(reason);
            return null;
        } finally {
            if (generation === requestGeneration) {
                busy = false;
                render();
            }
        }
    };

    const loadList = async (): Promise<void> => {
        if (previewed) {await clearPreview();}
        const generation = ++requestGeneration;
        detail = null;
        selectedEntity = null;
        const action = await run('entity_rules.list', {}, generation);
        if (!action || generation !== requestGeneration || phase === 'closed') {return;}
        const payload = isRecord(action.payload) ? action.payload : {};
        rules = readRules(payload.rules);
        phase = 'list';
        render();
    };

    const loadDetail = async (profileName: string): Promise<void> => {
        await clearPreview();
        const generation = ++requestGeneration;
        const action = await run('entity_rules.get', {profileName}, generation);
        if (!action || generation !== requestGeneration || phase === 'closed') {return;}
        const payload = isRecord(action.payload) ? action.payload : {};
        detail = readView(payload.view);
        if (!detail) {
            error = '规则详情格式无效';
            render();
            return;
        }
        selectedEntity = detail.entities.at(0) ?? null;
        phase = 'detail';
        render();
    };

    const togglePreview = async (): Promise<void> => {
        if (!selectedEntity) {return;}
        const selection = selectionOf(selectedEntity);
        if (sameSelection(previewed, selection)) {
            await clearPreview();
            render();
            return;
        }
        const generation = ++requestGeneration;
        busy = true;
        error = '';
        render();
        try {
            const opened = await options.onPreview(selection);
            if (generation !== requestGeneration || phase !== 'detail') {return;}
            if (!opened) {
                error = '无法在当前页面查看这条规则';
                previewed = null;
                return;
            }
            previewed = selection;
            panel.focus({preventScroll: true});
        } catch (reason) {
            if (generation !== requestGeneration) {return;}
            error = reason instanceof Error ? reason.message : String(reason);
            previewed = null;
        } finally {
            if (generation === requestGeneration) {
                busy = false;
                render();
            }
        }
    };

    const editCurrent = async (): Promise<void> => {
        if (!detail) {return;}
        const profileName = detail.profileName;
        await close();
        await options.onEdit(profileName);
    };

    const createRule = async (): Promise<void> => {
        await close();
        await options.onCreate();
    };

    const render = (): void => {
        title.textContent = phase === 'detail' ? (detail?.label ?? '规则详情') : '页面规则';
        body.replaceChildren();
        if (error) {
            const message = document.createElement('div');
            message.className = 'rules-error';
            message.textContent = error;
            body.appendChild(message);
        }
        if (phase === 'closed') {return;}
        if (phase === 'list') {
            const actions = document.createElement('div');
            actions.className = 'rules-actions';
            const refresh = button(busy ? '刷新中…' : '刷新');
            refresh.disabled = busy;
            refresh.setAttribute('data-rpa-rules-action', 'refresh');
            refresh.addEventListener('click', () => {void loadList();});
            const create = button('新建规则', 'primary');
            create.disabled = busy;
            create.setAttribute('data-rpa-rules-action', 'create');
            create.addEventListener('click', () => {void createRule();});
            actions.append(refresh, create);
            body.appendChild(actions);
            if (!busy && rules.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'rules-empty';
                empty.textContent = '当前工作流还没有页面规则。';
                body.appendChild(empty);
            }
            for (const rule of rules) {body.appendChild(renderRuleCard(rule));}
            return;
        }
        const back = button('← 返回规则列表', 'quiet');
        back.disabled = busy;
        back.setAttribute('data-rpa-rules-action', 'back');
        back.addEventListener('click', () => {
            void clearPreview().then(() => {
                detail = null;
                selectedEntity = null;
                phase = 'list';
                render();
            });
        });
        body.appendChild(back);
        if (!detail) {return;}
        const note = document.createElement('div');
        note.className = 'rules-note';
        note.textContent = detail.urlPattern
            ? `适用页面：${detail.urlPattern}`
            : '适用页面：未限制';
        body.appendChild(note);
        for (const entity of detail.entities) {body.appendChild(renderEntityCard(entity));}
        const actions = document.createElement('div');
        actions.className = 'rules-actions';
        const preview = button(sameSelection(previewed, selectedEntity ? selectionOf(selectedEntity) : null)
            ? '结束查看'
            : busy ? '打开中…' : '在页面查看');
        preview.disabled = busy || !selectedEntity;
        preview.setAttribute('data-rpa-rules-action', 'preview');
        preview.addEventListener('click', () => {void togglePreview();});
        const edit = button('编辑规则', 'primary');
        edit.disabled = busy;
        edit.setAttribute('data-rpa-rules-action', 'edit');
        edit.addEventListener('click', () => {void editCurrent();});
        actions.append(preview, edit);
        body.appendChild(actions);
    };

    const renderRuleCard = (rule: EntityRuleProfileSummary): HTMLElement => {
        const invalid = rule.status === 'invalid';
        const current = !invalid && matchesPage(rule, options.pageUrl());
        const card = document.createElement('article');
        card.className = `rule-card${current ? ' current' : ''}${invalid ? ' invalid' : ''}`;
        const head = document.createElement('div');
        head.className = 'rule-card-head';
        const name = document.createElement('strong');
        name.textContent = rule.label;
        const open = button('查看');
        open.disabled = busy || invalid;
        open.setAttribute('data-rpa-rules-action', 'open');
        open.addEventListener('click', () => {void loadDetail(rule.profileName);});
        head.append(name, open);
        const meta = document.createElement('div');
        meta.className = 'rule-meta';
        meta.append(
            badge(KIND_LABELS[rule.pageKind ?? ''] ?? '页面区域'),
            badge(`${String(rule.entityCount)} 个业务区域`),
        );
        if (invalid) {meta.appendChild(badge('无法读取'));}
        if (current) {meta.appendChild(badge('当前页面', true));}
        card.append(head, meta);
        if (invalid && rule.error) {
            const message = document.createElement('div');
            message.className = 'rules-error';
            message.textContent = rule.error;
            card.appendChild(message);
        }
        return card;
    };

    const renderEntityCard = (entity: EntityRuleEntityView): HTMLElement => {
        const selected = selectedEntity?.businessTag === entity.businessTag;
        const card = document.createElement('article');
        card.className = `entity-card${selected ? ' selected' : ''}`;
        const head = document.createElement('div');
        head.className = 'entity-card-head';
        const name = document.createElement('strong');
        name.textContent = entity.label;
        const choose = button(selected ? '已选择' : '选择');
        choose.disabled = busy || selected;
        choose.addEventListener('click', () => {
            void clearPreview().then(() => {
                selectedEntity = entity;
                render();
            });
        });
        head.append(name, choose);
        const meta = document.createElement('div');
        meta.className = 'rule-meta';
        meta.appendChild(badge(KIND_LABELS[entity.entityKind] ?? '页面区域'));
        const items = document.createElement('div');
        items.className = 'entity-items';
        const descriptions = [
            ...entity.fields.map((field) => `字段：${field.label}`),
            ...entity.actions.map((action) => `操作：${action.label}`),
            ...entity.rowActions.map((action) => `行操作：${action.label}`),
            ...entity.columns.map((column) => `列：${column.label}${column.primaryKey ? '（主键）' : ''}`),
            ...(entity.hasPagination ? ['分页'] : []),
        ];
        for (const description of descriptions) {
            const item = document.createElement('span');
            item.className = 'entity-item';
            item.textContent = description;
            items.appendChild(item);
        }
        if (descriptions.length === 0) {
            const item = document.createElement('span');
            item.className = 'entity-item';
            item.textContent = '仅标注业务区域';
            items.appendChild(item);
        }
        card.append(head, meta, items);
        return card;
    };

    launcher.addEventListener('click', () => {
        if (phase !== 'closed') {
            void close();
            return;
        }
        setActive(true);
        render();
        void loadList();
    });
    closeButton.addEventListener('click', () => {void close();});
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (phase === 'closed' || event.key !== 'Escape') {return;}
        event.preventDefault();
        event.stopImmediatePropagation();
        void close();
    };
    panel.ownerDocument.addEventListener('keydown', onDocumentKeyDown, true);
    render();

    return {
        setVisible: (visible) => {
            launcher.hidden = !visible;
            if (!visible && phase !== 'closed') {void close();}
        },
        refresh: async () => {
            if (phase === 'closed') {return;}
            await loadList();
        },
        close,
        unmount: () => {
            requestGeneration += 1;
            void options.onPreview(null);
            options.onActiveChange?.(false);
            panel.ownerDocument.removeEventListener('keydown', onDocumentKeyDown, true);
            launcher.remove();
            panel.remove();
            style.remove();
        },
    };
};

const button = (label: string, className = ''): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (className) {element.className = className;}
    return element;
};

const badge = (label: string, current = false): HTMLElement => {
    const element = document.createElement('span');
    element.className = `rule-badge${current ? ' current' : ''}`;
    element.textContent = label;
    return element;
};

const selectionOf = (entity: EntityRuleEntityView): EntityRuleSelection => ({
    profileName: entity.profileName,
    businessTag: entity.businessTag,
    entityKind: entity.entityKind,
});

const sameSelection = (
    left: EntityRuleSelection | null,
    right: EntityRuleSelection | null,
): boolean => {
    if (!left || !right) {return false;}
    return left.profileName === right.profileName
        && left.businessTag === right.businessTag
        && left.entityKind === right.entityKind;
};

const matchesPage = (rule: EntityRuleProfileSummary, pageUrl: string): boolean => {
    if (rule.status === 'invalid') {return false;}
    if (!rule.urlPattern) {return true;}
    try {
        return new RegExp(rule.urlPattern).test(pageUrl);
    } catch {
        return false;
    }
};

const readRules = (value: unknown): EntityRuleProfileSummary[] =>
    Array.isArray(value) ? value.filter(isRuleSummary) : [];

const readView = (value: unknown): EntityRuleProfileView | null =>
    isRuleView(value) ? value : null;

const isRuleSummary = (value: unknown): value is EntityRuleProfileSummary =>
    isRecord(value)
    && typeof value.profileName === 'string'
    && typeof value.label === 'string'
    && typeof value.entityCount === 'number'
    && (value.status === undefined || value.status === 'ready' || value.status === 'invalid')
    && (value.error === undefined || typeof value.error === 'string');

const isRuleView = (value: unknown): value is EntityRuleProfileView => {
    if (!isRecord(value) || !isRuleSummary(value)) {return false;}
    const entities = (value as EntityRuleProfileSummary & Record<string, unknown>).entities;
    return Array.isArray(entities) && entities.every(isRuleEntity);
};

const isRuleEntity = (value: unknown): value is EntityRuleEntityView =>
    isRecord(value)
    && typeof value.profileName === 'string'
    && typeof value.businessTag === 'string'
    && typeof value.entityKind === 'string'
    && typeof value.label === 'string'
    && Array.isArray(value.fields)
    && Array.isArray(value.actions)
    && Array.isArray(value.rowActions)
    && Array.isArray(value.columns)
    && typeof value.hasPagination === 'boolean';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
