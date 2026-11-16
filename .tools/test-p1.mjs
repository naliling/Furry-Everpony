
const B = 'http://127.0.0.1:7799';
let RAN=0, PASS=0, FAIL=0, ERR=0;
const fails=[];
async function t(name, fn){
  RAN++;
  try { const ok = await fn(); if(ok){PASS++;console.log('PASS '+name);} else {FAIL++;fails.push(name);console.log('FAIL '+name);} }
  catch(e){ERR++;fails.push(name+': '+e.message);console.log('ERR  '+name+' :: '+e.message);}
}
const j = async (p, opt={}) => {
  const r = await fetch(B+p, { method: opt.method||'GET', headers: Object.assign({'content-type':'application/json'}, opt.token?{authorization:'Bearer '+opt.token}:{}), body: opt.body?JSON.stringify(opt.body):undefined });
  let data=null; try{ data = await r.json(); }catch{}
  return { status:r.status, data };
};

async function solveCaptcha(){
  const r = await fetch(B+'/api/captcha');
  const d = await r.json();
  const code = (String(d.svg||'').match(/>([0-9A-Z])<\/text>/g)||[]).map(x=>x.replace(/^>/,'').replace(/<\/text>$/,'')).join('');
  return { captchaId: d.id, captcha: code };
}

let token=null, botNumber='3881756500';
(async()=>{
  const email = 'p1test@example.com';
  const number = '3881756548';
  await t('匿名 /api/bots/public 200', async()=>{ const r=await j('/api/bots/public'); return r.status===200 && Array.isArray(r.data.bots); });
  await t('号码 7 位被拒 400', async()=>{ const r=await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email:'a1@example.com',number:'1234567',password:'pony20041014',nickname:'x'}}); return r.status===400; });
  await t('号码以 0 开头被拒 400', async()=>{ const r=await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email:'a2@example.com',number:'03881756548',password:'pony20041014',nickname:'x'}}); return r.status===400; });
  await t('邮箱格式错 400', async()=>{ const r=await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email:'not-an-email',number:'3881756548',password:'pony20041014',nickname:'x'}}); return r.status===400; });
  await t('注册成功（邮箱+11位号码）', async()=>{ const r=await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email,number,password:'pony20041014',nickname:'测试主号'}}); if(r.status!==200) throw new Error(JSON.stringify(r.data)); token=r.data.token; return !!token && r.data.account.email===email && r.data.account.number===number; });
  await t('重复邮箱 409', async()=>{ const r=await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email,number:'3881756549',password:'pony20041014',nickname:'y'}}); return r.status===409; });
  await t('重复号码 409', async()=>{ const r=await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email:'other@example.com',number,password:'pony20041014',nickname:'z'}}); return r.status===409; });
  await t('邮箱登录成功', async()=>{ const r=await j('/api/login',{method:'POST',body:{identifier:'P1Test@Example.com',password:'pony20041014'}}); return r.status===200 && !!r.data.token; });
  await t('号码登录成功', async()=>{ const r=await j('/api/login',{method:'POST',body:{identifier:number,password:'pony20041014'}}); return r.status===200 && !!r.data.token; });
  await t('错误密码 401', async()=>{ const r=await j('/api/login',{method:'POST',body:{identifier:email,password:'wrongpass123'}}); return r.status===401; });
  await t('/api/me 带 email 与 tags', async()=>{ const r=await j('/api/me',{token}); return r.status===200 && r.data.account.email===email && Array.isArray(r.data.account.tags); });
  await t('创建公开 Bot（带标签）', async()=>{ const r=await j('/api/bots',{method:'POST',token,body:{number:botNumber,nickname:'灵犀',bio:'陪你聊天',public:true,tags:['陪伴','中文','治愈']}}); if(r.status!==200) throw new Error(JSON.stringify(r.data)); return JSON.stringify(r.data.bot.tags)==='["陪伴","中文","治愈"]'; });
  await t('匿名广场能看到 Bot 与标签', async()=>{ const r=await j('/api/bots/public'); const b=(r.data.bots||[]).find(x=>x.number===botNumber); return !!b && b.tags.length===3 && b.isMine===false; });
  await t('匿名搜索标签能命中', async()=>{ const r=await j('/api/bots/public?q='+encodeURIComponent('治愈')); return (r.data.bots||[]).some(x=>x.number===botNumber); });
  await t('免加好友直接开私聊', async()=>{ const r=await j('/api/dm',{method:'POST',token,body:{number:botNumber}}); return r.status===200 && !!r.data.conversationId; });
  await t('标签超过 5 个被拒 400', async()=>{ const r=await j('/api/bots/'+botNumber,{method:'PATCH',token,body:{tags:['a','b','c','d','e','f']}}); return r.status===400; });
  await t('PATCH 标签生效', async()=>{ const r=await j('/api/bots/'+botNumber,{method:'PATCH',token,body:{tags:['陪伴','中文']}}); if(r.status!==200) throw new Error(JSON.stringify(r.data)); const s=await j('/api/bots/public'); const b=(s.data.bots||[]).find(x=>x.number===botNumber); return b && b.tags.length===2; });
  console.log('\nRAN='+RAN+' PASS='+PASS+' FAIL='+FAIL+' ERR='+ERR);
  if(fails.length) console.log('失败项: '+fails.join(' | '));
})();