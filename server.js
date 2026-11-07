import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const equal = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (res, status, value) => {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
  res.end(JSON.stringify(value));
};
const fail = (status, message) => Object.assign(new Error(message), {status});
const validSKU = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.trim());

async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw fail(415, 'Send application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw fail(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, 'Send a valid JSON object.'); }
}

function emailFor(product, sku) {
  const name = String(product.name || sku);
  const price = Number.isFinite(product.price) ? new Intl.NumberFormat('en-GB', {style:'currency', currency:/^[A-Z]{3}$/.test(product.currency || '') ? product.currency : 'GBP'}).format(product.price) : '';
  return {
    subject: `${name} is back in stock`,
    text: `${name} (${sku}) is back in stock${price ? ` at ${price}` : ''}. Visit the store to order. Availability can change. You received this one-time alert because you requested it.`,
    html: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f1e9;color:#26362a;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" style="max-width:520px;background:#fffdf8;border:1px solid #dddccf;border-radius:18px" cellpadding="28"><tr><td><p style="font-size:14px;letter-spacing:3px">RESTOCK /</p><p style="font-size:12px;color:#63765b;text-transform:uppercase">Your wait is over</p><h1 style="font-family:Georgia,serif;font-size:36px;line-height:1.15;font-weight:400">A good thing.<br>Back again.</h1><hr style="border:0;border-top:1px solid #dddccf"><h2 style="font-size:22px;line-height:1.4">${escapeHTML(name)}</h2><p style="color:#63705e">${escapeHTML(sku)}${price ? ` &nbsp; / &nbsp; ${escapeHTML(price)}` : ''}</p><p style="line-height:1.7">The item you asked about is available again. Visit the store to place your order. Stock can change, so this is an alert, not a reservation.</p><p style="background:#edf0e4;border-radius:8px;padding:16px;line-height:1.6">This is your one-time restock email. We won't keep emailing you about this request.</p><p style="color:#778070;font-size:12px;line-height:1.7">Sent because you requested an alert for this item. No account, newsletter, or follow-up campaign.</p></td></tr></table></td></tr></table></body></html>`
  };
}

export function createApp(config = process.env, {fetcher = fetch, interval = 1000, now = Date.now} = {}) {
  for (const key of ['STOCK_API_URL','STOCK_API_KEY','RESEND_API_KEY','RESEND_BASE_URL','WEBHOOK_SECRET']) {
    if (!config[key]) throw new Error(`Missing ${key}`);
  }
  for (const key of ['STOCK_API_URL','RESEND_BASE_URL']) {
    const url = new URL(config[key]);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid ${key}`);
  }
  const file = config.DATABASE_PATH || './data/alerts.sqlite';
  if (file !== ':memory:') mkdirSync(dirname(file), {recursive:true});
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL, sku TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
      notified_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, payload TEXT, last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_request ON requests(email,sku) WHERE status != 'notified';
    CREATE INDEX IF NOT EXISTS requests_due ON requests(status,next_attempt);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, quantity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
    );
    UPDATE requests SET status='queued' WHERE status='sending';`);
  const assets = Object.fromEntries(['index.html','embed.html','style.css','form.js'].map(name => [name, readFileSync(new URL(`./public/${name}`, import.meta.url))]));
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const stockURL = config.STOCK_API_URL.replace(/\/+$/, '');
  const getStock = async sku => {
    const response = await fetcher(`${stockURL}/${encodeURIComponent(sku)}`, {headers:{authorization:`Bearer ${config.STOCK_API_KEY}`}, signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error(`Stock API HTTP ${response.status}`);
    const product = await response.json();
    if (typeof product.quantity !== 'number' || !Number.isFinite(product.quantity) || product.quantity < 0 || typeof product.in_stock !== 'boolean') throw new Error('Stock API returned invalid stock.');
    return product;
  };
  const retry = attempts => now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
  let stopping = false, active;
  async function processQueue() {
    for (const event of db.prepare("SELECT * FROM events WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 50").all(now())) {
      if (stopping) break;
      try {
        const product = await getStock(event.sku);
        transaction(() => {
          if (product.in_stock && product.quantity > 0) {
            const payload = JSON.stringify(emailFor(product, event.sku));
            db.prepare("UPDATE requests SET status='queued', payload=?, next_attempt=0 WHERE sku=? AND status='pending'").run(payload, event.sku);
          }
          db.prepare("UPDATE events SET status='done', last_error=NULL WHERE id=?").run(event.id);
        });
      } catch (error) {
        db.prepare('UPDATE events SET attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?').run(retry(event.attempts), error.message.slice(0,160), event.id);
      }
    }
    for (const request of db.prepare("SELECT * FROM requests WHERE status='queued' AND next_attempt<=? ORDER BY id LIMIT 50").all(now())) {
      if (stopping) break;
      try {
        const product = await getStock(request.sku);
        if (!product.in_stock || product.quantity <= 0) {
          db.prepare('UPDATE requests SET next_attempt=? WHERE id=?').run(now()+30_000, request.id);
          continue;
        }
        db.prepare("UPDATE requests SET status='sending' WHERE id=?").run(request.id);
        const response = await fetcher(`${config.RESEND_BASE_URL.replace(/\/+$/, '')}/emails`, {
          method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${config.RESEND_API_KEY}`, 'idempotency-key':`restock-request-${request.id}`},
          body:JSON.stringify({from:'Restock <alerts@restock.example>', to:[request.email], ...JSON.parse(request.payload)}),
          signal:AbortSignal.timeout(8000)
        });
        if (!response.ok) throw new Error(`Email API HTTP ${response.status}`);
        const receipt = await response.json();
        if (typeof receipt.id !== 'string' || !receipt.id) throw new Error('Email API returned no receipt.');
        db.prepare("UPDATE requests SET status='notified',notified_at=?,last_error=NULL WHERE id=?").run(now(),request.id);
      } catch (error) {
        db.prepare("UPDATE requests SET status='queued',attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?").run(retry(request.attempts),error.message.slice(0,160),request.id);
      }
    }
  }
  const drain = () => {
    if (!active && !stopping) active = processQueue().catch(error => console.error('Queue processing failed:',error.message)).finally(() => {active=undefined;});
    return active;
  };
  const timer = interval > 0 ? setInterval(drain, interval) : null;
  timer?.unref();
  // shortcut: run one application process against this SQLite volume; use transactional leases before adding replicas.
  const limits = new Map();
  const server = http.createServer(async (req,res) => {
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://picsum.photos https://*.picsum.photos; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      const path = new URL(req.url,'http://local').pathname;
      if (req.method==='GET' && path==='/healthz') { db.prepare('SELECT 1').get(); return json(res,200,{status:'ok'}); }
      const asset = {'/':'index.html','/embed':'embed.html','/style.css':'style.css','/form.js':'form.js'}[path];
      if (req.method==='GET' && asset) {
        res.writeHead(200,{'content-type':asset.endsWith('css')?'text/css':asset.endsWith('js')?'text/javascript':'text/html; charset=utf-8'});
        return res.end(assets[asset]);
      }
      if (req.method==='GET' && path==='/api/products') {
        const response = await fetcher(stockURL,{headers:{authorization:`Bearer ${config.STOCK_API_KEY}`},signal:AbortSignal.timeout(8000)});
        if (!response.ok) throw fail(503,'The store is temporarily unavailable. You can still enter an item code.');
        const data = await response.json();
        const products = (Array.isArray(data.products) ? data.products : []).filter(p => validSKU(p.sku)).map(p => ({sku:p.sku,name:String(p.name||p.sku),price:p.price,currency:p.currency,quantity:p.quantity,in_stock:p.in_stock}));
        return json(res,200,{products});
      }
      if (req.method==='POST' && path==='/api/requests') {
        const ip = req.socket.remoteAddress;
        const limit = limits.get(ip);
        if (limit && now()-limit.start<60_000 && limit.count>=60) return json(res,429,{error:'Too many requests. Please try again in a minute.'});
        if (!limit || now()-limit.start>=60_000) limits.set(ip,{start:now(),count:1}); else limit.count++;
        if (limits.size>5000) for (const [key,value] of limits) if(now()-value.start>=60_000) limits.delete(key);
        const input = await body(req);
        if (typeof input.email !== 'string' || input.email.length>254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.email.trim())) throw fail(400,'Enter a valid email address.');
        if (!validSKU(input.sku)) throw fail(400,'Enter an item code of up to 64 letters, numbers, dots, dashes or underscores.');
        const email=input.email.trim().toLowerCase(), sku=input.sku.trim().toUpperCase();
        const result=transaction(() => {
          const existing=db.prepare("SELECT id,status FROM requests WHERE email=? AND sku=? AND status!='notified'").get(email,sku);
          if (existing) return {id:existing.id,status:existing.status,duplicate:true};
          const inserted=db.prepare('INSERT INTO requests(email,sku,created_at) VALUES(?,?,?)').run(email,sku,now());
          const id=Number(inserted.lastInsertRowid);
          db.prepare('INSERT INTO events(id,sku,quantity) VALUES(?,?,0)').run(`request-${id}`,sku);
          return {id,status:'pending',duplicate:false};
        });
        return json(res,result.duplicate?200:201,{...result,message:"You're on the list. We'll email you once when this item is available."});
      }
      if (req.method==='POST' && path==='/webhooks/stock') {
        if (!equal(req.headers['x-webhook-secret'],config.WEBHOOK_SECRET)) throw fail(401,'Invalid webhook secret.');
        const event=await body(req);
        if (typeof event.event_id!=='string' || !/^[\w.:-]{1,128}$/.test(event.event_id) || event.event_id.startsWith('request-') || !validSKU(event.sku) || !Number.isInteger(event.quantity) || event.quantity<0) throw fail(400,'Invalid stock event.');
        const sku=event.sku.trim().toUpperCase();
        const previous=db.prepare('SELECT sku,quantity FROM events WHERE id=?').get(event.event_id);
        if(previous && (previous.sku!==sku || previous.quantity!==event.quantity)) throw fail(409,'Event ID was already used with different stock data.');
        db.prepare('INSERT OR IGNORE INTO events(id,sku,quantity) VALUES(?,?,?)').run(event.event_id,sku,event.quantity);
        return json(res,202,{accepted:true,duplicate:!!previous});
      }
      if(req.method==='GET' && path==='/admin') {
        const password=config.ADMIN_PASSWORD||config.WEBHOOK_SECRET;
        const expected=`Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
        if (!equal(req.headers.authorization,expected)) {
          res.setHeader('www-authenticate','Basic realm="Restock admin", charset="UTF-8"');
          return json(res,401,{error:'Admin sign-in required.'});
        }
        const rows=db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 500').all();
        const counts=db.prepare('SELECT status,COUNT(*) AS count FROM requests GROUP BY status').all();
        const count=status=>counts.find(c=>c.status===status)?.count||0;
        const date=value=>value?new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC':'—';
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY'});
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Requests · Restock</title><link rel="stylesheet" href="/style.css"></head><body><main class="admin"><nav><a class="brand" href="/">restock<span>/</span></a><span class="eyebrow">PRIVATE WORKSPACE</span></nav><header><p class="eyebrow">THE WAITING LIST</p><h1>Every request.<br>Nothing lost.</h1><p class="muted">Delivery status and notification times. Refresh for the latest activity.</p></header><section class="stats"><div><b>${count('pending')}</b>Awaiting stock</div><div><b>${count('queued')+count('sending')}</b>Delivery queue</div><div><b>${count('notified')}</b>Notified</div></section><div class="table-wrap"><table><thead><tr><th>Customer / Item</th><th>Status</th><th>Requested</th><th>Notified</th><th>Retries</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${escapeHTML(r.email)}</strong><small>${escapeHTML(r.sku)}</small></td><td><span class="pill ${r.status==='notified'?'green':''}">${escapeHTML(r.status)}</span>${r.last_error?`<small>${escapeHTML(r.last_error)}</small>`:''}</td><td>${date(r.created_at)}</td><td>${date(r.notified_at)}</td><td>${r.attempts}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">No requests yet. Your first customer starts the list.</td></tr>'}</tbody></table></div><p class="fine">Showing the latest 500 requests. Dates are UTC. Pending and retrying work is saved on disk.</p></main></body></html>`);
      }
      return json(res,404,{error:'Not found.'});
    } catch(error) {
      if(!error.status) console.error('Request failed:',error.message);
      if(!res.headersSent) json(res,error.status||503,{error:error.status?error.message:'Temporarily unavailable. Please try again.'}); else res.end();
    }
  });
  server.requestTimeout=15_000;
  server.headersTimeout=10_000;
  return {server, db, drain, async close() { stopping=true; if(timer) clearInterval(timer); await new Promise(resolve=>server.close(resolve)); await active; db.close(); }};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const app=createApp();
  app.server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Restock listening on port ${process.env.PORT||3000}`));
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{app.close().then(()=>process.exit(0));});
}
