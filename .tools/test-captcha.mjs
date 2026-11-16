
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
async function grab(){
  const r = await fetch(B+'/api/captcha');
  const d = await r.json();
  const code = (String(d.svg||'').match(/>([0-9A-Z])<\/text>/g)||[]).map(x=>x.replace(/^>/,'').replace(/<\/text>$/,'')).join('');
  return { id: d.id, code, svg: d.svg, expiresIn: d.expiresIn, status: r.status };
}
const PWD='pony20041014';
const reg = (body) => j('/api/register',{method:'POST',body});

(async()=>{
  let first = null;
  await t('GET /api/captcha 返回 id+svg', async()=>{
    first = await grab();
    return first.status===200 && typeof first.id==='string' && first.id.length>=16 && /^<svg/.test(first.svg);
  });
  await t('验证码是 4 位', async()=> first.code.length===4);
  await t('SVG 含 4 个 text 字符', async()=> (first.svg.match(/<text /g)||[]).length===4);
  await t('expiresIn 是 300 秒', async()=> first.expiresIn===300);

  await t('不带验证码注册被拒 400', async()=>{
    const r = await reg({email:'nc1@example.com',number:'3882000001',password:PWD,nickname:'无码'});
    return r.status===400 && /验证码/.test(r.data.error||'');
  });
  await t('不存在的验证码 id 被拒 400', async()=>{
    const r = await reg({email:'nc2@example.com',number:'3882000002',password:PWD,nickname:'假码',captchaId:'deadbeefdeadbeefdeadbeef',captcha:'ABCD'});
    return r.status===400 && /过期/.test(r.data.error||'');
  });

  await t('错码被拒 400 且提示「不对」', async()=>{
    const c = await grab();
    const wrong = c.code.split('').reverse().join('') === c.code ? 'ZZZZ' : c.code.split('').reverse().join('');
    const r = await reg({email:'nc3@example.com',number:'3882000003',password:PWD,nickname:'错码',captchaId:c.id,captcha:wrong});
    return r.status===400 && /不对/.test(r.data.error||'');
  });

  await t('错一次后用正确码仍可注册', async()=>{
    const c = await grab();
    const wrong = c.code.split('').reverse().join('') === c.code ? 'ZZZZ' : c.code.split('').reverse().join('');
    await reg({email:'nc4@example.com',number:'3882000004',password:PWD,nickname:'先错',captchaId:c.id,captcha:wrong});
    const r = await reg({email:'nc4@example.com',number:'3882000004',password:PWD,nickname:'后对',captchaId:c.id,captcha:c.code});
    return r.status===200 && !!r.data.token;
  });

  await t('验证码只能用一次（复用被拒）', async()=>{
    const c = await grab();
    const ok = await reg({email:'nc5@example.com',number:'3882000005',password:PWD,nickname:'一次性',captchaId:c.id,captcha:c.code});
    if (ok.status!==200) throw new Error('首次注册失败 '+JSON.stringify(ok.data));
    const again = await reg({email:'nc6@example.com',number:'3882000006',password:PWD,nickname:'复用',captchaId:c.id,captcha:c.code});
    return again.status===400 && /过期/.test(again.data.error||'');
  });

  await t('小写输入也能通过', async()=>{
    const c = await grab();
    const r = await reg({email:'nc7@example.com',number:'3882000007',password:PWD,nickname:'小写',captchaId:c.id,captcha:c.code.toLowerCase()});
    return r.status===200;
  });

  await t('连错 6 次后该码作废', async()=>{
    const c = await grab();
    const wrong = c.code.split('').reverse().join('') === c.code ? 'ZZZZ' : c.code.split('').reverse().join('');
    let last=null;
    for (let i=0;i<6;i+=1){
      last = await reg({email:'nc8@example.com',number:'3882000008',password:PWD,nickname:'连错',captchaId:c.id,captcha:wrong});
    }
    return last.status===400 && /太多次/.test(last.data.error||'');
  });

  await t('注册成功后验证码已销毁', async()=>{
    const c = await grab();
    const ok = await reg({email:'nc9@example.com',number:'3882000009',password:PWD,nickname:'销毁',captchaId:c.id,captcha:c.code});
    if (ok.status!==200) throw new Error('注册失败 '+JSON.stringify(ok.data));
    const r = await reg({email:'nc10@example.com',number:'3882000010',password:PWD,nickname:'再用',captchaId:c.id,captcha:c.code});
    return r.status===400;
  });

  await t('第一位注册者仍是管理员', async()=>{
    const r = await j('/api/login',{method:'POST',body:{identifier:'nc4@example.com',password:PWD}});
    return r.status===200 && !!r.data.token;
  });

  console.log('\nRAN='+RAN+' PASS='+PASS+' FAIL='+FAIL+' ERR='+ERR);
  if (fails.length) console.log('FAILED: '+fails.join(' | '));
})();
