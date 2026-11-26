import {button, card, cardTitle, el, muted, sectionTitle, type SurfaceContext} from '../components/common.js';

export const renderGuideSurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    root.append(sectionTitle('从这里开始'));
    root.append(card([
        cardTitle('它能替你做什么？'),
        muted('把网页上的重复点击和填表录下来，以后再执行；也能用 AI 根据一句话尝试完成当前网页上的任务。'),
        muted('例如：每周到相同页面填写固定信息、进入固定菜单查询资料、重复一组筛选操作。录制会重做同一组操作和同样的输入值，不会自动生成新的业务数据。'),
    ]));
    root.append(card([
        cardTitle('在其他网站上怎么用'),
        el('ol', undefined, [
            el('li', undefined, ['在这个 RPA 浏览器的地址栏打开目标网站，或回到新标签页粘贴网址。']),
            el('li', undefined, ['需要登录的网站先自己登录，再进入要操作的具体页面。']),
            el('li', undefined, ['点击网页右侧的“RPA 助手”，选择“录制与回放”或“AI 帮我操作”。']),
            el('li', undefined, ['看不到入口？刷新网页。Chrome 设置页、扩展商店和浏览器内置 PDF 页面不支持网页助手；你平时单独打开的其他浏览器窗口也不会自动带上它。']),
        ]),
    ]));
    root.append(card([
        cardTitle('方式一：把固定操作录下来 · 无需 API'),
        muted('先进入流程起点 → 开始录制 → 自己操作网页 → 停止并检查 → 命名保存。随后在“我的录制”找到它，回到流程起点再回放。'),
        muted('效果：浏览器自动重复点击、输入和选择。录制开始前已做的操作不会补录；回放前应保持相同网站、登录状态和页面布局。'),
        button('去录制操作', () => {ctx.ui.teachKind = 'demonstration'; ctx.commands.openTeach();}, 'primary', {dataAction:'guide-record', disabled:ctx.view.reservation !== 'idle'}),
        button('查看我的录制', () => {ctx.commands.navigate('library');}, 'ghost', {dataAction:'guide-library'}),
    ]));
    root.append(card([
        cardTitle('方式二：用一句话让 AI 尝试完成 · 需要模型'),
        muted('在“开始”的 AI 输入框写清目标、数据和结束条件。例如：“把当前表单的姓名填为小明、类别选为工作，填完后停下，先不要提交。”'),
        muted('启动后到“任务”看进度和结果。页面要求你补充信息时在面板回答；也可暂停或停止。API 设置在新标签页，配置完成后返回目标网页。'),
        button('去 AI 任务输入框', () => {ctx.commands.navigate('home');}, 'ghost', {dataAction:'guide-ai'}),
    ]));
};
