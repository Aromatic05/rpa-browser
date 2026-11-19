/** Local, offline form for learning recording and replay without model credentials. */
export const PRACTICE_PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RPA 录制回放练习</title>
<style>body{font:16px/1.8 system-ui,sans-serif;background:#f5f7fb;color:#172033;margin:0}main{max-width:640px;margin:24px auto;padding:28px;background:white;border-radius:16px}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:8px;border:1px solid #ccd4dd;border-radius:6px}button{cursor:pointer}output{display:block;padding:16px;background:#e9f6ee;margin-top:20px}aside{color:#526171}@media(min-width:700px){main{margin-left:16px;margin-right:416px;max-width:640px;padding:20px}input{max-width:100%;box-sizing:border-box}}@media(max-width:699px){main{margin:16px}}</style></head>
<body><main><h1>让浏览器帮你再填一次</h1><p>这是本地练习，不会向外部网站提交数据，也不需要 API。</p>
<aside><ol><li>右侧已经打开录制引导？点击“开始录制”。如果没看到，点右边“RPA 助手”→“录制与回放”。</li><li>填写下面的表单并点击“提交练习”。</li><li>在面板点“停止并检查”，起个名字后点“保存录制”。</li><li>保存后会进入“我的录制”。点击下方“清空练习”，再点录制的“回放”，观察表单和结果自动恢复。</li></ol></aside>
<form id="practiceForm"><label for="practiceName">姓名 <input id="practiceName" name="name" required autocomplete="off" placeholder="例如：小明"></label>
<label for="practiceCategory">类别 <select id="practiceCategory" name="category"><option>学习</option><option>工作</option><option>生活</option></select></label>
<button type="submit">提交练习</button> <button type="reset">清空练习</button></form>
<output id="practiceResult" aria-live="polite">还未提交。录制后回放，看看这里会发生什么。</output>
<p>练习完成后，可在地址栏打开自己的目标网页，用同样的方式录制和回放。回放会执行你录下的操作，请先在测试数据上尝试。</p>
</main><script>
const form=document.getElementById('practiceForm');const result=document.getElementById('practiceResult');
form.addEventListener('submit',function(event){event.preventDefault();result.textContent='提交成功：'+document.getElementById('practiceName').value+' / '+document.getElementById('practiceCategory').value;});
form.addEventListener('reset',function(){result.textContent='已清空。现在可在“我的录制”点击“回放”，观察自动填写和提交。';});
</script></body></html>`;
