const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=x=>{try{const u=new URL(x);return ['https:','http:'].includes(u.protocol)?esc(u.href):'';}catch{return '';}};
export function rich(items=[]){return items.map(p=>{let t=esc(p.plain_text??p.text?.content??p.equation?.expression??'');const a=p.annotations||{};if(a.code)t='<code>'+t+'</code>';if(a.bold)t='<b>'+t+'</b>';if(a.italic)t='<em>'+t+'</em>';if(a.strikethrough)t='<s>'+t+'</s>';if(a.underline)t='<u>'+t+'</u>';if(/^(gray|brown|orange|yellow|green|blue|purple|pink|red)(_background)?$/.test(a.color))t=`<span class="notion-${a.color}">${t}</span>`;const href=url(p.href||p.text?.link?.url);return href?`<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`:t;}).join('');}
function picture(d){return d?.local_asset?`<figure><img data-notion-asset="${esc(d.local_asset)}" alt="${esc((d.caption||[]).map(x=>x.plain_text||x.text?.content||'').join(''))}"><figcaption>${rich(d.caption)}</figcaption></figure>`:'';}
export function blocks(items=[]){let order=0;return items.map(b=>{const d=b[b.type]||{},text=rich(d.rich_text),children=blocks(b.children||[]);order=b.type==='numbered_list_item'?order+1:0;switch(b.type){
 case 'paragraph':return `<p>${text}</p>${children}`;
 case 'heading_1':case 'heading_2':case 'heading_3':{const n=Number(b.type.slice(-1))+1;return `<h${n}>${text}</h${n}>${children}`;}
 case 'bulleted_list_item':return `<ul><li>${text}${children}</li></ul>`;
 case 'numbered_list_item':return `<ol start="${order}"><li>${text}${children}</li></ol>`;
 case 'to_do':return `<div class="notion-todo">${d.checked?'☑':'☐'} ${text}${children}</div>`;
 case 'toggle':return `<details><summary>${text}</summary>${children}</details>`;
 case 'quote':case 'callout':return `<blockquote>${d.icon?.emoji?esc(d.icon.emoji)+' ':''}${text}${children}</blockquote>`;
 case 'code':return `<pre><code>${text}</code></pre>${rich(d.caption)}`;
 case 'equation':return `<pre>${esc(d.expression)}</pre>`;
 case 'divider':return '<hr>';
 case 'image':return picture(d);
 case 'table':return `<div class="deadline-scroll"><table><tbody>${children}</tbody></table></div>`;
 case 'table_row':return '<tr>'+d.cells.map(c=>'<td>'+rich(c)+'</td>').join('')+'</tr>';
 case 'column_list':return `<div class="notion-columns">${children}</div>`;
 case 'column':return `<div>${children}</div>`;
 case 'synced_block':return children;
 case 'child_page':return `<h3>${esc(d.title)}</h3>${children}`;
 case 'bookmark':case 'link_preview':case 'embed':case 'video':case 'audio':case 'file':case 'pdf':{const href=url(d.url||d.external?.url||d.file?.url);return `<p>${href?`<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(d.name||b.type)}</a>`:esc(b.type)}</p>${rich(d.caption)}${children}`;}
 default:return `<div class="notice">Блок ${esc(b.type)}: ${text||'перегляньте оригінал у Notion.'}</div>${children}`;
 }}).join('');}
export function renderNotion(s){return `<div class="notion-copy"><p class="subtitle">${esc(s.view.name)} · ${esc(s.alias)} · Карток: ${s.pages.length}</p>${(s.warnings||[]).map(w=>`<p class="notice">${esc(w)}</p>`).join('')}${s.pages.map(p=>`<article class="notion-page">${picture(p.cover)}<h3>${p.icon?.emoji?esc(p.icon.emoji)+' ':''}${rich(Object.values(p.properties||{}).find(x=>x.type==='title')?.title)}</h3>${blocks(p.children)}${url(p.url)?`<a href="${url(p.url)}" target="_blank" rel="noopener noreferrer">Оригінал у Notion</a>`:''}</article>`).join('')}</div>`;}
