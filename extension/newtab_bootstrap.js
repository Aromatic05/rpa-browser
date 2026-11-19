// Classic script also runs in a local HTML preview, where extension modules cannot run.
(() => {
    const notice = document.getElementById('runtimeNotice');
    if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.runtime?.id) {
        if (notice) {
            notice.hidden = false;
            notice.textContent = '这里是普通浏览器中的首页预览，无法录制或控制网页。请双击项目文件夹中的“启动RPA.cmd”（或运行 pnpm start），然后在新弹出的 RPA 浏览器里粘贴网址。日常使用的 Edge 窗口不会自动安装助手。';
        }
        document.querySelectorAll('button, input, select').forEach((control) => {control.disabled = true;});
        return;
    }
    import('./start/newtab.js').then(() => {
        if (notice) {notice.hidden = true;}
    }).catch(() => {
        if (notice) {
            notice.hidden = false;
            notice.textContent = '首页脚本加载失败。请关闭 RPA 程序，运行 pnpm build:product，再通过 pnpm start 重新打开。';
        }
    });
})();
