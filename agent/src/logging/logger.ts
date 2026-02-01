/**
 * Logger：统一 action/record/trace/step 的输出策略。
 *
 * 设计目标：
 * - 统一前缀与输出格式，避免散落的 console.log
 * - 支持按类型控制“终端输出 / 文件输出”
 * - 文件输出为 JSONL，便于后续审计/解析
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RunnerConfig } from '../runner/config';

export type LogType = 'action' | 'record' | 'trace' | 'step';

type LogTarget = {
    consoleEnabled: boolean;
    fileEnabled: boolean;
    filePath: string;
};

let loggerConfig: RunnerConfig | null = null;
let runId = new Date().toISOString().replace(/[:.]/g, '-');
const streams = new Map<LogType, fs.WriteStream>();

export const resolveLogPath = (template: string) => {
    if (template.includes('{ts}')) return template.replace('{ts}', runId);
    const ext = path.extname(template);
    const base = ext ? template.slice(0, -ext.length) : template;
    return `${base}-${runId}${ext || '.log'}`;
};

const ensureStream = (type: LogType, filePath: string) => {
    if (streams.has(type)) return streams.get(type)!;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    streams.set(type, stream);
    return stream;
};

const getTarget = (type: LogType): LogTarget => {
    const obs = loggerConfig?.observability;
    if (!obs) {
        return { consoleEnabled: true, fileEnabled: false, filePath: '' };
    }
    if (type === 'action') {
        return {
            consoleEnabled: obs.actionConsoleEnabled,
            fileEnabled: obs.actionFileEnabled,
            filePath: resolveLogPath(obs.actionFilePath),
        };
    }
    if (type === 'record') {
        return {
            consoleEnabled: obs.recordConsoleEnabled,
            fileEnabled: obs.recordFileEnabled,
            filePath: resolveLogPath(obs.recordFilePath),
        };
    }
    if (type === 'trace') {
        return {
            consoleEnabled: obs.traceConsoleEnabled,
            fileEnabled: obs.traceFileEnabled,
            filePath: resolveLogPath(obs.traceFilePath),
        };
    }
    return { consoleEnabled: true, fileEnabled: false, filePath: '' };
};

export const initLogger = (config: RunnerConfig) => {
    loggerConfig = config;
};

export const getLogger = (type: LogType) => {
    return (...args: unknown[]) => {
        const target = getTarget(type);
        if (target.consoleEnabled) {
            console.log(`[${type}]`, ...args);
        }
        if (target.fileEnabled && target.filePath) {
            const stream = ensureStream(type, target.filePath);
            const payload = {
                ts: Date.now(),
                type,
                message: args,
            };
            stream.write(`${JSON.stringify(payload)}\n`);
        }
    };
};
