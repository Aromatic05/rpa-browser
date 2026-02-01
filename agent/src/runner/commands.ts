/**
 * commands：定义 agent 支持的命令联合类型。
 *
 * 设计约束：
 * - cmd 字符串用于协议路由（extension/WS/MCP 等一致）
 * - tabToken 仅为内部绑定字段；外部 UI 推荐使用 workspaceId/tabId
 * - scope 可选，未提供时默认使用 active workspace/tab
 */
import type { A11yScanOptions } from './a11y_types';

/**
 * Target：当前仍使用 selector 直连 Locator 的最小结构。
 * 后续可扩展为语义定位/候选列表，但该层仅定义数据形态。
 */
export type Target = {
    selector: string;
    frame?: string;
};

/**
 * CommandScope：显式指定 workspace/tab；缺省时走 active scope。
 */
export type CommandScope = {
    workspaceId?: string;
    tabId?: string;
};

export type BaseCommand = {
    cmd: string;
    tabToken: string;
    scope?: CommandScope;
    args?: Record<string, unknown>;
    requestId?: string;
};

type CommandWithArgs<C extends string, A> = {
    cmd: C;
    tabToken: string;
    scope?: CommandScope;
    args: A;
    requestId?: string;
};

export type EnsureSessionCommand = CommandWithArgs<'ensureSession', { url?: string }>;
export type RecordStartCommand = CommandWithArgs<'record.start', Record<string, never>>;
export type RecordStopCommand = CommandWithArgs<'record.stop', Record<string, never>>;
export type RecordGetCommand = CommandWithArgs<'record.get', Record<string, never>>;
export type RecordClearCommand = CommandWithArgs<'record.clear', Record<string, never>>;
export type RecordReplayCommand = CommandWithArgs<'record.replay', { stopOnError?: boolean }>;
export type RecordStopReplayCommand = CommandWithArgs<'record.stopReplay', Record<string, never>>;
export type StepsRunCommand = CommandWithArgs<'steps.run', { steps: unknown[]; stopOnError?: boolean }>;

export type WorkspaceListCommand = CommandWithArgs<'workspace.list', Record<string, never>>;
export type WorkspaceCreateCommand = CommandWithArgs<
    'workspace.create',
    { startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }
>;
export type WorkspaceSetActiveCommand = CommandWithArgs<'workspace.setActive', { workspaceId: string }>;

export type TabListCommand = CommandWithArgs<'tab.list', { workspaceId?: string }>;
export type TabCreateCommand = CommandWithArgs<
    'tab.create',
    { workspaceId?: string; startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }
>;
export type TabCloseCommand = CommandWithArgs<'tab.close', { workspaceId?: string; tabId: string }>;
export type TabSetActiveCommand = CommandWithArgs<
    'tab.setActive',
    { workspaceId?: string; tabId: string }
>;

export type PageGotoCommand = CommandWithArgs<
    'page.goto',
    { url: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }
>;
export type PageBackCommand = CommandWithArgs<'page.back', Record<string, never>>;
export type PageForwardCommand = CommandWithArgs<'page.forward', Record<string, never>>;
export type PageReloadCommand = CommandWithArgs<
    'page.reload',
    { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }
>;
export type WaitForLoadStateCommand = CommandWithArgs<
    'wait.forLoadState',
    { state: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }
>;
export type WaitForURLCommand = CommandWithArgs<
    'wait.forURL',
    { urlOrPattern: string; timeout?: number }
>;

export type ElementClickCommand = CommandWithArgs<
    'element.click',
    { target: Target; options?: Record<string, unknown> }
>;
export type ElementDblClickCommand = CommandWithArgs<
    'element.dblclick',
    { target: Target; options?: Record<string, unknown> }
>;
export type ElementRightClickCommand = CommandWithArgs<
    'element.rightclick',
    { target: Target; options?: Record<string, unknown> }
>;
export type ElementHoverCommand = CommandWithArgs<
    'element.hover',
    { target: Target; options?: Record<string, unknown> }
>;

export type ElementFillCommand = CommandWithArgs<
    'element.fill',
    { target: Target; text: string; options?: Record<string, unknown> }
>;
export type ElementTypeCommand = CommandWithArgs<
    'element.type',
    { target: Target; text: string; options?: Record<string, unknown> }
>;
export type ElementClearCommand = CommandWithArgs<
    'element.clear',
    { target: Target; options?: Record<string, unknown> }
>;

export type ElementCheckCommand = CommandWithArgs<
    'element.check',
    { target: Target; options?: Record<string, unknown> }
>;
export type ElementUncheckCommand = CommandWithArgs<
    'element.uncheck',
    { target: Target; options?: Record<string, unknown> }
>;
export type ElementSetCheckedCommand = CommandWithArgs<
    'element.setChecked',
    { target: Target; checked: boolean; options?: Record<string, unknown> }
>;
export type ElementSelectRadioCommand = CommandWithArgs<
    'element.selectRadio',
    { target: Target; options?: Record<string, unknown> }
>;
export type ElementSelectOptionCommand = CommandWithArgs<
    'element.selectOption',
    {
        target: Target;
        value?: string;
        label?: string;
        index?: number;
        options?: Record<string, unknown>;
    }
>;

export type ElementSetDateCommand = CommandWithArgs<
    'element.setDate',
    {
        target: Target;
        value: string;
        mode?: 'auto' | 'input' | 'picker';
        options?: Record<string, unknown>;
    }
>;

export type PageScrollByCommand = CommandWithArgs<'page.scrollBy', { dx: number; dy: number }>;
export type PageScrollToCommand = CommandWithArgs<'page.scrollTo', { x: number; y: number }>;
export type ElementScrollIntoViewCommand = CommandWithArgs<
    'element.scrollIntoView',
    { target: Target; align?: 'center' | 'start' | 'end' | 'nearest' }
>;

export type PageOnDialogCommand = CommandWithArgs<
    'page.onDialog',
    { mode: 'accept' | 'dismiss'; promptText?: string; scope?: 'tab' | 'global' }
>;
export type PageHandleNextDialogCommand = CommandWithArgs<
    'page.handleNextDialog',
    { mode: 'accept' | 'dismiss'; promptText?: string }
>;
export type PageExpectPopupCommand = CommandWithArgs<
    'page.expectPopup',
    { action: Command; timeout?: number }
>;
export type PageClosePopupCommand = CommandWithArgs<'page.closePopup', { popupTabToken?: string }>;

export type ElementCopyCommand = CommandWithArgs<'element.copy', { target: Target }>;
export type ElementPasteCommand = CommandWithArgs<
    'element.paste',
    { target: Target; text?: string; options?: { allowSensitive?: boolean } }
>;
export type ClipboardWriteCommand = CommandWithArgs<'clipboard.write', { text: string }>;
export type ClipboardReadCommand = CommandWithArgs<'clipboard.read', Record<string, never>>;

export type KeyboardPressCommand = CommandWithArgs<'keyboard.press', { key: string }>;
export type KeyboardHotkeyCommand = CommandWithArgs<'keyboard.hotkey', { keys: string[] }>;
export type MouseDragAndDropCommand = CommandWithArgs<
    'mouse.dragAndDrop',
    { from: Target; to: Target }
>;
export type MouseWheelCommand = CommandWithArgs<'mouse.wheel', { dx: number; dy: number }>;

export type ElementSetFilesFromPathCommand = CommandWithArgs<
    'element.setFilesFromPath',
    { target: Target; paths: string[] }
>;
export type ElementSetFilesCommand = CommandWithArgs<
    'element.setFiles',
    { target: Target; files: Array<{ name: string; mime?: string; base64: string }> }
>;

export type WaitForSelectorCommand = CommandWithArgs<
    'wait.forSelector',
    { target: Target; state?: 'attached' | 'visible' | 'hidden' | 'detached'; timeout?: number }
>;
export type AssertTextCommand = CommandWithArgs<
    'assert.text',
    { target: Target; contains?: string; equals?: string }
>;
export type AssertCheckedCommand = CommandWithArgs<
    'assert.checked',
    { target: Target; value: boolean }
>;
export type AssertVisibleCommand = CommandWithArgs<
    'assert.visible',
    { target: Target; value: boolean }
>;

export type PageA11yScanCommand = CommandWithArgs<'page.a11yScan', A11yScanOptions>;

export type Command =
    | WorkspaceListCommand
    | WorkspaceCreateCommand
    | WorkspaceSetActiveCommand
    | TabListCommand
    | TabCreateCommand
    | TabCloseCommand
    | TabSetActiveCommand
    | EnsureSessionCommand
    | RecordStartCommand
    | RecordStopCommand
    | RecordGetCommand
    | RecordClearCommand
    | RecordReplayCommand
    | RecordStopReplayCommand
    | StepsRunCommand
    | PageGotoCommand
    | PageBackCommand
    | PageForwardCommand
    | PageReloadCommand
    | WaitForLoadStateCommand
    | WaitForURLCommand
    | ElementClickCommand
    | ElementDblClickCommand
    | ElementRightClickCommand
    | ElementHoverCommand
    | ElementFillCommand
    | ElementTypeCommand
    | ElementClearCommand
    | ElementCheckCommand
    | ElementUncheckCommand
    | ElementSetCheckedCommand
    | ElementSelectRadioCommand
    | ElementSelectOptionCommand
    | ElementSetDateCommand
    | PageScrollByCommand
    | PageScrollToCommand
    | ElementScrollIntoViewCommand
    | PageOnDialogCommand
    | PageHandleNextDialogCommand
    | PageExpectPopupCommand
    | PageClosePopupCommand
    | ElementCopyCommand
    | ElementPasteCommand
    | ClipboardWriteCommand
    | ClipboardReadCommand
    | KeyboardPressCommand
    | KeyboardHotkeyCommand
    | MouseDragAndDropCommand
    | MouseWheelCommand
    | ElementSetFilesFromPathCommand
    | ElementSetFilesCommand
    | WaitForSelectorCommand
    | AssertTextCommand
    | AssertCheckedCommand
    | AssertVisibleCommand
    | PageA11yScanCommand;
