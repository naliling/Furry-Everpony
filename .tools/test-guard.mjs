const B = 'http://127.0.0.1:7799';
let RAN=0, PASS=0, FAIL=0, ERR=0;
const fails=[];
async function t(name, fn){
  RAN++;
  try { const ok = await fn(); if(ok){PASS++;console.log('PASS '+name);} else {FAIL++;fails.push(name);console.log('FAIL '+name);} }
  catch(e){ERR++;fails.push(name+': '+e.message);console.log('ERR  '+name+' :: '+e.message);}
}
const j = async (p, opt={}) => {
  const headers = Object.assign({'content-type':'application/json'}, opt.token?{authorization:'Bearer '+opt.token}:{});
  if (opt.ip) headers['x-forwarded-for'] = opt.ip;
  const r = await fetch(B+p, { method: opt.method||'GET', headers, body: opt.body?JSON.stringify(opt.body):undefined });
  let data=null; try{ data = await r.json(); }catch{}
  return { status:r.status, data };
};
async function grab(){
  const r = await fetch(B+'/api/captcha');
  const d = await r.json();
  const code = (String(d.svg||'').match(/>([0-9A-Z])<\/text>/g)||[]).map(x=>x.replace(/^>/,'').replace(/<\/text>$/,'')).join('');
  return { id: d.id, code };
}
const PWD='pony20041014';
async function register(number, nickname, email){
  const c = await grab();
  return j('/api/register',{method:'POST',body:{email,number,nickname,password:PWD,captchaId:c.id,captcha:c.code}});
}
let adminToken=null, userToken=null;

(async()=>{
  await t('空库首注册者直接成为管理员且免审核', async()=>{
    const r = await register('3889000001','站长','adm@example.com');
    adminToken = r.data && r.data.token;
    return r.status===200 && !!adminToken && r.data.account.is_admin===true && r.data.pending!==true;
  });

  await t('默认注册模式是 approval', async()=>{
    const r = await j('/api/admin/settings',{token:adminToken});
    return r.status===200 && r.data.registerMode==='approval';
  });

  await t('新注册默认进待审核（不发 token）', async()=>{
    const r = await register('3889000002','待审','u2@example.com');
    return r.status===200 && r.data.pending===true && !r.data.token;
  });

  await t('待审核账号登录被拒 403', async()=>{
    const r = await j('/api/login',{method:'POST',body:{identifier:'3889000002',password:PWD}});
    return r.status===403 && /审核/.test(r.data.error||'');
  });

  await t('管理员能看到待审核列表（含 IP 与设备）', async()=>{
    const r = await j('/api/admin/pending',{token:adminToken});
    const row = (r.data.pending||[])[0];
    return r.status===200 && r.data.pending.length===1 && row.number==='3889000002' && typeof row.ip==='string' && row.ip.length>0;
  });

  await t('审核通过后可以登录', async()=>{
    const a = await j('/api/admin/accounts/3889000002/approve',{method:'POST',token:adminToken,body:{approve:true}});
    if (a.status!==200) return false;
    const r = await j('/api/login',{method:'POST',body:{identifier:'3889000002',password:PWD}});
    userToken = r.data && r.data.token;
    return r.status===200 && !!userToken;
  });

  await t('普通用户访问管理接口被拒 403', async()=>{
    const r = await j('/api/admin/overview',{token:userToken});
    return r.status===403;
  });

  await t('不带 token 访问管理接口 401', async()=>{
    const r = await j('/api/admin/overview');
    return r.status===401;
  });

  await t('我的登录设备带 IP 与设备名', async()=>{
    const r = await j('/api/me/sessions',{token:userToken});
    const one = (r.data.sessions||[])[0];
    return r.status===200 && r.data.sessions.length>=1 && typeof one.device==='string' && one.device.length>0 && typeof one.ip==='string' && one.current===true;
  });

  await t('管理员能看到登录记录（含昵称与成败）', async()=>{
    const r = await j('/api/admin/logins?limit=50',{token:adminToken});
    const rows = r.data.logins||[];
    const one = rows[0];
    return r.status===200 && rows.length>0 && typeof one.ok==='boolean' && typeof one.nickname==='string' && one.nickname.length>0;
  });

  await t('只看失败过滤生效', async()=>{
    const r = await j('/api/admin/logins?only=fail&limit=50',{token:adminToken});
    const rows = r.data.logins||[];
    return r.status===200 && rows.every((x)=>x.ok===false);
  });

  await t('注册模式改 open 后新号直接可用', async()=>{
    const s = await j('/api/admin/settings',{method:'PATCH',token:adminToken,body:{registerMode:'open'}});
    if (s.status!==200) return false;
    const r = await register('3889000003','开放','u3@example.com');
    return r.status===200 && !!r.data.token;
  });

  await t('注册模式只认三个值（非法值 400）', async()=>{
    const r = await j('/api/admin/settings',{method:'PATCH',token:adminToken,body:{registerMode:'whatever'}});
    return r.status===400;
  });

  await t('注册模式改 closed 后注册被拒 403', async()=>{
    await j('/api/admin/settings',{method:'PATCH',token:adminToken,body:{registerMode:'closed'}});
    const r = await register('3889000004','关门','u4@example.com');
    await j('/api/admin/settings',{method:'PATCH',token:adminToken,body:{registerMode:'approval'}});
    return r.status===403 && /关闭注册/.test(r.data.error||'');
  });

  await t('拒绝审核会把这个账号删掉', async()=>{
    await register('3889000005','要被拒','u5@example.com');
    const a = await j('/api/admin/accounts/3889000005/approve',{method:'POST',token:adminToken,body:{approve:false}});
    const login = await j('/api/login',{method:'POST',body:{identifier:'3889000005',password:PWD}});
    return a.status===200 && a.data.deleted===true && (login.status===401||login.status===404);
  });

  await t('封禁 IP 后该 IP 被挡在门口 403', async()=>{
    const fake='203.0.113.9';
    const add = await j('/api/admin/ip-bans',{method:'POST',token:adminToken,body:{ip:fake,reason:'测试'}});
    if (add.status!==200) return false;
    const blocked = await j('/api/health',{ip:fake});
    const ok = await j('/api/health');
    const list = await j('/api/admin/ip-bans',{token:adminToken});
    return blocked.status===403 && ok.status===200 && (list.data.bans||[]).some((b)=>b.ip===fake);
  });

  await t('解封 IP 后恢复访问', async()=>{
    const fake='203.0.113.9';
    const del = await j('/api/admin/ip-bans/'+fake,{method:'DELETE',token:adminToken});
    const back = await j('/api/health',{ip:fake});
    return del.status===200 && back.status===200;
  });

  await t('普通用户不能封 IP（403）', async()=>{
    const r = await j('/api/admin/ip-bans',{method:'POST',token:userToken,body:{ip:'203.0.113.10'}});
    return r.status===403;
  });

  await t('撞库限流：同账号错 5 次后 429', async()=>{
    let last=null;
    for (let i=0;i<6;i++){
      last = await j('/api/login',{method:'POST',body:{identifier:'3889000003',password:'wrong-pass-'+i}});
    }
    return last.status===429;
  });

  await t('被封账号登录提示已封禁', async()=>{
    await j('/api/admin/accounts/3889000002/ban',{method:'POST',token:adminToken,body:{banned:true,reason:'测试封禁'}});
    const r = await j('/api/login',{method:'POST',body:{identifier:'3889000002',password:PWD}});
    await j('/api/admin/accounts/3889000002/ban',{method:'POST',token:adminToken,body:{banned:false,reason:''}});
    return r.status===403 && /封禁/.test(r.data.error||'');
  });

  console.log('\nRAN='+RAN+' PASS='+PASS+' FAIL='+FAIL+' ERR='+ERR);
  if (fails.length) console.log('失败项：\n - '+fails.join('\n - '));
  process.exit(FAIL+ERR?1:0);
})();
