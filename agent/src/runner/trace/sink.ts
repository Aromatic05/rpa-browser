/**
 * Trace Sink：用于存储/输出 trace 事件。
 * MemorySink 是必需实现；ConsoleSink 可选。
 */

import type { TraceEvent, TraceSink } from './types';

/**
 * MemorySink：将事件存入内存数组，便于测试与调试。
 */
export class MemorySink implements TraceSink {
    private readonly events: TraceEvent[] = [];

    write(event: TraceEvent) {
        this.events.push(event);
    }

    getEvents() {
        return [...this.events];
    }

    clear() {
        this.events.length = 0;
    }
}

/**
 * ConsoleSink：将事件打印到控制台。
 * 适合本地 demo/调试，不建议在生产环境默认启用。
 */
export class ConsoleSink implements TraceSink {
    write(event: TraceEvent) {
        // 控制台输出保持简洁，避免泄露敏感数据
        console.log('[trace]', event.type, event.op, event);
    }
}
