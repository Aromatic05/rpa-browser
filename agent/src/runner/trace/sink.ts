/**
 * Trace Sink：用于存储/输出 trace 事件。
 * MemorySink 是必需实现；ConsoleSink 可选。
 */

import fs from 'node:fs';
import path from 'node:path';
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

/**
 * FileSink：将 trace 事件写入文件（JSONL）。
 * - 每行一个事件，便于后续解析/回放/审计
 * - 由上层控制是否启用与输出路径
 */
export class FileSink implements TraceSink {
    private readonly stream: fs.WriteStream;

    constructor(filePath: string) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    }

    write(event: TraceEvent) {
        this.stream.write(`${JSON.stringify(event)}\n`);
    }
}
