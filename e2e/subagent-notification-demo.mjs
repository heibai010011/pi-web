import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
const base=process.env.E2E_BASE_URL || 'http://127.0.0.1:30141';
const output='test-results/subagent-demo';
mkdirSync(output,{recursive:true});
const executablePath=process.env.E2E_CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch(executablePath?{executablePath}:{});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const id='demo-subagent-receipts',cwd=process.cwd(),timestamp=new Date().toISOString();
 const info={id,path:'demo-only.jsonl',cwd,name:'子任务回执演示（模拟数据）',created:timestamp,modified:timestamp,messageCount:6,firstMessage:'检查登录流程',transient:false};
 const assistant=text=>({role:'assistant',content:[{type:'text',text}],timestamp:Date.now(),provider:'demo',model:'fixture',stopReason:'stop'});
 const notification=(description,result)=>({role:'custom',customType:'pi-web:subagent-notification',display:true,timestamp:Date.now(),content:result,details:{kind:'pi-web-subagent',sessionId:'demo-child',description,status:'completed'}});
 let failed=false;
 const messages=()=>[{role:'user',content:[{type:'text',text:'帮我检查登录流程的接口、前端状态和测试覆盖。（模拟演示，不调用模型）'}],timestamp:Date.now()},assistant('完整审查结论：这里是主 agent 在第一轮交付的详细答复，后续子任务通知不应把这段隐藏。'),notification('检查接口','接口检查完成。\n\n- 参数校验正常。\n- 失败响应缺少统一错误码。\n- 本次为静态检查，未运行真实请求。'),notification('检查前端状态','前端检查完成。重新提交前应清除旧错误提示。'),notification('检查测试覆盖','缺少超时与重试场景的测试。'),...(failed?[{role:'custom',customType:'pi-web:subagent-delivery-error',display:true,timestamp:Date.now(),content:'模拟故障：父模型启动失败。子任务结果已经保存，无需重复运行子任务。',details:{kind:'pi-web-subagent',sessionId:'demo-child',description:'汇总登录流程检查',status:'completed',error:'示例错误：父模型请求暂时不可用'}}]:[assistant('### 主 agent 汇总（模拟内容）\n\n三个方向建议分别处理：**统一接口错误码、清除前端旧提示、补齐异常路径测试**。\n\n本次仅完成静态检查，未修改代码，也未执行真实登录验证。')])];
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),p=url.pathname;
  if(p==='/api/sessions')return route.fulfill({json:{sessions:[info],sessionListVersion:1,runningSessionIds:[],completionNotificationSuppressedSessionIds:[]}});
  if(p===`/api/sessions/${id}`){const m=messages();return route.fulfill({json:{sessionId:id,filePath:info.path,info,leafId:'e5',tree:[],context:{messages:m,entryIds:m.map((_,i)=>`e${i}`),hasMore:false,model:null,thinkingLevel:'off'},stats:{tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},cost:0,totalMessages:m.length},totalActiveMs:0}})}
  if(p.startsWith('/api/agent/'))return route.fulfill({json:p.endsWith('/running')?{runningSessionIds:[]}:{isStreaming:false,isCompacting:false}});
  // Keep all writes confined to the browser fixture, never create/modify real sessions.
  if(route.request().method()!=='GET')return route.fulfill({json:{ok:true}});
  return route.continue();
 });
 await page.goto(`${base}/?session=${id}`,{waitUntil:'domcontentloaded'});
 // Explicit fresh reload avoids stale development module graphs.
 await page.reload({waitUntil:'domcontentloaded'});
 const receipts=page.locator('details').filter({has:page.locator('summary', {hasText:'检查接口'})});
 try { await receipts.waitFor({timeout:30000}); } catch(error) { console.log('PAGE', (await page.locator('body').innerText()).slice(0,12000)); console.log('ERRORS',errors); await page.screenshot({path:`${output}/debug.png`,fullPage:true}); throw error; }
 assert.equal(await receipts.getAttribute('open'),null);
 assert.equal(await page.getByText('完整审查结论：这里是主 agent 在第一轮交付的详细答复，后续子任务通知不应把这段隐藏。',{exact:true}).isVisible(),true);
 await page.screenshot({path:`${output}/01-collapsed.png`,fullPage:true});
 await receipts.locator('summary').click();
 assert.notEqual(await receipts.getAttribute('open'),null);
 await page.getByText('失败响应缺少统一错误码。',{exact:false}).waitFor();
 await page.screenshot({path:`${output}/02-expanded.png`,fullPage:true});
 failed=true;
 await page.reload({waitUntil:'domcontentloaded'});
 const failure=page.locator('details[open]').filter({hasText:'汇总登录流程检查'});
 await failure.waitFor();
 await page.screenshot({path:`${output}/03-continuation-error.png`,fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));
 console.log('PASS: real Pi Web browser component; collapsed, click-expanded, delivery-error states; no page errors. Fixture only, no model calls or persisted sessions.');
}finally{await browser.close()}
