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

const PWD = 'pony20041014';
let adminTok=null, userTok=null, userNumber='3881000002', adminNumber='3881000001';
(async()=>{
  await t('第一个注册者自动成为管理员', async()=>{
    const r = await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email:'adm@example.com',number:adminNumber,password:PWD,nickname:'站长'}});
    if(r.status!==200) throw new Error(JSON.stringify(r.data));
    adminTok = r.data.token;
    return r.data.account.is_admin === true;
  });
  await t('第二个注册者是普通用户', async()=>{
    const r = await j('/api/register',{method:'POST',body:{...(await solveCaptcha()),email:'u@example.com',number:userNumber,password:PWD,nickname:'路人'}});
    if(r.status!==200) throw new Error(JSON.stringify(r.data));
    userTok = r.data.token;
    return r.data.account.is_admin === false;
  });
  await t('匿名 /api/admin/overview 401', async()=>{ const r=await j('/api/admin/overview'); return r.status===401; });
  await t('普通用户 /api/admin/overview 403', async()=>{ const r=await j('/api/admin/overview',{token:userTok}); return r.status===403; });
  await t('管理员 /api/admin/overview 200 且有统计', async()=>{
    const r=await j('/api/admin/overview',{token:adminTok});
    return r.status===200 && r.data.counts && r.data.counts.accounts>=2 && typeof r.data.dbBytes==='number' && typeof r.data.uptimeSec==='number';
  });
  await t('管理员账号列表 200', async()=>{ const r=await j('/api/admin/accounts',{token:adminTok}); return r.status===200 && Array.isArray(r.data.accounts) && r.data.accounts.length>=2; });
  await t('账号搜索命中', async()=>{ const r=await j('/api/admin/accounts?q='+userNumber,{token:adminTok}); return (r.data.accounts||[]).some(a=>a.number===userNumber); });
  await t('筛选 banned 可用', async()=>{ const r=await j('/api/admin/accounts?filter=banned',{token:adminTok}); return r.status===200 && Array.isArray(r.data.accounts); });
  await t('不能封禁自己 400', async()=>{ const r=await j('/api/admin/accounts/'+adminNumber+'/ban',{method:'POST',token:adminTok,body:{banned:true,reason:'test'}}); return r.status===400; });
  await t('封禁普通用户 200', async()=>{ const r=await j('/api/admin/accounts/'+userNumber+'/ban',{method:'POST',token:adminTok,body:{banned:true,reason:'测试封禁'}}); return r.status===200; });
  await t('被封禁账号登录 403', async()=>{ const r=await j('/api/login',{method:'POST',body:{identifier:userNumber,password:PWD}}); return r.status===403; });
  await t('被封禁账号旧 token 失效 401', async()=>{ const r=await j('/api/me',{token:userTok}); return r.status===401; });
  await t('解封 200', async()=>{ const r=await j('/api/admin/accounts/'+userNumber+'/ban',{method:'POST',token:adminTok,body:{banned:false}}); return r.status===200; });
  await t('解封后能重新登录', async()=>{ const r=await j('/api/login',{method:'POST',body:{identifier:userNumber,password:PWD}}); if(r.status!==200) return false; userTok=r.data.token; return !!userTok; });
  await t('设普通用户为管理员 200', async()=>{ const r=await j('/api/admin/accounts/'+userNumber+'/admin',{method:'POST',token:adminTok,body:{admin:true}}); return r.status===200; });
  await t('被授权者现在能进管理台', async()=>{ const r=await j('/api/admin/overview',{token:userTok}); return r.status===200; });
  await t('取消管理员 200', async()=>{ const r=await j('/api/admin/accounts/'+userNumber+'/admin',{method:'POST',token:adminTok,body:{admin:false}}); return r.status===200; });
  await t('取消后又被拒 403', async()=>{ const r=await j('/api/admin/overview',{token:userTok}); return r.status===403; });
  await t('管理员 Bot 列表 200', async()=>{ const r=await j('/api/admin/bots',{token:adminTok}); return r.status===200 && Array.isArray(r.data.bots); });
  await t('管理员消息列表 200', async()=>{ const r=await j('/api/admin/messages',{token:adminTok}); return r.status===200 && Array.isArray(r.data.messages); });
  await t('普通用户看消息列表 403', async()=>{ const r=await j('/api/admin/messages',{token:userTok}); return r.status===403; });
  await t('/api/server-info 有 lan 与 tunnel 字段', async()=>{
    const r=await j('/api/server-info',{token:adminTok});
    return r.status===200 && Array.isArray(r.data.lan) && typeof r.data.tunnel==='string' && r.data.port===7799;
  });
  await t('/api/me 返回 is_admin', async()=>{ const r=await j('/api/me',{token:adminTok}); return r.status===200 && r.data.account.is_admin===true; });
  await t('删除消息接口鉴权 403', async()=>{ const r=await j('/api/admin/messages/1',{method:'DELETE',token:userTok}); return r.status===403; });
  console.log('\nRAN='+RAN+' PASS='+PASS+' FAIL='+FAIL+' ERR='+ERR);
  if(fails.length) console.log('失败项: '+fails.join(' | '));
})();
