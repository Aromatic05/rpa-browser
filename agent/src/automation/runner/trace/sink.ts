/**
 * Trace Sink：用于存储/输出 trace 事件。
 * MemorySink 是必需实现；ConsoleSink 可选。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TraceEvent, TraceSink } from './types';
import { getLogger } from '../../../platform/logging/logger';
import { createRedactionPolicy, type RedactionPolicy } from '../../../security/redaction';
import { redactTraceEvent } from './redact';

/**
 * MemorySink：将事件存入内存数组，便于测试与调试。
 */
export class MemorySink implements TraceSink {
    private readonly events: TraceEvent[] = [];
    private readonly policy: RedactionPolicy;

    constructor(redact?: RedactionPolicy) {
        this.policy = redact ?? createRedactionPolicy();
    }

    write(event: TraceEvent): void {
        this.events.push(redactTraceEvent(event, this.policy));
    }

    getEvents(): TraceEvent[] {
        return [...this.events];
    }

    clear(): void {
        this.events.length = 0;
    }
}

/**
 * ConsoleSink：将事件打印到控制台。
 * 适合本地 demo/调试，不建议在生产环境默认启用。
 */
export class ConsoleSink implements TraceSink {
    private readonly log = getLogger('trace');
    private readonly policy: RedactionPolicy;

    constructor(redact?: RedactionPolicy) {
        this.policy = redact ?? createRedactionPolicy();
    }

    write(event: TraceEvent): void {
        // 控制台输出保持简洁，避免泄露敏感数据
        this.log('[trace]', event.type, event.op, redactTraceEvent(event, this.policy));
    }
}

/**
 * FileSink：将 trace 事件写入文件（JSONL）。
 * - 每行一个事件，便于后续解析/回放/审计
 * - 由上层控制是否启用与输出路径
 */
export class FileSink implements TraceSink {
    private readonly stream: fs.WriteStream;
    private readonly policy: RedactionPolicy;

    constructor(filePath: string, redact?: RedactionPolicy) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.stream = fs.createWriteStream(filePath, { flags: 'a' });
        this.policy = redact ?? createRedactionPolicy();
    }

    write(event: TraceEvent): void {
        this.stream.write(`${JSON.stringify(redactTraceEvent(event, this.policy))}\n`);
    }

    close(): Promise<void> {
        return new Promise((resolve) => {
            this.stream.end(() => { resolve(); });
        });
    }
}
