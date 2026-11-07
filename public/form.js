const $ = selector => document.querySelector(selector);
const form = $('#alert-form');
if (form) {
  const sku = new URLSearchParams(location.search).get('sku');
  if (sku) $('#sku').value=sku;
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const button=form.querySelector('button'), status=$('#status');
    button.disabled=true; status.className='status'; status.textContent='Saving your request…';
    try {
      const response=await fetch('/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:$('#email').value,sku:$('#sku').value})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error || 'Please try again.');
      status.textContent=data.duplicate ? "You're already on this item's list. We'll email you once when it's available." : data.message;
      $('#email').value='';
    } catch(error) { status.className='status error'; status.textContent=error.message||'Could not connect. Please try again.'; }
    finally {button.disabled=false;}
  });
}
fetch('/api/products').then(async response => {
  if (!response.ok) throw new Error();
  const {products}=await response.json();
  const list=$('#sku-list');
  if(list) for(const product of products) { const option=document.createElement('option'); option.value=product.sku; option.label=product.name; list.append(option); }
  const grid=$('#products');
  if(!grid)return;
  grid.replaceChildren();
  const chosen=[...products.filter(p=>!p.in_stock),...products.filter(p=>p.in_stock)].slice(0,4);
  if(!chosen.length) throw new Error();
  chosen.forEach((p,index)=>{
    const card=document.createElement('article');card.className='product';
    const art=document.createElement('div');art.className='product-illustration';art.textContent=['✳','◒','✧','≋'][index];art.setAttribute('aria-hidden','true');
    const info=document.createElement('div');info.className='product-info';
    const title=document.createElement('h3');title.textContent=p.name;
    const detail=document.createElement('p');detail.textContent=`${p.sku} · ${p.in_stock?'Available now':'Waiting for a return'}`;
    const link=document.createElement('a');link.href=`/embed?sku=${encodeURIComponent(p.sku)}`;link.textContent='Get an alert ↗';
    info.append(title,detail,link);card.append(art,info);grid.append(card);
  });
}).catch(()=>{const grid=$('#products');if(grid){grid.replaceChildren();const message=document.createElement('p');message.className='loading';message.textContent="The collection is taking a moment. You can still request an alert using an item code.";grid.append(message);}});
