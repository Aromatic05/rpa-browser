/**
 * UI 日志封装：统一输出到面板日志区域。
 *
 * 约束：
 * - 只负责格式化与展示，不做业务逻辑。
 */

export const createUiLogger = (outEl: HTMLPreElement) => {
    const logPayload = (payload: unknown) => {
        outEl.textContent = JSON.stringify(payload, null, 2);
    };

    const logMessage = (message: string) => {
        logPayload({ ok: true, message });
    };

    return { logPayload, logMessage };
};
