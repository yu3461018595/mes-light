// 复现：从当前线上（空业务数据）状态，走完整“建产品→路线(带工序)→工单→下发”链路
const fs = require('fs');
global.localStorage = { _d: {}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=v;}, removeItem(k){delete this._d[k];} };
const seed = JSON.parse(fs.readFileSync('public/data/seed.json','utf8'));
global.fetch = async () => ({ ok:true, json: async () => seed });
const Store = require('./public/js/store.js');

const H = (m,u,b)=>Store.handle(m,u,b||{});
async function login(u,p){ const r=await H('POST','/login',{username:u,password:p}); if(!r.ok) throw new Error('login '+u+' 失败: '+r.msg); return r.data; }
function assert(c,msg){ if(!c){ console.log('❌ '+msg); process.exitCode=1; } else console.log('✅ '+msg); }

(async()=>{
  await Store.init();
  console.log('=== 场景1：admin 完整链路（应能成功下发）===');
  await login('admin','123456');
  const prod = await H('POST','/products',{code:'P1',name:'测试产品',spec:'',unit:'个'});
  const proc = await H('POST','/processes',{code:'PR1',name:'车削'});
  const wc   = await H('POST','/work_centers',{code:'WC1',name:'车床'});
  const route= await H('POST','/routes',{code:'RT1',name:'轴工艺',product_id:prod.data.id,steps:[{seq:10,process_id:proc.data.id,work_center_id:wc.data.id}]});
  assert(prod.ok&&proc.ok&&wc.ok&&route.ok,'admin 可建 产品/工序/工作中心/路线');
  const rsteps = await H('GET','/routes/'+route.data.id+'/steps');
  console.log('  [debug] route.data=',JSON.stringify(route.data),'| 该路线工序数=',rsteps.data.length);
  const order= await H('POST','/orders',{product_id:prod.data.id,route_id:route.data.id,qty_plan:10});
  console.log('  [debug] order.data=',JSON.stringify(order.data),'| 传入 route_id=',route.data.id);
  const od   = await H('GET','/orders/'+order.data.id);
  assert(od.data.steps.length===1,'工单按路线展开出 1 道工序 (实际 '+od.data.steps.length+')');
  const rel  = await H('PATCH','/orders/'+order.data.id+'/status',{status:'released'});
  const after= await H('GET','/orders/'+order.data.id);
  assert(rel.ok && after.data.status==='released','admin 可下发 → 状态=已下发');

  console.log('\n=== 场景2：leader 自建完整链路（应成功，从空数据也能做出发放工单）===');
  await login('leader1','123456');
  const p2 = await H('POST','/products',{code:'P2',name:'领导产品'});
  const pr2= await H('POST','/processes',{code:'PR2',name:'焊接'});
  const wc2= await H('POST','/work_centers',{code:'WC2',name:'焊台'});
  const rt2= await H('POST','/routes',{code:'RT2',name:'焊接路线',product_id:p2.data.id,steps:[{seq:10,process_id:pr2.data.id,work_center_id:wc2.data.id}]});
  assert(p2.ok&&pr2.ok&&wc2.ok&&rt2.ok,'leader 可建 产品/工序/工作中心/路线');
  const rs2= await H('GET','/routes/'+rt2.data.id+'/steps');
  assert(rs2.data.length===1,'leader 建的路线带 1 道工序');
  const o2 = await H('POST','/orders',{product_id:p2.data.id, route_id:rt2.data.id, qty_plan:5});
  const od2= await H('GET','/orders/'+o2.data.id);
  assert(od2.data.steps.length===1,'leader 工单按路线展开 1 道工序');
  const rel2= await H('PATCH','/orders/'+o2.data.id+'/status',{status:'released'});
  const af2= await H('GET','/orders/'+o2.data.id);
  assert(rel2.ok && af2.data.status==='released','leader 可下发 → 状态=已下发');
})().catch(e=>{console.error('ERR',e);process.exit(1);});
