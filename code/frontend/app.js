"use strict";
const S = { token:null, tree:null, wc:null, analyze:null, comp:null,
            choices:{}, objem:100, picks:new Set(), refTab:0,
            collapse:{}, query:"", rows:[], smetaQuery:"", history:[],
            manualCode:null, positions:{}, showAll:false, expandWork:{},
            swaps:{}, qtys:{}, drops:new Set(), krat:1, kratText:"",
            betonLib:null, matLib:null, betonPickFor:null, swapType:"", betonClass:"", betonQuery:"" };

const $ = s => document.querySelector(s);
const esc = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const ALL_VIEWS = ["#engineView", "#projectView", "#vorView", "#normaView", "#infoView", "#validatorView", "#wizardView"];
function showOnlyView(sel){
  ALL_VIEWS.forEach(s => { const e = $(s); if (e) e.classList.toggle("hidden", s !== sel); });
}

function hl(text){
  text = String(text==null?"":text);
  const q = S.query;
  if(!q) return esc(text);
  const toks = q.split(/\s+/).filter(Boolean).sort((a,b)=>b.length-a.length);
  if(!toks.length) return esc(text);
  const re = new RegExp("("+toks.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join("|")+")","gi");
  const parts=[]; let idx=0;
  text.replace(re,(m,_p,off)=>{ parts.push(esc(text.slice(idx,off)));
    parts.push('<span class="hlq">'+esc(m)+'</span>'); idx=off+m.length; return m; });
  parts.push(esc(text.slice(idx)));
  return parts.join("");
}
const fmt = v => (v==null||v==="") ? "" : String(v).replace(".", ",");
function toast(msg, kind){
  const t=document.createElement("div"); t.className="toast"+(kind==="err"?" err":"");
  t.innerHTML=`<span>${kind==="err"?"⚠":"✓"}</span><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition=".3s"; setTimeout(()=>t.remove(),300); }, 2600);
}

async function api(path, opts={}){
  opts.headers = Object.assign({"Content-Type":"application/json","X-Auth":S.token||""}, opts.headers||{});
  const r = await fetch(path, opts);
  if(!r.ok){ const e = new Error((await r.json().catch(()=>({}))).detail || r.statusText); e.status = r.status; throw e; }
  return r;
}

async function doLogin(){
  const pw = $("#pw").value;
  try{
    const r = await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:pw})});
    if(!r.ok){ $("#loginErr").textContent="Неверный пароль."; return; }
    const d = await r.json();
    S.token = d.token;
    $("#operator").textContent = d.operator || "оператор";

    try { sessionStorage.setItem("iismeta_auth", JSON.stringify({ token: d.token, operator: d.operator || "" })); } catch (e) {}
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    loadTree();
  }catch(e){ $("#loginErr").textContent="Ошибка соединения."; }
}

function restoreSession(){
  let a = null;
  try { a = JSON.parse(sessionStorage.getItem("iismeta_auth") || "null"); } catch (e) {}
  if(!a || !a.token) return;
  S.token = a.token;
  $("#operator").textContent = a.operator || "оператор";
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  loadTree().catch((e)=>{

    if (e && (e.status === 401 || e.status === 403)) {
      S.token = null;
      try { sessionStorage.removeItem("iismeta_auth"); } catch (er) {}
      $("#app").classList.add("hidden");
      $("#login").classList.remove("hidden");
    } else {
      setTimeout(() => { try { loadTree(); } catch (er) {} }, 2500);
    }
  });
}

async function loadTree(){
  const root=$("#tree");
  if(root && !(S.tree&&S.tree.tree)) root.innerHTML='<div class="tree-loading">⏳ Загрузка базы расценок…<br/><span class="muted">база расценок — пара секунд</span></div>';
  const d = await (await api("/api/tree")).json();
  S.tree = d;
  $("#treeSub").textContent = "· " + d.sbornik;
  { const _p = $("#sbornikPill"); if (_p) _p.textContent = d.sbornik; }
  renderTree();
}
function matchWork(w){
  const q = S.query;
  if(!q) return true;

  const hay = (w.code + " " + (w.name||"")).toLowerCase();
  return q.split(/\s+/).every(tok => tok==="" || hay.includes(tok));
}
function isLeaf(n){ return n.leaf || (n.code && !n.children); }
function subtreeMatch(n){
  if(isLeaf(n)) return matchWork(n);
  return (n.children||[]).some(subtreeMatch);
}
function renderNode(n, parent, idPath, depth){
  if(n._wm) return;
  if(n.techpart){ if(!S.query) parent.appendChild(techPartNode(n)); return; }
  if(isLeaf(n)){ if(matchWork(n)) parent.appendChild(workNode(n)); return; }
  if(S.query && !subtreeMatch(n)) return;
  const open = S.query ? true : (S.collapse[idPath] === true);
  const lvl = depth===0 ? "lvl1" : "lvl2";
  parent.appendChild(node(idPath, lvl, n.name, open, ()=>{
    const box = document.createElement("div"); box.className="children";
    (n.children||[]).forEach((ch,i)=> renderNode(ch, box, idPath+"/"+i, depth+1));
    return box;
  }));
}

function tpIsTableRow(l){ return /^\s*\|.*\|\s*$/.test(l); }
function tpIsSepCell(c){ return /^:?-{2,}:?$/.test(c.trim()) || c.trim()===""; }
function tpSplitRow(l){ let s=l.trim(); if(s.startsWith("|")) s=s.slice(1); if(s.endsWith("|")) s=s.slice(0,-1); return s.split("|").map(c=>c.trim()); }
function tpIsEnumLine(l){ return /^\s*(?:[а-яa-z]\)|[0-9]{1,2}\)|-)\s+\S/.test(l); }
function tpRenderTableBlock(lines){
  const rows = lines.map(tpSplitRow);
  const flat = rows.filter(r=>!r.every(tpIsSepCell)).map(r=>r.filter(c=>c!=="").join(" · "));
  if(!flat.length) return "";
  return `<div class="tp-tablefrag"><div class="tp-tablefrag-h">⚠ Таблица из источника (построчно; порядок граф после извлечения не гарантирован — точные величины см. в «Условия производства»)</div><ul class="tp-tablefrag-list">${flat.map(r=>`<li>${esc(r)}</li>`).join("")}</ul></div>`;
}
function tpRenderWarnFrag(line){
  const m = line.match(/⚠️\s*таблица\s*\(([^)]*)\)\s*:?\s*(.*)$/i);
  const note = m ? m[1] : "геометрия не распозналась";
  const content = m ? m[2] : line.replace(/^\s*>\s*/,"");
  return `<div class="tp-tablefrag"><div class="tp-tablefrag-h">⚠ Таблица из источника (${esc(note)})</div><div class="tp-tablefrag-flat">${esc(content)}</div></div>`;
}
function techPartHtml(text){
  const lines = String(text||"").split("\n");
  let html=""; let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(line.trim()===""){ i++; continue; }
    if(/⚠️\s*таблица/i.test(line)){ html+=tpRenderWarnFrag(line); i++; continue; }
    if(tpIsTableRow(line)){
      const block=[]; while(i<lines.length && tpIsTableRow(lines[i])){ block.push(lines[i]); i++; }
      html+=tpRenderTableBlock(block); continue;
    }
    const h=line.match(/^#{1,6}\s+(.*)$/);
    if(h){ html+=`<div class="tp-h">${esc(h[1].trim())}</div>`; i++; continue; }
    const sh=line.match(/^(\d{1,2})\.\s+([А-ЯЁ][^.]{2,45})$/);
    if(sh && !/\d/.test(sh[2])){ html+=`<div class="tp-h">${esc(sh[1])}. ${esc(sh[2].trim())}</div>`; i++; continue; }
    if(tpIsEnumLine(line)){
      const items=[];
      while(i<lines.length && lines[i].trim()!=="" && tpIsEnumLine(lines[i])){ items.push(lines[i].replace(/^\s*(?:[а-яa-z]\)|[0-9]{1,2}\)|-)\s+/,"")); i++; }
      html+=`<ul class="tp-list">${items.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`; continue;
    }
    const para=[];
    while(i<lines.length && lines[i].trim()!=="" && !tpIsTableRow(lines[i]) && !/⚠️\s*таблица/i.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !tpIsEnumLine(lines[i])){ para.push(lines[i]); i++; }
    const joined = para.map(esc).join("<br/>").replace(/^(\d{1,2}\.\d{1,3}\.)(\s)/, '<strong class="tp-clause">$1</strong>$2');
    html+=`<p>${joined}</p>`;
  }
  return html;
}
const TCH_ICON = {"ТЧ":"📘","Дополнения":"📗","Добавления":"📙"};
function techPartNode(n){
  const row=document.createElement("div");
  row.className="trow lvl2 techpart";
  const icon = TCH_ICON[n.dk] || "📘";
  row.innerHTML=`<span class="tcaret" style="visibility:hidden">▶</span><span class="ticon">${icon}</span>
    <span class="tlabel">${esc(n.name)}</span>`;
  if(n.doc){
    row.onclick=async ()=>{
      $("#tchdocTitle").textContent = icon+" "+n.name;
      $("#tchdocSub").textContent = "полный документ · таблицы и коэффициенты как в источнике";
      $("#tchdocFrame").srcdoc = "<p style='font:14px Arial;padding:20px'>⏳ Загрузка документа…</p>";
      $("#tchdocModal").classList.remove("hidden");
      try{
        if(!n._html){ const d=await (await api("/api/techdoc?file="+encodeURIComponent(n.doc))).json(); n._html=d.html||""; }
        $("#tchdocFrame").srcdoc = n._html || "<p style='font:14px Arial;padding:20px'>Документ пуст.</p>";
      }catch(e){ $("#tchdocFrame").srcdoc = "<p style='font:14px Arial;padding:20px'>Не удалось загрузить документ — попробуйте ещё раз.</p>"; }
    };
    return row;
  }
  row.onclick=async ()=>{ S.wc=null; S.comp=null; renderTree();
    showWorkPopup();
    const paint=t=>{ $("#paramBody").innerHTML = `<div class="techpart-view">
      <div class="work-head"><div class="work-title">📘 ${esc(n.name)}</div></div>
      <div class="techpart-text">${esc(t||"").replace(/\n/g,'<br/>')}</div></div>`; };
    if(n.tp && !n.text){
      paint("⏳ Загрузка технической части…");
      try{ const d=await (await api("/api/techpart?key="+encodeURIComponent(n.tp))).json(); n.text=d.text||""; }
      catch(e){ n.text=""; }
      paint(n.text||"Не удалось загрузить текст — попробуйте ещё раз.");
    } else paint(n.text);
  };
  return row;
}
function renderTree(){
  const root = $("#tree"); root.innerHTML="";
  if(S.query){
    if(S.searching){ root.innerHTML='<div class="muted" style="padding:10px 4px">Поиск…</div>'; return; }
    const res = S.searchResults || [];
    if(!res.length){ root.innerHTML='<div class="muted" style="padding:10px 4px">Ничего не найдено</div>'; return; }
    res.forEach(r=>{
      const lr = document.createElement("div");
      lr.className = "trow lvl4" + (S.manualCode===r.code ? " sel selrasc":"");
      lr.innerHTML = `<span class="tcaret" style="visibility:hidden">▶</span><span class="ticon">📄</span>
        <span class="tlabel"><span class="tcode">${hl(r.shifr||r.code)}</span>${hl(r.name)}</span>`;
      lr.onclick = ()=> selectWorkThenPick(r.wc, r.code);
      root.appendChild(lr);
    });
    return;
  }
  const list = (S.tree && S.tree.tree) ? S.tree.tree : [];
  list.forEach((n,i)=> renderNode(n, root, "n"+i, 0));
}
function node(id, lvl, label, open, childrenFn){
  const wrap = document.createElement("div"); wrap.className="tnode";
  const row = document.createElement("div"); row.className="trow "+lvl;
  row.innerHTML = `<span class="tcaret ${open?'open':''}">▶</span><span class="ticon">${open?'📂':'📁'}</span><span class="tlabel">${hl(label)}</span>`;
  wrap.appendChild(row);
  let kids = null;
  if(open){ kids = childrenFn(); wrap.appendChild(kids); }
  row.onclick = () => { S.collapse[id] = !open; renderTree(); };
  return wrap;
}
function workNode(w){

  const wrap = document.createElement("div"); wrap.className="tnode";
  const open = S.expandWork[w.code]===true;
  const row = document.createElement("div");

  row.className = "trow lvl3" + ((S.wc===w.code && !S.manualCode) ? " sel":"");
  row.innerHTML = `<span class="tcaret tcaret-w ${open?'open':''}">▶</span><span class="ticon">📄</span>
    <span class="tlabel"><span class="tcode">${hl(w.shnk||w.code)}</span>${hl(w.name)}</span>`;
  wrap.appendChild(row);

  row.querySelector(".tcaret").onclick = async (e)=>{
    e.stopPropagation();
    S.expandWork[w.code] = !open;
    if(!open) await loadPositions(w.code);
    renderTree();
  };

  row.querySelector(".tlabel").onclick = (e)=>{ e.stopPropagation(); selectWork(w.code); };
  if(open){
    const cb = document.createElement("div"); cb.className="children";
    const list = S.positions[w.code] || [];
    list.forEach(p=>{
      const lr = document.createElement("div");
      lr.className = "trow lvl4" + (S.manualCode===p.code ? " sel selrasc":"");
      lr.innerHTML = `<span class="tcaret" style="visibility:hidden">▶</span>
        <span class="tlabel"><span class="tcode">${hl(p.code)}</span>${hl(p.name)}</span>`;
      lr.onclick = (e)=>{ e.stopPropagation(); selectWorkThenPick(w.code, p.code); };
      cb.appendChild(lr);
    });
    wrap.appendChild(cb);
  }
  return wrap;
}

async function selectWork(wc){
  showWorkPopup();
  S.editingSrc = null;
  S.wc = wc; S.picks = new Set(); S.refTab = 0; S.objem = 0;
  S.manualCode = null; S.showAll = false;
  S.swaps = {}; S.qtys = {}; S.drops = new Set(); S.krat = 1; S.kratText = ""; S.betonPickFor = null;
  S.analyze = await (await api("/api/analyze?wc="+encodeURIComponent(wc))).json();
  S.choices = {};
  (S.analyze.axes||[]).forEach(ax=>{
    if(ax.kind !== "number") S.choices[ax.key] = ax.options[0];
  });
  renderTree();
  await recompute(); renderParam();
}
function isReady(){
  if(!(S.objem > 0)) return false;
  for(const ax of (S.analyze.axes||[])){
    const v = S.choices[ax.key];
    if(ax.kind === "number"){ if(!(parseFloat(v) > 0)) return false; }
    else if(v===undefined || v===null || v==="") return false;
  }
  return true;
}
async function recompute(){
  if(!S.wc){ S.comp = null; return; }
  if(S.manualCode){
    S.comp = await (await api("/api/compute_pos",{method:"POST",
      body:JSON.stringify({wc:S.wc, objem:S.objem, code:S.manualCode, swaps:S.swaps, qtys:S.qtys, drops:[...(S.drops||[])]})})).json();
    return;
  }
  if(!(S.objem>0) || !isReady()){ S.comp = null; return; }
  S.comp = await (await api("/api/compute",{method:"POST",
    body:JSON.stringify({wc:S.wc, objem:S.objem, choices:S.choices, swaps:S.swaps, qtys:S.qtys, drops:[...(S.drops||[])]})})).json();
}
async function loadPositions(wc){
  wc = wc || S.wc;
  if(S.positions[wc]) return S.positions[wc];
  const d = await (await api("/api/positions?wc="+encodeURIComponent(wc))).json();
  S.positions[wc] = d.positions||[]; return S.positions[wc];
}
async function pickPosition(code){
  S.manualCode = code; S.picks = new Set();
  S.swaps = {}; S.qtys = {}; S.betonPickFor = null;
  await recompute();
  if(S.comp && S.comp["оси"] && S.analyze){
    (S.analyze.axes||[]).forEach(ax=>{
      const v = S.comp["оси"][ax.key];
      if(ax.kind!=="number" && v!=null && v!=="") S.choices[ax.key]=v;
    });
  }
  renderTree();
  renderParam();
}
async function selectWorkThenPick(wc, code){
  if(S.wc !== wc) await selectWork(wc);
  await pickPosition(code);
}
function renderParam(){
  const a = S.analyze, r = S.comp, b = $("#paramBody");
  const axes = (a.axes||[]).map(ax=>{
    if(ax.kind==="number"){
      const val = (S.choices[ax.key]==null ? "" : S.choices[ax.key]);
      return `<div class="field"><label>${esc(ax.label)} <span class="muted">(база ${ax.base} · шаг ${ax.step})</span></label>
        <input type="number" data-key="${ax.key}" value="${val}" step="${ax.step||1}" min="0" placeholder="не задано"/></div>`;
    }
    const chosen = S.choices[ax.key];
    const opts = ax.options.map(o=>`<option value="${esc(o)}" ${String(o)===String(chosen)?'selected':''}>${esc(o)}</option>`).join("");
    return `<div class="field"><label>${esc(ax.label)}</label><select data-key="${ax.key}">${opts}</select></div>`;
  }).join("");

  let result = "";
  if(!r){
    result = `<div class="hint">Задайте объём и выберите параметры — появится расценка с ресурсами, поправками и характеристиками.</div>`;
    $("#addBtn").classList.add("hidden"); $("#dupNote").classList.add("hidden");
  } else if(r.error){
    result = `<div class="warn-banner">Позиция по выбранным параметрам не найдена — такой комбинации в ШНК нет.
      Измените параметры (например, группу грунта или ковш).</div>`;
    $("#addBtn").classList.add("hidden"); $("#dupNote").classList.add("hidden");
  } else {
    result = `<div class="rate-banner">Расценка: <b>${esc(r.shifr)}</b> — ${esc(r["наименование"])}</div>
      ${r["добор"]?`<div class="dobor-line">📏 ${esc(r["добор"])}</div>`:""}
      ${refWindow(r)}`;

    const add=$("#addBtn"), note=$("#dupNote");
    add.classList.remove("hidden"); note.classList.add("hidden");
    add.textContent = "+ Добавить в смету  (поправок: "+S.picks.size+")";
  }
  b.innerHTML = `<div class="work-head">
      <div><div class="work-title">${esc(S.wc)} · ${esc(a.vid)}</div>
        <div class="work-meta">измеритель ${esc(a.izmeritel)} · позиций ${a.n_pos}</div></div>
      <button class="btn btn-icon" id="unsel">✕</button></div>
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:12px">
      <div class="field" style="max-width:200px"><label>Объём (${esc(a.izmeritel)})</label>
        <input type="number" id="objem" value="${S.objem>0?S.objem:''}" step="10" min="0" placeholder="введите объём"/></div>
      <div class="field" style="width:80px" title="кратность: расценка учитывается N раз (напр. «в 2 слоя»)"><label>К =</label>
        <input type="number" id="krat" value="${S.krat>1?S.krat:''}" step="1" min="1" placeholder="1"/></div>
      <div class="field" style="flex:1;min-width:140px" title="примечание к кратности"><label>Примечание к К</label>
        <input type="text" id="kratText" value="${esc(S.kratText||'')}" placeholder="напр. в 2 слоя"/></div></div>
    <div class="params-grid">${axes}</div>${posSection(a)}${result}`;

  const tg=$("#toggleAll");
  if(tg) tg.onclick = async ()=>{ S.showAll=!S.showAll; if(S.showAll) await loadPositions(); renderParam(); };
  const cm=$("#clearManual");
  if(cm) cm.onclick = async ()=>{ S.manualCode=null; S.picks=new Set(); await recompute(); renderTree(); renderParam(); };
  b.querySelectorAll(".rasc-item").forEach(el=> el.onclick = ()=> pickPosition(el.dataset.pos));

  $("#unsel").onclick = ()=>{ S.wc=null; S.comp=null; renderTree(); hideWorkPopup();
    $("#paramBody").innerHTML = `<div class="empty-state"><div class="empty-ic">🛠</div>
      <p>Выберите работу в дереве слева — здесь откроется подбор расценки<br/>и окно Ресурсы / Поправки / Характеристики / Стоимость.</p></div>`;
    $("#addBtn").classList.add("hidden"); $("#dupNote").classList.add("hidden"); };
  $("#objem").onchange = async e=>{ S.objem=parseFloat(e.target.value)||0; await recompute(); renderParam(); };
  { const k=$("#krat"); if(k) k.onchange = e=>{ S.krat=Math.max(1, parseInt(e.target.value)||1); };
    const kt=$("#kratText"); if(kt) kt.onchange = e=>{ S.kratText=e.target.value.trim(); }; }
  b.querySelectorAll("[data-key]").forEach(el=>{
    el.onchange = async e=>{ S.choices[e.target.dataset.key]=e.target.value; S.picks=new Set();
      S.manualCode=null;
      S.swaps={}; S.qtys={}; S.drops=new Set(); S.betonPickFor=null;
      await recompute(); renderTree(); renderParam(); };
  });
  bindRefTabs(); bindPops(); bindBeton();
}

async function loadBetonLib(){
  if(!S.betonLib) S.betonLib = await (await api("/api/beton_marks")).json();
  return S.betonLib;
}
async function loadMatLib(){
  if(!S.matLib) S.matLib = await (await api("/api/material_catalog")).json();
  return S.matLib;
}
function swapFilterAndRender(){
  const list = $(".blist"); if(!list) return;
  const q = (S.betonQuery||"").toLowerCase().trim();
  const toks = q.split(/\s+/).filter(Boolean);
  let items;
  if(S.swapType==="бетон"){
    const L=S.betonLib; if(!L) return;
    if(q){ items = L["марки"].filter(m=>{ const h=(m["наим"]+" "+m.code).toLowerCase(); return toks.every(t=>h.includes(t)); }); }
    else if(S.betonClass){ items = L["марки"].filter(m=>m["класс"]===S.betonClass && /^Бетон тяжелый класса/i.test(m["наим"])); }
    else items = [];
  } else {
    const L=S.matLib; if(!L) return;
    items = q ? L["материалы"].filter(m=>{ const h=(m["наим"]+" "+m.code).toLowerCase(); return toks.every(t=>h.includes(t)); }) : [];
  }
  if(q && toks[0] && items.length){
    const t0=toks[0];
    items = items.slice().sort((a,b)=>
      (a["наим"].toLowerCase().startsWith(t0)?0:1) - (b["наим"].toLowerCase().startsWith(t0)?0:1)
      || a["наим"].localeCompare(b["наим"]));
  }
  const total = items.length, shown = items.slice(0,80);
  list.innerHTML = shown.length
    ? shown.map(m=>`<div class="brow2" data-code="${esc(m.code)}"><span class="bcode">${esc(m.code)}</span><span class="bnm">${esc(m["наим"])}</span><span class="bun">${esc(m["ед"]||"")}</span></div>`).join("")
    : `<div class="muted bnone">${(q||S.betonClass)?"Ничего не найдено — уточните запрос."
        :(S.swapType==="бетон"?"Выберите класс выше или начните поиск (марка, морозост., фракция…)."
                              :"Начните поиск: название материала, тип, размер/диаметр…")}</div>`;
  const more = $(".bmore"); if(more) more.textContent = total>80 ? `показано 80 из ${total} — уточните поиск` : (total?`${total} найдено`:"");
  list.querySelectorAll(".brow2").forEach(el=> el.onclick = ()=> applySwap(el.dataset.code));
}
async function applySwap(code){
  if(code && S.betonPickFor){ S.swaps[S.betonPickFor]=code; }
  const who = S.betonPickFor; S.betonPickFor=null;
  await recompute(); renderParam();
  if(code) toast("Ресурс заменён для "+who);
}
function bindBeton(){
  document.querySelectorAll(".bpick").forEach(a=> a.onclick = async ()=>{
    S.swapType = a.dataset.type || "ресурс"; S.betonClass="";
    S.betonQuery = (S.swapType==="ресурс") ? (a.dataset.seed||"") : "";
    S.refTab=0;
    if(S.swapType==="бетон") await loadBetonLib(); else await loadMatLib();
    S.betonPickFor = a.dataset.res; renderParam(); });
  document.querySelectorAll(".breset").forEach(a=> a.onclick = async ()=>{
    delete S.swaps[a.dataset.res]; await recompute(); renderParam(); toast("Замена отменена"); });
  document.querySelectorAll(".rrevert").forEach(b=> b.onclick = async (e)=>{
    e.stopPropagation(); delete S.swaps[b.dataset.revert];
    await recompute(); renderParam(); toast("Замена отменена"); });
  document.querySelectorAll(".rrestore").forEach(b=> b.onclick = async (e)=>{
    e.stopPropagation(); if(S.drops) S.drops.delete(b.dataset.restore);
    await recompute(); renderParam(); toast("Ресурс возвращён"); });
  document.querySelectorAll(".rdrop").forEach(d=> d.onclick = async (e)=>{
    e.stopPropagation(); const rc=d.dataset.drop;
    if(!S.drops) S.drops=new Set();
    S.drops.add(rc); delete S.swaps[rc]; delete S.qtys[rc];
    await recompute(); renderParam(); toast("Ресурс исключён"); });
  const rd=$("#restoreDrops"); if(rd) rd.onclick = async ()=>{
    S.drops=new Set(); await recompute(); renderParam(); toast("Исключённые возвращены"); };
  document.querySelectorAll(".bchip").forEach(b=> b.onclick = ()=>{
    const c=b.dataset.c; S.betonClass = (S.betonClass===c?"":c); S.betonQuery="";
    const si=$("#bSearch"); if(si) si.value="";
    document.querySelectorAll(".bchip").forEach(x=>x.classList.toggle("on", x.dataset.c===S.betonClass));
    swapFilterAndRender(); });
  const si=$("#bSearch"); if(si) si.oninput = e=>{ S.betonQuery=e.target.value; S.betonClass="";
    document.querySelectorAll(".bchip").forEach(x=>x.classList.remove("on")); swapFilterAndRender(); };
  const bx=$("#bCancel"); if(bx) bx.onclick = ()=>{ S.betonPickFor=null; renderParam(); };
  const sub=$("#swapUserBtn"); if(sub) sub.onclick = ()=>{ const t=S.betonPickFor; S.betonPickFor=null; openResPicker("swap", t); };  // #110
  document.querySelectorAll(".qin").forEach(inp=> inp.onchange = async ()=>{
    const v=inp.value.trim(), res=inp.dataset.res;
    if(v==="") delete S.qtys[res]; else S.qtys[res]=v;
    await recompute(); renderParam(); });
  swapFilterAndRender();
}
function posSection(a){

  if(!S.manualCode) return "";
  return `<div class="allrasc"><span class="manual-tag">выбрано вручную из дерева · <a id="clearManual">сбросить → визард</a></span></div>`;
}
function refWindow(r){
  const T=["📦 Ресурсы","⚙ Поправки","📋 Характеристики","💰 Стоимость"];
  const tabs = T.map((t,i)=>`<button class="ref-tab ${i===S.refTab?'active':''}" data-tab="${i}">${t}</button>`).join("");
  const resRow = x=>{
    const origCode = x["шифр_orig"] || x["шифр"];
    const seed = String(x["наименование"]||"").trim().split(/\s+/)[0].toLowerCase();
    const excluded = !!x["исключён"];
    let nm = esc(x["наименование"]);
    if(x["замена"] && !excluded){
      if(x["заменён"]){

        nm = esc(x["наименование"]);
      } else if(x["замена"]==="бетон"){
        nm += `<a class="blink bpick" data-res="${esc(x["шифр"])}" data-type="бетон" title="выбрать конкретную марку бетона">⇄ выбрать марку</a>`;
      }

    }

    if(x["по_проекту"] && !excluded && !x["заменён"])
      nm += ` <span class="pprotag" title="ресурс задаётся проектом — уточните марку (⇄) и расход">по проекту</span>`;
    const normaCell = x["ввод_кол"]
      ? `<input class="qin${x["кол_задан"]?" set":""}" type="number" step="any" min="0" data-res="${esc(origCode)}"
           value="${x["кол_задан"]?String(x["норма"]).replace(',','.'):''}" placeholder="по проекту" title="расход — задаётся проектом"/>`
      : (x["по_проекту"] && !excluded)
      ? `<input class="qin${x["кол_задан"]?" set":""}" type="number" step="any" min="0" data-res="${esc(origCode)}"
           value="${String(x["норма"]).replace(',','.')}" title="расход по проекту — при необходимости уточните"/>`
      : esc(x["норма"]);

    let ctrl;
    if(excluded){
      ctrl = `<button class="rbtn rrestore" data-restore="${esc(origCode)}" title="вернуть ресурс в смету">Вернуть</button>`;
    } else if(x["заменён"]){
      ctrl = `<span class="rdot rdrop" data-drop="${esc(origCode)}" title="исключить ресурс"></span>`
           + `<button class="rbtn rrevert" data-revert="${esc(x["шифр_orig"]||origCode)}" title="отменить замену, вернуть «по проекту»">Вернуть</button>`;
    } else {
      const dropDot = `<span class="rdot rdrop" data-drop="${esc(origCode)}" title="исключить ресурс"></span>`;
      const swapDot = (x["замена"])
        ? `<span class="rdot rswap bpick" data-res="${esc(x["шифр"])}" data-type="${x["замена"]==="бетон"?"бетон":"ресурс"}" data-seed="${esc(seed)}" title="заменить ресурс"></span>` : "";
      ctrl = dropDot + swapDot;
    }
    const trCls = excluded ? "r-excluded" : ((x["замена"]||x["ввод_кол"])?"r-beton":"");
    return `<tr class="${trCls}"><td><span class="rdots">${ctrl}</span>${esc(x["шифр"])}</td><td>${nm}</td>
      <td>${esc(x["ед"])}</td><td class="num">${normaCell}</td></tr>`;
  };
  const resRows = r["ресурсы"].map(resRow).join("");

  const dob = r["добор_ресурсы"]||[];
  const dobBlock = dob.length
    ? `<tr class="dob-sep"><td colspan="4">+ добавочная норма «на каждые след. м» · К=${esc(r["n_dob"])} · ${esc(r["добор_shifr"])}</td></tr>`
      + dob.map(resRow).join("")
    : "";
  let betonPanel = "";
  const swapReady = S.betonPickFor && (S.swapType==="бетон" ? S.betonLib : S.matLib);
  if(swapReady && S.swapType==="бетон"){
    const chips = (S.betonLib["классы"]||[]).map(c=>`<button class="bchip${S.betonClass===c?' on':''}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
    betonPanel = `<div class="beton-panel">
      <div class="bph"><b>Замена бетона «по проекту» → марка</b>
        <a id="bCancel" class="bx" title="закрыть">✕</a></div>
      <div class="bsub">Быстро по классу (тяжёлый):</div>
      <div class="bchips">${chips}</div>
      <input id="bSearch" class="bsearch" placeholder="или поиск: класс, марка (М-300), морозост. (F150), фракция…" value="${esc(S.betonQuery||"")}"/>
      <div class="blist"></div><div class="muted bmore"></div></div>`;
  } else if(swapReady){
    betonPanel = `<div class="beton-panel">
      <div class="bph"><b>Заменить ресурс «по проекту»</b> · поиск по справочнику ресурсов
        <button id="swapUserBtn" class="btn btn-mini" title="заменить на свой ресурс">👤 Данные пользователя</button>
        <a id="bCancel" class="bx" title="закрыть">✕</a></div>
      <div class="bsub">Показаны материалы по типу строки — измените/очистите поиск для всего каталога (7045). Или «Данные пользователя» — свой ресурс.</div>
      <input id="bSearch" class="bsearch" placeholder="поиск материала: название, тип, размер/диаметр…" value="${esc(S.betonQuery||"")}"/>
      <div class="blist"></div><div class="muted bmore"></div></div>`;
  }
  const nDrop = (S.drops && S.drops.size) ? S.drops.size : 0;
  const exclBanner = nDrop ? `<div class="res-excluded">Исключено ресурсов: <b>${nDrop}</b><a id="restoreDrops">вернуть все</a></div>` : "";
  const pane0 = `<table class="res"><thead><tr><th>Шифр</th><th>Наименование ресурса</th><th>Ед.</th>
    <th class="num">Норма</th></tr></thead><tbody>${resRows}${dobBlock}</tbody></table>${exclBanner}${betonPanel}
    <div class="hint" style="margin-top:8px">Кружки в шифре: <span class="rdot rdrop" style="cursor:default"></span> исключить · <span class="rdot rswap" style="cursor:default"></span> заменить ресурс.</div>`;
  const pops = (r["поправки"]||[]).map(c=>{
    const ex=(c["исключить"]||[]).length, rk=Object.keys(c["ресурс_коэф"]||{}).length;
    let ops="";
    if(ex) ops+=`<span class="pop-op" style="color:#c0392b">· убрать ${ex} рес.</span>`;
    if(rk) ops+=`<span class="pop-op" style="color:#2E75B6">· точечно ${rk} рес.</span>`;
    return `<label class="pop"><input type="checkbox" data-pt="${esc(c["пункт"])}"
      ${S.picks.has(c["пункт"])?'checked':''}/>
      <span><span class="pt">п.${esc(c["пункт"])}</span><span class="pk">×труд ${esc(c["коэф_труд"])} / ×маш ${esc(c["коэф_маш"])}</span>${ops} — ${esc(c["усл"]||"")}</span></label>`;
  }).join("");

  const OP_LABEL_KB = {"norm.redirect":"🔀 другой сборник","norm.gate":"🧭 выбор нормы",
    "res.add":"➕ ресурс","res.drop":"➖ ресурс","res.scale":"× ресурс","res.replace":"⇄ ресурс"};
  const tchOps = (r["техчасти_ops"]||[]).map(op=>
    `<div class="pop-tch"><b>${esc(OP_LABEL_KB[op.op]||op.op)}</b> ${esc(op.citation||"")}
      <span class="muted">(${esc(op.source||"")})</span></div>`).join("");
  const seismic = r["поправка_сейсмика_авто"];
  const tchAuto = seismic ? `<div class="pop-tch"><b>📎 сейсмика</b> ${esc(seismic.note||seismic.citation||"")}
      <span class="muted">(${esc(seismic.source||"")})</span></div>` : "";
  const tchBlock = (tchOps||tchAuto) ? `<div class="pop-tch-block">${tchOps}${tchAuto}</div>` : "";
  const pane1 = (pops || `<div class="muted" style="padding:10px 4px">Применимых поправок раздела 3 для этой расценки нет.</div>`) + tchBlock;

  const harRow=(k,v)=>`<div class="har-row"><span class="hk">${esc(k)}</span><span class="hv">${esc(v)}</span></div>`;
  let pane2;
  if(r["характеристики_список"]){
    pane2 = r["характеристики_список"].map(([k,v])=>harRow(k,v)).join("");
  } else {
    const har = Object.entries(r["характеристики"]||{}).filter(([k,v])=>v && k!=="dobavka").map(([k,v])=>harRow(k,v)).join("");
    pane2 = harRow("Шифр расценки", r.shifr) + harRow("Измеритель", r["измеритель"]) + har;
  }

  const sostRaw = (r["состав"]!=null && r["состав"]!=="") ? String(r["состав"])
                : ((S.analyze && S.analyze["состав_работ"]) ? String(S.analyze["состав_работ"]) : "");
  if(sostRaw){
    const items = sostRaw.split(/\s+(?=\d{1,2}\s*\.)/).filter(x=>x.trim());
    pane2 += `<div class="har-row har-sost-head"><span class="hk">Состав работ</span></div>`
      + `<div class="sostav">` + items.map(it=>`<div class="sostav-item">${esc(it.trim())}</div>`).join("") + `</div>`;
  }
  const pane3 = `<div class="muted" style="padding:10px 4px">Стоимостные показатели (цены ресурсов × нормы) — следующий этап.</div>`;
  const panes=[pane0,pane1,pane2,pane3];
  return `<div class="ref-tabs">${tabs}</div>` +
    panes.map((p,i)=>`<div class="ref-pane ${i===S.refTab?'active':''}" data-pane="${i}">${p}</div>`).join("");
}
function bindRefTabs(){
  document.querySelectorAll(".ref-tab").forEach(t=>{
    t.onclick=()=>{ S.refTab=+t.dataset.tab;
      document.querySelectorAll(".ref-tab").forEach(x=>x.classList.toggle("active",x===t));
      document.querySelectorAll(".ref-pane").forEach(p=>p.classList.toggle("active",+p.dataset.pane===S.refTab));
    };
  });
}
function bindPops(){
  document.querySelectorAll(".pop input").forEach(cb=>{
    cb.onchange=()=>{ const pt=cb.dataset.pt; cb.checked?S.picks.add(pt):S.picks.delete(pt);
      const add=$("#addBtn"); if(!add.classList.contains("hidden")) add.textContent="+ Добавить в смету  (поправок: "+S.picks.size+")";
      syncPicksToRow(); };
  });
}
function syncPicksToRow(){
  if(!S.comp || S.comp.error) return;
  const row = (S.editingSrc!=null && S.rows[S.editingSrc] && S.rows[S.editingSrc].shifr===S.comp.shifr)
            ? S.rows[S.editingSrc] : S.rows.find(x=>x.shifr===S.comp.shifr);
  if(row){ row.picks=[...S.picks]; renderNaked();
    toast("Поправки строки "+S.comp.shifr+" обновлены: "+S.picks.size); }
}

function snapshot(){
  S.history.push(JSON.stringify(S.rows));
  if(S.history.length>50) S.history.shift();
  S.smetaDirty = true;
  smetaAutoSoon();
  syncUndoBtn();
}
function undo(){
  if(!S.history.length) return;
  S.rows = JSON.parse(S.history.pop());
  renderNaked();
  if(S.comp && !S.comp.error) renderParam();
  syncUndoBtn();
  toast("Действие отменено");
}
function syncUndoBtn(){ const off=!S.history.length;
  [$("#undoBtn"), $("#undoBtnGrid")].forEach(b=>{ if(b) b.disabled=off; }); }

function duplicateRow(i){
  const r=S.rows[i]; if(!r || r.sec) return;
  snapshot();
  const copy=JSON.parse(JSON.stringify(r));
  S.rows.splice(i+1,0,copy);
  renderNaked();
  toast("Дубль строки: "+(copy.shifr||""));
}

function smetaRowMatch(it){
  const q=(S.smetaQuery||"").toLowerCase().trim();
  if(!q) return true;
  const hay=((it.shifr||"")+" "+(it.name||"")+" "+(it.kind||"")).toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(t=>hay.includes(t));
}

function _addSmetaRow(row){
  if(S.selRow!=null && S.selRow>=0 && S.selRow<S.rows.length){
    S.rows.splice(S.selRow+1, 0, row); S.selRow++;
  } else { S.rows.push(row); S.selRow = S.rows.length-1; }
}
function addToSmeta(){
  if(!S.comp || S.comp.error) return;

  const swapSel = (S.comp["ресурсы"]||[]).filter(x=>x["заменён"]).map(x=>esc(x["наименование"]));
  const unfilled = (S.comp["ресурсы"]||[]).filter(x=>x["ввод_кол"] && !x["кол_задан"]).length;
  snapshot();
  _addSmetaRow({ wc:S.wc, objem:S.objem, choices:Object.assign({},S.choices),
    picks:[...S.picks], code:S.manualCode, swaps:Object.assign({},S.swaps), qtys:Object.assign({},S.qtys),
    drops:[...(S.drops||[])], krat:S.krat||1, kratText:S.kratText||"", krat_text:S.kratText||"",
    shifr:S.comp.shifr, name:S.comp["наименование"],
    izm:S.analyze.izmeritel, nres:S.comp["ресурсы"].length, swap:swapSel });
  S.smetaDirty = true;
  renderNaked(); renderParam();
  hideWorkPopup();
  toast("Добавлено в смету: "+S.comp.shifr+" · работ: "+S.rows.filter(r=>!r.sec).length);
  if(unfilled) toast(unfilled+" материал(ов) «по проекту» без расхода — задайте, иначе не попадут в смету","err");

  const ppro=(S.comp["ресурсы"]||[]).filter(x=>x["по_проекту"] && !x["кол_задан"] && !x["заменён"] && !x["исключён"]).length;
  if(ppro) toast(ppro+" материал(ов) «по проекту» — уточните марку/расход (взяты справочные)");
}
function _mapWorkRow(r){
  if(r.prebuilt){ const p=Object.assign({},r.prebuilt); p["объём"]=r.objem; return {prebuilt:p}; }

  if(r.material) return {material:true, name:r.name||"", objem:r.objem, izm:r.izm||"", mat_code:r.mat_code||""};
  return {wc:r.wc, objem:r.objem, choices:r.choices, picks:r.picks,
    code:r.code, swaps:r.swaps||{}, qtys:r.qtys||{}, drops:r.drops||[],
    krat:r.krat||1, krat_text:r.kratText||r.krat_text||""};
}
function smetaWorkRows(){
  return S.rows.filter(r=>!r.sec).map(_mapWorkRow);
}
function smetaRows(){
  const lbl=sectionLabels();
  return S.rows.map((r,i)=> r.cond ? {cond:true, sec_id:r.sec_id, section:r.section, num:r.num, usl:r.usl, kzt:r.kzt, kem:r.kem, text:r.text, group:r.group||"MAIN"}
    : (r.sec ? {sec:true, kind:r.kind, name:r.name, num:lbl[i]||""} : _mapWorkRow(r)));
}
async function addPerevozkaDist(){
  const text=(prompt("Груз (для наименования), напр. «грунт»:","грунт")||"").trim();
  const km=parseFloat(prompt("Расстояние перевозки, км:","10")||"");
  if(!(km>0)){ toast("Не задано расстояние","err"); return; }
  const t=parseFloat(prompt("Объём перевозки, тонн:","100")||"");
  if(!(t>0)){ toast("Не задан объём (т)","err"); return; }
  let d;
  try{ d=await (await api("/api/perevozka_dist",{method:"POST",
    body:JSON.stringify({text, L_km:km, tonnes:t})})).json(); }
  catch(e){ toast("Ошибка расчёта перевозки","err"); return; }
  if(!d || d.error || !d.resolved){ toast(d&&d.error?d.error:"Нет нормы на это расстояние","err"); return; }
  snapshot();
  _addSmetaRow({prebuilt:d.resolved, dist:true, shifr:d.shifr, name:d.name,
    objem:t, izm:"т", nres:d.nres, picks:[], drops:[], krat:1});
  renderNaked();
  toast("Перевозка добавлена: "+d.shifr+" · "+t+" т");
}
function renderNaked(skipGrid){
  const has = S.rows.length>0;
  if(!has){ S.smetaQuery=""; const gf=$("#gridFilter"); if(gf){ gf.value=""; } }
  const cb=$("#clearBtn"); if(cb) cb.disabled=!has;
  if(!skipGrid) scheduleLiveRender();
}
function sectionLabels(){
  let R=0, P=0; const map={};
  S.rows.forEach((it,i)=>{
    if(!it.sec) return;
    if(it.kind==="Подраздел"){ P++; map[i] = (R>0 ? R+"." : "")+P; }
    else { R++; P=0; map[i] = ""+R; }
  });
  return map;
}
function moveSmetaRow(src, dir){
  const j=src+dir; if(j<0||j>=S.rows.length) return;
  snapshot();
  const t=S.rows[src]; S.rows[src]=S.rows[j]; S.rows[j]=t; renderNaked();
}
async function openWorkInPodbor(src){
  const r=S.rows[src]; if(!r||r.sec){ return; }
  if(!r.wc){ toast("Поправки доступны только для обычных расценок","err"); return; }
  await selectWork(r.wc);
  S.editingSrc = src;
  S.objem = r.objem||0; S.choices = Object.assign({}, r.choices||{});
  S.picks = new Set(r.picks||[]); S.drops = new Set(r.drops||[]);
  S.swaps = Object.assign({}, r.swaps||{}); S.qtys = Object.assign({}, r.qtys||{});
  S.manualCode = r.code||null; S.krat = r.krat||1; S.kratText = r.kratText||"";
  S.refTab = 1;
  await recompute(); renderParam();
  toast("Работа в подборе — меняй поправки слева, смета пересчитается");
}

function closePopr(){ const m=$("#poprModal"); if(m) m.classList.add("hidden"); }
async function openPopr(src){
  const r=S.rows[src]; if(!r||r.sec) return;
  if(r.prebuilt||r.extra||r.dist){ toast("У этой строки нет поправок техчасти","err"); return; }
  if(!Array.isArray(r.picks)) r.picks=[];
  $("#poprTitle").textContent="⚙ Поправки технической части";
  $("#poprSub").textContent="загрузка…";
  $("#poprBody").innerHTML=`<div class="popr-empty">⏳ Загрузка поправок…</div>`;
  $("#poprModal").classList.remove("hidden");
  let comp;
  try{ comp=await (await api("/api/compute",{method:"POST",body:JSON.stringify({wc:r.wc, objem:r.objem||100, choices:r.choices||{}, swaps:r.swaps||{}, qtys:r.qtys||{}, drops:r.drops||[]})})).json(); }
  catch(e){ $("#poprBody").innerHTML=`<div class="popr-empty">⚠ Ошибка загрузки поправок</div>`; return; }
  const pops=(comp&&comp["поправки"])||[];
  $("#poprTitle").textContent="⚙ Поправки — "+(comp.shifr||r.shifr||"");
  $("#poprSub").textContent=String(r.name||comp["наименование"]||"");
  if(!pops.length){ $("#poprBody").innerHTML=`<div class="popr-empty">🚫 Применимых поправок раздела 3 для этой расценки нет.</div>`; return; }
  const card=c=>{
    const pt=String(c["пункт"]), on=r.picks.includes(pt);
    const ex=(c["исключить"]||[]).length, rk=Object.keys(c["ресурс_коэф"]||{}).length;
    const chips=[`<span class="chip chip-trud">×труд ${esc(c["коэф_труд"])}</span>`,
                 `<span class="chip chip-mash">×маш ${esc(c["коэф_маш"])}</span>`];
    if(ex) chips.push(`<span class="chip chip-ex">− ${ex} рес.</span>`);
    if(rk) chips.push(`<span class="chip chip-pt">точечно ${rk} рес.</span>`);
    return `<div class="popr-card-item${on?' on':''}" data-pt="${esc(pt)}" role="button" tabindex="0">
      <span class="popr-toggle">✓</span>
      <div class="popr-main">
        <div class="popr-h"><span class="popr-pt">п.${esc(pt)}</span><span class="popr-usl">${esc(c["усл"]||"условие не указано")}</span></div>
        <div class="popr-chips">${chips.join("")}</div>
      </div></div>`;
  };
  $("#poprBody").innerHTML=`<div class="popr-grid">${pops.map(card).join("")}</div>
    <div class="popr-foot"><span class="popr-applied">Применено: <b>${r.picks.length}</b> из ${pops.length}</span>
      <button class="btn btn-primary btn-mini" id="poprDone">Готово</button></div>`;
  const toggle=el=>{
    const pt=el.dataset.pt, i=r.picks.indexOf(pt);
    if(i>=0){ r.picks.splice(i,1); el.classList.remove("on"); }
    else { r.picks.push(pt); el.classList.add("on"); }
    const a=$(".popr-applied b"); if(a) a.textContent=r.picks.length;
    renderNaked();
  };
  $("#poprBody").querySelectorAll(".popr-card-item").forEach(el=>{
    el.onclick=()=>toggle(el);
    el.onkeydown=k=>{ if(k.key===" "||k.key==="Enter"){ k.preventDefault(); toggle(el); } };
  });
  const dn=$("#poprDone"); if(dn) dn.onclick=closePopr;
}
function insertSection(at){
  const t=(prompt("Тип:  1 — Раздел,  2 — Подраздел","1")||"").trim();
  const kind = t==="2" ? "Подраздел" : "Раздел";
  const name=(prompt(kind+" — название:","")||"").trim();
  if(!name) return;
  snapshot();
  S.rows.splice(at,0,{sec:true,kind,name}); renderNaked();
  toast(kind+" вставлен: "+name);
}
let _dragFrom=null;
function bindDragRows(n){
  n.querySelectorAll("[draggable=true]").forEach(el=>{
    el.ondragstart=e=>{ _dragFrom=+el.dataset.i; e.dataTransfer.effectAllowed="move"; el.classList.add("dragging"); };
    el.ondragend=()=>{ el.classList.remove("dragging"); n.querySelectorAll(".dragover").forEach(x=>x.classList.remove("dragover")); };
    el.ondragover=e=>{ e.preventDefault(); el.classList.add("dragover"); };
    el.ondragleave=()=>el.classList.remove("dragover");
    el.ondrop=e=>{ e.preventDefault(); el.classList.remove("dragover");
      const to=+el.dataset.i; if(_dragFrom===null||_dragFrom===to){ _dragFrom=null; return; }
      snapshot(); const [m]=S.rows.splice(_dragFrom,1); S.rows.splice(to,0,m); _dragFrom=null; renderNaked(); };
  });
}

async function formSmeta(){
  const d = await (await api("/api/smeta",{method:"POST",
    body:JSON.stringify({rows:smetaRows()})})).json();
  $("#smetaMeta").textContent = `${d.n_works} работ · ${d.n_res} ресурсных строк`;
  let wn=0;
  const works = d.works.map((w)=>{
    if(w.sec){ return `<div class="smeta-sec${w.kind==='Подраздел'?' sub':''}">${esc(w.kind)}${w.num?' '+esc(w.num):''}: ${esc(w["наим"])}</div>`; }
    if(w.cond){ const kt="Кзтр "+fmt(w.kzt)+((w.kem&&Number(w.kem)!==1)?(" · Кэм "+fmt(w.kem)):"");
      return `<div class="smeta-sec cond">📐 УСЛОВИЯ · ${esc(kt)} · ${esc(w.scope==='раздел'?'на раздел':'на всю смету')}: ${esc(w.text||w.usl||"")}</div>`; }
    if(w.err){ return `<div class="smeta-sec err">⚠ Расценка не найдена в базе: ${esc(w["наим"]||w["код"]||"")} — удалите строку или подберите заново</div>`; }
    wn++;
    const rows=w["ресурсы"].map(rr=>`<tr><td>${esc(rr["шифр"])}</td><td>${esc(rr["наим"])}</td>
      <td>${esc(rr["ед"])}</td><td class="num">${esc(fmt(rr["норма"]))}</td><td class="num">${esc(fmt(rr["кол"]))}</td></tr>`).join("");
    return `<div class="smeta-work"><div class="swh">${w["статус"]} №${wn} · ${esc(w["код"])} · ${esc(w["наим"])}${w["попр"]?`<span class="popr-i">${esc(w["попр"])}</span>`:""} (объём ${esc(fmt(w["объём"]))}, Кр=${esc(fmt(w["Кр"]))})</div>
      <table class="res"><thead><tr><th>Шифр</th><th>Наименование</th><th>Ед.</th><th class="num">Норма</th><th class="num">Кол-во</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
  const svod = d.svod.filter(s=>s.items.length).map(s=>{
    const rows=s.items.map(it=>`<tr><td>${esc(it["шифр"])}</td><td>${esc(it["наим"])}</td>
      <td>${esc(it["ед"])}</td><td class="num">${esc(fmt(it["кол"]))}</td></tr>`).join("");
    return `<div class="svod-title">${esc(s.title)}</div>
      <table class="res"><thead><tr><th>Шифр</th><th>Наименование</th><th>Ед.</th><th class="num">Кол-во по проекту</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join("");
  $("#smetaBody").innerHTML = works + svod;
  $("#smetaModal").classList.remove("hidden");
}

let UNI=null;                                   // univerAPI
function initUniver(){
  if(UNI) return UNI;
  try{
    const host=$("#univerHost"); if(host) host.innerHTML="";
    const { createUniver } = UniverPresets;
    const { LocaleType } = UniverCore;
    const { UniverSheetsCorePreset } = UniverPresetSheetsCore;
    const r = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: window.UniverPresetSheetsCoreRuRU || {} },
      presets: [ UniverSheetsCorePreset({ container: 'univerHost' }) ],
    });
    UNI = r.univerAPI; UNI.createWorkbook({ name: 'ЛРВ' });
  }catch(e){ console.error("Univer init fail:", e); toast("Не удалось открыть эксель-редактор","err"); }
  return UNI;
}

function _lUu(s){ s=String(s||"").toUpperCase().replace(/³/g,"3").replace(/²/g,"2"); return s.replace(/^(\d{2,}) ([А-Я]\d?)$/,"$1$2"); }
function _lRu(x){ if(x===null||x===undefined||x==="") return ""; let f=parseFloat(String(x).replace(",",".")); if(isNaN(f)) return String(x); let s=f.toFixed(8).replace(/0+$/,"").replace(/\.$/,""); return (s||"0").replace(".",","); }
function _lStrip(c){ let s=String(c||"").trim(); let m=s.replace(/^[^\d]+/,""); return m||s; }
function _lSostav(s){ s=String(s||"").trim(); if(!s) return []; return s.split(/\s+(?=\d{1,2}\s*\.)/).map(p=>p.trim()).filter(Boolean); }
function _lProj(objem,izm){ let m=String(izm||"").match(/^\s*(\d+(?:[.,]\d+)?)/); let mult=m?parseFloat(m[1].replace(",",".")):1; let v=parseFloat(String(objem||"").replace(",",".")); if(isNaN(v)) return objem; return mult?(v/mult):v; }

const _RESCOLOR={"труд":"#7A4FA0","машины":"#1F8A5B","материалы":"#1F3864"};
function _resType(ed){ ed=String(ed||"").toUpperCase(); return /ЧЕЛ/.test(ed)?"труд":/МАШ/.test(ed)?"машины":"материалы"; }
async function renderLRV(){
  if(!initUniver()){ return; }
  let d;
  try{ d = await (await api("/api/smeta",{method:"POST",body:JSON.stringify({rows:smetaRows()})})).json(); }
  catch(e){ toast("Ошибка формирования сметы","err"); return; }
  const sheet = UNI.getActiveWorkbook().getActiveSheet();
  const TNR="Times New Roman", CYAN="#CCFFFF", NUM="00-1-1";
  const BS=(typeof UniverCore!=="undefined"&&UniverCore.BorderStyleTypes)||{};
  const THIN=(BS.THIN!=null?BS.THIN:1), PEN={style:THIN, color:"#000000"};

  const rows=[];
  const P=(cells,kind,t)=> rows.push({c:cells.concat(Array(6).fill("")).slice(0,6), k:kind, t:t||""});
  P(["","","","","Форма N 5",""],"formno");
  P([""],"und");
  P(["(наименование стройки)"],"capit");                    // 3
  P(["ЛОКАЛЬНАЯ РЕСУРСНАЯ ВЕДОМОСТЬ   № "+NUM],"bigttl");    // 4: TNR12 bold
  P(["(локальная ресурсная смета)"],"capit");               // 5
  P(["на   "],"und");
  P(["(наименование работ и затрат, наименование объекта)"],"capit"); // 7
  P(["Основание:   "],"undl");
  P(["N п.п.","Шифр номера нормативов и коды ресурсов","Наименование работ и затрат","Единица измерения","Количество",""],"hdr1");
  P(["","","","","на. ед. измерения","по проектным данным"],"hdr2");
  P(["1","2","3","4","5","6"],"hdrn");
  let n=0;
  (d.works||[]).forEach(w=>{
    if(w.sec){ const num=w.num?(" "+w.num):""; P([((w.kind?(w.kind+num+": "):"")+String(w["наим"]||"").toUpperCase())],"sec"); return; }
    n++;
    let code=String(w["код"]||"—"), shifr=/^\d/.test(code)?("Е"+code):code;
    P([String(n), shifr, String(w["наим"]||"").toUpperCase(), _lUu(w["измеритель"]), _lRu(_lProj(w["объём"],w["измеритель"])), ""],"work");
    const items=_lSostav(w["состав"]);
    if(items.length){ P(["","","СОСТАВ РАБОТ:","","",""],"sost"); items.forEach(it=> P(["","",it,"","",""],"sost")); }
    (w["ресурсы"]||[]).forEach((r,k)=>{ const ed=_lUu(r["ед"]);
      P([n+"."+(k+1), _lStrip(r["шифр"]), String(r["наим"]||"").toUpperCase(), ed, _lRu(r["норма"]), _lRu(r["кол"])],"res",_resType(ed)); });
  });
  P(["ИТОГО ПО ЛОКАЛЬНОЙ РЕСУРСНОЙ ВЕДОМОСТИ:"],"itg");
  let jj=0;
  (d.svod||[]).filter(s=>s.items&&s.items.length).forEach(s=>{
    const st=/ТРУД/.test(s.title)?"труд":/МАШИН/.test(s.title)?"машины":"материалы";
    P([s.title],"svh");
    s.items.forEach(it=>{ jj++; let sc=_lStrip(it["шифр"]); sc=sc.replace(/^0+/,"")||sc;
      P([String(jj), sc, String(it["наим"]||"").toUpperCase(), _lUu(it["ед"]), "", _lRu(it["кол"])],"svi",st); });
  });

  const data=rows.map(r=>r.c), N=data.length, W=[34,84,262,58,60,88];
  const R=(i,a,b)=> sheet.getRange(i, a==null?0:a, 1, b==null?6:b);
  const hi=rows.findIndex(r=>r.k==="hdr1");
  try{
    sheet.getRange(0,0,Math.max(N+6,90),8).setValue("");
    sheet.getRange(0,0,Math.max(N+6,90),8).setBackground("#FFFFFF");
    sheet.getRange(0,0,N,6).setValues(data);
    W.forEach((w,i)=>{ try{ sheet.setColumnWidth(i,w); }catch(e){} });
    try{ sheet.getRange(0,0,N,6).setFontFamily(TNR).setFontSize(9).setFontColor("#000000").setWrap(true).setVerticalAlignment("top"); }catch(e){}
    const UND=(i,al)=>{ try{ R(i).merge().setHorizontalAlignment(al||"center").setVerticalAlignment("bottom").setBorder("bottom",PEN); }catch(e){} };
    rows.forEach((r,i)=>{ try{
      const k=r.k;
      if(k==="formno"){ sheet.getRange(i,4,1,2).merge().setHorizontalAlignment("center").setFontSize(8); }
      else if(k==="und"){ UND(i,"center"); }
      else if(k==="undl"){ UND(i,"left"); }
      else if(k==="capit"){ R(i).merge().setHorizontalAlignment("center").setVerticalAlignment("middle").setFontSize(8); }
      else if(k==="bigttl"){ R(i).merge().setHorizontalAlignment("center").setVerticalAlignment("middle").setFontWeight("bold").setFontSize(12); }
      else if(k==="sec"){ R(i).merge().setBackground(CYAN).setHorizontalAlignment("left").setVerticalAlignment("middle").setFontWeight("bold").setFontSize(10); }
      else if(k==="itg"||k==="svh"){ R(i).merge().setBackground(CYAN).setHorizontalAlignment("left").setVerticalAlignment("middle").setFontWeight("bold"); }
      else if(k==="sost"){ R(i,2,1).setHorizontalAlignment("left"); }
      else if(k==="work"){ R(i).setFontWeight("bold").setFontSize(10); R(i,0,1).setHorizontalAlignment("center"); R(i,1,1).setHorizontalAlignment("left"); R(i,2,1).setHorizontalAlignment("left"); R(i,3,1).setHorizontalAlignment("center"); sheet.getRange(i,4,1,2).merge().setHorizontalAlignment("center"); }
      else if(k==="res"){ R(i,0,1).setHorizontalAlignment("center"); R(i,1,1).setHorizontalAlignment("center"); R(i,2,1).setHorizontalAlignment("left"); R(i,3,1).setHorizontalAlignment("center"); R(i,4,1).setHorizontalAlignment("center"); R(i,5,1).setHorizontalAlignment("center"); }
      else if(k==="svi"){ R(i,0,1).setHorizontalAlignment("center"); R(i,1,1).setHorizontalAlignment("center"); R(i,2,1).setHorizontalAlignment("left"); R(i,3,1).setHorizontalAlignment("center"); R(i,5,1).setHorizontalAlignment("center").setFontSize(10); }
    }catch(e){} });

    rows.forEach((r,i)=>{ if((r.k==="res"||r.k==="svi")&&_RESCOLOR[r.t]){ try{ R(i).setFontColor(_RESCOLOR[r.t]); }catch(e){} } });

    try{ for(let c=0;c<4;c++) sheet.getRange(hi,c,2,1).merge(); sheet.getRange(hi,4,1,2).merge(); }catch(e){}
    try{ sheet.getRange(hi,0,3,6).setBackground(CYAN).setHorizontalAlignment("center").setVerticalAlignment("middle"); R(hi+2).setFontWeight("bold"); }catch(e){}
    try{ sheet.getRange(hi,0,N-hi,6).setBorder("all",PEN); }catch(e){}

    const cpl=w=>Math.max(6,Math.floor(w/7.2)), nl=(t,w)=>Math.max(1,Math.ceil(String(t||"").length/cpl(w))), TOT=W.reduce((a,b)=>a+b,0);
    for(let i=0;i<N;i++){ try{
      const k=rows[i].k; let h;
      if(k==="formno"||k==="capit"||k==="und"||k==="undl") h=16;
      else if(k==="bigttl") h=22;
      else if(k==="hdr1") h=26;
      else if(k==="hdr2") h=44;
      else if(k==="hdrn") h=18;
      else if(k==="sec"||k==="itg"||k==="svh"){ h=Math.max(22, nl(data[i][0],TOT)*16+10); }
      else { const w=(k==="sost")?(W[2]+W[3]+W[4]+W[5]):W[2]; h=Math.max(22, nl(data[i][2],w)*16+12); }
      sheet.setRowHeight(i, Math.min(260,h));
    }catch(e){} }

    for(let i=0;i<N;i++){ if(rows[i].k==="res"){ try{ sheet.getRange(i,0,1,1).setValues([[{v:String(rows[i].c[0]), t:1}]]); }catch(e){} } }
  }catch(e){ console.error("renderLRV write fail:", e); toast("Ошибка отрисовки ЛРВ","err"); return; }
  await new Promise(r=>setTimeout(r,80));
  try{ UNI.getActiveWorkbook().getActiveSheet().getRange(hi+3,2,1,1).activate(); }catch(e){}
  $("#smetaNoLbl") && ($("#smetaNoLbl").textContent = `смета · ${d.n_works} работ · ${d.n_res} ресурсов`);
  toast("Смета сформирована — ЛРВ в окне справа");
}

const _RESCLS={"труд":"trud","машины":"mash","материалы":"mat"};
function lrvgHtml(d){
  const W=[48,78,230,84,54,86];
  if(!S.expSost) S.expSost=new Set();
  if(!S.colRes) S.colRes=new Set();
  const e=s=>esc(String(s==null?"":s));
  const T = S.titul || (S.titul={стройка:"",объект:"",основание:"",номер:"00-1-1"});
  let h=`<div class="lrvg-titul">
    <div class="lrvg-und"><span class="te" contenteditable="true" data-f="стройка" data-ph="наименование стройки">${e(T.стройка)}</span></div><div class="lrvg-cap">(наименование стройки)</div>
    <div class="lrvg-big">ЛОКАЛЬНАЯ РЕСУРСНАЯ ВЕДОМОСТЬ&nbsp;&nbsp;№ <span class="te" contenteditable="true" data-f="номер">${e(T.номер||"00-1-1")}</span></div>
    <div class="lrvg-cap">(локальная ресурсная смета)</div>
    <div class="lrvg-und" style="text-align:center">на <span class="te" contenteditable="true" data-f="объект" data-ph="наименование работ и объекта">${e(T.объект)}</span></div><div class="lrvg-cap">(наименование работ и затрат, наименование объекта)</div>
    <div class="lrvg-undl">Основание: <span class="te" contenteditable="true" data-f="основание" data-ph="номера чертежей">${e(T.основание)}</span></div>
  </div>`;
  h+=`<table class="lrvg"><colgroup>${W.map(w=>`<col style="width:${w}px">`).join("")}</colgroup>`;
  h+=`<thead>
    <tr class="hdr"><th rowspan="2"><span class="numn">N п.п.</span><button class="grp grp-all" title="все ресурсы: свернуть/развернуть">${S.colRes.size?'+':'−'}</button></th><th rowspan="2">Шифр номера нормативов и коды ресурсов</th>
      <th rowspan="2">Наименование работ и затрат</th><th rowspan="2">Единица измерения</th><th colspan="2">Количество</th></tr>
    <tr class="hdr"><th>на ед. измерения</th><th>по проектным данным</th></tr>
    <tr class="hdrn"><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th></tr></thead><tbody>`;
  let n=0, si=0;
  (d.works||[]).forEach(w=>{
    if(w.sec){ const src=si++; const num=w.num?(" "+w.num):"";
      h+=`<tr class="sec" data-src="${src}"><td colspan="6" class="wkname"><span class="wktools"><button class="wkup" title="выше">▲</button><button class="wkdn" title="ниже">▼</button><button class="wkdel" title="удалить раздел">🗑</button></span>${e((w.kind?(w.kind+num+": "):"")+String(w["наим"]||"").toUpperCase())}</td></tr>`; return; }
    if(w.cond){ const src=si++;
      const kTxt = "Кзтр "+e(_lRu(w.kzt)) + ((w.kem&&Number(w.kem)!==1)?(" · Кэм "+e(_lRu(w.kem))):"");
      const scope = w.scope==="раздел" ? "на раздел" : "на всю смету";
      const warn = w.warn ? `<span class="cond-warn" title="${e(w.warn)}">⚠ ${e(w.warn)}</span>` : "";
      h+=`<tr class="cond${w.warn?" cond-conflict":""}" data-src="${src}"><td colspan="6" class="wkname">`+
         `<span class="wktools"><button class="wkrepl" title="заменить условие">⇄</button><button class="wkup" title="выше">▲</button><button class="wkdn" title="ниже">▼</button><button class="wkdel" title="удалить условие">🗑</button></span>`+
         `<span class="cond-tag">📐 УСЛОВИЯ · ${kTxt} · <em>${e(scope)}</em></span>${warn}`+
         `<span class="cond-desc">${e(w.text||w.usl||"")}</span></td></tr>`; return; }
    if(w.err){ const src=si++;
      h+=`<tr class="errrow" data-src="${src}"><td colspan="6" class="wkname">`+
         `<span class="wktools"><button class="wkup" title="выше">▲</button><button class="wkdn" title="ниже">▼</button><button class="wkdel" title="удалить строку">🗑</button></span>`+
         `⚠ Расценка не найдена в базе (база обновилась): <b>${e(w["наим"]||w["код"]||"")}</b> — удалите строку или подберите заново</td></tr>`; return; }
    const src = w["доп"] ? (si-1) : (si++);
    n++;
    let code=String(w["код"]||"—"), shifr=/^\d/.test(code)?("Е"+code):code;
    const isExtra = code.toUpperCase()==="ВНЕ";
    if(isExtra){ const r0=(w["ресурсы"]||[])[0]; if(r0) shifr=String(r0["шифр"]||"—").trim(); }
    const mine = !w["доп"] && !!S.rows[src];
    const isReg = mine && !!S.rows[src].wc;
    const qty = e(_lRu(_lProj(w["объём"],w["измеритель"])));
    const qtyCell = isReg
      ? `<td class="c qty-edit" colspan="2" data-src="${src}" data-objem="${e(S.rows[src].objem)}" title="двойной клик — изменить объём">${qty}</td>`
      : `<td class="c" colspan="2">${qty}</td>`;
    const wtools = mine ? `<span class="wktools">${isReg?`<button class="wkpopr" title="поправки техчасти">ƒ</button>`:""}<button class="wkdup" title="дублировать позицию">⧉</button><button class="wkup" title="выше">▲</button><button class="wkdn" title="ниже">▼</button><button class="wkins" title="вставить раздел над работой">＋</button><button class="wkdel" title="удалить работу">🗑</button></span>` : "";
    const popr = String(w["попр"]||"").replace(/^[.\s]+/,"").trim();
    const poprHtml = popr ? `<div class="wpopr"><i class="ic" style="font-style:normal">ƒ</i> Поправка: ${e(popr)}</div>` : "";
    const showGrp=mine&&!isExtra, sostOpen=S.expSost.has(src), resOpen=!S.colRes.has(src);
    const grp = showGrp ? `<span class="grp2"><button class="grp grp-res" data-src="${src}" title="ресурсы: свернуть/развернуть">${resOpen?'−':'+'}</button><button class="grp grp-sost" data-src="${src}" title="состав работ: свернуть/развернуть">${sostOpen?'−':'+'}</button></span>` : "";
    h+=`<tr class="work" data-src="${src}"><td class="c"><span class="numn">${n}</span>${grp}</td><td class="l">${e(shifr)}</td><td class="l wkname">${wtools}${e((w["наим"]||"").toUpperCase())}${poprHtml}</td><td class="c">${e(_lUu(w["измеритель"]))}</td>${qtyCell}</tr>`;
    if(!isExtra){
    const items=_lSostav(w["состав"]);
    if(items.length && sostOpen){ h+=`<tr class="sost"><td></td><td></td><td class="l" colspan="4">СОСТАВ РАБОТ:</td></tr>`; items.forEach(it=> h+=`<tr class="sost"><td></td><td></td><td class="l" colspan="4">${e(it)}</td></tr>`); }
    if(resOpen) (w["ресурсы"]||[]).forEach((r,k)=>{ const ed=_lUu(r["ед"]), tp=_resType(ed), rc=e(r["шифр"]);
      const sw=(mine&&S.rows[src]&&S.rows[src].swaps)||{};
      const swOrig=Object.keys(sw).find(o=>String(sw[o])===String(r["шифр"]));
      const rctl = isReg
        ? (swOrig
            ? `<span class="rctl"><button class="rrev" data-orig="${esc(swOrig)}" title="вернуть исходный ресурс">↩</button><button class="rx" data-rc="${esc(swOrig)}" title="исключить ресурс">✖</button>${tp==="материалы"?`<button class="rsw" data-rc="${esc(swOrig)}" title="заменить материал">⇄</button>`:""}</span>`
            : `<span class="rctl"><button class="rx" title="исключить ресурс">✖</button>${tp==="материалы"?`<button class="rsw" title="заменить материал">⇄</button>`:""}</span>`)
        : "";
      const pproTag = r["по_проекту"] ? ` <span class="pprotag" title="ресурс задаётся проектом — уточните марку/расход в окне работы">ПО ПРОЕКТУ</span>` : "";
      h+=`<tr class="res ${_RESCLS[tp]}" data-src="${src}" data-rc="${rc}"><td class="c">${n}.${k+1}</td><td class="c">${e(_lStrip(r["шифр"]))}</td><td class="l resname">${rctl}${e((r["наим"]||"").toUpperCase())}${pproTag}</td><td class="c">${e(ed)}</td><td class="r">${e(_lRu(r["норма"]))}</td><td class="r">${e(_lRu(r["кол"]))}</td></tr>`; });
    }
    if(isReg){ const dr=(S.rows[src].drops||[]).length, sw=Object.keys(S.rows[src].swaps||{}).length;
      if(dr||sw) h+=`<tr class="editline" data-src="${src}"><td></td><td colspan="5" class="l">${dr?`⊘ исключено: ${dr}  `:""}${sw?`⇄ заменено: ${sw}  `:""}<a class="undoedit">↩ сбросить правки работы</a></td></tr>`; }
  });
  h+=`<tr class="itg"><td colspan="6">ИТОГО ПО ЛОКАЛЬНОЙ РЕСУРСНОЙ ВЕДОМОСТИ:</td></tr>`;
  let jj=0;
  (d.svod||[]).filter(s=>s.items&&s.items.length).forEach(s=>{
    const st=/ТРУД/.test(s.title)?"труд":/МАШИН/.test(s.title)?"машины":"материалы";
    h+=`<tr class="svh"><td colspan="6">${e(s.title)}</td></tr>`;
    s.items.forEach(it=>{ jj++; let sc=_lStrip(it["шифр"]).replace(/^0+/,"")||_lStrip(it["шифр"]);
      h+=`<tr class="res ${_RESCLS[st]}"><td class="c">${jj}</td><td class="c">${e(sc)}</td><td class="l">${e((it["наим"]||"").toUpperCase())}</td><td class="c">${e(_lUu(it["ед"]))}</td><td class="r"></td><td class="r">${e(_lRu(it["кол"]))}</td></tr>`; });
  });
  h+=`</tbody></table>`;
  return h;
}

function applyGridZoom(){
  const host=$("#lrvgHost"); if(!host) return;
  const t=host.querySelector("table.lrvg"); if(!t) return;
  const z=S.gridZoom||1;
  t.style.transformOrigin="top left";
  t.style.transform = (z!==1) ? ("scale("+z+")") : "";
}

function _highlightSel(){
  if(S.selRow==null) return; const host=$("#lrvgHost"); if(!host) return;
  const tr=host.querySelector('tbody tr[data-src="'+S.selRow+'"]'); if(tr) tr.classList.add("sel");
}

function redrawGrid(){
  const host=$("#lrvgHost"); if(!host || !S._grid) return;
  const prev=host.scrollTop;
  host.innerHTML = lrvgHtml(S._grid);
  host.scrollTop = prev;
  applyGridZoom(); _highlightSel();
  host.querySelectorAll(".te[contenteditable]").forEach(el=>{
    el.onblur=()=>{ if(!S.titul) S.titul={}; S.titul[el.dataset.f]=el.textContent.replace(/\s+/g," ").trim(); };
    el.onkeydown=k=>{ if(k.key==="Enter"){ k.preventDefault(); el.blur(); } };
  });
  applyGridFilter();
}
let _gridGen=0;
async function renderLRVGrid(silent){
  const host=$("#lrvgHost"); if(!host) return;
  const gen = ++_gridGen;
  let d;
  try{ d = await (await api("/api/smeta",{method:"POST",body:JSON.stringify({rows:smetaRows()})})).json(); }
  catch(e){ if(!silent) toast("Ошибка формирования сметы","err"); return; }
  if(gen!==_gridGen) return;
  if(!(S.rows && S.rows.some(r=>!r.sec))){ scheduleLiveRender(); return; }
  S._grid = d;
  const prevScroll = host.scrollTop;
  host.innerHTML = lrvgHtml(d);
  host.scrollTop = prevScroll;
  applyGridZoom(); _highlightSel();
  host.onclick = ev=>{
    const gres=ev.target.closest(".grp-res"), gsost=ev.target.closest(".grp-sost"), gall=ev.target.closest(".grp-all");
    if(gres||gsost||gall){ ev.stopPropagation();
      if(gall){ const srcs=[...host.querySelectorAll("tr.work")].map(t=>+t.dataset.src);
        if(S.colRes.size) S.colRes.clear(); else srcs.forEach(s=>S.colRes.add(s)); }
      else if(gres){ const s=+gres.dataset.src; S.colRes.has(s)?S.colRes.delete(s):S.colRes.add(s); }
      else { const s=+gsost.dataset.src; S.expSost.has(s)?S.expSost.delete(s):S.expSost.add(s); }
      redrawGrid(); return; }
    const rx=ev.target.closest(".rx"), rsw=ev.target.closest(".rsw"), und=ev.target.closest(".undoedit"), rrev=ev.target.closest(".rrev");
    if(rx||rsw||und||rrev){ ev.stopPropagation(); const tr=ev.target.closest("tr"); const src=+tr.dataset.src; if(!S.rows[src]) return;
      if(rx){ snapshot(); const rc=(rx.dataset.rc||tr.dataset.rc); if(!Array.isArray(S.rows[src].drops)) S.rows[src].drops=[]; if(!S.rows[src].drops.includes(rc)) S.rows[src].drops.push(rc); if(S.rows[src].swaps) delete S.rows[src].swaps[rc]; renderNaked(); toast("Ресурс исключён"); }
      else if(rsw){ openResPicker("swap", (rsw.dataset.rc||tr.dataset.rc), src); }
      else if(rrev){ snapshot(); if(S.rows[src].swaps) delete S.rows[src].swaps[rrev.dataset.orig]; renderNaked(); toast("Замена отменена"); }
      else if(und){ snapshot(); S.rows[src].drops=[]; S.rows[src].swaps={}; renderNaked(); toast("Правки работы сброшены"); }
      return; }
    const up=ev.target.closest(".wkup"), dn=ev.target.closest(".wkdn"), ins=ev.target.closest(".wkins"), del=ev.target.closest(".wkdel"), popr=ev.target.closest(".wkpopr"), dup=ev.target.closest(".wkdup"), repl=ev.target.closest(".wkrepl");
    if(up||dn||ins||del||popr||dup||repl){ ev.stopPropagation(); const tr=ev.target.closest("tr"); const src=+tr.dataset.src;
      if(up) moveSmetaRow(src,-1);
      else if(dn) moveSmetaRow(src,1);
      else if(ins) insertSection(src);
      else if(dup) duplicateRow(src);
      else if(popr) openPopr(src);
      else if(repl) openUslov(src);
      else if(del){ const it=S.rows[src]; if(it){ if(!it.sec && !it.cond && !confirm("Удалить работу из сметы?")) return; snapshot(); S.rows.splice(src,1); if(S.selRow!=null && S.selRow>=src) S.selRow=Math.max(-1,S.selRow-1); renderNaked(); toast(it.cond?"Условие удалено":"Удалено"); } }
      return; }
    const tr=ev.target.closest("tbody tr"); if(!tr) return;
    host.querySelectorAll("tr.sel").forEach(t=>t.classList.remove("sel")); tr.classList.add("sel");
    if(tr.dataset.src!=null) S.selRow=+tr.dataset.src;
  };
  host.ondblclick = ev=>{
    const td=ev.target.closest("td.qty-edit"); if(!td || td.querySelector("input")) return;
    const src=+td.dataset.src, cur=td.dataset.objem;
    td.innerHTML=`<input type="number" step="any" min="0" class="qtyin" value="${esc(cur)}"/>`;
    const inp=td.querySelector("input"); inp.focus(); inp.select();
    let done=false;
    const commit=ok=>{ if(done) return; done=true;
      if(ok){ const v=parseFloat(inp.value); if(v>0 && S.rows[src]){ S.rows[src].objem=v; renderNaked(); } }
      renderLRVGrid(true); };
    inp.onblur=()=>commit(true);
    inp.onkeydown=k=>{ if(k.key==="Enter"){ commit(true); } else if(k.key==="Escape"){ commit(false); } };
  };
  host.querySelectorAll(".te[contenteditable]").forEach(el=>{
    el.onblur=()=>{ if(!S.titul) S.titul={}; S.titul[el.dataset.f]=el.textContent.replace(/\s+/g," ").trim(); };
    el.onkeydown=k=>{ if(k.key==="Enter"){ k.preventDefault(); el.blur(); } };
  });
  $("#smetaNoLbl") && ($("#smetaNoLbl").textContent = `смета · ${d.n_works} работ · ${d.n_res} ресурсов`);
  applyGridFilter();
  if(!silent) toast("Смета сформирована — ЛРВ (свой грид)");
}

function applyGridFilter(){
  const host=$("#lrvgHost"); if(!host) return;
  const q=(S.smetaQuery||"").toLowerCase().trim();
  const toks=q.split(/\s+/).filter(Boolean);
  let curVisible=true, inWork=false, totals=false, shown=0, total=0;
  host.querySelectorAll("tbody tr").forEach(tr=>{
    if(tr.classList.contains("itg")) totals=true;
    if(totals){ tr.style.display=""; return; }
    if(tr.classList.contains("work")){
      inWork=true; total++;
      curVisible = !toks.length || (()=>{ const t=tr.textContent.toLowerCase(); return toks.every(x=>t.includes(x)); })();
      if(curVisible) shown++;
      tr.style.display = curVisible ? "" : "none";
    } else if(tr.classList.contains("sec")){
      tr.style.display=""; inWork=false;
    } else {
      tr.style.display = (inWork && !curVisible) ? "none" : "";
    }
  });
  const c=$("#gridCount"); if(c) c.textContent = q ? (shown?`показано ${shown} из ${total}`:`ничего (всего ${total})`) : "";
}

let _liveT=null;
function scheduleLiveRender(){
  if(SMETA_VIEW!=="grid") return;
  clearTimeout(_liveT); _gridGen++;
  const host=$("#lrvgHost"); if(!host) return;
  if(!(S.rows && S.rows.some(r=>!r.sec))){ host.innerHTML=`<div class="empty-state"><div class="empty-ic">📊</div><p>Наберите работы — смета построится здесь автоматически.</p></div>`; return; }
  _liveT=setTimeout(()=>renderLRVGrid(true), 220);
}
let SMETA_VIEW="grid";
function renderSmeta(){ return renderLRVGrid(); }
function setSmetaView(v){
  SMETA_VIEW=v;
  $("#viewGrid") && $("#viewGrid").classList.toggle("active", v==="grid");
  $("#viewUniver") && $("#viewUniver").classList.toggle("active", v==="univer");
  $("#lrvgHost") && ($("#lrvgHost").style.display = v==="grid"?"":"none");
  $("#univerHost") && ($("#univerHost").style.display = v==="univer"?"":"none");
  if(S.rows && S.rows.length) renderSmeta();
}

async function openMetod(){
  const m=$("#metodModal"); if(m) m.classList.remove("hidden");
  if(!S.metodData){
    $("#metodBody").innerHTML=`<div class="popr-empty">⏳ Загрузка перечня документов…</div>`;
    try{ S.metodData = await (await api("/api/metodologiya")).json(); }
    catch(e){ $("#metodBody").innerHTML=`<div class="popr-empty">⚠ Ошибка загрузки перечня</div>`; return; }
  }
  renderMetod();
}
function closeMetod(){ const m=$("#metodModal"); if(m) m.classList.add("hidden"); }
function renderMetod(){
  const body=$("#metodBody"), d=S.metodData; if(!body||!d) return;
  const link=(it,k)=>{
    if(!(k in it)) return "";
    const lbl=esc(it[k+"_label"]||k.toUpperCase());
    if(!it[k+"_avail"]) return `<span class="mlink off" title="файл ещё не загружен на сервер">${lbl}</span>`;
    return `<a class="mlink" data-n="${it.n}" data-fmt="${k}" title="${k==='pdf'?'открыть для просмотра':'открыть документ (можно сохранить)'}">${lbl}</a>`;
  };
  const q=(S.metodQuery||"").toLowerCase().trim(), toks=q.split(/\s+/).filter(Boolean);
  const docs=(d["документы"]||[]).filter(it=> !toks.length || toks.every(t=>String(it["наим"]||"").toLowerCase().includes(t)));
  body.innerHTML =
    `<div class="metod-search"><input id="metodSearch" class="bsearch" placeholder="🔍 поиск по названию документа…" autocomplete="off" value="${esc(S.metodQuery||"")}"/>
       <span class="muted metod-count">${q?(docs.length+" из "+(d["документы"]||[]).length):((d["документы"]||[]).length+" документов")}</span></div>`+
    `<table class="metod-tbl"><thead><tr><th>№</th><th>Наименование документа</th><th>DOC</th><th>PDF</th></tr></thead><tbody>`+
    (docs.length?docs.map(it=>{
      const empty = !("doc" in it) && !("pdf" in it);
      return `<tr class="${empty?'mrow-empty':''}"><td class="c">${it.n}</td><td>${esc(it["наим"])}${empty?' <span class="muted">· документ готовится</span>':''}</td>
        <td class="c">${link(it,"doc")}</td><td class="c">${link(it,"pdf")}</td></tr>`;
    }).join(""):`<tr><td colspan="4" class="muted" style="padding:14px;text-align:center">Ничего не найдено по «${esc(S.metodQuery)}»</td></tr>`)
    +`</tbody></table>`;
  const si=$("#metodSearch"); if(si){ si.oninput=e=>{ S.metodQuery=e.target.value; const p=si.selectionStart; renderMetod(); const s2=$("#metodSearch"); if(s2){ s2.focus(); try{s2.setSelectionRange(p,p);}catch(_){} } }; }
  body.querySelectorAll("a.mlink").forEach(a=> a.onclick=()=> openMetodDoc(+a.dataset.n, a.dataset.fmt));
}
async function openMetodDoc(n, fmt){
  toast("Открываю документ…");
  let r;
  try{ r = await api("/api/metodologiya_doc?n="+n+"&fmt="+fmt); }
  catch(e){ toast("Не удалось получить файл: "+e.message,"err"); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);

  window.open(url, "_blank");
  setTimeout(()=>URL.revokeObjectURL(url), 120000);
}

async function openUslov(replaceIdx){
  S.uslovReplaceIdx = (replaceIdx==null ? null : replaceIdx);
  const m=$("#uslovModal"); if(m) m.classList.remove("hidden");
  if(!S.uslovData){
    try{ S.uslovData = await (await api("/api/usloviya")).json(); }
    catch(e){ toast("Ошибка загрузки условий","err"); return; }
  }
  if(!S.uslovOpen) S.uslovOpen={};
  renderUslov();
}
function closeUslov(){ S.uslovReplaceIdx=null; const m=$("#uslovModal"); if(m) m.classList.add("hidden"); }
function renderUslov(){
  const body=$("#uslovBody"), d=S.uslovData; if(!body||!d) return;
  const repl = S.uslovReplaceIdx!=null;
  body.innerHTML = (repl?`<div class="uslov-note">Замена коэффициента — выберите новое условие.</div>`:"") +
    (d["разделы"]||[]).map(s=>{
      const open=!!S.uslovOpen[s.id];
      const head=`<div class="uslov-sec-h${open?' open':''}" data-sid="${esc(s.id)}"><span class="uslov-caret">${open?'▼':'▶'}</span>
        <b>${esc(s["название"])}</b> <span class="muted">· ${s["условия"].length} усл. · ${esc(s["источник"]||"")}</span></div>`;
      const tbl = open ? `<table class="uslov-tbl"><thead><tr><th>№</th><th>Условие производства работ</th><th>Кзтр</th><th>Кэм</th></tr></thead><tbody>`+
        s["условия"].map((u,ui)=>`<tr class="uslov-row" data-sid="${esc(s.id)}" data-ui="${ui}" title="выбрать — коэффициент в смету">
          <td class="c">${esc(u["№"])}</td><td>${esc(u["условие"])}</td>
          <td class="c num">${esc(fmt(u["Кзтр"]))}</td><td class="c num">${s["только_кзтр"]?'—':esc(fmt(u["Кэм"]))}</td></tr>`).join("")
        +`</tbody></table>` : "";
      return `<div class="uslov-sec">${head}${tbl}</div>`;
    }).join("");
  body.querySelectorAll(".uslov-sec-h").forEach(el=> el.onclick=()=>{ const id=el.dataset.sid; S.uslovOpen[id]=!S.uslovOpen[id]; renderUslov(); });
  body.querySelectorAll(".uslov-row").forEach(el=> el.onclick=()=> pickUslov(el.dataset.sid, +el.dataset.ui));
}
function pickUslov(sid, ui){
  const d=S.uslovData; const s=(d["разделы"]||[]).find(x=>x.id===sid); if(!s) return;
  const u=s["условия"][ui]; if(!u) return;
  const row={cond:true, sec_id:sid, section:s["название"], num:String(u["№"]), usl:u["условие"],
             kzt:u["Кзтр"], kem:(s["только_кзтр"]?1:u["Кэм"]), text:u["текст"]||u["условие"], group:u["группа"]||"MAIN"};
  snapshot();
  if(S.uslovReplaceIdx!=null && S.rows[S.uslovReplaceIdx] && S.rows[S.uslovReplaceIdx].cond){
    S.rows[S.uslovReplaceIdx]=row;
  } else {
    S.rows.unshift(row);
  }
  S.uslovReplaceIdx=null;
  renderNaked(); closeUslov();
  toast("Условие: Кзтр "+fmt(u["Кзтр"])+(s["только_кзтр"]?"":(" · Кэм "+fmt(u["Кэм"]))));
}

function addExtraResource(){ openResPicker("extra", null); }

function openResPicker(mode, target, gridSrc, opts){

  const preset = mode === "material" ? (opts && opts.presetQuery || "") : "";
  S.rp = {mode, target: target||null, gridSrc: (gridSrc==null?null:gridSrc),
          view: preset ? "catalog" : "cats", q: preset,
          vorRow: (opts && opts.vorRow != null ? opts.vorRow : null)};
  const m=$("#resPickerModal"); if(m) m.classList.remove("hidden");
  renderPicker();
}
function closeResPicker(){ S.rp=null; const m=$("#resPickerModal"); if(m) m.classList.add("hidden"); }

async function ensureUserRes(force){
  if(force) S.userRes=null;
  if(!S.userRes) S.userRes = ((await (await api("/api/user_resources")).json()).items)||[];
  return S.userRes;
}

function renderPicker(){
  const rp=S.rp; if(!rp) return;
  const body=$("#rpBody"), title=$("#rpTitle"), sub=$("#rpSub"); if(!body) return;
  if(rp.view==="cats"){

    title.textContent = rp.mode==="swap" ? "Замена ресурса" : "Ресурс вне расценки";
    sub.textContent="выберите источник";
    body.innerHTML = `<div class="rp-cats">
      <button class="rp-cat" data-go="catalog"><b>📚 Справочник ресурсов</b><span>выбрать из базы → ввести объём</span></button>
      <button class="rp-cat" data-go="user"><b>👤 Данные пользователя</b><span>свой ресурс (код ПМ-/ПО- авто) → ввести объём</span></button>
    </div>`;
    body.querySelectorAll(".rp-cat").forEach(b=> b.onclick=()=>{ rp.view=b.dataset.go; rp.q=""; renderPicker(); });
    return;
  }
  if(rp.view==="catalog"){
    title.textContent="Справочник ресурсов"; sub.textContent="поиск по справочнику ресурсов";
    body.innerHTML = `<div class="rp-nav"><a class="rp-back">← категории</a></div>
      <input id="rpSearch" class="bsearch" placeholder="поиск: название материала, код…" value="${esc(rp.q)}"/>
      <div id="rpList" class="rp-list"></div><div class="muted rp-more"></div>`;
    body.querySelector(".rp-back").onclick=()=>{ rp.view="cats"; renderPicker(); };
    const si=$("#rpSearch"); si.oninput=()=>{ rp.q=si.value; renderCatalogList(); };
    loadMatLib().then(renderCatalogList);
    return;
  }

  title.textContent="Данные пользователя"; sub.textContent="ваши ресурсы · код присваивается автоматически (ПМ-/ПО-)";
  body.innerHTML = `<div class="muted" style="padding:10px">Загрузка…</div>`;
  ensureUserRes().then(()=>{
    const rows=(S.userRes||[]).map(u=>`<tr data-code="${esc(u.code)}" data-name="${esc(u.name)}" data-unit="${esc(u.unit)}" data-cost="${esc(u.cost||0)}">
      <td>${esc(u.code)}</td><td>${esc(u.name)}</td><td>${esc(u.unit||"")}</td><td class="num">${esc(u.cost||"")}</td>
      <td><button class="btn btn-mini rp-pick">выбрать</button></td></tr>`).join("");
    const back = rp.mode==="swap" ? "" : `<div class="rp-nav"><a class="rp-back">← категории</a></div>`;
    body.innerHTML = back +
      `<table class="rp-tbl"><thead><tr><th>Код</th><th>Наименование</th><th>Ед.изм</th><th class="num">Стоимость</th><th></th></tr></thead>
       <tbody>${rows||`<tr><td colspan="5" class="muted">Пока нет ресурсов — добавьте ниже.</td></tr>`}</tbody></table>
      <div class="rp-add"><div class="rp-add-h">Добавить новый ресурс</div>
        <div class="rp-add-row">
          <select id="rpKind"><option value="материал">Материал → ПМ</option><option value="оборудование">Оборудование → ПО</option></select>
          <input id="rpName" placeholder="Наименование"/>
          <input id="rpUnit" class="rp-unit" placeholder="Ед.изм"/>
          <input id="rpCost" class="rp-cost" type="number" step="any" min="0" placeholder="Стоимость"/>
          <button id="rpSave" class="btn btn-primary btn-mini">Сохранить</button>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px">Код присвоится автоматически: ПМ-ХХХХХХХ (материал) / ПО-ХХХХХХХ (оборудование).</div>
      </div>`;
    const bk=body.querySelector(".rp-back"); if(bk) bk.onclick=()=>{ rp.view="cats"; renderPicker(); };
    body.querySelectorAll(".rp-pick").forEach(b=> b.onclick=()=>{ const tr=b.closest("tr");
      onPickResource(tr.dataset.code, tr.dataset.name, tr.dataset.unit, parseFloat(tr.dataset.cost)||0); });
    $("#rpSave").onclick = async ()=>{
      const name=$("#rpName").value.trim(); if(!name){ toast("Введите наименование","err"); return; }
      const kind=$("#rpKind").value, unit=$("#rpUnit").value.trim(), cost=$("#rpCost").value.trim();
      let d; try{ d=await (await api("/api/user_resource_add",{method:"POST",body:JSON.stringify({name,unit,cost,kind})})).json(); }
      catch(e){ toast("Ошибка сохранения","err"); return; }
      if(d&&d.item){ toast("Добавлен "+d.item.code); await ensureUserRes(true); renderPicker(); }
      else toast(d&&d.error?d.error:"Ошибка","err");
    };
  });
}
function renderCatalogList(){
  const rp=S.rp, L=S.matLib, list=$("#rpList"); if(!rp||!L||!list) return;
  const q=(rp.q||"").toLowerCase().trim(), toks=q.split(/\s+/).filter(Boolean);
  const items = q ? L["материалы"].filter(m=>{const h=(m["наим"]+" "+m.code).toLowerCase(); return toks.every(t=>h.includes(t));}) : [];
  const shown=items.slice(0,80);
  list.innerHTML = shown.length
    ? shown.map(m=>`<div class="brow2" data-code="${esc(m.code)}" data-name="${esc(m["наим"])}" data-unit="${esc(m["ед"]||"")}"><span class="bcode">${esc(m.code)}</span><span class="bnm">${esc(m["наим"])}</span><span class="bun">${esc(m["ед"]||"")}</span></div>`).join("")
    : `<div class="muted bnone">${q?"Ничего не найдено — уточните запрос.":"Начните поиск: название материала, код…"}</div>`;
  const mo=document.querySelector(".rp-more"); if(mo) mo.textContent = items.length>80?`показано 80 из ${items.length} — уточните поиск`:(items.length?`${items.length} найдено`:"");
  list.querySelectorAll(".brow2").forEach(el=> el.onclick=()=> onPickResource(el.dataset.code, el.dataset.name, el.dataset.unit, 0));
}
async function onPickResource(code, name, unit, cost){
  const rp=S.rp; if(!rp) return;
  if(rp.mode==="material"){
    if(rp.vorRow!=null && typeof window.vorMatResPicked==="function"){
      const i=rp.vorRow; closeResPicker();
      window.vorMatResPicked(i, code, name, unit); return;
    }
    closeResPicker(); return;
  }
  if(rp.mode==="swap"){
    if(rp.vorRow!=null && typeof window.vorResSwapPicked==="function"){
      const i=rp.vorRow, t=rp.target; closeResPicker();
      await window.vorResSwapPicked(i, t, code, name); return;
    }
    if(rp.gridSrc!=null && S.rows[rp.gridSrc]){
      if(!S.rows[rp.gridSrc].swaps) S.rows[rp.gridSrc].swaps={};
      S.rows[rp.gridSrc].swaps[rp.target]=code; renderNaked(); toast("Заменено на «"+name+"»");
    } else if(rp.target){ S.swaps[rp.target]=code; await recompute(); renderParam(); toast("Заменено на «"+name+"» — задайте норму расхода в строке"); }
    closeResPicker(); return;
  }

  if(rp.vorRow!=null && typeof window.vorExtraPicked==="function"){
    const i=rp.vorRow; closeResPicker();
    window.vorExtraPicked(i, code, name, unit); return;
  }
  const qty=parseFloat((prompt("Количество (по проекту) для «"+name+"»:","")||"").replace(",","."));
  if(!(qty>0)){ toast("Не задано количество","err"); return; }
  let d; try{ d=await (await api("/api/extra_resource",{method:"POST",
    body:JSON.stringify({name, unit, qty, code, cost})})).json(); }
  catch(e){ toast("Ошибка добавления ресурса","err"); return; }
  if(!d || d.error || !d.resolved){ toast(d&&d.error?d.error:"Ошибка","err"); return; }
  snapshot();
  _addSmetaRow({prebuilt:d.resolved, extra:true, shifr:d.shifr, name:d.name,
    objem:qty, izm:unit||"ед", nres:1, picks:[], drops:[], krat:1});
  renderNaked(); toast("Добавлен ресурс вне расценки: "+name); closeResPicker();
}
async function saveSmeta(opts){
  opts = opts || {};
  if(!S.rows.length){ toast("Смета пуста — нечего сохранять","err"); return false; }
  let title = S.smetaTitle || "";
  if(!S.smetaN){

    if(opts.auto){
      const o=(S.titul&&S.titul.объект)||(S.titul&&S.titul.стройка)||"";
      title=("Черновик · "+(o||"без объекта")).slice(0,80);
      S.smetaDraft=true;
    }else{
      const def=(S.titul&&S.titul.объект)||"";
      title=(prompt("Название сметы:", def)||"").trim();
    }
  } else if(!opts.auto && S.smetaDraft){
    const def=(S.titul&&S.titul.объект)||S.smetaTitle||"";
    const t=(prompt("Название сметы:", def)||"").trim();
    if(t){ title=t; S.smetaDraft=false; }
  }
  let d;
  try{ d=await (await api("/api/smeta_save",{method:"POST",
    body:JSON.stringify({rows:S.rows, titul:S.titul||{}, title, n:S.smetaN||0, proj:S.proj||{}})})).json(); }
  catch(e){ toast("Ошибка сохранения","err"); return false; }
  if(d&&d.n){
    const wasUpdate = !!S.smetaN;
    S.smetaN=d.n; S.smetaTitle=title; S.smetaDirty=false;
    if(opts.auto) _smetaAutoMark("✓ сохранено "+_hhmm(),"ok");
    else toast((wasUpdate?"Смета обновлена · №":"Смета сохранена · №")+d.n+(title?" «"+title+"»":""));
    if(opts.close){
      if(typeof window.__onCycleComplete==="function") window.__onCycleComplete();
      else closeSmetaWindow(true);
    }
    return true;
  }
  toast("Не удалось сохранить","err"); return false;
}

function _hhmm(){ const t=new Date(); return String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0"); }
function _smetaAutoMark(txt,cls){ const el=document.querySelector("#smetaAutoState");
  if(el){ el.textContent=txt||""; el.className="vor-auto"+(cls?" "+cls:""); } }
let _smAutoT=null, _smAutoBusy=false;
async function smetaAutoSave(){
  if(_smAutoBusy) return false;
  if(!S.smetaDirty || !S.rows.length) return false;
  _smAutoBusy=true; _smetaAutoMark("сохраняю…");
  try{ return await saveSmeta({auto:true}); }
  catch(e){ _smetaAutoMark("⚠ не сохранилось — нажмите 💾","err"); return false; }
  finally{ _smAutoBusy=false; }
}
function smetaAutoSoon(){
  clearTimeout(_smAutoT);
  if(!S.smetaDirty) return;
  _smetaAutoMark("есть несохранённые правки");
  _smAutoT=setTimeout(smetaAutoSave,25000);
}
window.smetaAutoSave = smetaAutoSave;

function closeSmetaWindow(silent){
  S.rows=[]; S.smetaN=null; S.smetaTitle=""; S.smetaDirty=false; S.proj={}; S.selRow=null;
  S.history=[]; S.smetaQuery=""; syncUndoBtn();
  const gf=$("#gridFilter"); if(gf) gf.value=""; const sf=$("#smetaFilter"); if(sf) sf.value="";
  renderNaked();
  if(!silent) toast("Смета закрыта — окно пустое");
}

window.engineResetSmeta = function(){ closeSmetaWindow(true); };
window.engineHasDraft   = function(){ return S.rows.some(r=>!r.sec) || S.smetaDirty; };

window.engineDirty      = function(){ return !!S.smetaDirty; };

function closeSmetaNoSave(){
  if(!S.rows.length){ toast("Окно Сметы уже пустое"); return; }
  if(S.smetaDirty && !confirm("Закрыть смету без сохранения? Несохранённые изменения будут потеряны.")) return;
  closeSmetaWindow();
}

function closeSmetaList(){ const m=$("#smetaListModal"); if(m) m.classList.add("hidden"); }
async function openSmetaList(){
  const body=$("#smetaListBody"); if(!body) return;
  body.innerHTML=`<div class="popr-empty">⏳ Загрузка списка…</div>`;
  $("#smetaListModal").classList.remove("hidden");
  let d;
  try{ d=await (await api("/api/smeta_list")).json(); }
  catch(e){ body.innerHTML=`<div class="popr-empty">⚠ Ошибка загрузки списка</div>`; return; }
  S._smetas=d.smetas||[];
  if(!S._smetas.length){ body.innerHTML=`<div class="popr-empty">🗃 Сохранённых смет пока нет.<br/>Соберите смету и нажмите «💾 Сохранить».</div>`; return; }
  body.innerHTML=`<input id="smetaListSearch" class="bsearch" placeholder="🔍 поиск по названию или №…" autocomplete="off"/><div id="smetaListItems" class="smeta-list"></div>`;
  $("#smetaListSearch").oninput=e=>paintSmetaList(e.target.value);
  paintSmetaList("");
}
function paintSmetaList(q){
  const wrap=$("#smetaListItems"); if(!wrap) return;
  const toks=(q||"").toLowerCase().split(/\s+/).filter(Boolean);
  const list=(S._smetas||[]).filter(s=>{ if(!toks.length) return true; const h=((s.title||"")+" №"+s.n).toLowerCase(); return toks.every(t=>h.includes(t)); });
  wrap.innerHTML = list.length ? list.map(s=>`
    <div class="smeta-card">
      <div class="sc-main"><div class="sc-h"><span class="sc-n">№${s.n}</span>${esc(s.title||'без названия')}</div>
        <div class="sc-meta">🕘 ${esc(s.ts||'')} · работ: ${s.n_rows||0}</div></div>
      <div class="sc-tools"><button class="btn btn-mini sc-open" data-n="${s.n}">📂 Открыть</button>
        <button class="sc-del" data-n="${s.n}" title="Удалить смету">🗑</button></div>
    </div>`).join("") : `<div class="popr-empty">Ничего не найдено</div>`;
  wrap.querySelectorAll(".sc-open").forEach(b=>b.onclick=()=>loadSmeta(+b.dataset.n));
  wrap.querySelectorAll(".sc-del").forEach(b=>b.onclick=async()=>{
    const n=+b.dataset.n; if(!confirm("Удалить смету №"+n+"? Это нельзя отменить.")) return;
    try{ await api("/api/smeta_delete",{method:"POST",body:JSON.stringify({n})}); }
    catch(e){ toast("Ошибка удаления","err"); return; }
    S._smetas=(S._smetas||[]).filter(x=>x.n!==n); paintSmetaList(q); toast("Смета №"+n+" удалена"); });
}
async function loadSmeta(n){
  let rec;
  try{ rec=await (await api("/api/smeta_load?n="+encodeURIComponent(n))).json(); }
  catch(e){ toast("Не удалось загрузить смету","err"); return; }
  S.rows=Array.isArray(rec.rows)?rec.rows:[]; S.selRow=null;
  S.titul=rec.titul||{};
  S.proj=rec.proj||{};
  S.smetaN=rec.n; S.smetaTitle=rec.title||""; S.smetaDirty=false;
  S.history=[]; S.smetaQuery=""; syncUndoBtn();
  closeSmetaList();
  renderNaked();
  toast("Загружена смета №"+rec.n+(rec.title?" «"+rec.title+"»":""));
}

const PROJ_KEYS=["проект","проект_шифр","этап","этап_шифр","объект","объект_шифр",
                 "подобъект","подобъект_шифр","дисциплина","дисциплина_шифр","смета","смета_шифр"];

let _crSubs=[];
async function loadCreateSubs(){
  const sel=$("#cr_bind"); if(!sel) return;
  try{ const d=await (await api("/api/project/subs")).json(); _crSubs=d.subs||[]; }
  catch(e){ _crSubs=[]; }
  const cur=S.proj&&S.proj.sub_id?String(S.proj.sub_id):"";
  sel.innerHTML='<option value="">— не привязывать (заполню поля вручную) —</option>'+
    _crSubs.map(x=>{
      const lbl=[x.проект,x.объект,x.подобъект].filter(Boolean).join(" › ")+(x.подобъект_шифр?" · "+x.подобъект_шифр:"");
      return `<option value="${esc(x.sub_id)}"${x.sub_id===cur?" selected":""}>${esc(lbl)}</option>`;
    }).join("");
}
function applyCreateBind(){
  const sel=$("#cr_bind"); if(!sel) return;
  const x=_crSubs.find(y=>y.sub_id===sel.value);
  if(!x) return;
  const put=(k,v)=>{ const el=$("#cr_"+k); if(el&&v) el.value=v; };
  put("проект",x.проект); put("объект",x.объект); put("подобъект",x.подобъект);
  put("подобъект_шифр",x.подобъект_шифр); put("этап",x.этап);
}
function openCreateModal(){
  const p=S.proj||{};
  PROJ_KEYS.forEach(k=>{ const el=$("#cr_"+k); if(el) el.value=p[k]||""; });
  loadCreateSubs();
  const w=$("#createWarn"); if(w) w.textContent = S.rows.length ? "⚠ Текущая смета будет закрыта — сохрани её, если нужно" : "";
  $("#createModal").classList.remove("hidden");
  setTimeout(()=>{ const f=$("#cr_проект"); if(f) f.focus(); }, 60);
}
function closeCreateModal(){ const m=$("#createModal"); if(m) m.classList.add("hidden"); }
function submitCreate(){
  const p={}; PROJ_KEYS.forEach(k=>{ const el=$("#cr_"+k); const v=(el&&el.value||"").trim(); if(v) p[k]=v; });

  const _b=$("#cr_bind"), _x=_b?_crSubs.find(y=>y.sub_id===_b.value):null;
  if(_x){ p.sub_id=_x.sub_id; p.object_id=_x.object_id; p.project_n=String(_x.n); }
  closeSmetaWindow(true);
  S.proj=p;
  S.titul=S.titul||{};
  if(p.объект) S.titul.объект=p.объект;
  if(p.смета_шифр) S.titul.номер=p.смета_шифр;
  S.smetaTitle=p.смета||p.объект||"";
  closeCreateModal(); renderNaked();
  toast("Создана новая смета"+(p.проект?" · проект «"+p.проект+"»":""));
}

function _hasProj(s){ const p=s.proj||{}; return !!(p.проект||p.этап||p.объект||p.подобъект||p.дисциплина); }
function closeProjects(){ const m=$("#projectsModal"); if(m) m.classList.add("hidden"); }
async function openProjects(){
  const body=$("#projectsBody"); if(!body) return;
  body.innerHTML=`<div class="pj-empty">⏳ Загрузка структуры…</div>`;
  $("#projectsModal").classList.remove("hidden");
  let d; try{ d=await (await api("/api/smeta_list")).json(); }
  catch(e){ body.innerHTML=`<div class="pj-empty">⚠ Ошибка загрузки</div>`; return; }
  S._smetas=d.smetas||[]; paintProjects();
}
function paintProjects(){
  const body=$("#projectsBody"); if(!body) return;
  const list=S._smetas||[];
  if(!list.length){ body.innerHTML=`<div class="pj-empty">📂 Сохранённых смет пока нет.<br/>Соберите смету и нажмите «💾 Сохранить».</div>`; return; }
  const LEVELS=[["проект","проект_шифр","📁"],["этап","этап_шифр","🗂"],["объект","объект_шифр","🏗"],
                ["подобъект","подобъект_шифр","🧱"],["дисциплина","дисциплина_шифр","📐"]];
  const root={children:{}, smetas:[]};
  list.filter(_hasProj).forEach(s=>{
    let node=root;
    LEVELS.forEach(([nk,ck,ic])=>{
      const nm=((s.proj||{})[nk]||"").trim(); if(!nm) return;
      if(!node.children[nm]) node.children[nm]={label:nm, code:((s.proj||{})[ck]||""), ic, children:{}, smetas:[]};
      node=node.children[nm];
    });
    node.smetas.push(s);
  });
  const smetaRow=(s,pad)=>`<div class="pj-smeta" data-n="${s.n}" style="padding-left:${pad}px">`+
    `<span class="pj-n">№${s.n}</span><span class="pj-nm">${esc(s.title||(s.proj||{}).смета||'без названия')}</span>`+
    `<span class="pj-meta">${esc(s.ts||'')} · ${s.n_rows||0} стр.</span></div>`;
  const render=(node,depth)=>{
    let h="";
    Object.values(node.children).sort((a,b)=>a.label.localeCompare(b.label,'ru')).forEach(ch=>{
      h+=`<div class="pj-grp" style="padding-left:${depth*16+8}px"><span class="pj-ic">${ch.ic}</span>`+
         `<span>${esc(ch.label)}</span>${ch.code?`<span class="pj-code">${esc(ch.code)}</span>`:""}</div>`;
      h+=render(ch, depth+1);
    });
    node.smetas.forEach(s=>{ h+=smetaRow(s, depth*16+10); });
    return h;
  };
  let html=`<div class="proj-tree">`+(render(root,0)||"")+`</div>`;
  const noP=list.filter(s=>!_hasProj(s));
  if(noP.length){
    html+=`<div class="pj-unassigned"><div class="pj-h">Разрозненные сметы (без привязки к проекту)</div>`+
          noP.map(s=>smetaRow(s,10)).join("")+`</div>`;
  }
  body.innerHTML=html;
  body.querySelectorAll(".pj-smeta").forEach(el=>el.onclick=()=>{ closeProjects(); loadSmeta(+el.dataset.n); });
}
async function downloadXls(kind){
  const r = await api("/api/excel",{method:"POST",
    body:JSON.stringify({kind, rows:smetaRows(), glob:S.titul||{}})});
  const blob = await r.blob(); const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=(kind==="res"?"Smeta_RES.xlsx":"Smeta_LRV.xlsx");
  a.click(); URL.revokeObjectURL(url);

  const nSkip = +(r.headers.get("X-Skipped-Rows") || 0);
  if (nSkip) toast(`⚠ В файл не попало строк: ${nSkip} — расценка не разрешилась (проверьте коды)`, "err");
}

$("#loginBtn").onclick = doLogin;
$("#pw").onkeydown = e=>{ if(e.key==="Enter") doLogin(); };
async function runSearch(q){
  try{
    const d = await (await api("/api/search?q="+encodeURIComponent(q))).json();
    S.searchResults = d.results || [];
  }catch(e){ S.searchResults = []; }
  S.searching = false; renderTree();
}
$("#search").oninput = e=>{
  const q = e.target.value.trim();
  S.query = q.toLowerCase();
  clearTimeout(S._st);
  if(!q){ S.searchResults = null; S.searching = false; renderTree(); return; }
  S.searching = true; renderTree();
  S._st = setTimeout(()=> runSearch(q), 250);
};
$("#addBtn").onclick = addToSmeta;
{ const fb=$("#formBtn"); if(fb) fb.onclick = renderSmeta; }
{ const xb=$("#xlsExport"); if(xb) xb.onclick = ()=>downloadXls("lrv"); }

function showNaked(){ const p=$("#nakedPanel"); if(p) p.classList.remove("hidden"); }
function hideNaked(){ const p=$("#nakedPanel"); if(p) p.classList.add("hidden"); }
{ const x=$("#nakedClose"); if(x) x.onclick=hideNaked; const o=$("#openNaked"); if(o) o.onclick=()=>{ const p=$("#nakedPanel"); if(p) p.classList.toggle("hidden"); }; }
(function dragNaked(){
  const head=$("#nakedHead"), panel=$("#nakedPanel"); if(!head||!panel) return;
  let sx,sy,sl,st,drag=false;
  head.addEventListener("mousedown",e=>{ if(e.target.closest(".float-x")) return; drag=true; sx=e.clientX; sy=e.clientY;
    const r=panel.getBoundingClientRect(); sl=r.left; st=r.top; panel.style.left=sl+"px"; panel.style.right="auto"; panel.style.top=st+"px"; e.preventDefault(); });
  window.addEventListener("mousemove",e=>{ if(!drag) return;
    let nl=Math.max(4,Math.min(sl+(e.clientX-sx), window.innerWidth-140)), nt=Math.max(48,Math.min(st+(e.clientY-sy), window.innerHeight-56));
    panel.style.left=nl+"px"; panel.style.top=nt+"px"; });
  window.addEventListener("mouseup",()=>{ drag=false; });
})();

function showWorkPopup(){ const p=$("#workPanel"); if(p) p.classList.remove("hidden"); }
function hideWorkPopup(){ const p=$("#workPanel"); if(p) p.classList.add("hidden"); }
{ const x=$("#workClose"); if(x) x.onclick=()=>{ hideWorkPopup(); S.wc=null; S.comp=null; renderTree(); }; }
(function dragWork(){
  const head=$("#workHead"), panel=$("#workPanel"); if(!head||!panel) return;
  let sx,sy,sl,st,drag=false;
  head.addEventListener("mousedown",e=>{ if(e.target.closest(".float-x")) return; drag=true; sx=e.clientX; sy=e.clientY;
    const r=panel.getBoundingClientRect(); sl=r.left; st=r.top; panel.style.left=sl+"px"; panel.style.transform="none"; panel.style.top=st+"px"; e.preventDefault(); });
  window.addEventListener("mousemove",e=>{ if(!drag) return;
    let nl=Math.max(4,Math.min(sl+(e.clientX-sx), window.innerWidth-160)), nt=Math.max(48,Math.min(st+(e.clientY-sy), window.innerHeight-56));
    panel.style.left=nl+"px"; panel.style.top=nt+"px"; });
  window.addEventListener("mouseup",()=>{ drag=false; });
})();
{ const asb=$("#addSectionBtn"); if(asb) asb.onclick = ()=>insertSection(S.rows.length); }
{ const pdb=$("#perevozkaDistBtn"); if(pdb) pdb.onclick = addPerevozkaDist; }
{ const erb=$("#extraResBtn"); if(erb) erb.onclick = addExtraResource; }
{ const ub=$("#uslovBtn"); if(ub) ub.onclick = ()=>openUslov(); }
{ const uc=$("#uslovClose"); if(uc) uc.onclick = closeUslov;
  const um=$("#uslovModal"); if(um) um.onclick = e=>{ if(e.target===um) closeUslov(); }; }
{ const mb=$("#metodBtn"); if(mb) mb.onclick = openMetod; }
{ const mc=$("#metodClose"); if(mc) mc.onclick = closeMetod;
  const mm=$("#metodModal"); if(mm) mm.onclick = e=>{ if(e.target===mm) closeMetod(); }; }
{ const tc=$("#tchdocClose"); const tm=$("#tchdocModal");
  const closeTch=()=>{ if(tm) tm.classList.add("hidden"); };
  if(tc) tc.onclick = closeTch;
  if(tm) tm.onclick = e=>{ if(e.target===tm) closeTch(); }; }
{ const cb=$("#clearBtn"); if(cb) cb.onclick = ()=>{ if(S.rows.length) snapshot(); S.rows=[]; S.smetaN=null; S.smetaTitle=""; S.selRow=null; renderNaked(); if(S.comp&&!S.comp.error) renderParam(); }; }
{ const ub=$("#undoBtn"); if(ub) ub.onclick = undo; }
{ const ug=$("#undoBtnGrid"); if(ug) ug.onclick = undo; }
{ const sf=$("#smetaFilter"); if(sf) sf.oninput = e=>{ S.smetaQuery=e.target.value;
    const gf=$("#gridFilter"); if(gf) gf.value=e.target.value; renderNaked(); }; }
{ const gf=$("#gridFilter"); if(gf) gf.oninput = e=>{ S.smetaQuery=e.target.value;
    const sf=$("#smetaFilter"); if(sf) sf.value=e.target.value; applyGridFilter(); }; }
{ const b=$("#saveSmetaBtn"); if(b) b.onclick = saveSmeta; }
{ const b=$("#saveSmetaGridBtn"); if(b) b.onclick = ()=>saveSmeta(); }
{ const b=$("#saveCloseBtn"); if(b) b.onclick = ()=>saveSmeta({close:true}); }
{ const b=$("#closeNoSaveBtn"); if(b) b.onclick = closeSmetaNoSave; }
{ const b=$("#openListBtn"); if(b) b.onclick = openSmetaList; }
{ const b=$("#createBtn"); if(b) b.onclick = openCreateModal; }
{ const b=$("#projectsBtn"); if(b) b.onclick = openProjects; }
{ const c=$("#createClose"); if(c) c.onclick = closeCreateModal;
  const g=$("#createGo"); if(g) g.onclick = submitCreate;
  const b=$("#cr_bind"); if(b) b.onchange = applyCreateBind;
  const m=$("#createModal"); if(m) m.onclick = e=>{ if(e.target===m) closeCreateModal(); }; }
{ const c=$("#projectsClose"); if(c) c.onclick = closeProjects;
  const m=$("#projectsModal"); if(m) m.onclick = e=>{ if(e.target===m) closeProjects(); }; }

{ const host=$("#lrvgHost"); if(host) host.addEventListener("wheel",e=>{
    if(!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    S.gridZoom = Math.min(1.8, Math.max(0.6, (S.gridZoom||1) + (e.deltaY<0?0.1:-0.1)));
    S.gridZoom = Math.round(S.gridZoom*100)/100;
    applyGridZoom();
  }, {passive:false}); }
document.querySelectorAll(".tb-stub").forEach(b=>b.onclick=()=>toast("Слот №"+b.dataset.stub+" свободен — функция будет назначена"));
{ const c=$("#smetaListClose"); if(c) c.onclick = closeSmetaList;
  const m=$("#smetaListModal"); if(m) m.onclick = e=>{ if(e.target===m) closeSmetaList(); }; }
$("#closeSmeta").onclick = ()=>$("#smetaModal").classList.add("hidden");
{ const rc=$("#rpClose"); if(rc) rc.onclick = closeResPicker; }
{ const pc=$("#poprClose"); if(pc) pc.onclick = closePopr;
  const pm=$("#poprModal"); if(pm) pm.onclick = e=>{ if(e.target===pm) closePopr(); }; }
$("#xlsLrv").onclick = ()=>smetaAutoSave().then(()=>downloadXls("lrv")).then(()=>toast("ЛРВ-файл выгружен")).catch(()=>toast("Ошибка выгрузки","err"));
$("#xlsRes").onclick = ()=>smetaAutoSave().then(()=>downloadXls("res")).then(()=>toast("RES-файл выгружен")).catch(()=>toast("Ошибка выгрузки","err"));
$("#logoutBtn").onclick = ()=>{

  if (S.token) { try { api("/api/logout", {method:"POST", body:"{}"}).catch(()=>{}); } catch(e) {} }
  S.token=null; S.rows=[]; S.smetaN=null; S.smetaTitle=""; S.wc=null; S.comp=null;
  S.history=[]; S.smetaQuery=""; const sf=$("#smetaFilter"); if(sf) sf.value=""; syncUndoBtn();
  try { sessionStorage.removeItem("iismeta_auth"); } catch (e) {}
  $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); $("#pw").value=""; };
restoreSession();
document.addEventListener("keydown", e=>{
  if(e.key==="Escape"){ $("#smetaModal").classList.add("hidden"); closePopr(); closeSmetaList(); closeUslov(); closeMetod(); return; }

  if((e.ctrlKey||e.metaKey) && (e.key==="z"||e.key==="Z") && !e.shiftKey){
    const t=e.target, tag=t&&t.tagName;
    if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT") return;
    if($("#app").classList.contains("hidden")) return;
    e.preventDefault(); undo();
  }
});

function engineConsumeVor(){
  const rows = window.__vorRows;
  if(!Array.isArray(rows) || !rows.length){ toast("Из ВОР не пришло ни одной строки с расценкой — подберите работы в дереве","err"); return; }
  window.__vorRows = null;

  const _key = r => (r.code || r.shifr || "") + "|" + (r.name || "").trim().toLowerCase();
  const keep = new Map();
  S.rows.forEach(r => {
    if (r.sec) return;
    const hasEdits = (r.swaps && Object.keys(r.swaps).length) || (r.qtys && Object.keys(r.qtys).length)
      || (r.drops && r.drops.length) || (r.picks && r.picks.length)
      || (r.krat && r.krat !== 1) || (r.choices && Object.keys(r.choices).length);
    if (hasEdits) keep.set(_key(r), r);
  });
  if(S.rows.length && !keep.size && !confirm("В Смете уже есть строки — заменить их черновиком из ВОР?")) return;
  snapshot();
  let restored = 0;
  S.rows = rows.map(r => {
    if (r.sec) return {sec:true, kind:r.kind||"Раздел", name:r.name||""};

    if (r.material) return {material:true, name:r.name||"", objem:(+r.objem||0), izm:r.izm||"",
                            wc:null, code:null, shifr:"—", mat_code:r.mat_code||"",
                            choices:{}, picks:[], swaps:{}, qtys:{},
                            drops:[], krat:1, kratText:"", krat_text:"", nres:0};
    const base = {wc:r.wc, objem:(+r.objem||0), choices:{}, picks:[], code:r.code, swaps:{}, qtys:{}, drops:[],
                  krat:1, kratText:"", krat_text:"", shifr:r.code, name:r.name||"", izm:r.izm||"", nres:0};

    if (r.resEdited) {
      base.swaps = r.swaps||{}; base.qtys = r.qtys||{}; base.drops = r.drops||[];
    }
    const old = keep.get(_key(base));
    if (!old) return base;
    restored++;
    return Object.assign(base, {
      choices: old.choices||{}, picks: old.picks||[], krat: old.krat||1,
      kratText: old.kratText||"", krat_text: old.krat_text||"",
      swaps: r.resEdited ? base.swaps : (old.swaps||{}),
      qtys:  r.resEdited ? base.qtys  : (old.qtys||{}),
      drops: r.resEdited ? base.drops : (old.drops||[]),
    });
  });
  if (restored) setTimeout(() => toast("Правки ресурсов сохранены в " + restored + " строк(ах)"), 900);
  S.smetaN = null; S.smetaTitle = ""; S.smetaDirty = true;

  const _vt = window.__vorTitul || null;
  if(_vt){
    S.titul = S.titul || {};

    const _inShifr = (_vt.номер||"").trim(), _curShifr = (S.titul.номер||"").trim();
    const _newObj = !!_inShifr && _inShifr !== _curShifr;
    Object.keys(_vt).forEach(k => {
      const v = (_vt[k]||"").trim(); if(!v) return;
      if(_newObj || !(S.titul[k]||"").trim()) S.titul[k] = v;
    });
    if(!S.titul.номер) S.titul.номер = "00-1-1";

    S.smetaTitle = _vt.объект || _vt.стройка || "";
    window.__vorTitul = null;
  }

  const _vp = window.__vorProj || null;
  if(_vp){
    S.proj = S.proj || {};
    const _pShifr = (_vp.подобъект_шифр||"").trim();
    const _pNew = !!_pShifr && _pShifr !== (S.proj.подобъект_шифр||"").trim();
    Object.keys(_vp).forEach(k => {

      if(Array.isArray(_vp[k])){ if(_pNew || !(S.proj[k]||[]).length) S.proj[k] = _vp[k].slice(); return; }
      const v = String(_vp[k]||"").trim(); if(!v) return;
      if(_pNew || !String(S.proj[k]||"").trim()) S.proj[k] = v;
    });
    window.__vorProj = null;
  }
  renderNaked();
  const nW = S.rows.filter(x=>!x.sec).length, nZ = S.rows.filter(x=>!x.sec && !(x.objem>0)).length;
  toast("Черновик сметы из ВОР: работ "+nW+(nZ?(" · без объёма: "+nZ+" — введите двойным кликом"):""));
  if(window.__vorSkipped) toast(window.__vorSkipped+" строк(и) ВОР без подобранной расценки — подберите в дереве вручную","err");
}
renderNaked();

window.addEventListener("message", async ev => {
  if (ev.origin !== location.origin) return;
  const msg = ev.data;
  if (!msg || msg.type !== "iismeta:wizard:add_to_smeta" || !Array.isArray(msg.items)) return;
  const results = [];
  for (const item of msg.items) {
    try {
      if (item.kind === "perevozka") {
        const d = await (await api("/api/perevozka_dist", {method: "POST",
          body: JSON.stringify({text: item.text || "груз", L_km: item.km, tonnes: item.tonnes})})).json();
        if (!d || d.error || !d.resolved) throw new Error(d && d.error || "нет нормы на это расстояние");
        _addSmetaRow({prebuilt: d.resolved, dist: true, shifr: d.shifr, name: d.name,
          objem: item.tonnes, izm: "т", nres: d.nres, picks: [], drops: [], krat: 1});
      } else {

        const d = await (await api("/api/compute_by_code", {method: "POST",
          body: JSON.stringify({code: item.code, objem: item.objem})})).json();
        _addSmetaRow({wc: d.wc, code: d.code, objem: d.objem, shifr: d.shifr, name: d.name,
          izm: d.izm, nres: d.nres, choices: {}, picks: [], swaps: {}, qtys: {}, drops: [],
          krat: 1, kratText: ""});
      }
      results.push({ok: true, label: item.label || item.code});
    } catch (e) {
      results.push({ok: false, label: item.label || item.code, error: String(e && e.message || e)});
    }
  }
  const okN = results.filter(r => r.ok).length;

  if (okN) { S.smetaDirty = true; renderNaked(); }
  toast(okN + " из " + results.length + " позиций визарда добавлено в смету"
    + (okN < results.length ? " — часть не найдена, см. ответ визарду" : ""),
    okN < results.length ? "err" : undefined);
  if (okN) { const te = $("#tabEngine"); if (te) te.click(); }
  if (ev.source) ev.source.postMessage({type: "iismeta:wizard:add_to_smeta:done", results}, ev.origin);
});
