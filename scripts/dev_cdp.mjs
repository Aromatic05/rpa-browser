if (!process.argv.some((arg) => arg.startsWith('--mode='))) {
    process.argv.push('--mode=cdp');
}
await import('./dev_runtime.mjs');
