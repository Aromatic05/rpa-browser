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
import type { RunnerConfig } from '../config';

export type LogType = 'action' | 'record' | 'trace' | 'step' | 'entity';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type Logger = ((...args: unknown[]) => void) & {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warning: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

type LogTarget = {
    consoleEnabled: boolean;
    fileEnabled: boolean;
    filePath: string;
    minLevel: LogLevel;
};

let loggerConfig: RunnerConfig | null = null;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const streams = new Map<LogType, fs.WriteStream>();

export const resolveLogPath = (template: string): string => {
    if (template.includes('{ts}')) {return template.replace('{ts}', runId);}
    const ext = path.extname(template);
    const base = ext ? template.slice(0, -ext.length) : template;
    return `${base}-${runId}${ext || '.log'}`;
};

const ensureStream = (type: LogType, filePath: string) => {
    if (streams.has(type)) {return streams.get(type)!;}
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
        return { consoleEnabled: false, fileEnabled: false, filePath: '', minLevel: 'warning' };
    }
    if (type === 'action') {
        return {
            consoleEnabled: obs.actionConsoleEnabled,
            fileEnabled: obs.actionFileEnabled,
            filePath: resolveLogPath(obs.actionFilePath),
            minLevel: obs.actionLogLevel,
        };
    }
    if (type === 'record') {
        return {
            consoleEnabled: obs.recordConsoleEnabled,
            fileEnabled: obs.recordFileEnabled,
            filePath: resolveLogPath(obs.recordFilePath),
            minLevel: obs.recordLogLevel,
        };
    }
    if (type === 'trace') {
        return {
            consoleEnabled: obs.traceConsoleEnabled,
            fileEnabled: obs.traceFileEnabled,
            filePath: resolveLogPath(obs.traceFilePath),
            minLevel: obs.traceLogLevel,
        };
    }
    if (type === 'entity') {
        return {
            consoleEnabled: obs.traceConsoleEnabled,
            fileEnabled: obs.traceFileEnabled,
            filePath: resolveLogPath(obs.traceFilePath),
            minLevel: obs.traceLogLevel,
        };
    }
    return {
        consoleEnabled: false,
        fileEnabled: false,
        filePath: '',
        minLevel: obs.stepLogLevel,
    };
};

export const initLogger = (config: RunnerConfig): void => {
    loggerConfig = config;
};

const emit = (type: LogType, level: LogLevel, args: unknown[]) => {
    const target = getTarget(type);
    const levelRank = { debug: 10, info: 20, warning: 30, error: 40 } as const;
    if (levelRank[level] < levelRank[target.minLevel]) {
        return;
    }
    if (target.consoleEnabled) {
        if (level === 'error') {
            console.error(`[${type}]`, ...args);
        } else if (level === 'warning') {
            console.warn(`[${type}]`, ...args);
        } else {
            console.warn(`[${type}][${level}]`, ...args);
        }
    }
    if (target.fileEnabled && target.filePath) {
        const stream = ensureStream(type, target.filePath);
        const payload = {
            ts: Date.now(),
            type,
            level,
            message: args,
        };
        stream.write(`${JSON.stringify(payload)}\n`);
    }
};

export const getLogger = (type: LogType): Logger => {
    const logger = ((...args: unknown[]) => {
        emit(type, 'info', args);
    }) as Logger;
    logger.debug = (...args: unknown[]) => {
        emit(type, 'debug', args);
    };
    logger.info = (...args: unknown[]) => {
        emit(type, 'info', args);
    };
    logger.warning = (...args: unknown[]) => {
        emit(type, 'warning', args);
    };
    logger.warn = (...args: unknown[]) => {
        emit(type, 'warning', args);
    };
    logger.error = (...args: unknown[]) => {
        emit(type, 'error', args);
    };
    return logger;
};
