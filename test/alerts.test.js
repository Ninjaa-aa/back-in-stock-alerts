import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server.js';

test('HTTP workflow preserves subscriptions and delivers once across concurrent events, failures and restart',async t => {
  const directory=mkdtempSync(join(tmpdir(),'restock-test-'));
  let clock=Date.now(),stock=0,stockFails=false,emailFails=0,loseReceipt=false;
  const accepted=new Map(), attempts=[];
  const config={DATABASE_PATH:join(directory,'alerts.sqlite'),STOCK_API_URL:'https://store.test/api/stock',STOCK_API_KEY:'stock-key',RESEND_BASE_URL:'https://mail.test',RESEND_API_KEY:'email-key',WEBHOOK_SECRET:'test-webhook-secret',ADMIN_PASSWORD:'test-admin-password'};
  const fetcher=async (url,options) => {
    if (url.startsWith(config.STOCK_API_URL)) {
      assert.equal(options.headers.authorization,'Bearer stock-key');
      if(stockFails)return Response.json({error:'temporary'},{status:503});
      return Response.json({quantity:stock,in_stock:stock>0,name:'<script>plant</script>',price:18,currency:'GBP'});
    }
    assert.equal(url,'https://mail.test/emails');
    assert.equal(options.headers.authorization,'Bearer email-key');
    const key=options.headers['idempotency-key'], payload=JSON.parse(options.body);
    attempts.push({key,payload});
    if(emailFails-->0)return Response.json({error:'injected'},{status:500});
    if(!accepted.has(key))accepted.set(key,{id:`mail-${accepted.size+1}`,payload});
    else assert.deepEqual(payload,accepted.get(key).payload,'an idempotency key must have an identical payload');
    if(loseReceipt){loseReceipt=false;throw new Error('Connection lost after provider accepted email');}
    return Response.json({id:accepted.get(key).id});
  };
  let app,base;
  async function start() {
    app=createApp(config,{fetcher,interval:0,now:()=>clock});
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
    base=`http://127.0.0.1:${app.server.address().port}`;
  }
  const post=async(path,input,secret=config.WEBHOOK_SECRET)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':secret},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  };
  const subscribe=(email,sku='TEST-A')=>post('/api/requests',{email,sku});
  const hook=(id,quantity=5,secret)=>post('/webhooks/stock',{event_id:id,sku:'TEST-A',quantity},secret);
  await start();
  try {
    await t.test('validates boundaries and protects customer data',async()=>{
      assert.equal((await fetch(base+'/admin')).status,401);
      assert.equal((await fetch(base+'/admin',{headers:{authorization:`Basic ${Buffer.from('admin:wrong').toString('base64')}`}})).status,401);
      assert.equal((await subscribe('bad-address')).status,400);
      assert.equal((await subscribe('test@example.com','../../escape')).status,400);
      assert.equal((await hook('unauthorized',5,'bad-secret')).status,401);
      assert.equal((await post('/api/requests',[])).status,400);
      const badJSON=await fetch(base+'/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:'{'});
      assert.equal(badJSON.status,400);
      const oversized=await fetch(base+'/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(9000)});
      assert.equal(oversized.status,413);
      assert.equal((await fetch(base+'/embed')).headers.get('x-frame-options'),null,'embed must remain frameable');
    });
    await t.test('concurrent duplicate signups create only one open subscription',async()=>{
      const responses=await Promise.all(Array.from({length:12},()=>subscribe('Customer@Example.com')));
      assert.equal(responses.filter(r=>r.status===201).length,1);
      assert.equal(new Set(responses.map(r=>r.body.id)).size,1);
      await app.drain();assert.equal(accepted.size,0);
    });
    await t.test('a claimed restock is ignored when the stock API disagrees',async()=>{
      await hook('phantom',999);await app.drain();
      assert.equal(accepted.size,0);
    });
    await t.test('concurrent duplicate webhooks notify each waiting customer once',async()=>{
      await subscribe('other@example.com');await app.drain();stock=8;
      const replies=await Promise.all(Array.from({length:12},()=>hook('real-restock')));
      assert.ok(replies.every(r=>r.status===202));await app.drain();
      assert.equal(accepted.size,2);
      const payload=[...accepted.values()][0].payload;
      assert.ok(payload.html.includes('&lt;script&gt;plant&lt;/script&gt;'));
      assert.ok(!payload.html.includes('<script>'));
      assert.equal((await hook('real-restock',7)).status,409);
      await hook('a-different-event');await app.drain();assert.equal(accepted.size,2);
      const response=await fetch(base+'/admin',{headers:{authorization:`Basic ${Buffer.from('admin:test-admin-password').toString('base64')}`}});
      const html=await response.text();assert.equal(response.status,200);assert.match(html,/notified/);assert.match(html,/UTC/);
    });
    await t.test('stock API outages retain events and retry without another webhook',async()=>{
      stock=0;await subscribe('stock-retry@example.com');await app.drain();
      stock=5;stockFails=true;await hook('stock-api-outage');await app.drain();assert.equal(accepted.size,2);
      stockFails=false;clock+=2000;await app.drain();assert.equal(accepted.size,3);
    });
    await t.test('failed emails and pending subscriptions survive a process restart',async()=>{
      stock=0;await subscribe('restart@example.com');await subscribe('pending@example.com','TEST-B');await app.drain();
      stock=4;emailFails=1;await hook('mail-outage');await app.drain();assert.equal(accepted.size,3);
      await app.close();await start();clock+=2000;await app.drain();assert.equal(accepted.size,4);
      await post('/webhooks/stock',{event_id:'second-product',sku:'TEST-B',quantity:4});await app.drain();assert.equal(accepted.size,5);
    });
    await t.test('lost email receipts retry the same delivery key and payload after restart',async()=>{
      stock=0;await subscribe('lost-receipt@example.com');await app.drain();stock=4;loseReceipt=true;
      await hook('lost-receipt-event');await app.drain();assert.equal(accepted.size,6);
      const first=attempts.at(-1);
      await app.close();await start();clock+=2000;await app.drain();assert.equal(accepted.size,6);
      assert.deepEqual(attempts.at(-1),first);
      const row=app.db.prepare('SELECT status FROM requests WHERE email=?').get('lost-receipt@example.com');assert.equal(row.status,'notified');
    });
    await t.test('a committed in-flight delivery resumes on startup',async()=>{
      stock=0;await subscribe('inflight@example.com');await app.drain();stock=4;emailFails=1;
      await hook('inflight');await app.drain();
      app.db.prepare("UPDATE requests SET status='sending',next_attempt=0 WHERE email=?").run('inflight@example.com');
      await app.close();await start();await app.drain();assert.equal(accepted.size,7);
    });
    await t.test('a second request after notification is a new independent alert',async()=>{
      const response=await subscribe('customer@example.com');assert.equal(response.status,201);
      await app.drain();assert.equal(accepted.size,8);
    });
  } finally {await app.close();rmSync(directory,{recursive:true,force:true});}
});
