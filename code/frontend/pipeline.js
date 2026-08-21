"use strict";

(function () {
  const P = { enginePill: null, activeProject: null, lastVor: null, vorFile: null, vorBusy: false };

  function _pushWorkRow(rows, r, c) {

    const nm = r._clean || r.name || "", izm = c.unit_calc || r.unit || c.izm_norm || "";
    const comps = Array.isArray(c.components) && c.components.length ? c.components : [{ shifr: c.shifr, objem: c.objem }];

    comps.forEach((cc, ci) => {
      const row = { vor: true, wc: c.wc, code: cc.shifr, objem: +((cc.objem != null ? cc.objem : r.qty) || 0),
                    name: ci === 0 ? nm : (nm + " (добор)"), izm };

      if (cc.objem_base != null && cc.k) { row.objem_base = +cc.objem_base; row.k = +cc.k; }

      const resTouched = r._resTouched || (r._drops && r._drops.length)
        || (r._swaps && Object.keys(r._swaps).length) || (r._qtys && Object.keys(r._qtys).length);
      if (cc.shifr === c.shifr && resTouched) {
        row.resEdited = true;
        row.swaps = Object.assign({}, r._swaps || {});
        row.qtys = Object.assign({}, r._qtys || {});
        row.drops = (r._drops || []).slice();
      }
      rows.push(row);
    });
  }

  const _PIROG_SB = new Set(["11", "12", "15", "26"]);
  function _pirogWork(r) {
    if ((r.type || "Работа") !== "Материал") return null;

    if (r._extraRes) return null;
    const c = _chosen(r);
    if (!c || c.wc == null || !c.shifr) return null;

    if (!/^Е/.test(String(c.shifr))) return null;

    if (c.engine === "v2-agg") return c;

    if (c.node_sum) return c;
    const sb = String(c.shifr).replace(/^[А-Яа-яA-Za-z]+/, "").replace(/[^0-9]/g, "").slice(0, 2);
    return _PIROG_SB.has(sb) ? c : null;
  }

  const VIEWS = { project: "#projectView", vor: "#vorView", engine: "#engineView", validator: "#validatorView" };
  const TABS  = { project: "#tabProject", vor: "#tabVor", engine: "#tabEngine", validator: "#tabValidator" };

  function showView(name) {
    if (!VIEWS[name]) return;
    const pill = $("#sbornikPill");
    const active = document.querySelector(".tab.active");
    if (pill && active && active.id === "tabEngine") P.enginePill = pill.textContent;

    showOnlyView(VIEWS[name]);
    Object.entries(TABS).forEach(([k, sel]) => { const el = $(sel); if (el) el.classList.toggle("active", k === name); });
    const tn = $("#tabNorma"); if (tn) tn.classList.remove("active");
    const ti = $("#tabInfo"); if (ti) ti.classList.remove("active");

    const tw = $("#tabWizard"); if (tw) tw.classList.remove("active");

    if (pill) {
      if (name === "project") pill.textContent = "Проект · контейнер пайплайна";
      else if (name === "vor") pill.textContent = "ВОР · распознавание ведомости";
      else if (name === "validator") pill.textContent = "Валидатор · без ИИ, детерминированно";
      else pill.textContent = P.enginePill || pill.textContent;
    }
    if (name === "project") { renderProject(); if (P.activeProject) loadSmetas(); }
    if (name === "vor" && typeof _refreshAiStatus === "function") _refreshAiStatus();
    if (typeof updateVorTabGate === "function") updateVorTabGate();
    if (typeof updateCycleUI === "function") updateCycleUI();
  }

  function resetCycle() {
    P.vorRows = null; P.lastVor = null; P.vorFile = null; P.vorDoc = null; P.vorExtractor = null;
    P.vorStage = 0; P.vorHistory = []; P.vorIndex = null; P.vorScenario = null; P.vorProjectN = null;

    P.vorSubId = null; P.vorObjId = null; P.vorCriteria = null; P.vorFileIds = null;
    P.vorDisc = null; P.vorMapOpen = null; P.vorActOpen = null; P.vorDiscOpen = null;
    P.vorAllCols = false; P.vorBusy = false; P.vorDirty = false;
    try { if (typeof window.engineResetSmeta === "function") window.engineResetSmeta(); } catch (e) {}
    const vs = $("#vorState"); if (vs) vs.textContent = "";
    updateCycleUI();
  }

  function _cycleProjectN() { return P.vorProjectN || (P.activeProject && P.activeProject.n) || null; }

  function _landOnProject() {
    const n = _cycleProjectN();
    resetCycle();
    showView("project");
    if (n && typeof openProject === "function") openProject(n); else renderProject();
  }

  function onCycleComplete() { _landOnProject(); }

  function cancelCycle() {
    const hasDraft = (typeof window.engineHasDraft === "function" && window.engineHasDraft())
      || !!(P.vorRows && P.vorRows.length);
    if (hasDraft && !confirm("Отменить текущий цикл?\nНесохранённые правки прохода будут потеряны. Уже сохранённые в проект ВОР и сметы останутся.")) return;
    _landOnProject();
    toast("Цикл отменён — буферы очищены, сохранённое в проекте цело");
  }

  function updateCycleUI() {
    const btn = $("#cycleCancelBtn"), ind = $("#cycleInd");
    const hasVor = !!(P.vorRows && P.vorRows.length);
    const hasDraft = typeof window.engineHasDraft === "function" && window.engineHasDraft();
    const active = hasVor || hasDraft;
    const state = hasVor ? "ВОР загружен" : hasDraft ? "черновик сметы" : "";
    if (btn) btn.classList.toggle("hidden", !active);
    if (ind) { ind.classList.toggle("hidden", !state); ind.textContent = state ? "Цикл: " + state : ""; }
  }

  async function apiJson(path, opts) { return (await api(path, opts)).json(); }

  async function renderProject() {

    if (P.activeProject) return renderProjectDetail();
    return renderProjectList();
  }

  async function renderProjectList() {
    const host = $("#projectBody");
    host.innerHTML = `<div class="proj-loading">Загрузка проектов…</div>`;
    let projects = [];
    try { projects = (await apiJson("/api/project/list")).projects || []; }
    catch (e) { host.innerHTML = `<div class="vor-err">⚠ ${esc(e.message)}</div>`; return; }

    if (!projects.length) {
      host.innerHTML = `<div class="proj-empty">
        <div class="empty-ic">📁</div>
        <p>Пока нет проектов.<br/>Проект — контейнер: объект, распознанные ВОР и сметы в одном месте.</p>
        <button id="projEmptyNew" class="btn btn-primary">+ Создать первый проект</button>
      </div>`;
      $("#projEmptyNew").onclick = newProject;
      return;
    }

    const order = PROJECT_TYPES.map(t => t.v).concat([""]);
    const byType = {}; projects.forEach(pr => { const k = pr.project_type || ""; (byType[k] = byType[k] || []).push(pr); });
    const groups = order.filter(k => byType[k]).map(k => {
      const t = PROJECT_TYPES.find(x => x.v === k);
      const head = `<div class="proj-grp-h">${t ? t.ic + " " + esc(t.v) : "— тип не выбран —"} <span class="proj-grp-n">${byType[k].length}</span></div>`;
      return head + `<div class="proj-list">${byType[k].map(projCard).join("")}</div>`;
    }).join("");
    host.innerHTML = `<div class="proj-groups">${groups}</div>`;
    host.querySelectorAll(".proj-li").forEach(c => {
      c.onclick = () => openProject(+c.dataset.n, true);
    });

    host.querySelectorAll(".proj-li-open").forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); openProject(+b.dataset.n, true); };
    });
    host.querySelectorAll(".proj-del").forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Удалить?"; b.classList.add("armed"); return; }
        await api("/api/project/delete", { method: "POST", body: JSON.stringify({ n: +b.dataset.n }) });
        toast("Проект удалён"); renderProjectList();
      };
    });
  }

  function projCard(p) {
    const name = p.name || `Проект №${p.n}`;
    const sub = p.object || "— объект не задан —";
    const t = PROJECT_TYPES.find(x => x.v === (p.project_type || ""));
    const typeLine = t ? `<div class="proj-li-type">${t.ic} ${esc(t.v)}</div>` : `<div class="proj-li-type proj-li-type-none">⚠ тип не выбран</div>`;
    return `<div class="proj-li" data-n="${p.n}">
      <div class="proj-li-main">
        ${typeLine}
        <div class="proj-li-name"><button type="button" class="proj-li-open" data-n="${p.n}">${esc(name)}</button></div>
        <div class="proj-li-sub">${esc(sub)}</div>
      </div>
      <div class="proj-li-meta">
        <span class="proj-li-badge" title="распознанных ВОР">📄 ${p.n_vors}</span>
        <span class="proj-li-badge" title="смет">📊 ${p.n_smetas}</span>
        <span class="proj-li-ts">${esc(p.updated || p.ts || "")}</span>
      </div>
      <button class="proj-del" data-n="${p.n}" title="Удалить проект">🗑</button>
    </div>`;
  }

  async function newProject() {
    try {
      const d = await apiJson("/api/project/save", { method: "POST", body: JSON.stringify({ name: "", object: "" }) });
      await openProject(d.n, true);
      toast("Новый проект создан");
    } catch (e) { toast("Не удалось создать проект", "err"); }
  }

  async function openProject(n, resetScroll) {
    try { P.activeProject = await apiJson("/api/project/load?n=" + n); }
    catch (e) { toast("Не удалось открыть проект", "err"); return; }
    P.completeness = null; P.fold = null; P.unfold = null;
    P.smetas = null;
    renderProjectDetail();
    loadSmetas();

    if (resetScroll) { const d = document.querySelector("#projectBody .proj-detail"); if (d) d.scrollTop = 0; }
  }

  const KLASS = {
    vor:      { label: "ВОР · ведомости работ", ic: "📄" },
    smeta:    { label: "Сметы / таблицы",       ic: "📊" },
    document: { label: "Документы",             ic: "📃" },
    drawing:  { label: "Чертежи",               ic: "📐" },
    archive:  { label: "Архивы",                ic: "🗜" },
    other:    { label: "Прочее",                ic: "📦" },
  };
  const KLASS_ORDER = ["vor", "smeta", "document", "drawing", "archive", "other"];

  const RU_REGIONS = ["Республика Каракалпакстан", "Андижанская", "Бухарская", "Джизакская",
    "Кашкадарьинская", "Навоийская", "Наманганская", "Самаркандская", "Сурхандарьинская",
    "Сырдарьинская", "Ташкентская", "Ферганская", "Хорезмская", "г. Ташкент"];

  const CALC_MODE_OPTS = [
    { v: "budget_state", label: "Бюджет — государственный" },
    { v: "budget_private", label: "Бюджет — частный" },
    { v: "user_offer", label: "Договорная (оферта подрядчика)" },
  ];

  const LIM_BTN = [
    { k: "winter", ic: "❄", label: "Зимнее удорожание", src: "winter" },
    { k: "vzis", ic: "🏗", label: "Временные здания и сооружения", src: "vzis" },
  ];
  const PASSPORT_SCHEMA = [
    { id: "calc", ic: "🧮", title: "Каскад ШНК — влияет на цифру", open: true, fields: [
      { k: "region", label: "Регион РУз", type: "select", opts: RU_REGIONS },
      { k: "calc_mode", label: "Режим определения цены", type: "select", opts: CALC_MODE_OPTS },
      { k: "realize_start", label: "Реализация — начало", type: "date" },
      { k: "realize_end", label: "Реализация — окончание", type: "date" },
      { k: "doc_start", label: "Документация/цены — начало периода", type: "date" },
      { k: "doc_end", label: "Документация/цены — окончание периода", type: "date" },
      { k: "u_region", label: "У — авто по региону, %", type: "number", ph: "заполнит Pricing при сборке" },
      { k: "u_percent", label: "У — итоговое, % (прочие затраты подрядчика)", type: "number", ph: "напр. 20,1" },
      { k: "kr_auto", label: "Кр — авто (по срокам), %", type: "number", ph: "заполнит Pricing при сборке" },
      { k: "kr_value", label: "Кр — итоговое, % (прогнозный рост цен)", type: "number", ph: "напр. 15" },
      { k: "kr_reason", label: "Кр — причина ручной правки", type: "text" },
      { k: "pz_sum", label: "Пз — прочие затраты заказчика, сумма", type: "number" },
      { k: "pz_reason", label: "Пз — основание (по договору)", type: "text" },
      { k: "vat", label: "НДС, %", type: "number", ph: "напр. 12" },
    ] },

    { id: "titul", ic: "🪪", title: "Титул — общее для всех подобъектов", fields: [
      { k: "customer", label: "Заказчик", type: "text", req: true },
      { k: "contractor", label: "Генподрядчик", type: "text", req: true },
      { k: "designer", label: "Проектировщик", type: "text", req: true },
    ] },
  ];

  const SUB_TITUL_FIELDS = [
    { k: "shifr", label: "Шифр", type: "text" },
    { k: "stage", label: "Стадия", type: "select", opts: ["Обоснование инвестиций", "Проект (П)", "Рабочая документация (РД)"] },
  ];

  function subTitul(p, s, k) {
    const own = ((s || {}).titul || {})[k];
    if (String(own || "").trim()) return { v: own, inh: false };
    const up = ((p || {}).passport || {})[k];
    return { v: up || "", inh: !!String(up || "").trim() };
  }

  const PROJECT_TYPES = [
    { v: "Новое строительство", ic: "🏗", hint: "все сборники, кроме реставрации и ремонтно-строит." },
    { v: "Ремонт / реконструкция", ic: "🔧", hint: "ремонтно-строит. сборники + реконструкция" },
    { v: "Реставрация", ic: "🏛", hint: "реставрационная серия (памятники)" },
  ];

  const PROJECT_TYPE_SCENARIO = {
    "Новое строительство": "Новое строительство",
    "Ремонт / реконструкция": "Капитальный ремонт",
    "Реставрация": "Реставрация",
  };

  const SCENARIO_PROJECT_TYPE = {
    "Новое строительство": "Новое строительство",
    "Реконструкция": "Ремонт / реконструкция",
    "Техперевооружение": "Ремонт / реконструкция",
    "Расширение": "Ремонт / реконструкция",
    "Капитальный ремонт": "Ремонт / реконструкция",
    "Реставрация": "Реставрация",
  };
  function deriveProjectType(p) {
    const s = projSubs(p).map(x => (x.s.criteria || {}).scenario).find(Boolean);
    return s ? (SCENARIO_PROJECT_TYPE[s] || "") : "";
  }

  const OBJ_CRITERIA_FIELDS = [
    { k: "type", label: "Тип объекта", type: "select", opts: ["Жилой дом (многоквартирный)", "Индивидуальный жилой дом",
      "Общественное здание", "Административное здание", "Производственное здание", "Складское здание", "Инженерное сооружение"] },

    { k: "scenario", label: "Сценарий", type: "select", match: true, opts: ["Новое строительство", "Реконструкция", "Техперевооружение", "Расширение", "Капитальный ремонт", "Реставрация"] },
    { k: "structure", label: "Конструктив", type: "select", match: true, opts: ["Монолитный железобетон", "Сборный железобетон (панельный)",
      "Кирпичная кладка", "Каркасный (металл)", "Каркасный (дерево)", "Смешанный"] },
    { k: "floors", label: "Этажность", type: "select", opts: ["1 этаж", "2–3 этажа", "4–5 этажей", "6–9 этажей", "10–16 этажей", "17+ этажей"] },

    { k: "height_m", label: "Высота здания, м", type: "number", opt: true, ph: "напр. 6 — для поправок по высоте работ" },

    { k: "seismic_balls", label: "Сейсмичность, баллов", type: "number", opt: true, ph: "напр. 8 — для поправок по сейсмике" },

    { k: "finish_quality", label: "Качество отделки", type: "select", opt: true, opts: ["Простая", "Улучшенная", "Высококачественная"] },
    { k: "decor_method", label: "Нанесение декор. покрытий", type: "select", opt: true, opts: ["Ручное", "Механизированное"] },
  ];

  function _srcBadge(src, emptyReq) {
    if (emptyReq) return ` <span class="pf-src need" title="в ВОРе нет — заполните вручную">🟡</span>`;
    if (src === "stamp") return ` <span class="pf-src ok" title="из ВОРа (штамп)">🟢</span>`;
    if (src === "guess") return ` <span class="pf-src warn" title="выведено движком — проверьте">🟡</span>`;
    if (src === "default") return ` <span class="pf-src def" title="дефолт движка — можно оставить">⚪</span>`;
    return "";
  }
  function passField(f, val, src) {
    const v = val == null ? "" : String(val);
    const id = `pf_${f.k}`;
    const req = f.req ? ' <span class="pf-req">*</span>' : "";

    const emptyReq = f.req && !v.trim() ? " pf-empty-req" : "";
    const lbl = `<span class="pf-l">${esc(f.label)}${req}${_srcBadge(src, f.req && !v.trim())}</span>`;
    if (f.type === "select") {

      const asOpt = o => (o && typeof o === "object") ? o : { v: o, label: o };
      const opts = ['<option value="">—</option>'].concat(f.opts.map(o => {
        const { v: ov, label } = asOpt(o);
        return `<option value="${esc(ov)}"${ov === v ? " selected" : ""}>${esc(label)}</option>`;
      })).join("");
      return `<label class="pf${emptyReq}">${lbl}<select class="pf-in" data-pk="${f.k}" id="${id}">${opts}</select></label>`;
    }
    if (f.type === "textarea") {
      return `<label class="pf pf-wide">${lbl}<textarea class="pf-in pf-ta" data-pk="${f.k}" id="${id}" rows="2" placeholder="${esc(f.ph || "")}"></textarea></label>`;
    }

    const isNum = f.type === "number";
    const attrs = isNum ? 'type="text" inputmode="decimal"' : `type="${f.type === "date" ? "date" : "text"}"`;
    return `<label class="pf${emptyReq}">${lbl}<input class="pf-in" ${attrs} data-pk="${f.k}" id="${id}" placeholder="${esc(f.ph || "")}"/></label>`;
  }

  function projSubs(p) {
    const out = [];
    ((p || {}).objects || []).forEach(o => (o.subs || []).forEach(s => out.push({ o: o, s: s })));
    return out;
  }
  function subById(p, id) {
    return projSubs(p).find(x => String(x.s.id) === String(id)) || null;
  }

  function subVors(p, s) {
    const fids = new Set(s.vor_file_ids || []);
    return (p.vors || []).filter(v => (v.sub_id ? String(v.sub_id) === String(s.id) : fids.has(v.file_id)));
  }
  function subFiles(p, s) {
    const fids = new Set(s.vor_file_ids || []);
    return (p.files || []).filter(f => f.klass === "vor"
      && (f.sub_id ? String(f.sub_id) === String(s.id) : fids.has(f.id)));
  }

  function limBlock(pp) {
    const cells = LIM_BTN.map(b => {
      const nm = pp[b.k + "_name"] || "", pct = pp[b.k + "_pct"] || "";
      const zone = b.k === "winter" ? (pp.winter_zone || "") : "";
      const val = nm
        ? `<span class="lim-v"><b>${esc(pct)}%</b>${zone ? ` · зона ${esc(zone)}` : ""} — ${esc(nm)}</span>`
        : `<span class="lim-v lim-none">не выбрано · необязательно</span>`;
      return `<div class="lim-row">
        <button class="btn btn-ghost lim-btn" data-lim="${b.k}">${b.ic} ${esc(b.label)}</button>
        ${val}
        ${nm ? `<button class="btn-s lim-clr" data-lim="${b.k}" title="Очистить">✕</button>` : ""}
        <input type="hidden" data-pk="${b.k}_name" value="${esc(nm)}"/>
        <input type="hidden" data-pk="${b.k}_pct" value="${esc(pct)}"/>
        ${b.k === "winter" ? `<input type="hidden" data-pk="winter_zone" value="${esc(zone)}"/>` : ""}
      </div>`;
    }).join("");
    return `<div class="lim-block">
      <div class="lim-h">Лимитированные затраты <span class="s">необязательно · проценты из таблиц ШНК</span></div>
      ${cells}
    </div>`;
  }

  async function openLimModal(kind) {
    const m = $("#limModal"), body = $("#limBody"), ttl = $("#limTitle");
    if (!m) return;
    m.classList.remove("hidden");
    body.innerHTML = `<div class="eq-empty">Загрузка таблицы ШНК…</div>`;
    if (!P.limData) {
      try { P.limData = await apiJson("/api/lim_zatraty"); }
      catch (e) { body.innerHTML = `<div class="eq-empty">Не удалось загрузить справочник</div>`; return; }
    }
    P.limKind = kind; P.limQuery = "";
    const d = P.limData[kind];
    ttl.textContent = (kind === "winter" ? "❄ Зимнее удорожание" : "🏗 Временные здания и сооружения")
      + " · " + d.shnk;
    renderLimBody();
  }
  function renderLimBody() {
    const body = $("#limBody"), d = (P.limData || {})[P.limKind]; if (!d) return;
    const q = (P.limQuery || "").trim().toLowerCase();
    const winter = P.limKind === "winter";
    const pp = (P.activeProject || {}).passport || {};
    const zone = pp.winter_zone || (P.limZone || "I");
    const hit = it => !q || (it.name + " " + (it.parent || "")).toLowerCase().includes(q);
    const rows = d.groups.map(g => {
      const items = g.items.filter(hit);
      if (!items.length) return "";
      return `<div class="lim-grp">${esc(g.title)}</div>` + items.map(it => {
        const v = winter ? it.v[zone === "II" ? 1 : 0] : it.v;
        const nm = (it.parent ? esc(it.parent) + " · " : "") + esc(it.name);
        return `<div class="lim-item" data-name="${esc((it.parent ? it.parent + " · " : "") + it.name)}" data-pct="${esc(v)}">
          <span class="nm">${it.no ? `<i>${esc(it.no)}</i> ` : ""}${nm}</span>
          <span class="pct">${esc(v)}%</span></div>`;
      }).join("");
    }).join("");
    const zoneSel = winter ? `<label class="lim-zone">Температурная зона
        <select id="limZone">${["I", "II"].map(z => `<option value="${z}"${z === zone ? " selected" : ""}>${z}</option>`).join("")}</select></label>` : "";
    body.innerHTML = `<div class="lim-top">
        <input id="limSearch" class="pf-in" placeholder="🔍 Поиск по виду строительства…" value="${esc(P.limQuery || "")}" autocomplete="off"/>
        ${zoneSel}
      </div>
      <div class="lim-note">${esc(d.title)} · норма в ${esc(d.unit)}. ${esc(d.note || "")}
        <b>Пока справочно:</b> цен в движке нет, смета считается в объёмах — процент сохранится в проекте и вступит в силу с ценовым слоем.</div>
      <div class="lim-list">${rows || '<div class="eq-empty">Ничего не найдено</div>'}</div>`;
    const s = $("#limSearch");
    if (s) {
      s.oninput = () => { P.limQuery = s.value; const pos = s.selectionStart; renderLimBody();
        const n = $("#limSearch"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
    }
    const z = $("#limZone");
    if (z) z.onchange = () => { P.limZone = z.value; renderLimBody(); };
    body.querySelectorAll(".lim-item").forEach(el => {
      el.onclick = () => {
        const p = P.activeProject; if (!p) return;
        p.passport = p.passport || {};
        p.passport[P.limKind + "_name"] = el.dataset.name;
        p.passport[P.limKind + "_pct"] = el.dataset.pct;
        if (P.limKind === "winter") p.passport.winter_zone = (P.limZone || pZone());
        $("#limModal").classList.add("hidden");
        renderProjectDetail();
        savePassport();
        toast("Норма выбрана: " + el.dataset.pct + "% — " + el.dataset.name.slice(0, 60));
      };
    });
    function pZone() { const zz = $("#limZone"); return zz ? zz.value : "I"; }
  }

  const _EJ = { buf: [], t: null };

  function _operator() {
    const el = document.getElementById("operator");
    if (el && el.textContent.trim() && el.textContent.trim() !== "оператор") return el.textContent.trim();
    try { return (JSON.parse(sessionStorage.getItem("iismeta_auth") || "{}").operator || ""); }
    catch (e) { return ""; }
  }
  function logEdit(field, was, now, r, extra) {
    if (String(was == null ? "" : was) === String(now == null ? "" : now)) return;
    const p = P.activeProject || {};
    const f = (P.vorFileIds && P.vorFileIds.length === 1) ? P.vorFileIds[0] : "";
    _EJ.buf.push(Object.assign({
      kind: (extra && extra.kind) || "cell", field: field,
      was: was, now: now,
      raw: (r && (r._raw || r.name)) || "",
      project_n: p.n || null, file_id: f, sub_id: P.vorSubId || "",
      discipline: (r && r._disc) || P.vorDisc || "",
      pos: (r && r.pos) || "", unit: (r && r.unit) || "", qty: (r && r.qty) != null ? r.qty : null,
      operator: _operator(),
    }, extra || {}));
    if (_EJ.t) clearTimeout(_EJ.t);
    _EJ.t = setTimeout(flushEdits, 1500);
    if (_EJ.buf.length >= 25) flushEdits();
  }
  function flushEdits() {
    if (_EJ.t) { clearTimeout(_EJ.t); _EJ.t = null; }
    if (!_EJ.buf.length) return;
    const batch = _EJ.buf.splice(0, _EJ.buf.length);
    api("/api/vor/edit_log", { method: "POST", body: JSON.stringify({ edits: batch }) })
      .catch(() => {  });
  }
  window.addEventListener("beforeunload", flushEdits);

  function plural(n, one, few, many) {
    n = Math.abs(n) % 100;
    const d = n % 10;
    if (n > 10 && n < 20) return many;
    if (d > 1 && d < 5) return few;
    if (d === 1) return one;
    return many;
  }

  async function loadSmetas() {
    try {
      const d = await apiJson("/api/smeta_list");
      P.smetas = d.smetas || [];
    } catch (e) { P.smetas = []; }
    if (P.activeProject) renderProjectDetail();
  }

  function subSmetas(p, s) {
    const list = P.smetas || [];
    const pn = (p.name || "").trim().toLowerCase(), sn = (s.name || "").trim().toLowerCase();
    return list.filter(x => {
      const q = x.proj || {};
      if (q.sub_id) return String(q.sub_id) === String(s.id);
      if (!sn) return false;
      return String(q.подобъект || "").trim().toLowerCase() === sn
        && (!pn || String(q.проект || "").trim().toLowerCase() === pn);
    });
  }

  function smetaVorIds(x) {
    const q = (x && x.proj) || {};
    const v = q.vor_file_ids;
    return Array.isArray(v) ? v.map(String) : (v ? String(v).split(",").filter(Boolean) : []);
  }
  function smetasOfVor(p, s, fileId) {
    return subSmetas(p, s).filter(x => smetaVorIds(x).indexOf(String(fileId)) >= 0);
  }
  function subRows(p, s) {
    let n = 0;
    subVors(p, s).forEach(v => {
      const rs = v.rows || [];
      n += rs.length ? rs.filter(r => !r._sec).length : ((v.stats && v.stats.rows) || 0);
    });
    return n;
  }

  function objChips(crit) {
    crit = crit || {};
    return OBJ_CRITERIA_FIELDS.map(f => crit[f.k]
      ? `<span class="obj-chip">${esc(crit[f.k])}</span>`
      : f.opt
        ? `<span class="obj-chip obj-chip-opt" title="Уточнение: можно не заполнять — движок возьмёт умолчание и пометит такие строки «уточнить»">${esc(f.label.toLowerCase())}: —</span>`
        : `<span class="obj-chip obj-chip-miss" title="Обязательно — влияет на дерево, ресурсы, структурирование">⚠ ${esc(f.label.toLowerCase())}</span>`).join("");
  }

  function objMatchMissing(o) {
    const c = (o || {}).criteria || {};
    return OBJ_CRITERIA_FIELDS.filter(f => f.match && !(c[f.k] || "").trim());
  }
  function objReadyForVor(o) {
    return objMatchMissing(o).length === 0;
  }

  function deriveWorkKind(p) {
    const pt = (p.project_type || "").trim();
    if (!pt) return "";
    if (pt === "Новое строительство") return "new";
    if (pt === "Реставрация") return "repair";
    if (pt === "Ремонт / реконструкция") {
      const scenarios = projSubs(p).map(x => (x.s.criteria || {}).scenario).filter(Boolean);
      return scenarios.some(s => s === "Реконструкция" || s === "Техперевооружение" || s === "Расширение")
        ? "reconstruction" : "repair";
    }
    return "";
  }

  async function syncWorkKind(p) {
    const pt = deriveProjectType(p);
    const ptChanged = !!pt && pt !== (p.project_type || "");

    const wk = deriveWorkKind(ptChanged ? { ...p, project_type: pt } : p);
    const wkChanged = !!wk && (p.passport || {}).work_kind !== wk;
    if (!ptChanged && !wkChanged) return;
    const body = { n: p.n };
    if (ptChanged) body.project_type = pt;
    const passport = wkChanged ? { ...(p.passport || {}), work_kind: wk } : null;
    if (passport) body.passport = passport;
    try {
      await api("/api/project/save", { method: "POST", body: JSON.stringify(body) });
      if (ptChanged) p.project_type = pt;
      if (passport) p.passport = passport;
    } catch (e) {  }
  }

  function wizardComplete(p) {

    if (!p || !((p.project_type || deriveProjectType(p)) || "").trim()) return false;
    const hasRows = (p.vors || []).some(v => ((v.stats && v.stats.rows) || (v.rows || []).length) > 0);
    return hasRows && projSubs(p).some(x => objReadyForVor(x.s));
  }

  function subReadyForVor(p, s) {
    return objReadyForVor(s) && subRows(p, s) > 0;
  }

  function goToVor(p, subId, fileIds) {
    const hit = subId ? subById(p, subId) : null;
    if (!hit) { toast("Подобъект не найден — обновите страницу", "err"); return; }
    const sub = hit.s;
    let vors = subVors(p, sub);
    if (fileIds && fileIds.length) {
      const want = new Set(fileIds.map(String));
      vors = vors.filter(v => want.has(String(v.file_id)));
    }

    {
      const seen = new Set(), dedup = [];
      vors.forEach(v => {
        const k = v.file_id ? "f:" + v.file_id : ("#" + (p.vors || []).indexOf(v));
        if (!seen.has(k)) { seen.add(k); dedup.push(v); }
      });
      vors = dedup;
    }
    const rows = []; let doc = null, extractor = null;
    vors.forEach(v => {
      if (!doc) doc = v.document; if (!extractor) extractor = v.extractor;
      (v.rows || []).forEach(r => rows.push(r));
    });
    if (!rows.length) { toast("У подобъекта «" + (sub.name || "") + "» нет распознанных строк ВОР", "err"); return; }
    P.vorProjectN = p.n;
    P.vorSubId = sub.id; P.vorObjId = hit.o.id;

    P.vorFileIds = vors.map(v => String(v.file_id || "")).filter(Boolean);

    P.vorIndex = (vors.length === 1) ? (p.vors || []).indexOf(vors[0]) : null;
    if (P.vorIndex < 0) P.vorIndex = null;

    P.vorScenario = (sub.criteria || {}).scenario || PROJECT_TYPE_SCENARIO[p.project_type] || "";

    P.vorCriteria = sub.criteria || {};
    renderVor({ document: doc, extractor: extractor, rows: rows });
    showView("vor");
  }

  function updateVorTabGate() {
    const tv = $("#tabVor"); if (!tv) return;
    const ok = wizardComplete(P.activeProject);
    tv.classList.toggle("tab-locked", !ok);
    tv.title = ok ? "" : "Сначала пройдите визард в «Проекте»: тип → распознать ВОР → критерии объекта";
  }

  const _FOLD_BY_DEFAULT = /^eq_/;
  function isFold(id) {
    id = String(id);
    if (_FOLD_BY_DEFAULT.test(id)) return !((P.unfold = P.unfold || new Set()).has(id));
    return (P.fold = P.fold || new Set()).has(id);
  }
  function toggleFold(id) {
    id = String(id);
    const set = _FOLD_BY_DEFAULT.test(id) ? (P.unfold = P.unfold || new Set()) : (P.fold = P.fold || new Set());
    if (set.has(id)) set.delete(id); else set.add(id);
  }
  function tgBtn(id) {
    const f = isFold(id);
    return `<button class="tg" data-fold="${esc(String(id))}" title="${f ? "Развернуть" : "Свернуть"}">${f ? "＋" : "−"}</button>`;
  }

  function vorNo(f, v) {
    const m = String((f && f.filename) || "").match(/([A-Z]{2,4})[-_](\d{3,6})(?=[-_.]|$)/i);
    if (m) return (m[1] + "-" + m[2]).toUpperCase();
    return String(((v || {}).document || {}).doc_no || "").trim();
  }

  function subCard(p, o, s) {
    const fold = isFold(s.id);
    const crit = s.criteria || {};
    const miss = objMatchMissing(s);
    const nR = subRows(p, s), files = subFiles(p, s);
    const discs = new Set(files.map(f => f.discipline || "Без дисциплины"));

    const st = miss.length
      ? `<span class="st st-need">⚠ ${esc(miss.map(f => f.label.toLowerCase()).join(", "))}</span>`
      : (nR ? `<span class="st st-ok">✓ готов к расценкам</span>`
            : `<span class="st st-need">⚠ нет ведомостей</span>`);
    const nSm = subSmetas(p, s).length;
    const tail = `${discs.size} дисц · ${files.length} ВОР · ${nR} ${plural(nR, "работа", "работы", "работ")}${nSm ? " · 📊 " + nSm : ""}`;
    const head = `<div class="sub-h">${tgBtn(s.id)}
        <span class="nm">🏢 ${esc(s.name || "подобъект без имени")}</span>${st}
        <span class="tail">${tail}</span>
        <button class="btn-s sub-ren" data-sid="${esc(s.id)}" title="Переименовать">✎</button>
        <button class="btn-s sub-del" data-sid="${esc(s.id)}" title="Удалить подобъект">🗑</button>
      </div>`;
    if (fold) return `<div class="sub" data-sid="${esc(s.id)}">${head}<div class="chips">${objChips(crit)}</div></div>`;
    return `<div class="sub act" data-sid="${esc(s.id)}">${head}
      <div class="chips">${objChips(crit)}</div>
      <div class="sub-body">
        ${subTitulSection(p, s)}
        ${subVorSection(p, s)}
        ${subGoBlock(p, s, miss)}
      </div>
    </div>`;
  }

  function subTitulSection(p, s) {
    const id = "tit_" + s.id, fold = isFold(id);
    const busy = P.objInferBusy === String(s.id);
    const aiBtn = `<button class="obj-ai-btn${busy ? " busy" : ""}" data-sid="${esc(s.id)}">${busy ? "🤖 читаю ВОР…" : "🤖 Определить (AI по ВОР)"}</button>`;
    const crit = s.criteria || {};
    const critHtml = OBJ_CRITERIA_FIELDS.map(f => {
      const cur = crit[f.k] || "";
      const need = f.match && !cur ? " sf-need" : "";

      const ctl = f.type === "number"
        ? `<input class="pf-in sf-in${need}" type="text" inputmode="decimal" data-sid="${esc(s.id)}" data-ck="${f.k}" value="${esc(cur)}" placeholder="${esc(f.ph || "")}" autocomplete="off"/>`
        : `<select class="pf-in sf-in${need}" data-sid="${esc(s.id)}" data-ck="${f.k}">` +
          ['<option value="">— не задано —</option>'].concat(f.opts.map(v =>
            `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`)).join("") + `</select>`;
      return `<div class="f"><label>${esc(f.label)}${f.match ? ' <span class="sf-req" title="Влияет на подбор расценок">★</span>' : ""}</label>${ctl}</div>`;
    }).join("");
    const titHtml = SUB_TITUL_FIELDS.map(f => {
      const t = subTitul(p, s, f.k);
      const inh = t.inh ? ` <span class="sf-inh" title="Унаследовано от проекта — введите своё, чтобы переопределить">от проекта</span>` : "";
      const ctl = f.type === "select"
        ? `<select class="pf-in sf-in" data-sid="${esc(s.id)}" data-tk="${f.k}">` +
          ['<option value="">— не задано —</option>'].concat(f.opts.map(v =>
            `<option value="${esc(v)}"${v === t.v ? " selected" : ""}>${esc(v)}</option>`)).join("") + `</select>`
        : `<input class="pf-in sf-in" data-sid="${esc(s.id)}" data-tk="${f.k}" value="${esc(t.v)}" autocomplete="off"/>`;
      return `<div class="f"><label>${esc(f.label)}${inh}</label>${ctl}</div>`;
    }).join("");
    return `<div class="s2">
      <div class="s2-h">${tgBtn(id)}<span class="t">Титульные данные подобъекта</span>
        <span class="s">действуют на все дисциплины этого подобъекта</span>
        <span class="tail">${aiBtn}</span></div>
      ${fold ? "" : `<div class="s2-b">
        <div class="pf-grid">${critHtml}${titHtml}</div>
        <div class="sf-inherit">Заказчик, генподрядчик, проектировщик, регион, НДС — наследованы от проекта, здесь не дублируются.</div>
      </div>`}
    </div>`;
  }

  function subVorSection(p, s) {
    const id = "vor_" + s.id, fold = isFold(id);
    const files = subFiles(p, s);
    const byFid = {}; (p.vors || []).forEach(v => { if (v.file_id) byFid[v.file_id] = v; });
    const allSubs = projSubs(p);
    const loading = P.smetas === null;
    const sel = P.vorPick && P.vorPick[s.id] ? P.vorPick[s.id] : {};
    const multi = files.length > 1;

    const byDisc = {};
    files.forEach(f => { const d = f.discipline || "Без дисциплины"; (byDisc[d] = byDisc[d] || []).push(f); });
    const body = Object.keys(byDisc).sort().map(d => {
      const rows = byDisc[d].map(f => {
        const v = byFid[f.id];
        const rc = v ? (v.rows || []).filter(r => !r._sec).length || (v.stats ? v.stats.rows : 0) : 0;

        const mv = allSubs.length > 1
          ? `<select class="vor-move" data-fid="${esc(f.id)}" title="Перенести ведомость в другой подобъект">` +
            allSubs.map(x => `<option value="${esc(x.s.id)}"${String(x.s.id) === String(s.id) ? " selected" : ""}>${esc(x.s.name || "—")}</option>`).join("") +
            `</select>` : "";
        const sm = smetasOfVor(p, s, f.id);
        const smCell = loading
          ? `<span class="sm-cell sm-wait">…</span>`
          : (sm.length
            ? sm.map(x => `<button class="sm-cell sm-has sm-open" data-n="${x.n}" title="${esc(x.title || "")} · ${esc(x.ts || "")}">📊 №${x.n} · ${x.n_rows || 0} ${plural(x.n_rows || 0, "строка", "строки", "строк")}</button>`).join("")
            : `<span class="sm-cell sm-no">сметы нет</span>`);
        const cb = multi
          ? `<input type="checkbox" class="vor-pick" data-sid="${esc(s.id)}" data-fid="${esc(f.id)}"${sel[f.id] ? " checked" : ""} title="Отметить, чтобы посчитать несколько ведомостей одной сметой"/>`
          : "";
        return `<div class="vorline">
          ${cb}<span class="disc">${esc(d)}<small>${esc(f.filename || "")}</small></span>
          <span class="no">${esc(vorNo(f, v))}</span>
          ${v ? `<span class="rows">✓ ${rc} ${plural(rc, "работа", "работы", "работ")}</span>` : `<span class="tg-wait">ожидает распознавания</span>`}
          ${smCell}
          ${v ? `<button class="btn-s vor-go" data-sid="${esc(s.id)}" data-fid="${esc(f.id)}" title="Считать смету по этой ведомости">Продолжить →</button>` : ""}
          ${mv}<button class="pt-del" data-fid="${esc(f.id)}" title="Удалить файл">✕</button>
        </div>`;
      }).join("");
      return `<div class="discblk"><div class="discgrp">${esc(d)}</div>${rows}</div>`;
    }).join("");

    const orphan = loading ? [] : subSmetas(p, s).filter(x => !smetaVorIds(x).length);
    const orphanHtml = orphan.map(x => `<div class="vorline vor-none">
        ${multi ? '<span class="cb-gap"></span>' : ""}
        <span class="disc">— <small>без ведомости · набрана в ядре</small></span>
        <span class="no">—</span><span class="rows"></span>
        <button class="sm-cell sm-has sm-open" data-n="${x.n}" title="${esc(x.title || "")}">📊 №${x.n} · ${x.n_rows || 0} ${plural(x.n_rows || 0, "строка", "строки", "строк")}</button>
      </div>`).join("");

    const nSel = Object.keys(sel).filter(k => sel[k]).length;
    const mergeBar = multi ? `<div class="vor-merge">
        <span class="vm-t">${nSel > 1
          ? `Отмечено ${nSel} — уйдут в один проход и дадут одну общую смету.`
          : "По умолчанию каждая ведомость считается отдельной сметой. Отметьте две и больше, чтобы объединить их в одну."}</span>
        <button class="btn btn-primary btn-s vor-go-multi" data-sid="${esc(s.id)}"${nSel > 1 ? "" : " disabled"}>Объединить отмеченные →</button>
      </div>` : "";

    const nSm = loading ? 0 : subSmetas(p, s).length;
    return `<div class="s2">
      <div class="s2-h">${tgBtn(id)}<span class="t">Ведомости и сметы</span><span class="s">смета — на каждую ведомость</span>
        <span class="tail">${Object.keys(byDisc).length} дисц · ${files.length} ВОР · 📊 ${loading ? "…" : nSm}</span></div>
      ${fold ? "" : `<div class="s2-b">${body || '<div class="eq-empty">Ведомостей нет. Загрузите ВОР — движок разложит его по дисциплинам.</div>'}
        ${orphanHtml}${mergeBar}
        <label class="intake-drop intake-mini sub-drop" data-sid="${esc(s.id)}">
          <input type="file" multiple hidden class="sub-file" data-sid="${esc(s.id)}"/>
          <div class="intake-ic">📥</div><div class="intake-t">＋ ВОР для этого подобъекта</div>
        </label></div>`}
    </div>`;
  }

  function subGoBlock(p, s, miss) {
    const nR = subRows(p, s);
    if (miss.length) return `<div class="govor-block govor-todo">
      <div class="govor-txt">Заполните ${esc(miss.map(f => f.label.toLowerCase()).join(", "))} — от ${miss.length > 1 ? "них" : "него"} зависит подбор расценок.</div>
      <button class="btn govor-btn" disabled>Продолжить →</button></div>`;
    if (!nR) return `<div class="govor-block govor-todo">
      <div class="govor-txt">Критерии заполнены, но у подобъекта нет распознанных строк ВОР.</div>
      <button class="btn govor-btn" disabled>Продолжить →</button></div>`;

    const files = subFiles(p, s);
    if (files.length > 1) {
      const done = files.filter(f => smetasOfVor(p, s, f.id).length).length;
      return `<div class="govor-block govor-ok">
        <div class="govor-txt">✓ Готов. ${files.length} ${plural(files.length, "ведомость", "ведомости", "ведомостей")}, ${nR} ${plural(nR, "работа", "работы", "работ")}.
          Смета считается на каждую ведомость — кнопка «Продолжить» у нужной строки выше.
          ${done ? `Посчитано: ${done} из ${files.length}.` : ""}</div></div>`;
    }
    const have = files.length ? smetasOfVor(p, s, files[0].id) : [];
    const again = have.length
      ? `<div class="govor-note">По этой ведомости уже есть ${plural(have.length, "смета", "сметы", "сметы")} №${have.map(x => x.n).join(", №")} — новый проход создаст ещё одну, старая останется.</div>`
      : "";
    return `<div class="govor-block govor-ok">
      <div class="govor-txt">✓ Готов. Дальше: чистка ВОР → расценки → ресурсы и смета. ${nR} ${plural(nR, "работа", "работы", "работ")}.</div>
      ${again}
      <button class="btn btn-primary govor-btn sub-go" data-sid="${esc(s.id)}">Продолжить →</button></div>`;
  }

  function renderLevels(p) {
    const objs = p.objects || [];
    if (!objs.length) return `<div class="proj-vors-empty">Структура появится после распознавания: движок разложит ведомости по объектам, подобъектам и дисциплинам.</div>`;
    return objs.map(o => {
      const subs = o.subs || [];
      const fold = isFold(o.id);
      let nV = 0, nR = 0;
      subs.forEach(s => { nV += subFiles(p, s).length; nR += subRows(p, s); });
      return `<div class="obj" data-oid="${esc(o.id)}">
        <div class="obj-h">${tgBtn(o.id)}<span class="ic">🏗</span>
          <span class="nm">${esc(o.name || "объект без имени")}</span>
          <span class="cnt">${subs.length} подобъект${subs.length === 1 ? "" : "а"} · ${nV} ВОР · ${nR} работ</span>
          <button class="btn-s obj-ren" data-oid="${esc(o.id)}" title="Переименовать">✎</button>
          <button class="btn-s sub-add" data-oid="${esc(o.id)}">＋ подобъект</button>
          <button class="btn-s obj-del" data-oid="${esc(o.id)}" title="Удалить объект со всеми подобъектами">🗑</button>
        </div>
        ${fold ? "" : `<div class="obj-body">${subs.map(s => subCard(p, o, s)).join("")}</div>`}
      </div>`;
    }).join("");
  }

  function renderCompletenessBlock(p) {
    const hasObj = (p.objects || []).length, hasVor = (p.vors || []).length;
    const gate = !hasObj ? "Заведите хотя бы один объект — дерево стадий строится из объекта."
      : !hasVor ? "Загрузите и распознайте ВОР — факт берётся из его строк." : "";
    const body = P.completeness ? renderCompletenessResult(P.completeness)
      : `<div class="cmpl-empty">Сопоставление: какие плановые стадии покрыты строками ВОР, а каких не хватает.</div>`;
    return `<div class="proj-block">
      <div class="pb-h"><span class="pb-t">Полнота по стадиям</span><span class="proj-sec-sub">план (дерево) vs факт (ВОР)</span>
        ${gate ? "" : '<button id="cmplBtn" class="pb-act">⚖ Проверить полноту</button>'}</div>
      ${gate ? `<div class="cmpl-gate">${esc(gate)}</div>` : body}
    </div>`;
  }

  function renderCompletenessResult(d) {

    const ic = { covered: "✅", missing: "⏳", extra: "⚪", none: "·" };
    const rows = d.stages.map(s => `<div class="cmpl-row cmpl-${s.status}">
        <span class="cmpl-ic">${ic[s.status] || "·"}</span>
        <span class="cmpl-ord">${s.order}</span>
        <span class="cmpl-t">${esc(s.title)}</span>
        <span class="cmpl-tag">${s.expected ? "план" : "вне плана"}</span>
        <span class="cmpl-n">${s.n_rows ? s.n_rows + " стр" : "—"}</span>
      </div>`).join("");
    const sm = d.summary;
    const unmapped = d.n_unmapped ? `<span class="cmpl-warn" title="строки, не легшие ни на одну стадию (вне покрытия воронки — напр. монтаж/нефтегаз)">${d.n_unmapped} из ${d.n_rows} строк вне покрытия</span>` : "";
    return `<div class="cmpl-sum">план: ${sm.n_expected} стадий · покрыто ВОРом: ${sm.n_covered} · <b class="cmpl-miss-n">ждут ВОР: ${sm.n_missing}</b> ${unmapped}</div>
      <div class="cmpl-list">${rows}</div>
      <div class="cmpl-note">⏳ плановая стадия без ВОР — ждёт свою дисциплину/этап (не ошибка) · ✅ покрыто · ⚪ есть в ВОРе, вне плана. v1: уровень проекта (без пообъектной привязки).</div>`;
  }

  async function runCompleteness(p) {
    const btn = document.getElementById("cmplBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Считаю…"; }
    try {
      P.completeness = await apiJson("/api/project/completeness", { method: "POST", body: JSON.stringify({ n: p.n }) });
      renderProjectDetail();
    } catch (e) { toast("Полнота не посчиталась: " + (e.message || ""), "err"); if (btn) { btn.disabled = false; btn.textContent = "⚖ Проверить полноту"; } }
  }

  function wireObjectsBlock(host, p) {
    const cmplBtn = host.querySelector("#cmplBtn");
    if (cmplBtn) cmplBtn.onclick = () => runCompleteness(p);

    const saveObjects = async (objects) => {
      await api("/api/project/save", { method: "POST", body: JSON.stringify({ n: p.n, objects }) });
      p.objects = objects;
      syncWorkKind(p);
    };
    const objsCopy = () => JSON.parse(JSON.stringify(p.objects || []));
    const withSub = (objects, sid, fn) => {
      objects.forEach(o => (o.subs || []).forEach(s => { if (String(s.id) === String(sid)) fn(s, o); }));
      return objects;
    };
    const newId = (pre) => pre + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const addBtn = host.querySelector("#objAddBtn");
    if (addBtn) addBtn.onclick = async () => {
      const name = (prompt("Название объекта (стройка/площадка):", "") || "").trim();
      if (!name) return;
      const objects = objsCopy();
      objects.push({ id: newId("obj"), name: name, subs: [] });
      try { await saveObjects(objects); renderProjectDetail(); }
      catch (e) { toast("Не удалось добавить объект", "err"); }
    };
    host.querySelectorAll(".obj-ren").forEach(b => {
      b.onclick = async () => {
        const cur = (p.objects || []).find(x => String(x.id) === b.dataset.oid) || {};
        const name = (prompt("Название объекта:", cur.name || "") || "").trim();
        if (!name || name === cur.name) return;
        const objects = objsCopy();
        objects.forEach(o => { if (String(o.id) === b.dataset.oid) o.name = name; });
        try { await saveObjects(objects); renderProjectDetail(); }
        catch (e) { toast("Не переименовалось", "err"); }
      };
    });
    host.querySelectorAll(".obj-del").forEach(b => {
      b.onclick = async () => {
        const o = (p.objects || []).find(x => String(x.id) === b.dataset.oid) || {};
        const nSub = (o.subs || []).length;

        if (!confirm(`Удалить объект «${o.name || ""}»` + (nSub ? ` вместе с ${nSub} подобъектом(ами)?` : "?"))) return;
        const objects = objsCopy().filter(x => String(x.id) !== b.dataset.oid);
        try { await saveObjects(objects); renderProjectDetail(); }
        catch (e) { toast("Не удалось удалить объект", "err"); }
      };
    });

    host.querySelectorAll(".sub-add").forEach(b => {
      b.onclick = async () => {
        const name = (prompt("Название подобъекта (здание/сооружение):", "") || "").trim();
        if (!name) return;
        const objects = objsCopy();
        const o = objects.find(x => String(x.id) === b.dataset.oid);
        if (!o) return;

        const sib = (o.subs || [])[0] || {};
        const scen = ((sib.criteria || {}).scenario) || PROJECT_TYPE_SCENARIO[p.project_type] || "";
        (o.subs = o.subs || []).push({ id: newId("sub"), name: name,
          criteria: scen ? { scenario: scen } : {}, titul: {}, equipment: [], vor_file_ids: [] });
        try { await saveObjects(objects); renderProjectDetail(); }
        catch (e) { toast("Не удалось добавить подобъект", "err"); }
      };
    });
    host.querySelectorAll(".sub-ren").forEach(b => {
      b.onclick = async () => {
        const hit = subById(p, b.dataset.sid); if (!hit) return;
        const name = (prompt("Название подобъекта:", hit.s.name || "") || "").trim();
        if (!name || name === hit.s.name) return;
        try { await saveObjects(withSub(objsCopy(), b.dataset.sid, s => { s.name = name; })); renderProjectDetail(); }
        catch (e) { toast("Не переименовалось", "err"); }
      };
    });
    host.querySelectorAll(".sub-del").forEach(b => {
      b.onclick = async () => {
        const hit = subById(p, b.dataset.sid); if (!hit) return;
        const nV = subFiles(p, hit.s).length;
        if (!confirm(`Удалить подобъект «${hit.s.name || ""}»?` + (nV ? ` Его ${nV} ведомость(и) останутся в проекте без привязки.` : ""))) return;
        const objects = objsCopy();
        objects.forEach(o => { o.subs = (o.subs || []).filter(s => String(s.id) !== String(b.dataset.sid)); });
        try { await saveObjects(objects); renderProjectDetail(); }
        catch (e) { toast("Не удалось удалить подобъект", "err"); }
      };
    });

    const saveSubField = async (el) => {
      const sid = el.dataset.sid, val = (el.value || "").trim();
      const ck = el.dataset.ck, tk = el.dataset.tk;
      const objects = withSub(objsCopy(), sid, s => {
        if (ck) { s.criteria = s.criteria || {}; if (val) s.criteria[ck] = val; else delete s.criteria[ck]; }
        if (tk) { s.titul = s.titul || {}; if (val) s.titul[tk] = val; else delete s.titul[tk]; }
      });
      try {
        await saveObjects(objects);

        if (ck && P.vorRows && P.vorRows.length && String(P.vorSubId) === String(sid)) {
          const fresh = (subById(p, sid) || {}).s.criteria || {};
          const changed = JSON.stringify(fresh) !== JSON.stringify(P.vorCriteria || {});
          P.vorCriteria = fresh;
          if (changed && P.vorRows.some(r => !r._sec && r._m))
            toast("Критерии подобъекта изменены — подбор сделан по прежним. Нажмите «подобрать по ШНК», чтобы пересобрать", "err");
        }

        if (ck) renderProjectDetail();
      } catch (e) { toast("Не сохранилось", "err"); }
    };
    host.querySelectorAll(".sf-in").forEach(el => { el.onchange = () => saveSubField(el); });

    host.querySelectorAll(".obj-ai-btn").forEach(b => {
      b.onclick = async () => {
        const sid = b.dataset.sid;
        P.objInferBusy = sid; renderProjectDetail();
        try {
          const r = await apiJson("/api/project/infer_criteria", { method: "POST", body: JSON.stringify({ n: p.n, object_id: sid }) });
          P.objInferBusy = null;
          if (!r.ok) { toast(r.note || "AI не смог", "err"); renderProjectDetail(); return; }
          const crit = r.criteria || {};
          const objects = withSub(objsCopy(), sid, s => {
            const c = { ...(s.criteria || {}) };
            OBJ_CRITERIA_FIELDS.forEach(f => { if (!(c[f.k] || "").trim() && crit[f.k]) c[f.k] = crit[f.k]; });
            s.criteria = c;
          });
          await saveObjects(objects);

          const after = subById(p, sid);
          const stillNoStruct = !((after && after.s.criteria) || {}).structure;
          toast(r.n_filled ? `AI заполнил ${r.n_filled} критериев (проверьте)` : "AI ничего не определил — заполните вручную", r.n_filled ? "ok" : "err");
          if (stillNoStruct) toast("Конструктив ИИ не определил — в ВОРе нет работ по несущим стенам. Укажите вручную: он заметно влияет на подбор расценок.", "info");
          renderProjectDetail();
        } catch (e) { P.objInferBusy = null; toast("AI: " + (e.message || ""), "err"); renderProjectDetail(); }
      };
    });

    host.querySelectorAll(".vor-move").forEach(sel => {
      sel.onchange = async () => {
        try {
          await apiJson("/api/project/vor_parent", { method: "POST",
            body: JSON.stringify({ n: p.n, file_id: sel.dataset.fid, sub_id: sel.value }) });
          toast("Ведомость перенесена"); await openProject(p.n);
        } catch (e) { toast("Не удалось перенести", "err"); renderProjectDetail(); }
      };
    });
    host.querySelectorAll(".sub-file").forEach(inp => {
      inp.onchange = e => runIntake(e.target.files, inp.dataset.sid);
    });
    host.querySelectorAll(".sub-drop").forEach(d => {
      d.addEventListener("dragover", e => { e.preventDefault(); d.classList.add("drag"); });
      d.addEventListener("dragleave", () => d.classList.remove("drag"));
      d.addEventListener("drop", e => {
        e.preventDefault(); d.classList.remove("drag");
        if (e.dataTransfer.files.length) runIntake(e.dataTransfer.files, d.dataset.sid);
      });
    });

  }

  function renderProjectDetail() {
    const p = P.activeProject; if (!p) return renderProjectList();
    if (!P.openSec) P.openSec = new Set(["calc"]);
    const host = $("#projectBody");

    const _oldDetail = host && host.querySelector(".proj-detail");
    const keepScroll = _oldDetail ? _oldDetail.scrollTop : 0;
    const vors = p.vors || [];
    const files = p.files || [];
    const pp = p.passport || {};
    const nPending = files.filter(f => f.klass === "vor" && !f.vor_recognized).length;

    const vorFiles = files.filter(f => f.klass === "vor");
    const discSet = new Set(vorFiles.map(f => f.discipline || "Без дисциплины"));
    let nRows = 0; vors.forEach(v => {
      const rs = v.rows || [];
      nRows += rs.length ? rs.filter(r => !r._sec).length : ((v.stats && v.stats.rows) || 0);
    });
    const nObj = (p.objects || []).length, nSub = projSubs(p).length;
    const nDisc = discSet.size, nVor = vorFiles.length;

    const funnel = [["Объекты", nObj], ["Подобъекты", nSub], ["Дисциплины", nDisc], ["ВОР", nVor], ["Работы", nRows], ["Σ стоимость", "—"]]
      .map((s, i) => `<div class="fn-node${i === 5 ? " fn-sum" : ""}"><div class="fn-v">${s[1]}</div><div class="fn-t">${s[0]}</div></div>${i < 5 ? '<span class="fn-arr">→</span>' : ""}`).join("");

    const psrc = p.passport_src || {};
    const filled = s => s.fields.filter(f => String(pp[f.k] || "").trim()).length;
    const sections = PASSPORT_SCHEMA.map(s => {
      const open = P.openSec.has(s.id);
      const grid = `<div class="pf-grid">${s.fields.map(f => passField(f, pp[f.k], psrc[f.k])).join("")}</div>`;
      const cnt = filled(s);
      const badge = cnt ? `<span class="ps-badge">${cnt}/${s.fields.length}</span>` : "";
      const extra = s.id === "calc" ? limBlock(pp) : "";
      return `<div class="psec ${open ? "open" : ""}" data-sec="${s.id}"><button class="psec-h" data-sec="${s.id}"><span class="psec-ic">${s.ic}</span><span class="psec-t">${esc(s.title)}</span>${badge}<span class="psec-car">▾</span></button><div class="psec-body">${grid}${extra}</div></div>`;
    }).join("");

    const recognized = (p.vors || []).some(v => ((v.stats && v.stats.rows) || (v.rows || []).length) > 0);

    const uploadBlock = `<div class="proj-block">
        ${recognized ? "" : `<div class="pb-h"><span class="pb-t">Загрузка ВОР</span><span class="proj-sec-sub">движок распознает ведомость и заполнит карточку</span></div>`}
        <label id="intakeDrop" class="intake-drop${(files.length && recognized) ? " intake-mini" : ""}">
          <input id="intakeFile" type="file" multiple hidden/>
          <div class="intake-ic">📥</div>
          <div class="intake-t">${(files.length && recognized) ? "＋ Добавить файлы или .zip-архив" : "Закиньте файлы проекта или .zip-архив"}</div>
          <div class="intake-d">PDF · ВОР · сметы · документы · чертежи — без сортировки, ИИ разложит сам</div>
        </label>
        <div id="intakeState" class="vor-state"></div>
        ${nPending ? `<div class="intake-actions"><button id="recognizeBtn" class="btn btn-primary">⚙ Распознать все ВОР (${nPending})</button><span class="vor-foot-note">оцифрует ведомости и заполнит строки И карточку проекта</span></div>` : ""}
        ${otherMaterials(files)}
      </div>`;

    const projFold = isFold("proj");
    const lvl1 = `<div class="lvl">
      <div class="lvl-h"><span class="lvl-n">УРОВЕНЬ 1</span><span class="lvl-t">Проект</span>
        <span class="lvl-s">общие данные наследуются всеми подобъектами</span></div>
      <div class="proj-block pcard">
        <div class="phead">${tgBtn("proj")}
          <input id="projName" class="proj-name" placeholder="Название проекта…" autocomplete="off"/>
          <span class="proj-status">№${p.n}</span>
          <button id="objAddBtn" class="btn-s acc">＋ объект</button></div>
        <div class="funnel">${funnel}</div>
        ${projFold ? "" : `<div class="pbody">
          <div class="pb-h"><span class="pb-t">Общие данные проекта</span><span class="proj-sec-sub">🟢 из ВОРа · ⚪ дефолт движка · 🟡 проверьте / дополните</span></div>
          <div class="psecs">${sections}</div>
        </div>`}
      </div>
    </div>`;

    const lvl23 = `<div class="lvl">
      <div class="lvl-h"><span class="lvl-n">УРОВНИ 2 и 3</span><span class="lvl-t">Объект → Подобъект</span>
        <span class="lvl-s">свернуть лишнее плюсиком слева</span></div>
      ${renderLevels(p)}
    </div>`;

    host.innerHTML = `<div class="proj-detail">
      <button class="proj-back">← все проекты</button>
      ${recognized ? lvl1 : `<div class="proj-hero"><div class="ph-top">
          <input id="projName" class="proj-name" placeholder="Название проекта…" autocomplete="off"/>
          <span class="proj-status">№${p.n}</span></div></div>`}

      ${uploadBlock}

      ${recognized ? lvl23 + renderCompletenessBlock(p)
        : `<div class="proj-hint">📋 Структура и параметры появятся здесь после распознавания — движок разложит ведомости по объектам, подобъектам и дисциплинам и заполнит карточку из штампа. Вы проверите и дополните пробелы.</div>`}
    </div>`;

    const nameInp = $("#projName"); nameInp.value = p.name || "";
    nameInp.onchange = async () => {
      try {
        await api("/api/project/save", { method: "POST", body: JSON.stringify({ n: p.n, name: nameInp.value }) });
        p.name = nameInp.value;
      } catch (e) { toast("Не сохранилось", "err"); }
    };

    syncWorkKind(p);

    PASSPORT_SCHEMA.forEach(s => s.fields.forEach(f => {
      const el = host.querySelector(`[data-pk="${f.k}"]`);
      if (el && pp[f.k] != null) el.value = pp[f.k];
    }));

    const psecsEl = host.querySelector(".psecs");
    if (psecsEl) psecsEl.addEventListener("change", e => {
      if (e.target && e.target.dataset && e.target.dataset.pk) savePassport();
    });
    host.querySelectorAll(".psec-h").forEach(h => {
      h.onclick = () => {
        const id = h.dataset.sec;
        if (P.openSec.has(id)) P.openSec.delete(id); else P.openSec.add(id);
        h.closest(".psec").classList.toggle("open");
      };
    });

    host.querySelector(".proj-back").onclick = () => { P.activeProject = null; renderProjectList(); };

    const inp = $("#intakeFile"); if (inp) inp.onchange = e => runIntake(e.target.files);

    const drop = $("#intakeDrop");
    if (drop) {
      drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
      drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("drag"); if (e.dataTransfer.files.length) runIntake(e.dataTransfer.files); });
    }
    const rb = $("#recognizeBtn"); if (rb) rb.onclick = recognizeVors;

    host.querySelectorAll(".sub-go").forEach(b => { b.onclick = () => goToVor(p, b.dataset.sid); });

    host.querySelectorAll(".vor-go").forEach(b => {
      b.onclick = () => goToVor(p, b.dataset.sid, [b.dataset.fid]);
    });

    host.querySelectorAll(".vor-pick").forEach(cb => {
      cb.onchange = () => {
        const sid = cb.dataset.sid;
        P.vorPick = P.vorPick || {};
        P.vorPick[sid] = P.vorPick[sid] || {};
        P.vorPick[sid][cb.dataset.fid] = cb.checked;
        renderProjectDetail();
      };
    });
    host.querySelectorAll(".vor-go-multi").forEach(b => {
      b.onclick = () => {
        const sel = (P.vorPick || {})[b.dataset.sid] || {};
        const ids = Object.keys(sel).filter(k => sel[k]);
        if (ids.length < 2) { toast("Отметьте хотя бы две ведомости", "err"); return; }
        goToVor(p, b.dataset.sid, ids);
      };
    });

    host.querySelectorAll(".lim-btn").forEach(b => {
      b.onclick = e => { e.preventDefault(); openLimModal(b.dataset.lim); };
    });
    host.querySelectorAll(".lim-clr").forEach(b => {
      b.onclick = e => {
        e.preventDefault();
        const k = b.dataset.lim; p.passport = p.passport || {};
        delete p.passport[k + "_name"]; delete p.passport[k + "_pct"];
        if (k === "winter") delete p.passport.winter_zone;
        renderProjectDetail(); savePassport();
      };
    });

    host.querySelectorAll(".sm-open").forEach(b => {
      b.onclick = async () => {
        if (typeof window.loadSmeta !== "function") { toast("Ядро сметчика не загружено", "err"); return; }
        await window.loadSmeta(+b.dataset.n);
        showView("engine");
      };
    });
    updateVorTabGate();

    host.querySelectorAll(".tg[data-fold]").forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); toggleFold(b.dataset.fold); renderProjectDetail(); };
    });

    host.querySelectorAll(".pt-del").forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "точно?"; b.classList.add("armed"); return; }
        try {
          await apiJson("/api/project/remove_file", { method: "POST", body: JSON.stringify({ n: p.n, file_id: b.dataset.fid }) });
          toast("Файл удалён"); await openProject(p.n);
        } catch (e) { toast("Не удалось удалить", "err"); }
      };
    });
    host.querySelectorAll(".pt-reclass").forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        try {
          await apiJson("/api/project/reclassify_file", { method: "POST", body: JSON.stringify({ n: p.n, file_id: b.dataset.fid, klass: "vor" }) });
          toast("Помечено как ВОР — теперь можно распознать"); await openProject(p.n);
        } catch (e) { toast("Не удалось пометить", "err"); }
      };
    });

    wireObjectsBlock(host, p);

    const _newDetail = host && host.querySelector(".proj-detail");
    if (_newDetail) _newDetail.scrollTop = keepScroll;
  }

  function otherMaterials(files) {
    const other = files.filter(f => f.klass !== "vor" && f.klass !== "archive");
    if (!other.length) return "";
    const groups = ["smeta", "document", "drawing", "other"].map(k => {
      const items = other.filter(f => f.klass === k); if (!items.length) return "";
      const km = KLASS[k] || KLASS.other;
      const rows = items.map(f => {
        const canVor = (k === "smeta" || k === "document");
        return `<div class="pt-file"><span class="pt-fn">${esc(f.filename)}</span><span class="tg-conf">${Math.round((f.confidence || 0) * 100)}%</span>${canVor ? `<button class="pt-reclass" data-fid="${esc(f.id)}" title="Это ведомость работ (ВОР)">→ ВОР</button>` : ""}<button class="pt-del" data-fid="${esc(f.id)}" title="Удалить файл">✕</button></div>`;
      }).join("");
      return `<div class="pt-disc"><div class="pt-disc-h"><span class="pt-dn">${km.ic} ${km.label}</span><span class="pt-cnt">${items.length}</span></div><div class="pt-files">${rows}</div></div>`;
    }).join("");
    if (!groups) return "";
    return `<div class="pt-other-h">Прочие материалы</div><div class="ptree">${groups}</div>`;
  }

  async function savePassport() {
    const p = P.activeProject; if (!p) return;
    const passport = {};
    document.querySelectorAll("#projectBody [data-pk]").forEach(el => {
      const v = (el.value || "").trim();
      if (v) passport[el.dataset.pk] = v;
    });
    if ((p.passport || {}).work_kind) passport.work_kind = p.passport.work_kind;

    try {
      await api("/api/project/save", { method: "POST", body: JSON.stringify({ n: p.n, passport }) });
      p.passport = passport;
    } catch (e) { toast("Паспорт не сохранился", "err"); }
  }

  async function runIntake(fileList, subId) {
    const p = P.activeProject; if (!p || !fileList || !fileList.length) return;
    const state = $("#intakeState");
    if (state) state.innerHTML = `<span class="vor-spin"></span> ИИ разбирает файлы (${fileList.length})…`;
    try {
      const fd = new FormData();
      fd.append("n", p.n);
      for (const f of fileList) fd.append("files", f);
      const r = await fetch("/api/project/intake", { method: "POST", headers: { "X-Auth": S.token || "" }, body: fd });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || r.statusText); }
      const data = await r.json();
      const c = data.counts || {};

      if (subId) {
        const known = new Set((p.files || []).map(f => f.id));
        const fresh = await apiJson("/api/project/load?n=" + p.n);
        const added = (fresh.files || []).filter(f => f.klass === "vor" && !known.has(f.id));
        for (const f of added) {
          try {
            await apiJson("/api/project/vor_parent", { method: "POST",
              body: JSON.stringify({ n: p.n, file_id: f.id, sub_id: subId }) });
          } catch (e) {  }
        }
      }
      toast(`Разобрано: ${data.n_files} · ВОР: ${c.vor || 0} · сметы: ${c.smeta || 0} · документы: ${c.document || 0}`);
      await openProject(p.n);
    } catch (e) {
      if (state) state.innerHTML = `<span class="vor-err">⚠ ${esc(e.message || "ошибка разбора")}</span>`;
      toast("Не удалось разобрать файлы", "err");
    }
  }

  async function recognizeVors() {
    const p = P.activeProject; if (!p) return;
    const btn = $("#recognizeBtn"); if (btn) btn.disabled = true;
    $("#intakeState").innerHTML = `<span class="vor-spin"></span> Распознаю ведомости и заполняю строки…`;
    try {
      const r = await apiJson("/api/project/recognize_vors", { method: "POST", body: JSON.stringify({ n: p.n }) });
      toast(`Распознано ВОР: ${r.recognized} · строк: ${r.rows}${r.pending_left ? ` · осталось: ${r.pending_left}` : ""}`);
      const bad = (r.details || []).filter(d => d.error || !d.rows);
      if (bad.length) {
        $("#intakeState").innerHTML = bad.map(d => `<div class="vor-err">⚠ ${esc(d.filename)}: ${esc(d.error || "0 строк")}</div>`).join("");
      }
      await openProject(p.n);
    } catch (e) {
      $("#intakeState").innerHTML = `<span class="vor-err">⚠ ${esc(e.message || "ошибка распознавания")}</span>`;
      toast("Не удалось распознать ВОР", "err");
      if (btn) btn.disabled = false;
    }
  }

  function projVorRow(v) {
    const doc = v.document || {};
    const st = v.stats || {};
    const title = doc.doc_no || v.filename || "ВОР";
    const area = doc.area || doc.project || "";
    return `<div class="proj-vor-row">
      <span class="pv-ic">📄</span>
      <div class="pv-main">
        <div class="pv-title">${esc(title)}</div>
        ${area ? `<div class="pv-sub">${esc(area)}</div>` : ""}
      </div>
      <span class="pv-rows">${st.rows != null ? st.rows : (v.rows || []).length} строк</span>
    </div>`;
  }

  const VOR_DISC = [
    ["", "— дисциплина —"], ["zemlya", "Земляные"], ["svai", "Сваи"], ["kzh", "Бетон/ЖБ"],
    ["km", "Металлоконстр."], ["ar", "Архитектура/отделка"], ["zashchita", "Защита/изоляция"],
    ["ovkv", "Отопл./вентиляция"], ["vik", "Вода/канализация"], ["gaz_vnutr", "Газ внутр."],
    ["blagoustr", "Благоустройство"], ["elektrika", "Электрика/ЛЭП"],
    ["avtodorogi", "Автодороги/аэродромы"], ["nk", "Теплосети/газ нар."], ["skvazhiny", "Скважины"],
    ["gornie", "Горные/взрывные"], ["zhd", "ЖД/трамвай"], ["tonneli", "Тоннели/метро"],
    ["mosty", "Мосты"], ["gidro", "Гидротехника"], ["vremennye", "Временные здания"],
    ["svyaz", "Связь/радио"], ["kipia", "КИПиА"], ["asutp", "АСУ ТП"],
    ["tehnologiya", "Технология/обвязка"], ["shleyfy", "Шлейфы/магистрали"],
    ["teplomehanika", "Котельные (ТМ)"], ["podyem", "Краны/лифты"],
    ["metallurg", "Печи/металлургия"], ["prom_oborud", "Оборуд. отраслевое"],
    ["pnr", "ПНР"], ["restavr", "Реставрация"],
  ];

  function renderVor(data) {
    P.lastVor = data;
    P.vorDoc = data.document || {};
    P.vorExtractor = data.extractor || "—";
    const rows = [];
    let lastSec = null;
    const numLike = s => /^[\d.,\s]+$/.test(s || "");
    const _rawIn = data.rows || [];

    const _normalized = _rawIn.some(r => r && (r._sec === true || r._clean != null || r._unitNorm != null
      || r._added || r._opOk || r._lvl === 0 || r._lvl === 1 || r._split
      || r._cmpParent || r._cmpChild || r._m || r._prop));
    _rawIn.forEach(r => {
      const secId = (r.section == null ? "" : String(r.section)).trim();
      const nm = (r.name || "").trim();
      const noVal = (!r.unit) && (r.qty == null || r.qty === "");
      if (_normalized) {

        if (r._sec === true) {
          rows.push({ _sec: true, name: r.name || "", _lvl: ((r._lvl === 0 || r._lvl === 1) ? r._lvl : undefined) });
          return;
        }
      } else {
        if (nm && _STAMP_JS.test(nm) && noVal) return;

        if (nm && (_looksSec(nm, r.unit) || (noVal && !numLike(nm)))) { rows.push({ _sec: true, name: nm }); lastSec = secId; return; }

        if (secId && secId !== lastSec) {
          rows.push({ _sec: true, name: /^\d+$/.test(secId) ? "" : secId });
          lastSec = secId;
        }
      }
      rows.push({
        pos: r.pos || "", name: r.name || "", unit: r.unit || "",
        qty: (r.qty != null ? r.qty : null), qty_raw: r.qty_raw || "",

        _qty0: (r._qty0 != null ? r._qty0 : (r._added ? null : (r.qty != null ? r.qty : null))),
        page: (r.page != null && !isNaN(+r.page)) ? +r.page : null,
        confidence: r.confidence, type: r.type || _autoType(r.name || ""),
        note: r.note || "", disc: r.disc || "", _mult: r._mult || false, compound: r.compound || false,

        doc_note: r.doc_note || "",
        unit_raw: r.unit_raw || "", qty_multi: r.qty_multi || "",

        _cmpChild: r._cmpChild || false, _cmpParent: r._cmpParent || false,
        _cmpNo: (r._cmpNo != null ? r._cmpNo : null), _cmpOf: r._cmpOf || "",
        _cmpDone: r._cmpDone || false,

        _m: r._m || null, _mi: r._mi || 0, _mOp: r._mOp || false, _mTree: r._mTree || false,
        _mTreeWas: r._mTreeWas || "", _res: r._res || null,

        _swaps: r._swaps || null, _qtys: r._qtys || null, _drops: r._drops || null,
        _resTouched: r._resTouched || false,

        _clean: r._clean, _unitNorm: r._unitNorm, _disc: r._disc || "", _params: r._params || null,
        _src: r._src || "", _conf: (r._conf != null ? r._conf : null),
        _opOk: r._opOk || false, _added: r._added || false, _split: r._split || false,
        _prop: r._prop || undefined,
        _lvl: ((r._lvl === 0 || r._lvl === 1) ? r._lvl : undefined),
      });
    });
    _fixStrayUnit(rows);
    _applyMultiplier(rows);
    P.vorRows = rows;
    P.vorHistory = [];
    P.vorMapOpen = null; P.vorActOpen = null; P.vorDiscOpen = null;
    P.vorStage = 1; P.vorAllCols = false;
    P.vorDirty = false;
    if (P.vorDisc === undefined) P.vorDisc = "";
    P.vorIndex = (P.vorIndex === undefined ? null : P.vorIndex);
    renderVorGrid();
    updateCycleUI();
  }

  function _cleanVorRows() {
    return P.vorRows.map(r => Object.assign({}, r));
  }

  function vorSnapshot() {
    P.vorHistory.push(JSON.stringify(P.vorRows));
    if (P.vorHistory.length > 60) P.vorHistory.shift();
    P.vorDirty = true;
    vorAutoSoon();
  }
  function vorUndo() { if (!P.vorHistory.length) return; P.vorRows = JSON.parse(P.vorHistory.pop()); P.vorMapOpen = null; renderVorGrid(); }

  function _evalFormula(expr) {
    const s = String(expr || "").replace(/\s+/g, "").replace(/,/g, ".").replace(/[×хХ*]/g, "*").replace(/[÷:]/g, "/");
    if (!s) return null;
    let pos = 0;
    const peek = () => s[pos];
    function pExpr() {
      let v = pTerm();
      while (peek() === "+" || peek() === "-") { const op = s[pos++]; const t = pTerm(); v = op === "+" ? v + t : v - t; }
      return v;
    }
    function pTerm() {
      let v = pFactor();
      while (peek() === "*" || peek() === "/") { const op = s[pos++]; const f = pFactor(); v = op === "*" ? v * f : v / f; }
      return v;
    }
    function pFactor() {
      if (peek() === "(") { pos++; const v = pExpr(); if (peek() === ")") pos++; else throw new Error("("); return v; }
      if (peek() === "-") { pos++; return -pFactor(); }
      if (peek() === "+") { pos++; return pFactor(); }
      let num = "";
      while (pos < s.length && /[0-9.]/.test(s[pos])) num += s[pos++];
      if (num === "" || !/^\d*\.?\d+$|^\d+\.?\d*$/.test(num)) throw new Error("num");
      return parseFloat(num);
    }
    try {
      const v = pExpr();
      if (pos !== s.length) return null;
      return isFinite(v) ? v : null;
    } catch (e) { return null; }
  }

  function _noteFormula(note) {
    const m = /^\s*=\s*(\S.*)$/.exec(String(note || ""));
    if (!m) return null;
    const v = _evalFormula(m[1]);
    return v == null ? { ok: false } : { ok: true, value: v };
  }

  function _qtyDisp(r) {
    if (r.qty != null && r.qty !== "") {
      const n = +r.qty;
      const s = Number.isFinite(n) ? String(+n.toFixed(6)) : String(r.qty);
      return s.replace(".", ",");
    }
    return r.qty_raw ? `<span class="vq-miss">${esc(r.qty_raw)}</span>` : "";
  }

  function _qtyPlain(r) {
    if (r.qty != null && r.qty !== "") return String(+(+r.qty).toFixed(6)).replace(".", ",");
    return r.qty_raw || "";
  }

  const _OPWORDS = /устройств|монтаж|установ|разработ|кладк|штукатур|оштукатур|окрас|окраш|укладк|прокладк|изоляц|гидроизоляц|засыпк|бетонир|армир|облицов|нанесен|демонтаж|разборк|погружен|забивк|сварк|резка|планировк|уплотн|возвед|усилен|укреплен|покрыт|обмазочн|шпатлевк|шпаклевк|посадк|разб\.|ремонт|смена|замена|пробивк|заделк|очистк/i;

  const _MATWORDS = /^(труб|лист|арматур|кабель|раствор|смесь|краск|мастик|профиль|уголок|швеллер|песок|плита|плиты|плит\b|кирпич|блок|изовер|пенопласт|рубероид|битум|герметик|сетк|проволок|анкер|болт|гвозд|саморез|электрод|эмаль|шпаклёвк|клей|короб)/i;
  function _autoType(name) {
    const s = (name || "").trim().replace(/^[\-\–•\s\d.]+/, "");
    if (_OPWORDS.test(s)) return "Работа";
    if (_MATWORDS.test(s)) return "Материал";
    return "Работа";
  }

  const _STAMP_JS = /утвержд|выпущен|approved|issued|изм\.?\s*кол|инв\.?\s*№|подп|\bрев\b|формат|соглас|sign\b|date|orig\.?\s*reg|вз[ае]м|\bдата\b|реквизит/i;
  const _FLOOR_JS = /\(\s*\d+\s*[-–]?\s*[йяогенае]*\s*этаж/i;
  const _SECNUM_JS = /^\s*\d{1,2}\.\s+[А-Яа-яЁё]/;
  function _looksSec(nm, unit) {
    if (!nm || _OPWORDS.test(nm)) return false;
    if (_SECNUM_JS.test(nm)) return true;
    const core = nm.replace(/\(.*?\)/g, "").trim();
    return _FLOOR_JS.test(nm) && core.split(/\s+/).length <= 3;
  }

  function _rowLight(r) {
    if (r._sec) return "";

    if (r._opOk) { const b = _rowLightBase(r); return (b === "red" || b === "yel") ? "grn" : b; }
    return _rowLightBase(r);
  }
  function _rowLightBase(r) {
    if (r._sec) return "";
    if (r._mult) return "yel";
    if (r._prop) return "yel";
    if (r._fb) return "yel";
    if (r.compound) return "red";
    if ((r.type || "Работа") === "Материал") return "grn";
    if ((r.type || "Работа") === "Работа" && r.unit && (r.qty == null || r.qty === "")) return "red";

    if ((r.confidence != null && r.confidence < 0.85) || (!r.unit && r.qty == null) || r.qty_raw) return "yel";
    return "grn";
  }

  function _absorbCell(r) {
    if (!r._m) return null;
    if (r._m.absorbed) return `<span class="vg-absorb" title="${esc(r.note || "учтено в составе нормы соседней работы")}">⊂ учтено в норме</span>`;
    if (r._m.material_direct) return `<span class="vg-absorb" title="${esc(r.note || "материал идёт в смету напрямую, без расценки")}">▪ материал напрямую</span>`;
    return null;
  }

  function _isSub(r) {
    return !r._sec && (!r.pos || /^[\-\–•]/.test((r.name || "").trim()) || (r.type || "") === "Материал");
  }

  const _M_CNT = /(\d+)\s*шт/i;
  const _M_PER1 = /(?:расход\w*.{0,15}|дано\s*.{0,6})на\s*1(?!\d)|дано\s*1(?!\d)\s*шт/i;
  function _multFactor(name) {
    if (!name || !_M_PER1.test(name)) return null;
    const m = name.match(_M_CNT); const n = m ? parseInt(m[1], 10) : 0;
    return n > 1 ? n : null;
  }

  const _TOT_RX = /общ\w*\.?\s*(?:вес\s*)?[-:—=]?\s*(\d+(?:[.,]\d+)?)\s*(кг|т|м\s*[2²])\b/i;
  const _PER_AREA = /(\d+(?:[.,]\d+)?)\s*м\s*[2²]\b/i;
  const _PER_KG = /вес[\s.\-:=]*(\d+(?:[.,]\d+)?)\s*кг/i;
  const _pnum = s => parseFloat(String(s).replace(",", "."));
  const _near = (a, b) => Math.abs(a - b) <= Math.max(0.01, 0.01 * Math.abs(b));
  function _readyTotal(r) {
    const m = _TOT_RX.exec(`${r.doc_note || ""} ${r.note || ""}`);
    if (!m) return null;
    const dim = m[2].replace(/\s+/g, "").toLowerCase();
    let tot = _pnum(m[1]), per = null;
    if (dim === "кг" || dim === "т") {
      const p = _PER_KG.exec(r.name || ""); per = p ? _pnum(p[1]) : null;
      if (dim === "т") tot *= 1000;
    } else {
      const p = _PER_AREA.exec(r.name || ""); per = p ? _pnum(p[1]) : null;
    }
    return (tot > 0 && per > 0) ? { tot, per } : null;
  }

  const _GROUND_GUARD = /отмостк|щебен/i;

  function _applyMultiplier(rows) {
    let factor = null, active = false;
    for (const r of rows) {
      if (r._sec) { factor = _multFactor(r.name); active = !!factor; continue; }
      const own = _multFactor(r.name);
      if (own) {

        if (!String(r.unit || "").trim()) { factor = own; active = true; }
        continue;
      }
      if (active && r.pos && !_isSub(r)) { active = false; factor = null; }
      if (active && factor && _isSub(r) && !r._mult && r.qty != null) {
        if (_GROUND_GUARD.test(r.name || "")) {
          const g = `× ${factor} НЕ применён: самостоятельная площадная/земляная работа под узловым заголовком — объём независим, проверить`;
          r.note = r.note ? (g + " · " + r.note) : g;
          r._multSkip = true;
          continue;
        }
        const rt = _readyTotal(r);
        if (rt && _near(r.qty * rt.per, rt.tot)) {
          const g = `× ${factor} не применён: итог задан в примечании (${String(+(r.qty * rt.per).toFixed(6)).replace(".", ",")} = ${String(r.qty).replace(".", ",")} × ${String(rt.per).replace(".", ",")}) — объём уже итоговый`;
          r.note = r.note ? (g + " · " + r.note) : g;
          r._multSkip = true;
          continue;
        }
        if (rt && !_near(r.qty * factor * rt.per, rt.tot)) {
          r._multAmbig = true;
        }
        const q = r.qty; r.qty = +(q * factor).toFixed(6);
        const f = `× ${factor} шт: ${String(+q.toFixed(6)).replace(".", ",")} × ${factor} = ${String(r.qty).replace(".", ",")}`
                + (r._multAmbig ? " · ⚠ примечание ВОРа не сходится ни с умноженным, ни с исходным — сверить" : "");
        r.note = r.note ? (f + " · " + r.note) : f;
        r._mult = true;
      }
    }
  }

  const _TBL_RX = /^\d{2}-\d{2}-\d{3}$/;

  const _UNIT_OK = new Set(["м2","м3","м","шт","компл","кг","т","мп","пм","км","л","г","мм","см","%","ед"]);
  function _unitIsReal(u) {
    const s = String(u || "").trim().toLowerCase().replace("²", "2").replace("³", "3")
      .replace(/[\s.]/g, "").replace(/^\d+(?:[.,]\d+)?/, "");
    if (!s) return true;
    for (const k of _UNIT_OK) if (s === k || s.startsWith(k)) return true;
    return false;
  }
  function _fixStrayUnit(rows) {
    let n = 0;
    (rows || []).forEach(r => {
      if (r._sec) return;
      const u = (r.unit || "").trim();
      if (!u || _unitIsReal(u)) return;
      const nm = (r.name || "").trim();
      if (nm && nm.toLowerCase().indexOf(u.toLowerCase()) < 0) r.name = nm + " " + u;
      r.unit = "";
      r.note = ((r.note || "") + " · ⚠ в колонке ед.изм был текст «" + u + "» — возвращён в наименование, единицу укажите").replace(/^ · /, "");
      n++;
    });
    return n;
  }
  const _tblOfShifr = sh => (String(sh || "").length > 8
    ? `${String(sh).slice(1, 3)}-${String(sh).slice(3, 5)}-${String(sh).slice(6, 9)}` : "");

  async function _shnkTree() {
    if (!P.shnkTree) {
      const d = await apiJson("/api/tree");
      P.shnkTree = d.tree || [];
    }
    return P.shnkTree;
  }
  function _treeLeaves(nodes, out) {
    (nodes || []).forEach(n => {
      if (n._wm) return;
      if (n.leaf && n.code) out.push(n);
      else if (n.children) _treeLeaves(n.children, out);
    });
    return out;
  }
  function _treeHtml(nodes, path) {
    return (nodes || []).filter(n => !n._wm).map((n, k) => {
      const id = path + "-" + k;
      if (n.leaf && n.code)
        return `<div class="tw-leaf" data-wc="${esc(n.code)}" data-nm="${esc(n.name || "")}" title="${esc(n.name || "")}">
          <span class="tw-code">${esc(n.code)}</span><span class="tw-nm">${esc(n.name || "")}</span>
          ${n.izm ? `<span class="tw-izm">${esc(n.izm)}</span>` : ""}</div>`;
      if (n.leaf) return "";
      const open = P.twOpen && P.twOpen[id];
      return `<div class="tw-node">
        <div class="tw-h${open ? " on" : ""}" data-tw="${id}"><span class="tw-car">${open ? "▾" : "▸"}</span>${esc(n.name || n.kind || "")}</div>
        ${open ? `<div class="tw-ch">${_treeHtml(n.children, id)}</div>` : ""}</div>`;
    }).join("");
  }

  async function _openTreeModal(i, preWc, preWcName) {
    const r = P.vorRows[i]; if (!r) return;
    P.twOpen = P.twOpen || {}; P.twQuery = ""; P.twWc = null; P.twPos = null;
    if (preWc) {
      P.twWc = preWc; P.twWcName = preWcName || preWc;
      try { P.twPos = (await apiJson("/api/positions?wc=" + encodeURIComponent(preWc))).positions || []; }
      catch (e) { P.twWc = null; P.twPos = null; toast("Не удалось открыть таблицу — показываю дерево целиком", "err"); }
    }
    const host = document.createElement("div");
    host.id = "treeWrap";
    document.body.appendChild(host);
    const close = () => { host.remove(); };

    const listHtml = async () => {
      if (P.twWc) {
        const _pi = p => p.izm || p.unit || p.izm_norm || "";
        const cur = (_chosen(r) || {}).shifr || "";
        return (P.twPos || []).map(p =>
          `<div class="tw-pos${p.code === cur ? " tw-cur" : ""}" data-code="${esc(p.code || "")}">
             <span class="tw-code">${esc(p.code || "")}</span>
             <span class="tw-nm">${esc(p.name || "")}</span>
             ${_pi(p) ? `<span class="tw-izm">${esc(_pi(p))}</span>` : ""}
             ${p.code === cur ? `<span class="tw-curtag">сейчас в строке</span>` : ""}
           </div>`).join("") || '<div class="pm-note">в этой таблице норм не нашлось</div>';
      }
      const tree = await _shnkTree();
      const q = (P.twQuery || "").trim().toLowerCase();
      if (q.length >= 2) {
        const hits = _treeLeaves(tree, []).filter(n => (n.name || "").toLowerCase().includes(q)
                                                    || (n.code || "").toLowerCase().includes(q));
        let inner = hits.slice(0, 300).map(n =>
          `<div class="tw-leaf" data-wc="${esc(n.code)}" data-nm="${esc(n.name || "")}">
             <span class="tw-code">${esc(n.code)}</span><span class="tw-nm">${esc(n.name || "")}</span>
             ${n.izm ? `<span class="tw-izm">${esc(n.izm)}</span>` : ""}</div>`).join("");
        if (!inner) inner = '<div class="pm-note">ничего не найдено</div>';
        else if (hits.length > 300) inner += `<div class="pm-note">показаны первые 300 из ${hits.length} — уточните запрос</div>`;
        return inner;
      }
      return _treeHtml(tree, "t");
    };

    const drawList = async () => {
      const box = host.querySelector(".tw-list"); if (!box) return;
      box.innerHTML = await listHtml();
      wireList();
    };

    const draw = async () => {
      host.innerHTML = `<div class="modal" id="treeModal"><div class="modal-card tw-card">
        <div class="modal-head"><h2>Дерево ШНК</h2>
          <div class="modal-actions"><button class="btn btn-ghost" id="twCancel">Закрыть</button></div></div>
        <div class="pm-note tw-for">для строки: ${esc(_clean(r) || r.name || "")}${r.unit ? ` · ${esc(r.unit)}` : ""}${r.qty != null ? ` · ${esc(String(r.qty))}` : ""}</div>
        <div class="tw-head"></div>
        <input class="pm-in tw-q" id="twQ" placeholder="поиск по названию или коду таблицы…" autocomplete="off">
        <div class="tw-list"></div></div></div>`;
      wireShell();
      await drawList();
      const q = host.querySelector("#twQ"); if (q) q.focus();
    };

    const pick = (code) => {
      const p = (P.twPos || []).find(x => x.code === code) || {};
      const izm = p.izm || p.unit || p.izm_norm || "";
      vorSnapshot();
      const was = _chosen(r);
      r._mTreeWas = was && was.shifr ? was.shifr : "";
      const nd = {
        wc: P.twWc, shifr: code, variant_name: p.name || p["наименование"] || "",
        sb_tbl: _tblOfShifr(code), sb_map: _tblOfShifr(code),

        sbornik: (String(code).length > 3 ? "Сборник " + String(code).slice(1, 3).replace(/^0/, "") : ""),
        vid: P.twWcName || "",
        var_status: "ok", score: 1, engine: "operator", by_operator: true,
        objem: (r.qty != null ? r.qty : null), unit_calc: izm,
        components: [{ shifr: code, objem: (r.qty != null ? r.qty : null) }],
        variants: (P.twPos || []).map(x => ({ shifr: x.code, name: x.name || "" })),
        why: "норму выбрал оператор из дерева ШНК",
      };
      r._m = r._m || { covered: true, candidates: [] };
      r._m.candidates = [nd].concat((r._m.candidates || []).filter(c => c.shifr !== code));
      r._mi = 0;
      r._mOp = true;
      r._mTree = true;
      P.vorDirty = true;

      logEdit("shifr", r._mTreeWas || "", code, r,
              { kind: "rate", now: code + (p.name ? " · " + p.name : "") });
      close();
      renderVorGrid();
      _openPosModal(i);
      toast(`Норма ${code} выбрана из дерева`);
    };

    const wireShell = () => {
      const q = host.querySelector("#twQ");
      if (q) q.oninput = () => { P.twQuery = q.value; clearTimeout(P._twT); P._twT = setTimeout(drawList, 200); };
      const cx = host.querySelector("#twCancel"); if (cx) cx.onclick = close;
      const md = host.querySelector("#treeModal");
      if (md) md.addEventListener("click", e => { if (e.target === md) close(); });
    };
    const wireList = () => {
      const head = host.querySelector(".tw-head");
      if (head) head.innerHTML = P.twWc
        ? `<div class="tw-back" id="twBack">← к дереву</div><div class="tw-tbl">Таблица <b>${esc(P.twWcName || P.twWc)}</b></div>` : "";
      const bk = host.querySelector("#twBack");
      if (bk) bk.onclick = () => { P.twWc = null; P.twPos = null; drawList(); };
      host.querySelectorAll(".tw-h").forEach(h => h.onclick = () => {
        const id = h.dataset.tw; P.twOpen[id] = !P.twOpen[id]; drawList();
      });
      host.querySelectorAll(".tw-leaf").forEach(l => l.onclick = async () => {
        P.twWc = l.dataset.wc; P.twWcName = l.dataset.nm; P.twPos = null;
        try {
          const d = await apiJson("/api/positions?wc=" + encodeURIComponent(P.twWc));
          P.twPos = d.positions || [];
        } catch (e) { toast("Не удалось загрузить нормы таблицы", "err"); P.twWc = null; }
        drawList();
      });
      host.querySelectorAll(".tw-pos").forEach(p => p.onclick = () => pick(p.dataset.code));
    };
    await draw();
  }

  function _dimOf(u) {
    const s = String(u || "").toLowerCase().replace("²", "2").replace("³", "3").replace(/[\s.]/g, "").replace(/^100?0?/, "");
    for (const [p, d] of [["м3", "объём"], ["м2", "площадь"], ["км", "длина"], ["мп", "длина"], ["пм", "длина"],
                          ["м", "длина"], ["шт", "счёт"], ["компл", "счёт"], ["кг", "масса"], ["т", "масса"], ["л", "объём"]])
      if (s.startsWith(p)) return d;
    return null;
  }
  function _dimMismatch(unitVor, unitNorm) {
    const a = _dimOf(unitVor), b = _dimOf(unitNorm);
    return !!(a && b && a !== b);
  }

  function _mapCell(r, i) {
    if (!r._m) return `<span class="vg-map-none">—</span>`;
    if (r._m.covered === false)
      return `<span class="vg-map-gap" title="${esc(r._m.note || "")}">⚠ вне покрытия</span>`;
    const cs = r._m.candidates || [];
    if (!cs.length) return `<span class="vg-map-none">нет узла</span>`;
    const c = cs[r._mi || 0] || cs[0];
    const sb = (c.sbornik || "").replace(/^Сборник\s*/, "Сб.");

    const dot = c.score >= 0.9 ? "ok" : (c.score >= 0.5 ? "mid" : "low");
    return `<button class="vg-mapbtn" data-i="${i}" title="выбрать узел / открыть в дереве">
      <span class="vg-dot vg-${dot}"></span>
      <span class="vg-map-sb">${esc(sb)}</span>
      <span class="vg-map-vid">${esc(c.vid || "")}</span>
      ${c.shifr ? `<span class="vg-map-shifr">${esc(c.shifr)}</span>` : ""}
      <span class="vg-map-car">▾</span></button>`;
  }

  function _companionChip(r, i) {
    const cs = (r._m && r._m.companions) || [];
    if (!cs.length) return "";

    const need = cs.some(c => c.objem == null || !c.shifr || c.compound);
    const tip = cs.map(c => `${c.shifr || c.table}: ${c.variant_name || ""}${!c.shifr ? " — выбрать вариант" : ""}${c.objem == null ? " — " + (c.flag || "объём не извлечён, ввести вручную") : " (объём=" + c.objem + ")"}${c.compound ? " · " + (c.note || "слой компаунд-строки ВОР") : ""}`).join("\n");

    const askVar = cs.some(c => !c.shifr && Array.isArray(c.candidates) && c.candidates.length);
    if (askVar)
      return ` <button class="vg-compvar" data-i="${i}" title="${esc(tip)}">+${cs.length} сопутств. ❓ выбрать вариант</button>`;
    return ` <span class="vg-companion${need ? " vg-companion-flag" : ""}" title="${esc(tip)}">+${cs.length} сопутств.${need ? " ⚠" : ""}</span>`;
  }

  function _compVarMenu(i) {
    const cs = ((P.vorRows[i] || {})._m || {}).companions || [];
    let html = `<div class="vpop-h">Сопутствующая работа — выберите вариант (ось из строки не извлеклась)</div>`;
    cs.forEach((c, ci) => {
      if (c.shifr || !Array.isArray(c.candidates) || !c.candidates.length) return;
      const head = (c.variant_name || c.table || "");
      html += `<div class="vpop-sub" style="opacity:.6;padding:3px 8px;font-size:11px">${esc(head)}</div>`;
      html += c.candidates.map((cd, k) =>
        `<div class="vpop-i" data-compvar-i="${i}" data-compvar-ci="${ci}" data-k="${k}"><span class="ic">◉</span> ${esc(cd.shifr || "")} <span style="opacity:.6">${esc(cd.name || "")}</span></div>`).join("");
    });
    return html;
  }

  function _pirogChip(r, i) {
    const ps = (r._m && r._m.pirog) || [];
    if (!ps.length) return "";
    const tip = "возможные слои этой конструкции (движок, 🟡 предложение):\n" +
      ps.map(p => `• ${p.name || p.head} (${p.tbl})`).join("\n");
    return ` <span class="vg-pirog" data-i="${i}" title="${esc(tip)}">🟡 +${ps.length} ${_plur(ps.length, "слой", "слоя", "слоёв")}?</span>`;
  }
  function _pirogMenu(i) {
    const ps = ((P.vorRows[i] || {})._m || {}).pirog || [];
    const items = ps.map((p, k) =>
      `<div class="vpop-i" data-pirog-add="${k}" data-i="${i}"><span class="ic">＋</span> ${esc(p.name || p.head)} <span style="opacity:.6">${esc(p.tbl)}</span></div>`).join("");
    return `<div class="vpop-h">Слои пирога — предложение движка (объём наследуется от якоря)</div>${items}`;
  }

  function _splitChip(r, i) {
    const sp = (r._m && r._m.split) || [];
    if (sp.length < 2) return "";
    const tip = "в этой ячейке несколько работ:\n" + sp.map(p => `• ${p.name}`).join("\n");
    return ` <span class="vg-split" data-i="${i}" title="${esc(tip)}">🧩 ${sp.length} работ?</span>`;
  }

  function _chainChip(r, i) {
    const cs = (r._m && r._m.chain) || [];
    if (!cs.length) return "";
    const tip = "звенья цепочки (составная строка):\n" + cs.map(c => `• ${c.seg} → ${c.code || c.tbl}`).join("\n");
    return ` <span class="vg-chain" data-i="${i}" title="${esc(tip)}">⛓ +${cs.length}</span>`;
  }

  function _forkChip(r, i) {
    const f = r._m && r._m.fork;
    if (!f) return "";
    const tip = (r._m.note || "").replace(/^.*?🔀\s*/, "🔀 ") ||
      ("сестринская таблица " + f + " — признак выбора в строке ВОР отсутствует");
    return ` <span class="vg-fork" data-i="${i}" title="${esc(tip)}">🔀 ${esc(f)}</span>`;
  }
  function _sputnikChip(r, i) {
    const sp = (r._m && r._m.sputniki) || [];
    if (!sp.length) return "";
    const tip = "спутники (движок, правило движка):\n" + sp.map(c => `• ${c.shifr} ${c.name}`).join("\n");
    return ` <span class="vg-sputnik" data-i="${i}" title="${esc(tip)}">⚙ +${sp.length}</span>`;
  }
  function _sputnikMenu(i) {
    const sp = ((P.vorRows[i] || {})._m || {}).sputniki || [];
    const items = sp.map((c, k) =>
      `<div class="vpop-i" data-sputnik-add="${k}" data-i="${i}"><span class="ic">＋</span> ${esc(c.name || "")} <span style="opacity:.6">${esc(c.shifr)}${c.k ? " ×" + esc(c.k) : ""}${c.qty_t ? " · " + esc(c.qty_t) + " т" : ""}${c.qty_m3 ? " · " + esc(c.qty_m3) + " м³" : ""}</span></div>`).join("");
    return `<div class="vpop-h">Спутники позиции (вывоз / доп-нормы / уплотнение) — добавить строкой</div>${items}`;
  }
  function _chainMenu(i) {
    const cs = ((P.vorRows[i] || {})._m || {}).chain || [];
    const done = ((P.vorRows[i] || {})._chainAdded) || [];
    const items = cs.map((c, k) => done.indexOf(k) >= 0 ? "" :
      `<div class="vpop-i" data-chain-add="${k}" data-i="${i}"><span class="ic">＋</span> ${esc(c.seg || "")} <span style="opacity:.6">${esc(c.code || c.tbl)}${c.k ? " К=" + esc(c.k) : ""}</span></div>`).join("");
    return `<div class="vpop-h">Цепочка составной строки — добавить звено (объём = объём якоря)</div>`
      + (items.trim() ? items
        : `<div class="vpop-i" style="opacity:.7">все звенья уже добавлены строками ниже</div>`);
  }

  function _splitMenu(i) {
    const sp = ((P.vorRows[i] || {})._m || {}).split || [];
    const items = sp.map(p => `<div class="vpop-i" style="cursor:default">• ${esc(p.name)}</div>`).join("");
    return `<div class="vpop-h">Составная строка — работы внутри ячейки</div>${items}
      <div class="vpop-i" data-split-apply="1" data-i="${i}"><span class="ic">🧩</span> Разнести на ${sp.length} строк (заменит исходную)</div>`;
  }

  function _candItems(r, i, selK) {
    const cs = (r._m && r._m.candidates) || [];
    const seen = new Set();
    const items = cs.map((c, k) => {

      const key = (c.shifr || "") + "|" + (c.variant_name || c.name || "");
      if (seen.has(key)) return "";
      seen.add(key);

      const warn = (c.disc_canon && c.disc_canon.length && r._disc && !c.disc_canon.includes(r._disc))
        ? ` <span class="vg-canon-warn" title="сборник ${esc(c.sb_key || "")} вне дисциплины «${esc(VOR_DISC_LBL[r._disc] || r._disc)}»">⚠</span>` : "";
      const stg = c.stage ? `<span class="vg-cand-stage" title="стадия техпоследовательности (канон)">${esc(c.stage.title || "")}</span>` : "";

      const forkTag = c.var_status === "fork" ? ` <span class="vg-cand-fork" title="развилка: другая таблица того же предмета — признак выбора в ВОРе отсутствует">🔀 другая таблица</span>` : "";
      const nm = c.variant_name || c.name || "";

      const code = c.shifr
        ? `<span class="vg-cand-shifr">${esc(c.shifr)}</span>`
        : `<span class="vg-cand-nocode" title="таблица предложена, вариант не выбран — ось не извлеклась из строки">вариант не выбран</span>`;
      const sel = k === selK;

      return `<div class="vg-cand${sel ? " sel" : ""}" data-i="${i}" data-k="${k}">
        <span class="vg-cand-pick">${sel ? "●" : "○"}</span>
        <div class="vg-cand-body">
          <div class="vg-cand-l1">${code}<span class="vg-cand-nm">${esc(nm) || '<i class="vg-cand-noname">имя варианта не пришло</i>'}</span></div>
          <div class="vg-cand-l2">${esc((c.sbornik || "").replace(/^Сборник\s*/, "Сб."))}${c.vid ? " · " + esc(c.vid) : ""}${warn}${stg}${forkTag}</div>
          ${sel && c.wc ? `<button class="vg-cand-tree" data-i="${i}" data-wc="${esc(c.wc)}" data-nm="${esc(c.vid || c.sbornik || "")}" data-shifr="${esc(c.shifr || "")}" title="открыть таблицу ШНК и выбрать норму">🌳 ${c.shifr ? "другая норма из этой таблицы" : "выбрать норму в этой таблице"}</button>` : ""}
        </div>
        <span class="vg-cand-sc" title="уверенность выбора: 1.0 — вариант взят из строки · 0.6 — вариант по умолчанию, ось из строки не извлеклась · 0.3 — только подсказка, подтверждённого выбора нет">${(c.score != null ? c.score : 0).toFixed(2)}</span>
      </div>`;
    }).join("");
    return { html: items, n: seen.size };
  }

  function _openCandModal(i) {
    const r = P.vorRows[i]; if (!r) return;
    _killFloat();
    let sel = r._mi || 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const close = () => host.remove();
    const closeAsk = () => {
      if (sel !== (r._mi || 0)
          && !confirm("Выбран другой вариант расценки, но он не записан в строку.\nЗакрыть и потерять выбор?")) return;
      close();
    };
    const apply = () => {

      if (sel !== (r._mi || 0)) { vorSnapshot(); r._mi = sel; r._mOp = true; }
      close(); renderVorGrid();
    };
    const draw = () => {
      const { html, n } = _candItems(r, i, sel);
      host.innerHTML = `<div class="modal cand-modal"><div class="modal-card cand-card">
        <div class="modal-head">
          <div class="cand-ttl"><h2>Расценка для строки</h2>
            <div class="cand-sub">${esc((_clean(r) || r.name || ""))}${r.unit ? ` · ${esc(r.unit)}` : ""}${r.qty != null ? ` · ${esc(String(r.qty))}` : ""}</div>
            <div class="cand-cnt">вариантов: ${n}</div></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="cdCancel">Отмена</button>
            <button class="btn btn-primary" id="cdApply">Применить</button>
          </div></div>
        <div class="modal-body cand-body">${html || '<div class="pm-note">кандидатов нет — выберите норму из дерева ШНК в карточке позиции</div>'}</div>
      </div></div>`;
      wire();
    };
    const wire = () => {
      const md = host.querySelector(".modal");
      md.addEventListener("click", e => { if (e.target === md) closeAsk(); });
      host.querySelector("#cdCancel").onclick = closeAsk;
      host.querySelector("#cdApply").onclick = apply;
      host.querySelectorAll(".vg-cand").forEach(el => el.onclick = e => {
        if (e.target.closest(".vg-cand-tree")) return;
        sel = +el.dataset.k; draw();
      });
      host.querySelectorAll(".vg-cand-tree").forEach(b => b.onclick = e => {
        e.stopPropagation(); close(); _openTreeModal(i, b.dataset.wc, b.dataset.nm);
      });
    };
    document.addEventListener("keydown", function onKey(e) {
      if (!document.body.contains(host)) { document.removeEventListener("keydown", onKey); return; }
      if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
      if (e.key === "Enter") { e.preventDefault(); apply(); }
    });
    draw();
  }

  function _secLvl(name) { const s = name || ""; return (/\([^)]*эта[жз]/i.test(s) || /:\s*$/.test(s)) ? 1 : 0; }

  function _rowLvl(r) { return (r && (r._lvl === 0 || r._lvl === 1)) ? r._lvl : _secLvl(_clean(r) || r.name); }

  function _secNums() {
    const map = {}; let R = 0, S1 = 0;
    P.vorRows.forEach((r, i) => {
      if (!r._sec) return;
      if (_rowLvl(r) === 1) { S1++; map[i] = (R > 0 ? R + "." : "") + S1; }
      else { R++; S1 = 0; map[i] = String(R); }
    });
    return map;
  }

  function _secCounts() {
    const deep = {};
    P.vorRows.forEach((r, i) => {
      if (!r._sec) return;
      const lvl = _rowLvl(r); let cnt = 0;
      for (let j = i + 1; j < P.vorRows.length; j++) {
        const rj = P.vorRows[j];
        if (rj._sec && _rowLvl(rj) <= lvl) break;
        if (!rj._sec) cnt++;
      }
      deep[i] = cnt;
    });
    return deep;
  }

  const VOR_STAGES = [

    { n: 1, lbl: "ВОР", kl: "кластер А", cap: "Этап 1: работа с текстом ведомости — наименования, единицы, объёмы, разделы. Слева как распознано, справа как будет в смете.", cols: 10, minw: 1260 },

    { n: 2, off: true, lbl: "Виды работ", kl: "кластер Б", cap: "Этап 2: дисциплина по СПДС на каждую строку (авто + правка). Сборник, таблицу и расценку движок подберёт на этапе 3 — здесь они ещё пусты.", cols: 7, minw: 760 },
    { n: 3, lbl: "Расценки ШНК", kl: "кластер С", cap: "Этап 2: сборник → таблица → норма по очищенному наименованию, состав нормы и передача в смету — на этом же экране. Видно и что было в ВОРе (ед.изм + объём), и что уйдёт в смету (измеритель нормы + пересчитанный объём).", cols: 12, minw: 1260 },

    { n: 4, off: true, lbl: "Ресурсы и смета", kl: "кластер Д", cap: "Этап 4: расценка → ресурсы (труд · машины · материалы). Отсюда — в ядро сметчика.", cols: 8, minw: 900 },
  ];
  const VOR_DISC_LBL = Object.fromEntries(VOR_DISC.map(([k, l]) => [k, l]));

  const VOR_SRC_LBL = { kw: "по ключевым словам", sec: "унаследовано из раздела", llm: "AI-классификация", op: "выбрано вручную" };
  function _discChip(r, i, ph) {
    if (!r._disc) return `<span class="vg-chip pick vg-discbtn" data-i="${i}">${ph}</span>`;
    const cf = r._conf === "low" ? " cf-low" : r._conf === "medium" ? " cf-med" : "";
    const cfLbl = r._conf === "low" ? "низкая — проверьте" : r._conf === "medium" ? "средняя — сверьте" : r._conf === "high" ? "высокая" : "";
    const tt = (cfLbl || r._src)
      ? ` title="${cfLbl ? "уверенность: " + cfLbl : ""}${cfLbl && r._src ? " · " : ""}${r._src ? (VOR_SRC_LBL[r._src] || r._src) : ""}"`
      : "";
    return `<span class="vg-chip vg-discbtn${cf}" data-i="${i}"${tt}>${esc(VOR_DISC_LBL[r._disc] || r._disc)}${r._conf === "low" ? " ?" : ""}</span>`;
  }

  const _flat = s => String(s || "").replace(/\s*[\r\n]+\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();

  const _clean = r => _flat((r._clean != null) ? r._clean : (r.name || ""));

  const _uNorm = r => (r._unitNorm != null) ? String(r._unitNorm) : (r.unit || "");
  const _chosen = r => (r._m && r._m.candidates && r._m.candidates[r._mi || 0]) || null;
  function _paramChip(r, i) {
    if (!r._params || !Object.keys(r._params).length) return "";
    const n = Object.keys(r._params).length;
    return ` <span class="vg-param" data-i="${i}" title="параметры работы (клик — показать)">⚙ ${n} ${_plur(n, "параметр", "параметра", "параметров")}</span>`;
  }
  function _plur(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    return (m10 === 1 && m100 !== 11) ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) ? few : many;
  }

  function _whyLine(r, c, isMat) {
    if (isMat) return `<div class="vg-why">материал идёт в смету напрямую, без нормы ШНК</div>`;
    if (!c) return "";

    const seen = new Set(), parts = [];
    const add = (txt, pre) => {
      const t = String(txt || "").trim(); if (!t) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key); parts.push((pre || "") + esc(t));
    };
    add(c.why);
    add(c.objem_why, "📐 ");
    add(r._m && r._m.note);
    if (r._mTree) parts.push("✋ норму выбрал оператор" + (r._mTreeWas ? " (движок предлагал " + esc(r._mTreeWas) + ")" : ""));
    if (!parts.length) return "";
    const warn = (r._m && r._m.note_cand) ? `<div class="vg-why vg-why-warn">⚠ ${esc(r._m.note_cand)}</div>` : "";
    return `<div class="vg-why">${parts.join(" · ")}</div>` + warn;
  }
  function _paramMenu(i) {
    const p = (P.vorRows[i] && P.vorRows[i]._params) || {};
    const items = Object.entries(p).map(([k, v]) =>
      `<div class="vpop-i" style="cursor:default"><b style="color:#9fd0ff;min-width:104px;display:inline-block">${esc(k)}</b> ${esc(Array.isArray(v) ? v.join(", ") : v)}</div>`).join("");
    return `<div class="vpop-h">Параметры работы — извлечено ${Object.keys(p).length}</div>${items}`;
  }

  function _vorStageState(n) {
    const cur = P.vorStage || 1;
    const data = P.vorRows.filter(r => !r._sec);
    const done = { 1: data.some(r => r._clean), 2: data.some(r => r._disc), 3: data.some(r => r._m), 4: data.some(r => r._res) };
    if (n === cur) return "active";
    return (done[n] && n < cur) ? "done" : "wait";
  }

  function _stageStep(cur, dir) {
    const vis = VOR_STAGES.filter(s => !s.off).map(s => s.n);
    const k = vis.indexOf(cur);
    if (k < 0) return dir > 0 ? (vis.find(n => n > cur) || vis[vis.length - 1])
                              : (vis.slice().reverse().find(n => n < cur) || vis[0]);
    return vis[Math.min(vis.length - 1, Math.max(0, k + dir))];
  }
  function _renderStepper() {
    const cur = P.vorStage || 1;
    const nxt = _stageStep(cur, +1);
    return `<div class="vst">` + VOR_STAGES.filter(s => !s.off).map((s, vi) => {
      const st = _vorStageState(s.n);
      const sub = st === "done" ? "готово" : st === "active" ? "активен" : (s.n === nxt && nxt !== cur ? "далее" : "…");
      const num = st === "done" ? "✓" : (vi + 1);
      return `<div class="vst-step ${st}" data-stage="${s.n}" title="${esc(s.kl || "")}${s.kl ? " · " : ""}${esc(s.cap)}">
        <div class="vst-hd"><span class="vst-num">${num}</span><b class="vst-lbl">${esc(s.lbl)}</b></div>
        <span class="vst-sub">${sub}</span></div>`;
    }).join("") + `</div>`;
  }

  function _paintAiState() {
    const el = $("#vorAiState"); if (!el) return;
    const on = P.aiOnline;
    if (on === true) {
      const sub = P.aiTransport === "cli";
      el.className = "vor-ai-state ai-on"; el.textContent = sub ? "🤖 ИИ (подписка)" : "🤖 ИИ включён";
      el.title = (sub ? "ИИ работает через локальный claude на твоей подписке (без API-баланса). " : "ИИ на связи. ")
        + "Очистка имён и параметров (этап 1), определение дисциплины (этап 2). Подбор расценки детерминирован всегда.";
    } else if (on === false) {
      el.className = "vor-ai-state ai-off"; el.textContent = "🔢 Детерминированный";
      el.title = "ИИ офлайн" + (P.aiReason ? " (" + P.aiReason + ")" : "") + ". Имена чистятся базово, дисциплина — по ключевым словам. Подбор расценки детерминирован в любом случае.";
    } else {
      el.className = "vor-ai-state ai-wait"; el.textContent = "🤖 ИИ";
      el.title = "Проверяю доступность ИИ…";
    }
  }
  async function _refreshAiStatus(force) {
    _paintAiState();
    if (P.aiOnline !== undefined && !force) return;
    if (P._aiChecking) return; P._aiChecking = true;
    try {
      const st = await apiJson("/api/vor/ai_status");
      P.aiOnline = !!st.ok;
      P.aiTransport = st.transport || null;
      P.aiReason = st.ok ? null : (st.error || "нет ключа/CLI");
    } catch (e) {  }
    finally { P._aiChecking = false; _paintAiState(); }
  }

  function _noteAiFromClean(llm) { if (typeof llm === "boolean") { P.aiOnline = llm; P.aiReason = llm ? null : P.aiReason; _paintAiState(); } }

  function _stageToolbar(stage) {
    const und = `<button id="vorgUndo" class="vg-act ghost" ${P.vorHistory.length ? "" : "disabled"}>↩ отмена</button>`;

    const _secsOpen = (P.vorRows || []).some(r => r._sec && !r._collapsed);
    const collapse = `<button id="vorgCollapseAll" class="vg-act" title="${_secsOpen ? "скрыть строки всех разделов — останутся только заголовки" : "показать строки всех разделов"}">${_secsOpen ? "⇑ свернуть все разделы" : "⇓ развернуть все разделы"}</button>`;

    const allcols = (stage >= 3)
      ? `<button id="vorgAllCols" class="vg-act${P.vorAllCols ? " a2" : " ghost"}" title="${P.vorAllCols
          ? "вернуться к рабочему виду: измеритель нормы и объём, который уйдёт в смету"
          : "добавить колонки документа (№ по ВОР, мусорное наименование, ед. и объём как в ВОРе); измеритель и объём сметы при этом скрываются"}">▦ ${P.vorAllCols ? "рабочий вид" : "+ колонки документа"}</button>` : "";
    let act = "";
    if (stage === 1) {

      const nComp = P.vorRows.filter(r => !r._sec && !r._cmpDone && (r.compound || (r._cmpParts || []).length >= 2)).length;
      const nBack = P.vorRows.filter(r => r._cmpChild).length;
      const dec = nComp
        ? `<button id="vorgDecomp" class="vg-act">🧩 разнести составные (${nComp})</button>`
        : `<button id="vorgDecomp" class="vg-act ghost" title="Найти строки, где в одной позиции перечислено несколько работ, и разложить их отдельными строками">🧩 найти составные</button>`;
      const undo = nBack
        ? `<button id="vorgDecompUndo" class="vg-act ghost" title="Убрать дочерние строки разбора и вернуть исходные строки документа">↺ свернуть разбор (${nBack})</button>` : "";
      const nProp = P.vorRows.filter(r => r._prop).length;
      const s1 = `<button id="vorgStage1" class="vg-act a1" title="Движок сам раскладывает пирог на работы, наследует работу из раздела, чистит огрызки. Предложения помечаются жёлтым «предложил движок» — ваши правки поверх главнее; применяется только к нетронутым строкам.">🤖 разложить (движок)${nProp ? " · " + nProp : ""}</button>`;
      act = `${s1}<button id="vorgClean" class="vg-act">✨ очистить (AI)</button>${dec}${undo}`;
    }
    else if (stage === 3) act = `<button id="vorgMatch" class="vg-act a2">🎯 подобрать по ШНК</button>`
      + `<button id="vorgRes" class="vg-act">🧱 загрузить ресурсы</button>`
      + `<button id="vorgAllRes" class="vg-act ghost" title="Раскрыть/свернуть состав всех расценок прямо в таблице">▤ состав норм</button>`;
    else if (stage === 4) act = `<button id="vorgRes" class="vg-act a2">📋 загрузить ресурсы</button>`;

    const _vis = VOR_STAGES.filter(s => !s.off);
    const _visN = n => _vis.findIndex(s => s.n === n) + 1;
    const pv = _stageStep(stage, -1), nx = _stageStep(stage, +1);
    const back = pv < stage ? `<button id="vorgBack" class="vg-act ghost">← этап ${_visN(pv)}</button>` : "";
    const fwd = nx > stage
      ? `<button id="vorgNext" class="vg-act prim">завершить → этап ${_visN(nx)}</button>`
      : `<button id="vorToEngine2" class="vg-act prim">в ядро сметчика →</button>`;

    const ap = P.activeProject;
    const save = ap
      ? `<button id="vorSave" class="vg-act a1" title="Сохранить строки этого ВОРа в проект «${esc(ap.name || ("№" + ap.n))}»">💾 сохранить в проект</button>`
        + `<span id="vorAutoState" class="vor-auto">${P.vorIndex == null ? "автосохранение включится после первого 💾" : (P.vorDirty ? "есть несохранённые правки" : "")}</span>`
      : `<span class="vor-foot-note">откройте проект на вкладке «Проект», чтобы сохранить этот ВОР</span>`;

    const find = `<span class="vgt-find"><input id="vorgFind" class="vg-find" placeholder="🔍 поиск по таблице…" value="${esc(P.vorFind || "")}" autocomplete="off"/>`
      + `<span id="vorgFindN" class="vg-find-n">${P.vorFind ? (P.vorFindN || 0) + " совпад." : ""}</span>`
      + (P.vorFind ? `<button id="vorgFindX" class="vg-find-x" title="сбросить поиск">✕</button>` : "") + `</span>`;
    return `<div class="vgt">${collapse}${und}${act}${find}${allcols}${save}<span class="vsp"></span>${back}${fwd}</div>`;
  }

  function _stageThead(stage) {
    if (stage === 0) return `<thead><tr>
      <th class="vc-n">П/Н</th><th class="vc-pos">№ ВОР</th><th>Наименование по ВОР</th><th class="vc-unit">Ед.</th><th class="vc-qty">Объём</th><th>Нормализ. наим.</th><th class="vc-unit">Ед.</th><th class="vc-type">Тип</th><th class="hi">Сборник</th><th class="hi vc-tbl">Таблица ШНК</th><th class="hi">Расценка ШНК</th><th>Примечания</th><th class="vc-act"></th></tr></thead>`;

    if (stage === 1) return `<thead>
      <tr><th class="vc-n">П/Н</th><th class="vc-pos">№ по ВОР</th><th>Наименование по ВОР</th><th class="vc-unit">Ед.</th><th class="vc-qty">Объём</th><th>Нормализ. наименование</th><th class="vc-act"></th><th class="vc-unit">Ед.</th><th class="vc-qty" title="объём после правки — слева как в ВОРе, здесь итоговый">Объём</th><th class="vc-type">Тип</th><th>Примечания</th></tr></thead>`;
    if (stage === 2) return `<thead><tr>
      <th class="vc-n">П/Н</th><th>Нормализ. наименование</th><th class="vc-unit">Ед.</th><th class="vc-type">Тип</th><th class="hi">Дисциплина по СПДС</th><th>Примечания</th><th class="vc-act"></th></tr></thead>`;

    if (stage === 3) return `<thead><tr>
      <th class="vc-n">П/Н</th><th>Нормализ. наименование</th><th class="vc-unit" title="единица измерения по ВОР">Ед. ВОР</th><th class="vc-num" title="объём по ВОР">Объём ВОР</th><th class="vc-type" title="Работа — подбирается расценка ШНК; Материал — идёт в смету напрямую, без расценки">Тип</th><th class="hi">Сборник</th><th class="hi vc-tbl">Таблица ШНК</th><th class="hi">Расценка ШНК</th><th class="vc-unit hi" title="измеритель нормы ШНК: 100 м², 1000 м³ и т.п.">Измеритель</th><th class="vc-num hi" title="объём, который уйдёт в смету (пересчитан под измеритель нормы)">Объём сметы</th><th>Примечания</th><th class="vc-act"></th></tr></thead>`;
    return `<thead><tr>
      <th class="vc-n">П/Н</th><th>Работа / ресурс</th><th>Шифр</th><th class="vc-unit">Ед.</th><th class="vc-num">Норма</th><th class="vc-num">Объём</th><th class="vc-num">Кол-во</th><th class="vc-cost">Стоимость</th></tr></thead>`;
  }

  function _actMenu(i) {
    const r = P.vorRows[i] || {};
    const isSec = !!r._sec;
    const stage = P.vorStage || 1;
    const rate = !isSec && stage !== 1;
    const rows = [
      `<div class="vpop-h">Вставить ниже</div>`,
      `<div class="vpop-i" data-act="sec" data-i="${i}"><span class="ic">🗂</span> Раздел</div>`,
      `<div class="vpop-i" data-act="sub" data-i="${i}"><span class="ic">🗂</span> Подраздел</div>`,
      `<div class="vpop-i" data-act="row" data-i="${i}"><span class="ic">＋</span> Строку работы</div>`,
      `<div class="vpop-h">${isSec ? "Этот раздел" : "Эта строка"}</div>`,
    ];

    if (isSec) {
      rows.push(_rowLvl(r) === 1
        ? `<div class="vpop-i" data-act="mkrazdel" data-i="${i}"><span class="ic">⬆</span> Сделать разделом</div>`
        : `<div class="vpop-i" data-act="mksub" data-i="${i}"><span class="ic">⬇</span> Сделать подразделом</div>`);
    }
    if (!isSec) rows.push(`<div class="vpop-i" data-act="split" data-i="${i}"><span class="ic">✂</span> Разбить на две строки</div>`);
    if (rate) rows.push(
      `<div class="vpop-i" data-act="extra" data-i="${i}"><span class="ic">🧱</span> Ресурс вне расценки</div>`,
      `<div class="vpop-i" data-act="match" data-i="${i}"><span class="ic">🎯</span> Подобрать расценку</div>`);
    rows.push(
      `<div class="vpop-i" data-act="up" data-i="${i}"><span class="ic">↑</span> Вверх</div>`,
      `<div class="vpop-i" data-act="dn" data-i="${i}"><span class="ic">↓</span> Вниз</div>`,
      `<div class="vpop-i" data-act="del" data-i="${i}"><span class="ic">✕</span> Удалить</div>`);
    return rows.join("");
  }
  function _discMenu(i) {
    const r = P.vorRows[i];
    const items = VOR_DISC.filter(([k]) => k).map(([k, l]) =>
      `<div class="vpop-i${r._disc === k ? " on" : ""}" data-disc="${k}" data-i="${i}">${esc(l)}</div>`).join("");
    return `<div class="vpop-h">Дисциплина СПДС</div>${items}`;
  }

  function _busyOpen(title, sub, note) {
    _busyClose();
    const d = document.createElement("div");
    d.className = "busy-veil"; d.id = "busyVeil";
    d.innerHTML = `<div class="busy-card">
      <div class="busy-ic">🤖</div>
      <div class="busy-t">${esc(title || "Идёт обработка…")}</div>
      <div class="busy-s">${esc(sub || "")}</div>
      <div class="busy-bar"><i></i></div>
      <div class="busy-note">${esc(note || "Не закрывайте вкладку — результат придёт сюда же")}</div>
    </div>`;
    d.addEventListener("click", e => e.stopPropagation(), true);
    document.body.appendChild(d);
    P._busyEl = d;
  }
  function _busySub(text) { const s = P._busyEl && P._busyEl.querySelector(".busy-s"); if (s) s.textContent = text; }
  function _busyClose() { if (P._busyEl) { P._busyEl.remove(); P._busyEl = null; } const o = $("#busyVeil"); if (o) o.remove(); }

  function _killFloat() { if (P._floatEl) { P._floatEl.remove(); P._floatEl = null; P._floatAnchor = null; } }
  function _floatPop(inner, anchor) {

    const same = P._floatEl && P._floatAnchor === anchor;
    _killFloat();
    if (same) return;
    const d = document.createElement("div");
    d.className = "vfloat"; d.innerHTML = inner;
    document.body.appendChild(d);
    const r = anchor.getBoundingClientRect();
    const w = d.offsetWidth, h = d.offsetHeight;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    d.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 10)) + "px";
    d.style.top = top + "px";
    P._floatEl = d; P._floatAnchor = anchor;
    d.addEventListener("click", e => {
      const it = e.target.closest(".vpop-i"); if (!it) return;
      if (it.dataset.chainAdd != null) {
        const i = +it.dataset.i, r = P.vorRows[i];
        const c = ((r || {})._m || {}).chain && r._m.chain[+it.dataset.chainAdd];
        if (r && c) {
          vorSnapshot();

          const parentTxt = _clean(r) || r.name || "";
          const [, childParams] = _splitParams(r._params || {}, [parentTxt, c.seg]);
          P.vorRows.splice(i + 1, 0, { pos: "", name: c.seg, unit: r.unit || "",
            qty: r.qty, qty_raw: "", type: "Работа", _params: childParams,
            note: "звено цепочки ⛓ (движок)" + (c.k ? " К=" + c.k : ""), disc: r._disc || "", _m: null, _mi: 0 });
          r._chainAdded = (r._chainAdded || []).concat([+it.dataset.chainAdd]);
          P.vorDirty = true; vorAutoSoon();
        }
        _killFloat(); renderVorGrid(); return;
      }
      if (it.dataset.sputnikAdd != null) {
        const i = +it.dataset.i, r = P.vorRows[i];
        const c = ((r || {})._m || {}).sputniki && r._m.sputniki[+it.dataset.sputnikAdd];
        if (r && c) {
          vorSnapshot();
          const qty = c.qty_t != null ? c.qty_t : (c.qty_m3 != null ? c.qty_m3 : r.qty);
          const unit = c.qty_t != null ? "т" : (c.qty_m3 != null ? "м3" : (r.unit || ""));
          P.vorRows.splice(i + 1, 0, { pos: "", name: (c.name || "") + " [" + c.shifr + "]",
            unit: unit, qty: qty, qty_raw: "", type: "Работа",
            note: "спутник ⚙ (движок)" + (c.k ? " ×" + c.k : ""), disc: r._disc || "", _m: null, _mi: 0 });
        }
        _killFloat(); renderVorGrid(); return;
      }
      if (it.dataset.compvarCi != null) {
        const i = +it.dataset.compvarI, ci = +it.dataset.compvarCi, k = +it.dataset.k;
        const cw = (((P.vorRows[i] || {})._m || {}).companions || [])[ci];
        const cd = cw && cw.candidates && cw.candidates[k];
        if (cw && cd) {
          vorSnapshot();
          cw.shifr = cd.shifr;
          cw.variant_name = cd.name || cw.variant_name;
          cw.operator_flag = false;
        }
        _killFloat(); renderVorGrid(); return;
      }
      if (it.dataset.splitApply != null) {
        const i = +it.dataset.i, r = P.vorRows[i];
        const sp = ((r || {})._m || {}).split || [];
        if (r && sp.length > 1) {
          vorSnapshot();

          const distr = _splitParams(r._params || {}, sp.map(p => p.name));
          const subs = sp.map((p, k) => ({ pos: k === 0 ? (r.pos || "") : "", name: p.name,
            unit: r.unit || "", qty: r.qty, qty_raw: "", type: "Работа", _params: distr[k] || {},
            note: "разнесено из составной 🧩 (движок)", disc: r._disc || "", _m: null, _mi: 0 }));
          P.vorRows.splice(i, 1, ...subs);
        }
        _killFloat(); renderVorGrid(); return;
      }
      if (it.dataset.pirogAdd != null) {
        const i = +it.dataset.i, r = P.vorRows[i];
        const p = ((r || {})._m || {}).pirog && r._m.pirog[+it.dataset.pirogAdd];
        if (r && p) {
          vorSnapshot();
          const parentTxt = _clean(r) || r.name || "";
          const [, layerParams] = _splitParams(r._params || {}, [parentTxt, p.name || p.head || ""]);
          P.vorRows.splice(i + 1, 0, { pos: "", name: p.name || p.head, unit: r.unit || "",
            qty: r.qty, qty_raw: "", type: "Работа", _params: layerParams,
            note: "слой пирога 🟡 (предложение движка)", disc: r._disc || "", _m: null, _mi: 0 });
        }
        _killFloat(); renderVorGrid(); return;
      }
      if (it.dataset.act != null) _vorAct(it.dataset.act, +it.dataset.i);
      else if (it.dataset.disc != null) { const rr = P.vorRows[+it.dataset.i]; if (rr) { vorSnapshot(); rr._disc = it.dataset.disc; rr._src = "op"; rr._conf = null; } _killFloat(); renderVorGrid(); }
    });
  }

  function _secRowHtml(r, i, stage, cnt, lvl, num) {
    const nm = esc(_clean(r) || r.name || "");
    const rawnm = esc(r.name || "");
    const tog = `<td class="vc-n"><span class="vg-grip" draggable="true" title="перетащить раздел">⠿</span><button class="vg-tog" data-i="${i}">${r._collapsed ? "▸" : "▾"}</button></td>`;
    const cntB = cnt ? `<span class="vg-cnt">${cnt}</span>` : "";
    const act = `<td class="vc-act"><button class="vg-menu" data-i="${i}">⋮</button></td>`;

    const numB = num ? `<span class="vg-secnum">${esc(lvl ? "Подраздел " + num : "Раздел " + num)}</span>` : "";

    const nmEd = `${numB}<span class="ce${nm ? "" : " vg-sec-empty"}" contenteditable data-i="${i}" data-f="name"${nm ? "" : ` data-ph="название раздела не распозналось — впишите"`}>${nm}</span>${cntB}`;
    const cls = `vg-sec vg-sec-l${lvl}${r._collapsed ? " vg-collapsed" : ""}`;
    if (stage === 0) return `<tr class="${cls}" data-i="${i}">${tog}<td class="vc-sec" colspan="10">${nmEd}</td><td></td>${act}</tr>`;

    if (stage === 1) return `<tr class="${cls}" data-i="${i}">
      ${tog}<td></td><td class="vc-mus vc-sec">${rawnm}</td><td colspan="2"></td><td class="vc-sec vc-norm2">${nmEd}</td>${act}<td colspan="4"></td></tr>`;
    const span = stage === 2 ? 4 : stage === 3 ? 8 : 6;
    if (stage === 4) return `<tr class="${cls}" data-i="${i}">${tog}<td class="vc-sec" colspan="${span}">${nmEd}</td><td></td></tr>`;
    return `<tr class="${cls}" data-i="${i}">${tog}<td class="vc-sec" colspan="${span}">${nmEd}</td><td></td>${act}</tr>`;
  }

  function _resRows3(r, i) {
    if (!r._res || !r._res.length || r._resCollapsed) return "";

    if ((r.type || "Работа") === "Материал") return "";
    const ic = { труд: '<span class="vg-res-tr">◆</span>', машина: '<span class="vg-res-mc">◆</span>', материал: '<span class="vg-res-mt">◆</span>' };
    return r._res.map(x => {
      const q = (x.kol != null) ? String(+(+x.kol).toFixed(3)).replace(".", ",") : "";
      const nr = (x.norma != null) ? String(x.norma).replace(".", ",") : "";
      const key = esc(x.key || x.code || "");

      const excl = !!x.excl;
      const editable = !excl && (x.ed || x.ppro);
      const normCell = editable
        ? `<td class="vc-num vg-rnorm"><span class="ce" contenteditable data-i="${i}" data-rk="${key}" data-rf="norm" data-rv="${esc(nr)}">${nr}</span></td>`
        : `<td class="vc-num vc-mus">${nr}</td>`;

      const swapOk = !!x.swapkind || (x.type || "") === "материал";
      const ctl = excl
        ? `<button class="vg-rrest" data-i="${i}" data-rk="${key}" title="вернуть ресурс в смету">↺</button>`
        : `<button class="vg-rx" data-i="${i}" data-rk="${key}" title="исключить ресурс из сметы">✕</button>`
          + (swapOk ? `<button class="vg-rsw" data-i="${i}" data-rk="${key}" title="заменить ресурс">⇄</button>` : "")
          + (x.swapped ? `<button class="vg-rrev" data-i="${i}" data-rk="${key}" title="вернуть исходный ресурс">↩</button>` : "");
      const tags = (excl ? `<span class="vg-rtag rt-ex">исключён</span>` : "")
        + (x.swapped ? `<span class="vg-rtag rt-sw" title="было: ${esc(x.orig_name || "")}">заменён</span>` : "")
        + (!excl && x.ppro ? `<span class="vg-rtag rt-pp" title="ресурс задаётся исходными данными проекта — уточните расход">ПО ПРОЕКТУ</span>` : "")
        + (!excl && x.ed && !x.qset ? `<span class="vg-rtag rt-need">задайте расход</span>` : "");

      return `<tr class="vg-res${excl ? " vg-res-ex" : ""}"><td></td>
        <td class="rlab">${ic[x.type] || "◆"} ${esc(x.name || "")}</td>
        <td class="vc-unit vc-mus">${esc(x.unit || "")}</td>${normCell}
        <td class="vc-type vc-mus" style="font-size:11px">${esc(x.type || "")}</td>
        <td colspan="3"></td>
        <td class="vc-unit vc-mus">${esc(x.unit || "")}</td><td class="vc-num">${excl ? "—" : q}</td>
        <td class="vc-note">${tags}</td><td class="vc-act vg-rctl">${ctl}</td></tr>`;
    }).join("");
  }

  function _resEditRow(i) {
    const r = P.vorRows[i]; if (!r) return null;
    if (!r._swaps) r._swaps = {};
    if (!r._qtys) r._qtys = {};
    if (!Array.isArray(r._drops)) r._drops = [];

    r._resTouched = true;
    return r;
  }
  async function vorResDrop(i, key) {
    const r = _resEditRow(i); if (!r || !key) return;
    if (r._drops.indexOf(key) < 0) r._drops.push(key);
    delete r._swaps[key];
    vorSnapshot();
    await vorResOne(i, "Ресурс исключён");
  }
  async function vorResRestore(i, key) {
    const r = _resEditRow(i); if (!r || !key) return;
    r._drops = r._drops.filter(d => d !== key);
    vorSnapshot();
    await vorResOne(i, "Ресурс возвращён");
  }
  async function vorResUnswap(i, key) {
    const r = _resEditRow(i); if (!r || !key) return;
    delete r._swaps[key]; delete r._qtys[key];
    vorSnapshot();
    await vorResOne(i, "Замена отменена");
  }
  async function vorResQty(i, key, val) {
    const r = _resEditRow(i); if (!r || !key) return;
    const s = String(val || "").trim().replace(",", ".");
    if (s === "") delete r._qtys[key]; else r._qtys[key] = s;
    vorSnapshot();
    await vorResOne(i, "");
  }

  function vorAddExtraRes(i) {
    if (typeof window.openResPicker !== "function") { toast("Справочник ресурсов недоступен", "err"); return; }
    window.openResPicker("extra", null, null, { vorRow: i });
  }
  window.vorExtraPicked = function (i, code, name, unit) {
    const r = P.vorRows[i]; if (!r) return;
    vorSnapshot();

    P.vorRows.splice(i + 1, 0, {
      pos: "", name: name || "", unit: unit || "", qty: null, qty_raw: "",
      type: "Материал", note: "ресурс вне расценки" + (code ? " · " + code : "") + " · ⚠ введите объём",
      _clean: name || "", _m: null, _mi: 0, _extraRes: code || "",
    });
    P.vorDirty = true; vorAutoSoon();
    renderVorGrid();

    _openPosModal(i + 1);
    toast("Добавлен ресурс вне расценки: " + (name || "") + " — задайте объём");
  };

  function vorPickMaterialRes(i) {
    if (typeof window.openResPicker !== "function") { toast("Справочник ресурсов недоступен", "err"); return; }
    const r = P.vorRows[i]; const q = r ? (_clean(r) || r.name || "") : "";
    window.openResPicker("material", null, null, { vorRow: i, presetQuery: q });
  }
  window.vorMatResPicked = function (i, code, name, unit) {
    const r = P.vorRows[i]; if (!r) return;
    vorSnapshot();
    r._extraRes = code || "";
    r._extraResName = name || "";
    r.note = (r.note || "").replace(/ · сверьте ресурс.*$/, "") + " · ресурс: " + (name || "") + (code ? " · " + code : "");
    P.vorDirty = true; vorAutoSoon();
    renderVorGrid();
    toast("Ресурс подтверждён: " + (name || ""));
  };

  window.vorResSwapPicked = async function (i, key, code, name) {
    const r = _resEditRow(i); if (!r || !key) return;
    r._swaps[key] = code;
    r._drops = r._drops.filter(d => d !== key);
    vorSnapshot();
    await vorResOne(i, "Заменено на «" + name + "» — задайте расход");
  };

  function _resRows(r) {
    if (!r._res || !r._res.length || r._resCollapsed) return "";
    const ic = { труд: '<span class="vg-res-tr">◆</span>', машина: '<span class="vg-res-mc">◆</span>', материал: '<span class="vg-res-mt">◆</span>' };
    const obj = (r.qty != null ? String(+(+r.qty).toFixed(3)).replace(".", ",") : "");
    return r._res.map(x => {
      const q = (x.kol != null) ? String(+(+x.kol).toFixed(3)).replace(".", ",") : "";
      const nr = (x.norma != null) ? String(x.norma).replace(".", ",") : "";
      return `<tr class="vg-res"><td></td><td class="rlab">${ic[x.type] || "◆"} ${esc(x.name || "")}</td>
        <td class="vc-mus" style="font-size:11px">${esc(x.type || "")}</td><td class="vc-unit vc-mus">${esc(x.unit || "")}</td>
        <td class="vc-num">${nr}</td><td class="vc-num vc-mus">${obj}</td><td class="vc-num">${q}</td><td class="vc-cost">—</td></tr>`;
    }).join("");
  }

  function _dataRowHtml(r, i, n, stage) {
    const light = _rowLight(r);

    const cmpCls = r._cmpChild ? " vg-cmpkid" : (r._cmpParent ? " vg-cmppar" : "");
    const nCell = `<td class="vc-n${cmpCls}"><span class="vg-grip" draggable="true" title="перетащить строку">⠿</span>${r._cmpChild ? "↳ " + r._cmpNo : n}${r.page ? `<span class="vg-pg">с.${r.page}</span>` : ""}</td>`;
    const note = r.note ? `<div class="vg-note">${esc(r.note)}</div>` : "";
    const act = `<td class="vc-act"><button class="vg-menu" data-i="${i}">⋮</button></td>`;
    const _t = r.type || "Работа";
    const tSel = `<td class="vc-type"><select class="vg-type${_t === "Материал" ? " tm" : ""}" data-i="${i}" title="${_t}"><option value="Работа" ${_t === "Работа" ? "selected" : ""}>Р</option><option value="Материал" ${_t === "Материал" ? "selected" : ""}>М</option></select></td>`;

    const _nf = _noteFormula(r.note);
    const _nfCls = _nf ? (_nf.ok ? " vg-formula" : " vg-formula-bad") : "";
    const noteCell = `<td class="vc-note${_nfCls}"${_nf && _nf.ok ? ` title="объём вычислен по формуле = ${esc(String(_qtyPlain(r)))}"` : ""}><span class="ce" contenteditable data-i="${i}" data-f="note">${esc(r.note || "")}</span></td>`;
    const nmClean = esc(_clean(r));
    if (stage === 0) {
      const c = _chosen(r);
      let sb = "—", vid = "—", nrm = `<span class="vg-nomatch">—</span>`;
      if (c) { sb = esc((c.sbornik || "").replace(/^Сборник\s*/, "Сб.")); vid = esc(c.vid || ""); nrm = `<span class="vg-mono">${esc(c.shifr || "")}</span> <button class="vg-mapbtn2" data-i="${i}">▾</button>`; }
      else if (_absorbCell(r)) { sb = _absorbCell(r); nrm = ""; }
      const objem = `<td class="vc-qty"><span class="ce" contenteditable data-i="${i}" data-f="qty">${_qtyDisp(r)}</span></td>`;
      const mid = `<td class="vc-pos"><span class="ce" contenteditable data-i="${i}" data-f="pos">${esc(r.pos || "")}</span></td>
        <td class="vc-name vc-mus">${esc(r.name || "")}</td><td class="vc-unit vc-mus">${esc(r.unit || "")}</td>${objem}
        <td class="vc-name"><span class="ce" contenteditable data-i="${i}" data-f="_clean">${nmClean}</span>${_paramChip(r, i)}</td>
        <td class="vc-unit vc-mus">${esc(r._unitNorm || r.unit || "")}</td>${tSel}
        <td class="hi">${sb}</td><td class="hi">${vid}</td><td class="hi">${nrm}</td>${noteCell}`;
      let html = `<tr class="vg-row${light ? " vg-l-" + light : ""}" data-i="${i}">${nCell}${mid}${act}</tr>`;

      return html;
    }
    if (stage === 1) {

      const src = (r._raw || (r._clean ? r.name : "")) || "";

      const docQ = (r._qty0 != null && r._qty0 !== "") ? String(+(+r._qty0).toFixed(6)).replace(".", ",") : "";
      const objemDoc = `<td class="vc-qty vc-mus">${docQ || (r.qty_raw ? `<span class="vq-miss">${esc(r.qty_raw)}</span>` : "")}</td>`;
      const changed = r._qty0 != null && r.qty != null && +r._qty0 !== +r.qty;

      const _hasNm = !!(_clean(r) || "").trim();
      const _hasUn = !!(_uNorm(r) || "").trim();
      const _hasQ = (r.qty != null && r.qty !== "") || !!((r.qty_raw || "").trim());
      const _fc = (_hasNm ? 1 : 0) + (_hasUn ? 1 : 0) + (_hasQ ? 1 : 0);
      const _part = _fc >= 1 && _fc < 3;
      const needNm = _part && !_hasNm ? " vg-need" : "";
      const needUn = _part && !_hasUn ? " vg-need" : "";
      const needQ = _part && !_hasQ ? " vg-need" : "";
      const objemEd = `<td class="vc-qty${changed ? " vg-qtychg" : ""}${needQ}"${changed ? ` title="в ВОРе было ${esc(docQ)}"` : (needQ ? ` title="строка заполнена частично — впишите объём или очистите всю строку"` : "")}><span class="ce" contenteditable data-i="${i}" data-f="qty">${_qtyDisp(r)}</span></td>`;
      const mid = `<td class="vc-pos"><span class="ce" contenteditable data-i="${i}" data-f="pos">${esc(r.pos || "")}</span></td>
        <td class="vc-name vc-mus${_isSub(r) ? " vg-sub" : ""}">${esc(r.name || "")}</td>
        <td class="vc-unit vc-mus">${esc(r.unit || "")}</td>${objemDoc}
        <td class="vc-norm2${needNm}"${needNm ? ` title="строка заполнена частично — впишите наименование или очистите всю строку"` : ""}><span class="ce" contenteditable data-i="${i}" data-f="_clean"${src ? ` title="очищено из: ${esc(src)}"` : ""}>${nmClean}</span>${r._fb ? `<span class="vg-fb" title="AI-очистка не тронула эту строку (фолбэк) — сверьте имя вручную">⚠</span>` : ""}${r._prop ? `<span class="vg-prop" title="предложил движок (${esc(r._prop)}) — проверьте/поправьте и нажмите Enter, чтобы принять (полоса станет зелёной); 💡 остаётся как пометка происхождения">💡</span>` : ""}</td>
        ${act}
        <td class="vc-unit vc-norm2${needUn}"${needUn ? ` title="строка заполнена частично — впишите ед.изм или очистите всю строку"` : ""}><span class="ce" contenteditable data-i="${i}" data-f="_unitNorm" title="единица измерения — впишите, если движок её не извлёк">${esc(_uNorm(r))}</span></td>${objemEd}${tSel}${noteCell}`;

      return `<tr class="vg-row${light ? " vg-l-" + light : ""}${r._added ? " vg-added" : ""}" data-i="${i}">${nCell}${mid}</tr>`;
    }
    if (stage === 2) {
      const dchip = _discChip(r, i, "выбрать ▾");
      const mid = `<td class="vc-name">${nmClean}</td><td class="vc-unit vc-mus">${esc(r.unit || "")}</td>${tSel}
        <td class="hi">${dchip}</td>${noteCell}`;
      return `<tr class="vg-row${light ? " vg-l-" + light : ""}" data-i="${i}">${nCell}${mid}${act}</tr>`;
    }
    if (stage === 3) {
      const c = _chosen(r);
      let sb = "—", vid = "—", nrm = `<span class="vg-nomatch">—</span>`;
      if (c) {
        sb = esc((c.sbornik || "").replace(/^Сборник\s*/, "Сб."));
        vid = esc(c.vid || "");

        const opm = r._mOp ? `<span class="vg-opmark" title="выбрано оператором — общий подбор эту строку не перезапишет">✋</span> ` : "";

        const nrmName = c.vid || c.variant_name || "";
        nrm = `${opm}<span class="vg-mono">${esc(c.shifr || "")}</span> <span class="vg-normname" title="${esc(c.variant_name || c.vid || "")}">${esc(nrmName)}</span> <button class="vg-mapbtn2" data-i="${i}">▾</button>`;
      } else if (_absorbCell(r)) { sb = _absorbCell(r); nrm = ""; }
      else if (r._m) { sb = `<span class="vg-nomatch">не найдено</span>`; }

      if (!r._m && !_absorbCell(r))
        nrm = `<button class="vg-matchone" data-i="${i}" title="подобрать расценку только для этой строки">🎯 подобрать</button>`;

      const _extras = [_companionChip(r, i), _pirogChip(r, i), _splitChip(r, i),
                       _chainChip(r, i), _sputnikChip(r, i), _forkChip(r, i)].filter(Boolean).length;
      if (_extras) nrm += ` <span class="vg-more" data-i="${i}" title="движок нашёл ${_extras} уточнение(й) по этой строке — откройте карточку">●</span>`;

      const vIzm = c ? (c.izm_norm || c.unit_calc || "") : "";
      const vObj = c ? (c.objem != null ? c.objem : r.qty) : null;

      const dimBad = c && _dimMismatch(r.unit, vIzm)
        && (vObj == null || vObj === "" || Math.abs(+vObj - (+r.qty || 0)) < 1e-9);

      const _t3 = r.type || "Работа";

      const _mat = _t3 === "Материал";
      const vIzmShow = _mat ? (r.unit || "") : vIzm;
      const vObjShow = _mat ? (r.qty != null ? r.qty : null) : vObj;
      const dimShow = _mat ? false : dimBad;
      const izmCell = `<td class="vc-unit hi${dimShow ? " vg-dimbad" : ""}"${dimShow ? ` title="размерность не сходится: в ВОРе «${esc(r.unit || "—")}», у нормы «${esc(vIzm)}» — проверьте единицу строки или норму"` : ""}>${esc(vIzmShow) || "—"}${dimShow ? " ⚠" : ""}</td>`;
      const objCell = `<td class="vc-num hi">${vObjShow != null && vObjShow !== "" ? esc(String(+(+vObjShow).toFixed(4)).replace(".", ",")) : "—"}</td>`;
      const q3 = (r.qty != null && r.qty !== "") ? String(+(+r.qty).toFixed(3)).replace(".", ",") : "";
      const tCell = `<td class="vc-type"><select class="vg-type${_t3 === "Материал" ? " tm" : ""}" data-i="${i}" title="${_t3 === "Материал" ? "Материал — в смету напрямую, без расценки ШНК" : "Работа — подбирается расценка ШНК"}"><option value="Работа" ${_t3 === "Работа" ? "selected" : ""}>Р</option><option value="Материал" ${_t3 === "Материал" ? "selected" : ""}>М</option></select></td>`;
      if (_t3 === "Материал") { sb = `<span class="vg-absorb">▪ материал напрямую</span>`; vid = "—"; nrm = `<span class="vg-map-none">без расценки</span>`; }

      const tblNo = c ? (c.sb_tbl || (_TBL_RX.test(c.sb_map || "") ? c.sb_map : "") || "") : "";
      const sbCell = (c && !_mat)
        ? `<td class="hi vg-pick-cell" data-pick="sb" data-i="${i}" title="${esc(c.sbornik || "")} — нажмите, чтобы выбрать другой сборник или таблицу">${sb}</td>`
        : `<td class="hi">${sb}</td>`;
      const tblCell = (c && !_mat)
        ? `<td class="hi vc-tbl vg-pick-cell" data-pick="tbl" data-i="${i}" title="${esc(c.vid || "")} — нажмите, чтобы выбрать другую таблицу">${esc(tblNo) || "—"}</td>`
        : `<td class="hi vc-tbl">${_mat ? "—" : (esc(tblNo) || "—")}</td>`;
      const mid = `<td class="vc-name">${nmClean}</td>`
        + `<td class="vc-unit vc-mus">${esc(r.unit || "")}</td><td class="vc-num vc-mus">${q3}</td>`
        + tCell
        + sbCell + tblCell + `<td class="hi" style="position:relative">${nrm}</td>`
        + izmCell + objCell + noteCell;
      let html = `<tr class="vg-row${light ? " vg-l-" + light : ""}" data-i="${i}">${nCell}${mid}${act}</tr>`;

      html += _resRows3(r, i);
      return html;
    }
    const c = _chosen(r);

    const shifr = c ? `<span class="vg-mono">${esc(c.shifr || "")}</span>`
      : (_absorbCell(r) || `<span class="vg-nomatch">—</span>`);
    const q = (r.qty != null && r.qty !== "") ? String(+(+r.qty).toFixed(3)).replace(".", ",") : "";
    const mid = `<td class="vc-name">${nmClean}</td><td>${shifr}</td><td class="vc-unit vc-mus">${esc(r.unit || "")}</td>
      <td class="vc-num">—</td><td class="vc-num">${q}</td><td class="vc-num">—</td><td class="vc-cost">—</td>`;
    return `<tr class="vg-row${light ? " vg-l-" + light : ""}" data-i="${i}">${nCell}${mid}</tr>` + _resRows(r);
  }

  function renderVorGrid() {
    _killFloat();
    const host = $("#vorResult");
    const doc = P.vorDoc || {};

    if (VOR_STAGES.some(s => s.off && s.n === P.vorStage)) P.vorStage = _stageStep(P.vorStage, +1);
    const stage = P.vorAllCols ? 0 : (P.vorStage || 1);
    const dataRows = P.vorRows.filter(r => !r._sec);
    const warn = dataRows.filter(r => { const l = _rowLight(r); return l === "yel" || l === "red"; }).length;
    const matched = dataRows.filter(r => r._m && r._m.candidates && r._m.candidates.length).length;
    $("#vorResSub").textContent = `строк: ${dataRows.length}${warn ? ` · на ревью: ${warn}` : ""}${matched ? ` · подобрано: ${matched}` : ""}`;

    const _ap = P.activeProject || {};
    if (!doc.project && _ap.name) doc.project = _ap.name;
    if (!doc.area && (_ap.object || _ap.name)) doc.area = _ap.object || _ap.name;
    P.vorDoc = doc;
    const headFields = [
      ["project", "Стройка", doc.project], ["area", "Объект", doc.area], ["doc_no", "Шифр", doc.doc_no],
    ].map(([f, lbl, v]) => `<span class="vd-inl"><span class="vd-l">${lbl}</span><b class="ce" contenteditable data-doc="${f}">${esc(v || "")}</b></span>`).join("");

    const cfg = stage === 0
      ? { cap: "Все столбцы: полный вид (мусорное · нормализованное · расценка). Для опытного оператора.", cols: 13, minw: 1620 }
      : (VOR_STAGES[stage - 1] || VOR_STAGES[0]);
    let n = 0, hideLvl = null;
    const childCnt = _secCounts();
    const secNum = _secNums();

    let curSecNum = "", inSecN = 0;
    const body = P.vorRows.map((r, i) => {
      if (r._sec) {
        const lvl = _rowLvl(r);
        curSecNum = secNum[i] || "";
        inSecN = 0;
        if (hideLvl != null && lvl > hideLvl) return "";
        hideLvl = r._collapsed ? lvl : null;
        return _secRowHtml(r, i, stage, childCnt[i] || 0, lvl, curSecNum);
      }
      n++; inSecN++;
      if (hideLvl != null) return "";
      const num = curSecNum ? curSecNum + "." + inSecN : String(n);
      return _dataRowHtml(r, i, num, stage);
    }).join("");

    const ctxHost = $("#vorCtx"); if (ctxHost) ctxHost.innerHTML = headFields;
    host.innerHTML = `${_renderStepper()}
      <div class="vst-cap">${esc(cfg.cap)}</div>
      ${_stageToolbar(P.vorStage || 1)}
      <div class="vorg-wrap"><table class="vor-table vor-grid" style="min-width:${cfg.minw}px">
        ${_stageThead(stage)}
        <tbody id="vorgBody">${body || `<tr><td colspan="${cfg.cols}" class="vor-empty">Строки не распознаны</td></tr>`}</tbody>
      </table></div>`;

    _wireVorGrid();
    if (P.vorFind) _vorApplyFind();
  }

  function _posModalHtml(i) {
    const r = P.vorRows[i]; if (!r) return "";
    const c = _chosen(r) || {};
    const isMat = (r.type || "Работа") === "Материал";
    const q = r.qty != null ? String(r.qty).replace(".", ",") : "";
    const secName = (() => { for (let j = i - 1; j >= 0; j--) if (P.vorRows[j]._sec) return _clean(P.vorRows[j]) || P.vorRows[j].name || ""; return ""; })();

    const doc = `
      <div class="pm-sec"><div class="pm-h">① Из документа</div>
        <div class="pm-g">
          <label class="pm-f"><span>№ по ВОР</span><input class="pm-in" data-f="pos" value="${esc(r.pos || "")}" placeholder="в документе не указан" title="№ позиции берётся из 1-й колонки ВОР. Если она в документе пустая — поле пустое; впишите свой номер при необходимости."></label>
          <label class="pm-f pm-wide"><span>Наименование (нормализованное)</span><input class="pm-in" data-f="_clean" value="${esc(_clean(r))}"></label>
          <label class="pm-f"><span>Ед. изм.</span><input class="pm-in" data-f="unit" value="${esc(r.unit || "")}"></label>
          <label class="pm-f"><span>Объём</span><input class="pm-in" data-f="qty" value="${esc(q)}"></label>
        </div>
        <div class="pm-note">Раздел: <b>${esc(secName || "—")}</b></div>
        <div class="pm-note pm-raw">Как в документе: «${esc(r.name || "")}»</div>
        ${r._pm_note ? `<div class="pm-note pm-eng">⚙ ${esc(r._pm_note)}</div>` : ""}
      </div>`;

    const pars = Object.entries(r._params || {});
    const parRows = pars.map(([k, v], n) => `
      <div class="pm-par" data-n="${n}">
        <input class="pm-in pm-pk" value="${esc(k)}">
        <input class="pm-in pm-pv" value="${esc(Array.isArray(v) ? v.join(", ") : (v == null ? "" : v))}">
        <button class="pm-pdel" title="удалить параметр">✕</button>
      </div>`).join("");
    const params = `
      <div class="pm-sec"><div class="pm-h">② Параметры <span class="pm-sub">извлечено движком из текста строки — можно править и дополнять</span></div>
        <div class="pm-pars">${parRows || '<div class="pm-note">параметров не извлечено</div>'}</div>
        <button class="pm-padd">＋ параметр</button>
      </div>`;

    const disc = "";

    const vars = c.variants || [];
    const varOpts = vars.map(v => `<option value="${esc(v.shifr)}"${v.shifr === c.shifr ? " selected" : ""}>${esc(v.shifr)} — ${esc(v.name || "")}</option>`).join("");
    const comps = (r._m && r._m.companions) || [];
    const compHtml = comps.map((cw, ci) => {
      const opts = (cw.candidates || []).map(x => `<option value="${esc(x.shifr || "")}"${x.shifr === cw.shifr ? " selected" : ""}>${esc(x.shifr || "")} — ${esc(x.name || "")}</option>`).join("");
      return `<div class="pm-comp">
        <div class="pm-comp-h">${cw.compound ? "🧩 слой из текста строки" : "⚙ сопутствующая работа"} · таблица ${esc(cw.table || "")}${cw.objem != null ? " · объём " + esc(String(cw.objem)) : " · <b>объём не извлечён</b>"}</div>
        ${opts ? `<select class="pm-in pm-compsel" data-ci="${ci}">${opts}</select>`
               : `<div class="pm-note">${esc(cw.shifr || "вариант не выбран")}</div>`}
        ${cw.note ? `<div class="pm-note pm-eng">⚙ ${esc(cw.note)}</div>` : ""}
      </div>`;
    }).join("");

    const cands = (r._m && r._m.candidates) || [];
    const curMi = r._mi || 0;
    const tblOpts = cands.map((x, k) => {
      const sbn = (x.sbornik || "").replace(/^Сборник\s*/, "Сб.");

      const tnum = x.sb_tbl || (_TBL_RX.test(x.sb_map || "") ? x.sb_map : "") || x.table || "";
      const lbl = `${tnum || "—"}${sbn ? " · " + sbn : ""}${x.vid ? " · " + x.vid : ""}`;
      return `<option value="${k}"${k === curMi ? " selected" : ""}>${esc(lbl)}</option>`;
    }).join("");

    const matCands = (r._matcand || []).slice(0, 5);
    const matCandHtml = matCands.length
      ? `<div class="pm-note pm-eng">⚙ похожие в каталоге: ${matCands.map(mc =>
          `<span class="pm-matcand" data-code="${esc(mc.code)}" data-name="${esc(mc["наим"])}" data-unit="${esc(mc["ед"] || "")}">${esc(mc["наим"])} (${esc(mc.code)})</span>`
        ).join(" · ")}</div>`
      : "";
    const rateMat = `
      <div class="pm-sec"><div class="pm-h">③ Ресурс вне расценки</div>
        <div class="pm-note">${r._extraRes
          ? `выбран: <b>${esc(r._extraResName || r._extraRes)}</b> · <span class="vg-mono">${esc(r._extraRes)}</span>`
          : `🟡 ресурс не подтверждён — движок только предлагает похожие, выбор за вами`}</div>
        ${matCandHtml}
        <div class="pm-tree-row">
          <button class="btn btn-ghost pm-tree-btn" id="pmMatRes">🧱 Ресурсы вне расценки</button>
          <span class="pm-note">справочник ресурсов или свой ресурс (код ПМ-/ПО-)</span>
        </div>
      </div>`;
    const rate = isMat ? rateMat : `
      <div class="pm-sec"><div class="pm-h">③ Расценка ШНК</div>
        ${cands.length > 1
          ? `<label class="pm-f pm-wide"><span>Таблица / сборник</span><select class="pm-in pm-tbl">${tblOpts}</select></label>
             <div class="pm-note pm-eng">⚙ смена таблицы меняет путь подбора — список вариантов ниже обновится</div>`
          : `<div class="pm-note">Таблица: <b>${esc(c.sb_tbl || (_TBL_RX.test(c.sb_map || "") ? c.sb_map : "") || "—")}</b>${c.sbornik ? " · " + esc(c.sbornik) : ""}</div>`}
        ${vars.length
          ? `<label class="pm-f pm-wide"><span>Вариант нормы</span><select class="pm-in pm-var">${varOpts}</select></label>`
          : `<div class="pm-note">${c.shifr ? "вариант: <b>" + esc(c.shifr) + "</b> (альтернатив каталог не дал)" : "норма не подобрана"}</div>`}
        ${""}
        <div class="pm-note pm-vol">📐 объём в смету: <b>${c && c.objem != null ? esc(String(c.objem)) : "—"}</b>${c && c.unit_calc ? " " + esc(c.unit_calc) : ""}${c && c.izm_norm ? ` <span class="pm-note">· измеритель нормы: ${esc(c.izm_norm)}</span>` : ""}
          ${c && c.objem == null ? ` <span class="pm-warn">объём не извлечён — задайте параметры ниже или впишите вручную</span>` : ""}</div>
        ${c && c.objem_why ? `<div class="pm-note pm-eng">⚙ ${esc(c.objem_why)}</div>` : ""}
        ${c.why ? `<div class="pm-note pm-eng">⚙ почему: ${esc(c.why)}</div>` : ""}
        ${(r._m && r._m.note) ? `<div class="pm-note pm-eng">⚙ ${esc(r._m.note)}</div>` : ""}
        ${(r._m && r._m.note_cand) ? `<div class="pm-note pm-warn">⚠ ${esc(r._m.note_cand)}</div>` : ""}
        ${""}
        <div class="pm-tree-row">
          <button class="btn btn-ghost pm-tree-btn" id="pmTree">🌳 Выбрать из дерева ШНК</button>
          ${c && c.shifr ? `<button class="btn btn-ghost pm-tree-btn" id="pmRes">🧱 Ресурсы этой нормы</button>` : ""}
          <span class="pm-note">весь классификатор: сборник → таблица → норма</span>
        </div>
        <div id="pmResBox" class="pm-resbox"></div>
        ${r._mTree ? `<div class="pm-note pm-op">✋ норму выбрал оператор из дерева${r._mTreeWas ? ` · движок предлагал ${esc(r._mTreeWas)}` : ""}</div>` : ""}
        ${compHtml}
      </div>`;

    const why = _whyLine(r, c, (r.type || "Работа") === "Материал");
    const head = why ? `<div class="pm-head-why">${why.replace(/class="vg-why[^"]*"/g, 'class="pm-why"')}</div>` : "";
    return `<div class="modal" id="posModal"><div class="modal-card pm-card">
      <div class="modal-head"><div><h2>Позиция ${r.pos ? "№ " + esc(r.pos) : ""}</h2>${head}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="pmCancel">Отмена</button>
          <button class="btn btn-primary" id="pmApply">Применить</button>
        </div></div>
      <div class="modal-body">${doc}${params}${disc}${rate}</div>
    </div></div>`;
  }

  function _openPosModal(i) {
    _killFloat();
    const host = document.createElement("div");
    host.innerHTML = _posModalHtml(i);
    const el = host.firstElementChild; if (!el) return;
    document.body.appendChild(el);
    const close = () => el.remove();

    const _snapFields = () => [...el.querySelectorAll(".pm-in[data-f]")].map(x => x.dataset.f + "=" + x.value).join("|");
    let _fieldsAtOpen = _snapFields();
    const _dirty = () => _snapFields() !== _fieldsAtOpen;
    const closeAsk = () => {
      if (_dirty() && !confirm("В карточке есть незаписанные правки (ед.изм, объём, наименование).\nЗакрыть и потерять их?")) return;
      close();
    };
    el.addEventListener("click", e => { if (e.target === el) closeAsk(); });
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.classList.contains("pm-in") && e.target.tagName === "INPUT") {
        e.preventDefault(); el.querySelector("#pmApply").click();
      }
      if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
    });
    el.querySelector("#pmCancel").onclick = closeAsk;

    const trb = el.querySelector("#pmTree");
    if (trb) trb.onclick = () => { close(); _openTreeModal(i); };

    const mrb = el.querySelector("#pmMatRes");
    if (mrb) mrb.onclick = () => { close(); vorPickMaterialRes(i); };
    el.querySelectorAll(".pm-matcand").forEach(sp => {
      sp.onclick = () => { close(); window.vorMatResPicked(i, sp.dataset.code, sp.dataset.name, sp.dataset.unit); };
    });

    const rsb = el.querySelector("#pmRes");
    if (rsb) rsb.onclick = async () => {
      const box = el.querySelector("#pmResBox"); if (!box) return;
      if (box.innerHTML.trim()) { box.innerHTML = ""; rsb.classList.remove("on"); return; }
      rsb.classList.add("on");
      const r = P.vorRows[i]; if (!r) return;
      const cc = _chosen(r);
      if (!cc || !cc.shifr) {
        box.innerHTML = `<div class="pm-note pm-warn">⚠ норма не выбрана — сначала подберите расценку или возьмите её из дерева</div>`;
        return;
      }
      if (cc.wc == null) {
        box.innerHTML = `<div class="pm-note pm-warn">⚠ у этой позиции нет ссылки на таблицу ШНК — состав нормы показать нечем</div>`;
        return;
      }
      box.innerHTML = `<div class="pm-note">загружаю состав нормы…</div>`;
      try {

        const d = await apiJson("/api/vor/resources", { method: "POST", body: JSON.stringify({ rows: [_resPayload(r, cc)], criteria: P.vorCriteria || {} }) });
        const res0 = (d.results || [{}])[0] || {};
        const list = res0.res || [];
        if (!list.length) {
          box.innerHTML = `<div class="pm-note pm-warn">⚠ у этой нормы в базе нет ресурсов — в смете строка будет пустой</div>`;
          return;
        }
        const grp = { "труд": [], "машина": [], "материал": [] };
        list.forEach(x => { (grp[x.type] || (grp[x.type] = [])).push(x); });

        const hc = res0.height_correction;
        const hcBlock = hc ? `<div class="pm-note pm-hc" title="${esc(hc["цитата"] || "")}">
            💡 поправка по высоте работ: <b>${esc(hc["диапазон"])}</b> (высота ${esc(String(hc["высота_м"]))} м — ${esc(hc["источник_высоты"] || "")})
            · п.${esc(hc["p_code"])} · ×труд ${esc(hc["коэф_труд"] || "—")} / ×маш ${esc(hc["коэф_маш"] || "—")} / ×мат ${esc(hc["коэф_мат"] || "—")}
            — отметьте в «Поправки», если применимо</div>` : "";

        const sc = res0.seismic_correction;
        const scBlock = sc ? `<div class="pm-note pm-hc" title="${esc(sc["citation"] || "")}">
            💡 сейсмика ≥${esc(String(sc["min_balls"]))} баллов, сб. ${esc(sc["sbornik"] || "")}: <b>${esc(sc["note"] || "")}</b>
            · источник ${esc(sc["source"] || "")} — отметьте в «Поправки», если применимо</div>` : "";
        box.innerHTML = hcBlock + scBlock + Object.keys(grp).filter(k => grp[k].length).map(k =>
          `<div class="pm-resgrp"><b>${esc(k)}</b>${grp[k].map(x =>
            `<div class="pm-resrow${x.excl ? " pm-resx" : ""}"><span class="pm-resnm">${esc(x.name || "")}</span>
               <span class="pm-resu">${esc(x.unit || "")}</span>
               <span class="pm-resn" title="норма на измеритель">${esc(String(x.norma ?? ""))}</span>
               <span class="pm-resk" title="на объём этой строки">${x.excl ? "—" : esc(String(x.kol ?? ""))}</span></div>`).join("")}</div>`).join("")
          + `<div class="pm-note pm-eng">⚙ норма на измеритель · количество на объём строки. Заменить ресурс, поправить расход или исключить — прямо в составе под строкой (кнопки ✕ ⇄ ↺).</div>`;
      } catch (e) { box.innerHTML = `<div class="pm-note pm-warn">не удалось загрузить состав нормы</div>`; }
    };
    const tsel = el.querySelector(".pm-tbl");
    if (tsel) tsel.onchange = () => {
      const rr = P.vorRows[i]; if (!rr) return;
      vorSnapshot();
      rr._mi = +tsel.value || 0;
      rr._mOp = true;
      close(); renderVorGrid(); _openPosModal(i);
      toast("Таблица изменена — проверьте вариант нормы ниже", "info");
    };
    el.querySelectorAll(".pm-pdel").forEach(b => b.onclick = () => b.closest(".pm-par").remove());
    const addBtn = el.querySelector(".pm-padd");
    if (addBtn) addBtn.onclick = () => {
      const d = document.createElement("div"); d.className = "pm-par";
      d.innerHTML = `<input class="pm-in pm-pk" placeholder="имя параметра"><input class="pm-in pm-pv" placeholder="значение"><button class="pm-pdel">✕</button>`;
      d.querySelector(".pm-pdel").onclick = () => d.remove();
      el.querySelector(".pm-pars").appendChild(d);
    };
    el.querySelector("#pmApply").onclick = () => {
      const r = P.vorRows[i]; if (!r) { close(); return; }
      _fieldsAtOpen = _snapFields();
      vorSnapshot();
      el.querySelectorAll(".pm-in[data-f]").forEach(inp => {
        const f = inp.dataset.f, v = inp.value.trim();
        if (f === "qty") r.qty = v === "" ? null : +v.replace(",", ".");
        else r[f] = v;
      });

      if ((r.unit || "").trim() && r.note) {
        r.note = r.note.split(" · ").filter(s => !(/не указан/i.test(s) && /едини|ед\.?\s*изм/i.test(s))).join(" · ");
      }
      const np = {};
      el.querySelectorAll(".pm-par").forEach(d => {
        const k = (d.querySelector(".pm-pk").value || "").trim();
        const v = (d.querySelector(".pm-pv").value || "").trim();
        if (k) np[k] = v;
      });
      r._params = np;
      const ds = el.querySelector(".pm-disc");
      if (ds) { const nv = ds.value; if (nv !== (r._disc || "")) { r._disc = nv || null; r._src = "op"; r._conf = null; } }
      const vs = el.querySelector(".pm-var");
      if (vs && r._m && r._m.candidates && r._m.candidates[r._mi || 0]) {
        const cand = r._m.candidates[r._mi || 0];
        if (vs.value && vs.value !== cand.shifr) {
          const chosen = (cand.variants || []).find(x => x.shifr === vs.value);
          cand.shifr = vs.value;
          cand.variant_name = chosen ? chosen.name : cand.variant_name;

          if (Array.isArray(cand.components) && cand.components.length) cand.components[0].shifr = vs.value;
          else cand.components = [{ shifr: vs.value, objem: cand.objem }];
          cand.var_status = "ok";
          cand.by_operator = true;
          r._mOp = true;
        }
      }
      el.querySelectorAll(".pm-compsel").forEach(sel => {
        const cw = ((r._m && r._m.companions) || [])[+sel.dataset.ci];
        if (cw && sel.value && sel.value !== cw.shifr) {
          cw.shifr = sel.value;
          cw.components = [{ shifr: sel.value, objem: cw.objem }];
          cw.operator_flag = false;
        }
      });
      close(); renderVorGrid();
    };
  }

  function _wireVorGrid() {
    const on = (id, fn) => { const el = $("#" + id); if (el) el.onclick = fn; };
    document.querySelectorAll(".vst-step").forEach(s => s.onclick = () => { vorAutoSave("переход этапа"); P.vorStage = +s.dataset.stage; _closeVorPops(); renderVorGrid(); });
    on("vorBackProj", () => { const t = $("#tabProject"); if (t) t.click(); });
    on("vorgUndo", vorUndo);
    on("vorgCollapseAll", _vorToggleAll);
    on("vorgAllCols", () => { P.vorAllCols = !P.vorAllCols; renderVorGrid(); });
    on("vorgFindX", () => { P.vorFind = ""; renderVorGrid(); });

    { const f = $("#vorgFind");
      if (f) {
        f.oninput = () => { P.vorFind = f.value; _vorApplyFind(); };
        f.onkeydown = e => { if (e.key === "Escape") { f.value = ""; P.vorFind = ""; _vorApplyFind(); } };
      }
    }
    on("vorgClean", () => vorAutoClean());
    on("vorgStage1", vorStage1Apply);
    on("vorgDecomp", vorRunDecompose);
    on("vorgDecompUndo", vorDecompUndo);

    on("vorgMatch", vorRunMatch);
    on("vorgRes", vorRunResources);
    on("vorgAllRes", () => {
      const anyOpen = P.vorRows.some(r => r._res && r._res.length && !r._resCollapsed);
      P.vorRows.forEach(r => { if (r._res && r._res.length) r._resCollapsed = anyOpen; });
      renderVorGrid();
    });
    on("vorgRes", vorRunResources);
    on("vorgBack", () => { vorAutoSave("переход этапа"); P.vorStage = _stageStep(P.vorStage || 1, -1); _closeVorPops(); renderVorGrid(); });
    on("vorgNext", () => { vorAutoSave("переход этапа"); P.vorStage = _stageStep(P.vorStage || 1, +1); _closeVorPops(); renderVorGrid(); });
    const toEngine = () => {
      vorAutoSave("переход в смету");
      const rows = []; let skipped = 0;
      P.vorRows.forEach(r => {

        if (r._sec) {
          const sname = _clean(r) || r.name || "";

          if (!sname.trim()) return;
          rows.push({ sec: true, kind: (_secLvl(sname) ? "Подраздел" : "Раздел"), name: sname });
          return;
        }
        if (r._cmpParent) return;

        if ((r.type || "Работа") === "Материал") {

          const cw = _pirogWork(r);
          if (cw) { _pushWorkRow(rows, r, cw); return; }
          const nmM = r._clean || r.name || "";

          if (nmM.trim()) rows.push({ material: true, name: nmM, objem: +(r.qty || 0),
                                      izm: r.unit || "", wc: null, code: null,
                                      mat_code: r._extraRes || "" });
          return;
        }
        const c = _chosen(r);
        if (c && c.wc != null && c.shifr) {
          _pushWorkRow(rows, r, c);

          (r._m && r._m.companions || []).forEach(cw => {
            if (!cw.wc) return;

            const hasVariant = !!cw.shifr;
            const draftCode = cw.shifr || ((cw.candidates && cw.candidates[0] && cw.candidates[0].shifr) || null);
            if (!draftCode) return;
            const ccomps = hasVariant && Array.isArray(cw.components) && cw.components.length
              ? cw.components : [{ shifr: draftCode, objem: cw.objem }];
            const askOp = !hasVariant || cw.operator_flag;
            ccomps.forEach(cc => {
              const noObjem = cc.objem == null;
              const tail = (!hasVariant ? " ⚠ выбрать вариант" : "") + (noObjem ? " ⚠ ввести объём" : "");
              rows.push({ vor: true, wc: cw.wc, code: cc.shifr, objem: noObjem ? 0 : +cc.objem,

                          name: (r._clean || r.name || "") + " — " + (cw.variant_name || "сопутствующая работа") + tail,
                          izm: cw.unit_calc || "", askOperator: askOp,
                          candidates: askOp ? (cw.candidates || []) : null });
            });
          });
        } else if ((r._clean || r.name || "").trim()) skipped++;
      });

      const _nWork = rows.filter(x => !x.sec && !x.material).length;
      if (skipped) {
        const msg = "В смету уйдут только подобранные работы.\n\n"
          + "Подобрано: " + _nWork + "\nБез расценки: " + skipped + " — эти строки в смету НЕ попадут.\n"
          + (_nWork ? "" : "\nПодобранных работ нет вовсе — смета получится из одних заголовков разделов.\n")
          + "\nПродолжить? (Отмена — вернуться и подобрать расценки)";
        if (!confirm(msg)) return;
      }
      window.__vorRows = rows; window.__vorSkipped = skipped;

      const _d = P.vorDoc || {}, _ap2 = P.activeProject || {};
      const _hit = P.vorSubId ? subById(_ap2, P.vorSubId) : null;
      const _sub = _hit ? _hit.s : null, _obj = _hit ? _hit.o : null;
      const _shifr = (_sub ? subTitul(_ap2, _sub, "shifr").v : ((_ap2.passport || {}).shifr || _d.doc_no || "")).trim();
      window.__vorTitul = {
        стройка: ((_obj && _obj.name) || _d.project || _ap2.name || _ap2.object || "").trim(),
        объект: ((_sub && _sub.name) || _d.area || _ap2.object || "").trim(),
        номер: _shifr,
        основание: (_shifr ? "шифр " + _shifr : "").trim(),
      };

      const _went = new Set((P.vorFileIds || []).map(String));
      const _files = _sub ? subFiles(_ap2, _sub) : [];
      const _mine = _went.size ? _files.filter(f => _went.has(String(f.id))) : _files;
      const _dis = [...new Set(_mine.map(f => f.discipline || "").filter(Boolean))];
      window.__vorProj = {
        проект: (_ap2.name || "").trim(),
        объект: ((_obj && _obj.name) || "").trim(),
        подобъект: ((_sub && _sub.name) || "").trim(),
        подобъект_шифр: _shifr,
        дисциплина: _dis.join(" · "),
        object_id: String((_obj && _obj.id) || ""),
        sub_id: String((_sub && _sub.id) || ""),
        vor_file_ids: [...(P.vorFileIds || [])],
      };
      showView("engine");
      if (typeof engineConsumeVor === "function") engineConsumeVor();
      else toast("Строки ВОР переданы в ядро");
    };
    on("vorToEngine", toEngine); on("vorToEngine2", toEngine);
    const save = $("#vorSave"); if (save) save.onclick = vorSaveRows;

    const bodyEl = $("#vorgBody");
    bodyEl.addEventListener("focusout", e => {
      const ce = e.target.closest(".ce"); if (!ce) return;
      if (ce.dataset.doc != null) { P.vorDoc[ce.dataset.doc] = ce.textContent.trim(); return; }
      if (ce.dataset.rf === "norm") {
        const nv = ce.textContent.trim();
        if (nv === (ce.dataset.rv || "")) return;
        vorResQty(+ce.dataset.i, ce.dataset.rk, nv); return;
      }
      const i = +ce.dataset.i, f = ce.dataset.f, val = ce.textContent.trim();
      const r = P.vorRows[i]; if (!r) return;
      if (f === "qty") {
        const was = _qtyDisp(r);
        const num = parseFloat(val.replace(",", ".").replace(/\s/g, ""));
        if (val === "") { r.qty = null; r.qty_raw = ""; }
        else if (isNaN(num)) { r.qty = null; r.qty_raw = val; }
        else { r.qty = num; r.qty_raw = ""; }
        logEdit("qty", was, val, r);

        const cell = ce.closest("td");
        if (cell) {
          const chg = r._qty0 != null && r.qty != null && +r._qty0 !== +r.qty;
          cell.classList.toggle("vg-qtychg", chg);
          if (chg) cell.title = "в ВОРе было " + String(+(+r._qty0).toFixed(6)).replace(".", ","); else cell.removeAttribute("title");
        }
      } else if (r[f] !== val) {
        vorSnapshot();
        const was = r[f];
        r[f] = val;
        logEdit(f, was, val, r);
      }

      if (f === "note") {
        const fm = _noteFormula(val);
        const noteCell = ce.closest("td");
        if (fm && fm.ok) {
          const was = _qtyDisp(r);
          r.qty = +(+fm.value).toFixed(6); r.qty_raw = "";
          logEdit("qty", was, String(r.qty).replace(".", ","), r, { kind: "formula", now: val });
          if (noteCell) { noteCell.classList.remove("vg-formula-bad"); noteCell.classList.add("vg-formula"); }

          const qCe = ce.closest("tr").querySelector('.ce[data-f="qty"]');
          if (qCe) {
            qCe.textContent = _qtyPlain(r);
            const qtd = qCe.closest("td");
            if (qtd) {
              const chg = r._qty0 != null && +r._qty0 !== +r.qty;
              qtd.classList.toggle("vg-qtychg", chg);
              qtd.title = "= " + val + (chg ? " · в ВОРе было " + String(+(+r._qty0).toFixed(6)).replace(".", ",") : "");
            }
          }
          toast("Объём по формуле: " + _qtyPlain(r));
        } else if (fm && !fm.ok && noteCell) {
          noteCell.classList.add("vg-formula-bad");
          noteCell.classList.remove("vg-formula");
          toast("Формулу не удалось вычислить — проверьте запись", "err");
        } else if (noteCell) {
          noteCell.classList.remove("vg-formula-bad", "vg-formula");
        }
      }

      if (f === "_clean" || f === "_unitNorm" || f === "qty" || f === "note") _vorRevalidate(i);
    });
    bodyEl.addEventListener("keydown", e => {
      const ce = e.target.closest(".ce");
      if (e.key === "Enter" && ce) {
        e.preventDefault();

        const tr = ce.closest("tr"), i = tr ? +tr.dataset.i : -1;
        ce.blur();
        const r = P.vorRows[i];
        if (r && !r._sec) {
          const base = _rowLightBase(r);
          if (base === "red" || base === "yel") {
            r._opOk = true; P.vorDirty = true; vorAutoSoon();
            logEdit("_opOk", base, "подтверждено (Enter)", r, { kind: "confirm" });
          }

          const light = _rowLight(r);
          tr.classList.remove("vg-l-red", "vg-l-yel", "vg-l-grn");
          if (light) tr.classList.add("vg-l-" + light);
        }
      }
    });
    bodyEl.querySelectorAll(".vg-type").forEach(sel => sel.onchange = e => { const r = P.vorRows[+e.target.dataset.i]; if (r) r.type = e.target.value; });

    bodyEl.addEventListener("click", e => {
      const tog = e.target.closest(".vg-tog"), menu = e.target.closest(".vg-menu"),
            discBtn = e.target.closest(".vg-discbtn"), mb = e.target.closest(".vg-mapbtn2"),
            cand = e.target.closest(".vg-cand"), tree = e.target.closest(".vg-cand-tree"),
            pchip = e.target.closest(".vg-param"), pirch = e.target.closest(".vg-pirog");
      if (pchip) { e.stopPropagation(); _floatPop(_paramMenu(+pchip.dataset.i), pchip); return; }
      if (pirch) { e.stopPropagation(); _floatPop(_pirogMenu(+pirch.dataset.i), pirch); return; }
      const spch = e.target.closest(".vg-split");
      if (spch) { e.stopPropagation(); _floatPop(_splitMenu(+spch.dataset.i), spch); return; }
      const chch = e.target.closest(".vg-chain");
      if (chch) { e.stopPropagation(); _floatPop(_chainMenu(+chch.dataset.i), chch); return; }
      const sput = e.target.closest(".vg-sputnik");
      if (sput) { e.stopPropagation(); _floatPop(_sputnikMenu(+sput.dataset.i), sput); return; }
      const compv = e.target.closest(".vg-compvar");
      if (compv) { e.stopPropagation(); _floatPop(_compVarMenu(+compv.dataset.i), compv); return; }

      const rx = e.target.closest(".vg-rx"), rrest = e.target.closest(".vg-rrest"),
            rsw = e.target.closest(".vg-rsw"), rrev = e.target.closest(".vg-rrev");
      if (rx) { e.stopPropagation(); vorResDrop(+rx.dataset.i, rx.dataset.rk); return; }
      if (rrest) { e.stopPropagation(); vorResRestore(+rrest.dataset.i, rrest.dataset.rk); return; }
      if (rrev) { e.stopPropagation(); vorResUnswap(+rrev.dataset.i, rrev.dataset.rk); return; }
      if (rsw) {
        e.stopPropagation();
        if (typeof window.openResPicker !== "function") { toast("Справочник ресурсов недоступен", "err"); return; }
        window.openResPicker("swap", rsw.dataset.rk, null, { vorRow: +rsw.dataset.i });
        return;
      }
      if (tog) { const r = P.vorRows[+tog.dataset.i]; if (r && r._sec) { r._collapsed = !r._collapsed; renderVorGrid(); } return; }

      if (tree) { e.stopPropagation(); _openTreeModal(+tree.dataset.i, tree.dataset.wc, tree.dataset.nm); return; }

      const pick = e.target.closest(".vg-pick-cell");
      if (pick) { e.stopPropagation(); _openTreeModal(+pick.dataset.i); return; }
      if (e.target.closest(".vg-more")) { e.stopPropagation(); _openPosModal(+e.target.closest(".vg-more").dataset.i); return; }
      if (e.target.closest(".vg-matchone")) { const i = +e.target.closest(".vg-matchone").dataset.i; vorMatchOne(i); return; }

      if (mb) { e.stopPropagation(); _openCandModal(+mb.dataset.i); return; }
      if (menu) { e.stopPropagation(); _floatPop(_actMenu(+menu.dataset.i), menu); return; }

      const rowEl = e.target.closest("tr.vg-row");
      if (rowEl && (P.vorStage || 1) !== 1 && !e.target.closest(".ce,select,button,input,.vg-chip")) {
        const ri = +rowEl.dataset.i;
        if (P.vorRows[ri] && !P.vorRows[ri]._sec) { _openPosModal(ri); return; }
      }
      if (discBtn) { e.stopPropagation(); _floatPop(_discMenu(+discBtn.dataset.i), discBtn); return; }
    });
    _wireVorDrag(bodyEl);
    if (!P._vorFloatWired) {
      P._vorFloatWired = true;
      document.addEventListener("mousedown", e => {
        if (P._floatEl && !P._floatEl.contains(e.target) && !e.target.closest(".vg-menu,.vg-discbtn,.vg-param,.vg-pirog,.vg-split,.vg-chain,.vg-sputnik,.vg-compvar")) _killFloat();
      });
      window.addEventListener("scroll", () => _killFloat(), true);
    }
  }

  function _closeVorPops() { _killFloat(); P.vorMapOpen = null; }
  function _vorToggleAll() {
    const secs = P.vorRows.filter(r => r._sec);
    const anyOpen = secs.some(r => !r._collapsed);
    secs.forEach(r => { r._collapsed = anyOpen; });
    renderVorGrid();
  }

  function _splitParams(params, texts) {
    const out = texts.map(() => ({}));
    const low = texts.map(t => String(t || "").toLowerCase());

    const hasTok = (text, needle) => {
      const nd = String(needle || "").trim().toLowerCase();
      if (!nd) return false;
      const esc = nd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pre = "(?:^|(?<=[^0-9a-zа-яё])|(?<=\\d[хx×]))";
      const post = "(?:$|(?=[^0-9a-zа-яё])|(?=[хx×]\\d))";
      try { return new RegExp(pre + esc + post, "i").test(text); }
      catch (e) { return new RegExp("(^|[^0-9a-zа-яё])" + esc + "($|[^0-9a-zа-яё])", "i").test(text); }
    };
    Object.entries(params || {}).forEach(([k, v]) => {
      const val = String(Array.isArray(v) ? v.join(" ") : (v == null ? "" : v)).toLowerCase().trim();
      const kname = String(k || "").toLowerCase().trim();

      const tries = [
        n => kname && kname.split(/\s+/).some(w => w.length > 3 && low[n].includes(w)),
        n => hasTok(low[n], val),
        n => val.split(/[\s,;]+/).filter(x => x.length > 1).some(w => hasTok(low[n], w)),
      ];
      let hit = -1;
      for (const t of tries) {
        for (let n = 0; n < low.length && hit < 0; n++) if (t(n)) hit = n;
        if (hit >= 0) break;
      }
      out[hit < 0 ? 0 : hit][k] = v;
    });
    return out;
  }
  function vorSplitRow(i) {
    const r = P.vorRows[i]; if (!r || r._sec) return;
    const cur = _clean(r) || r.name || "";
    const part = (window.prompt("Разбить строку на две.\n\nОставить в ПЕРВОЙ строке:", cur) || "").trim();
    if (!part) return;
    const rest = (window.prompt("Во ВТОРОЙ строке:", cur.replace(part, "").replace(/^[\s,;+·—-]+/, "").trim() || cur) || "").trim();
    if (!rest) return;
    vorSnapshot();
    const [p1, p2] = _splitParams(r._params || {}, [part, rest]);
    const mk = (nm, prm) => Object.assign({}, r, {
      _clean: nm, _params: prm, _split: true,
      _m: null, _mi: 0, _res: null, _resTouched: false,
      _swaps: {}, _qtys: {}, _drops: [],
    });
    const a = mk(part, p1), b = mk(rest, p2);
    b.qty = null; b.qty_raw = "";
    P.vorRows.splice(i, 1, a, b);
    logEdit("_clean", cur, part + "  ||  " + rest, r, { kind: "split" });
    _closeVorPops(); renderVorGrid();
    toast("Строка разбита на две — впишите объём второй строки" +
      (Object.keys(p2).length ? " · параметров передано: " + Object.keys(p2).length : ""));
  }

  function _vorAct(act, i) {
    P.vorActOpen = null;
    if (act === "up") return _vorMove(i, -1);
    if (act === "dn") return _vorMove(i, +1);
    if (act === "split") { _closeVorPops(); return vorSplitRow(i); }
    if (act === "mkrazdel" || act === "mksub") {
      const r = P.vorRows[i]; if (!r) return;
      vorSnapshot();
      const was = _rowLvl(r) === 1 ? "подраздел" : "раздел";
      r._lvl = act === "mksub" ? 1 : 0;
      logEdit("_lvl", was, act === "mksub" ? "подраздел" : "раздел", r, { kind: "level" });
      _closeVorPops(); return renderVorGrid();
    }
    if (act === "match") { _closeVorPops(); return vorMatchOne(i); }
    if (act === "extra") { _closeVorPops(); return vorAddExtraRes(i); }
    if (act === "del") {
      const rd = P.vorRows[i];
      if (rd && !rd._sec) logEdit("_clean", _clean(rd) || rd.name || "", "", rd, { kind: "delete" });
      vorSnapshot(); P.vorRows.splice(i, 1); _closeVorPops(); return renderVorGrid();
    }
    vorSnapshot();

    const item = act === "row" ? { pos: "", name: "", unit: "", qty: null, qty_raw: "", type: "Работа", note: "", _m: null, _mi: 0, _added: true, _qty0: null }
      : { _sec: true, name: act === "sub" ? "Новый подраздел:" : "Новый раздел" };
    P.vorRows.splice(i + 1, 0, item);
    if (act === "row") logEdit("_clean", "", "(добавлена оператором)", item, { kind: "add" });
    renderVorGrid();
  }

  function _vorMove(i, dir) {
    const j = i + dir; if (j < 0 || j >= P.vorRows.length) return;
    vorSnapshot(); const t = P.vorRows[i]; P.vorRows[i] = P.vorRows[j]; P.vorRows[j] = t;
    P.vorMapOpen = null; renderVorGrid();
  }

  function _vorClearFind(root) {
    root.querySelectorAll("mark.vg-hit").forEach(m => {
      const t = document.createTextNode(m.textContent);
      m.parentNode.replaceChild(t, m);
    });
    root.querySelectorAll("tr.vg-hidden").forEach(tr => tr.classList.remove("vg-hidden"));
    root.normalize();
  }
  function _vorApplyFind() {
    const body = $("#vorgBody"); if (!body) return;
    _vorClearFind(body);
    const q = String(P.vorFind || "").trim().toLowerCase();
    const cnt = $("#vorgFindN"), x = $("#vorgFindX");
    if (!q) { if (cnt) cnt.textContent = ""; if (x) x.remove(); P.vorFindN = 0; return; }
    let hits = 0;
    body.querySelectorAll("tr").forEach(tr => {

      const isSec = tr.classList.contains("vg-sec");
      let rowHit = false;
      tr.querySelectorAll("td").forEach(td => {
        if (td.querySelector("select,input,button")) { if (td.textContent.toLowerCase().includes(q)) rowHit = true; }
        const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, null);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(node => {
          const txt = node.nodeValue || "";
          const low = txt.toLowerCase();
          if (!low.includes(q)) return;
          const frag = document.createDocumentFragment();
          let pos = 0, k;
          while ((k = low.indexOf(q, pos)) >= 0) {
            if (k > pos) frag.appendChild(document.createTextNode(txt.slice(pos, k)));
            const m = document.createElement("mark");
            m.className = "vg-hit";
            m.textContent = txt.slice(k, k + q.length);
            frag.appendChild(m);
            pos = k + q.length; hits++; rowHit = true;
          }
          if (pos < txt.length) frag.appendChild(document.createTextNode(txt.slice(pos)));
          node.parentNode.replaceChild(frag, node);
        });
      });
      if (!rowHit && !isSec) tr.classList.add("vg-hidden");
    });

    const trs = [...body.querySelectorAll("tr")];
    trs.forEach((tr, k) => {
      if (!tr.classList.contains("vg-sec")) return;
      let alive = false;
      for (let j = k + 1; j < trs.length; j++) {
        if (trs[j].classList.contains("vg-sec")) break;
        if (!trs[j].classList.contains("vg-hidden")) { alive = true; break; }
      }
      if (!alive) tr.classList.add("vg-hidden");
    });
    P.vorFindN = hits;
    if (cnt) cnt.textContent = hits ? hits + " совпад." : "не найдено";
  }

  function _vorRevalidate(i) {
    if ((P.vorStage || 1) !== 1) return;
    const r = P.vorRows[i]; if (!r || r._sec) return;
    const body = $("#vorgBody"); if (!body) return;
    const tr = body.querySelector(`tr[data-i="${i}"]`); if (!tr) return;
    const nm = !!(_clean(r) || "").trim();
    const un = !!(_uNorm(r) || "").trim();
    const q = (r.qty != null && r.qty !== "") || !!((r.qty_raw || "").trim());
    const part = ((nm ? 1 : 0) + (un ? 1 : 0) + (q ? 1 : 0)) >= 1 && !(nm && un && q);
    const set = (fld, empty) => {
      const ce = tr.querySelector(`.ce[data-f="${fld}"]`), td = ce && ce.closest("td");
      if (td) td.classList.toggle("vg-need", part && empty);
    };
    set("_clean", !nm); set("_unitNorm", !un); set("qty", !q);
  }

  function _wireVorDrag(bodyEl) {
    let from = null;
    bodyEl.querySelectorAll(".vg-grip").forEach(g => {
      g.addEventListener("dragstart", e => {
        const tr = g.closest("tr"); if (!tr) return;
        from = +tr.dataset.i; tr.classList.add("vg-drag");
        try { e.dataTransfer.setDragImage(tr, 20, 10); } catch (_) {}
        e.dataTransfer.effectAllowed = "move";
      });
      g.addEventListener("dragend", () => {
        from = null; bodyEl.querySelectorAll(".vg-drag").forEach(x => x.classList.remove("vg-drag"));
      });
    });
    bodyEl.querySelectorAll("tr[data-i]").forEach(tr => {
      tr.addEventListener("dragover", e => { if (from != null) e.preventDefault(); });
      tr.addEventListener("drop", e => {
        if (from == null) return;
        e.preventDefault();
        const to = +tr.dataset.i;
        if (from === to) return;
        vorSnapshot();
        const [m] = P.vorRows.splice(from, 1);
        P.vorRows.splice(to, 0, m);
        from = null; P.vorMapOpen = null; renderVorGrid();
      });
    });
  }

  function _secOf(i) {
    let sub = "", raz = "";
    for (let k = i - 1; k >= 0; k--) {
      const rk = P.vorRows[k]; if (!rk || !rk._sec) continue;
      const nm = _clean(rk) || rk.name || "";
      if (_rowLvl(rk) === 1) { if (!sub && !raz) sub = nm; }
      else { raz = nm; break; }
    }
    return (raz && sub) ? (raz + " › " + sub) : (sub || raz || "");
  }

  function _matchPayloadRow(r, sec) {
    return { name: _clean(r), raw: r.name || "", disc: r._disc || "", qty: r.qty, unit: r.unit || "",
             section: sec, params: r._params || {},
             _pm_applied: (r._mult || r._multSkip) ? 1 : 0,
             doc_note: r.doc_note || "", note: r.note || "" };
  }

  async function vorMatchRows(idx, opts) {
    const list = (idx || []).filter(i => P.vorRows[i] && !P.vorRows[i]._sec);
    if (!list.length) { toast("Нечего подбирать", "err"); return 0; }
    vorSnapshot();
    const rows = list.map(i => _matchPayloadRow(P.vorRows[i], _secOf(i)));
    const crit = { ...(P.vorCriteria || {}) };
    if (P.vorScenario && !crit.scenario) crit.scenario = P.vorScenario;
    const quiet = !!(opts && opts.quiet);
    if (!quiet) _busyOpen("Подбор расценок ШНК", `Движок разбирает ${rows.length} строк по базе ШНК`,
                          "Подбор детерминированный — результат не зависит от повторов");
    try {
      const d = await apiJson("/api/vor/match", { method: "POST", body: JSON.stringify({ rows, top_k: 5, criteria: crit }) });
      (d.results || []).forEach((res, k) => {
        const r = P.vorRows[list[k]];
        if (r) { r._m = res; r._mi = 0; r._mOp = false; }
      });
      P.vorDirty = true; vorAutoSoon();
      renderVorGrid();
      return (d.results || []).filter(r => r.candidates && r.candidates.length).length;
    } finally { if (!quiet) _busyClose(); }
  }
  async function vorMatchOne(i) {
    const r = P.vorRows[i]; if (!r) return;
    try {
      const ok = await vorMatchRows([i], { quiet: true });
      toast(ok ? "Расценка подобрана" : "Расценку подобрать не удалось — выберите из дерева", ok ? "info" : "err");
    } catch (e) { toast("Не удалось подобрать: " + (e.message || ""), "err"); }
  }

  async function vorRunMatch() {

    const done = P.vorRows.filter(r => !r._sec && r._m).length;
    const opRows = P.vorRows.filter(r => !r._sec && r._mOp).length;
    let onlyEmpty = false;
    if (done) {
      onlyEmpty = !confirm(
        `Расценки уже подобраны у ${done} строк` + (opRows ? ` (из них выбрано вручную: ${opRows})` : "") + ".\n\n" +
        "ОК — подобрать ЗАНОВО все строки (ручной выбор сохранится).\n" +
        "Отмена — подобрать только те, у которых расценки ещё нет.");
    }
    const idx = [];
    P.vorRows.forEach((r, i) => {
      if (r._sec) return;
      if (r._cmpParent) return;

      if (r._mOp) return;
      if (onlyEmpty && r._m) return;
      idx.push(i);
    });
    if (!idx.length) {
      toast(opRows ? `Нечего подбирать: всё расценено, ${opRows} строк выбрано вручную` : "Нечего подбирать", "info");
      return;
    }
    const btn = $("#vorgMatch"); btn.disabled = true; const old = btn.textContent;
    btn.textContent = "Подбираю…";
    try {
      const ok = await vorMatchRows(idx);
      toast(`Подобрано узлов: ${ok} из ${idx.length}` + (opRows ? ` · сохранён ручной выбор: ${opRows}` : ""));
    } catch (e) { toast("Не удалось подобрать: " + (e.message || ""), "err"); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  async function vorRunDisc() {
    const idxMap = [], rows = []; let curSec = "";
    P.vorRows.forEach((r, i) => {
      if (r._sec) { curSec = _clean(r) || r.name || ""; return; }
      if (!(_clean(r) || "").trim()) return;
      idxMap.push(i); rows.push({ name: _clean(r), section: curSec });
    });
    if (!rows.length) { toast("Нет строк", "err"); return; }
    vorSnapshot();
    $("#vorState").innerHTML = `<span class="vor-spin"></span> Определяю дисциплину…`;
    _busyOpen("Этап 2 · вид работ по СПДС", `ИИ размечает ${rows.length} строк`,
              "Повторно нажимать не нужно: каждый запуск — это платные обращения к ИИ");
    try {
      let n = 0;
      const STEP = 600;
      for (let off = 0; off < rows.length; off += STEP) {
        const part = rows.slice(off, off + STEP);
        const d = await apiJson("/api/vor/disciplines", { method: "POST", body: JSON.stringify({ rows: part }) });
        (d.results || []).forEach(res => { const r = P.vorRows[idxMap[off + res.i]]; if (r) { r._disc = res.disc || null; r._src = res.src || null; r._conf = res.conf || null; if (res.disc) n++; } });
      }
      renderVorGrid(); $("#vorState").textContent = "";
      toast(`Дисциплина определена: ${n}/${rows.length}`);
    } catch (e) { $("#vorState").textContent = ""; toast("Сбой: " + (e.message || ""), "err"); }
    finally { _busyClose(); }
  }

  function _resPayload(r, c) {
    return { wc: c.wc, code: c.shifr,
             objem: (c.objem != null ? c.objem : (r.qty != null ? r.qty : 0)),
             unit: (c.unit_calc || r.unit || ""), params: r._params || {},
             swaps: r._swaps || {}, qtys: r._qtys || {}, drops: r._drops || [] };
  }

  async function vorResOne(i, msg) {
    const r = P.vorRows[i]; if (!r) return;
    const c = _chosen(r); if (!c || !c.shifr || c.wc == null) return;
    try {
      const d = await apiJson("/api/vor/resources", { method: "POST", body: JSON.stringify({ rows: [_resPayload(r, c)] }) });
      const res = (d.results || [])[0];
      if (!res) { toast("Не удалось пересчитать состав", "err"); return; }
      r._res = res.res || []; r._resErr = !!res.err;
      P.vorDirty = true; vorAutoSoon();
      renderVorGrid();
      if (msg) toast(msg);
      if (res.err) toast("Сбой пересчёта состава расценки", "err");
    } catch (e) { toast("Не удалось пересчитать состав: " + (e.message || ""), "err"); }
  }

  async function vorRunResources() {
    const btn = $("#vorgRes"); if (btn) { btn.disabled = true; btn.textContent = "Загружаю…"; }
    const jobs = [];

    P.vorRows.forEach(r => {
      if (r._sec) return;
      if ((r.type || "Работа") === "Материал" && !_pirogWork(r)) return;
      const c = _chosen(r); if (c && c.shifr && c.wc != null) jobs.push({ r, c });
    });
    if (!jobs.length) { toast("Нет подобранных расценок (этап 3)", "err"); if (btn) { btn.disabled = false; btn.textContent = "📋 загрузить ресурсы"; } return; }
    try {
      const payload = jobs.map(({ r, c }) => _resPayload(r, c));
      const d = await apiJson("/api/vor/resources", { method: "POST", body: JSON.stringify({ rows: payload }) });
      let filled = 0, empty = 0;
      (d.results || []).forEach((res, k) => {
        const r = jobs[k].r; r._res = res.res || []; r._resErr = !!res.err;
        if (r._res.length) filled++; else empty++;
      });
      P.vorDirty = true;
      renderVorGrid();
      const errs = d.errors || 0;
      if (d.kb === false) toast("База расценок не подключена — ресурсы недоступны", "err");
      else toast(`Ресурсы загружены: ${filled}/${jobs.length} расценок`
        + (errs ? ` · ⚠ сбой: ${errs}` : "")
        + (empty - errs > 0 ? ` · без ресурсов в базе: ${empty - errs}` : ""),
        errs ? "err" : "info");
    } catch (e) { toast("Не удалось загрузить ресурсы: " + (e.message || ""), "err"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "📋 загрузить ресурсы"; } }
  }

  async function vorRunDecompose() {
    const jobs = [];
    P.vorRows.forEach((r, i) => { if (!r._sec && !r._cmpDone && !r._cmpChild) jobs.push({ i, r }); });
    if (!jobs.length) { toast("Нет строк для разбора", "info"); return; }
    const btn = $("#vorgDecomp"); if (btn) { btn.disabled = true; btn.textContent = "Ищу…"; }
    try {
      const rows = jobs.map(({ i, r }) => ({ i, name: _clean(r) }));
      const d = await apiJson("/api/vor/compound_preview", { method: "POST", body: JSON.stringify({ rows }) });
      const byI = {};
      (d.results || []).forEach(res => { if ((res.parts || []).length >= 2) byI[res.i] = res.parts; });
      const idxs = Object.keys(byI).map(Number).sort((a, b) => b - a);
      if (!idxs.length) { toast("Составных строк не найдено — в каждой позиции одна работа", "info"); return; }
      vorSnapshot();
      idxs.forEach(idx => {
        const par = P.vorRows[idx], parts = byI[idx];
        par._cmpDone = true; par._cmpParent = true;
        par._m = null; par._mi = 0; par._mOp = false;

        const distr = _splitParams(par._params || {}, parts);
        const kids = parts.map((p, pi) => ({
          pos: "", name: p, _clean: p, unit: par.unit || "", qty: par.qty, _params: distr[pi] || {},
          type: par.type || "Работа", disc: par.disc || "", _disc: par._disc || "",
          page: par.page, confidence: 1, _m: null, _mi: 0,
          _cmpChild: true, _cmpNo: pi + 1, _cmpOf: (par.pos || "").trim(),
          note: "разбор движка · часть " + (pi + 1) + " из " + parts.length
                + (par.pos ? " (строка ВОР № " + par.pos + ")" : ""),
        }));
        P.vorRows.splice(idx + 1, 0, ...kids);
      });
      P.vorDirty = true; vorAutoSoon();
      renderVorGrid();
      toast(`Разложено строк: ${idxs.length} · получено работ: ${idxs.reduce((s, i) => s + byI[i].length, 0)}`);
    } catch (e) { toast("Сбой разбора: " + (e.message || ""), "err"); }
    finally { const b = $("#vorgDecomp"); if (b) b.disabled = false; renderVorGrid(); }
  }

  const _s1Fresh = r => r && !r._sec && r._clean == null && !r._opOk && !r._added
    && !r._cmpParent && !r._cmpChild && !r._prop;
  async function vorStage1Apply() {
    if (!P.vorRows || !P.vorRows.length) { toast("Нет строк для раскладки", "info"); return; }
    const btn = $("#vorgStage1"); if (btn) { btn.disabled = true; btn.textContent = "Раскладываю…"; }
    try {
      const payload = P.vorRows.map(r => r._sec
        ? { _sec: true, name: _clean(r) || r.name || "" }
        : { name: r.name || "", unit: r.unit || "", qty: r.qty });
      const d = await apiJson("/api/vor/stage1", { method: "POST", body: JSON.stringify({ rows: payload, criteria: P.vorCriteria || {} }) });
      const ops = (d && d.proposals) || [];
      if (!ops.length) { toast("Движку нечего предложить — строки уже разложены или без правил", "info"); return; }
      vorSnapshot();
      let nRen = 0, nDrop = 0, nSplit = 0;
      const _note = (r, t) => { r.note = r.note ? (r.note + " · " + t) : t; };

      ops.filter(o => o.kind === "rename").forEach(o => {
        const r = P.vorRows[o.i]; if (!_s1Fresh(r)) return;
        r._clean = o.clean; r._prop = o.rule; _note(r, "предложил движок (" + o.rule + "): " + (o.why || "")); nRen++;
      });
      ops.filter(o => o.kind === "drop").forEach(o => {
        const r = P.vorRows[o.i]; if (!_s1Fresh(r)) return;
        r._prop = o.rule; _note(r, "предложил движок (" + o.rule + "): " + (o.why || "")); nDrop++;
      });

      ops.filter(o => o.kind === "split").sort((a, b) => b.i - a.i).forEach(o => {
        const par = P.vorRows[o.i]; if (!_s1Fresh(par)) return;
        par._clean = o.clean; par._prop = o.rule;
        par._cmpDone = true; par._cmpParent = true; par._m = null; par._mi = 0; par._mOp = false;
        _note(par, "предложил движок (" + o.rule + "): " + (o.why || ""));

        const distr = _splitParams(par._params || {}, (o.children || []).map(ch => ch.clean));
        const kids = (o.children || []).map((ch, pi) => ({
          pos: "", name: "", _clean: ch.clean, unit: ch.unit || par.unit || "", _unitNorm: ch.unit || undefined,
          qty: par.qty, _qty0: null, type: _autoType(ch.clean), disc: par.disc || "", _disc: par._disc || "",
          page: par.page, confidence: 1, _m: null, _mi: 0, _prop: o.rule,
          _params: ch.params || distr[pi] || {},
          _cmpChild: true, _cmpNo: pi + 1, _cmpOf: (par.pos || "").trim(),
          note: "предложил движок (" + o.rule + ") · часть " + (pi + 1) + " из " + (o.children || []).length,
        }));
        P.vorRows.splice(o.i + 1, 0, ...kids);
        nSplit++;
      });
      P.vorDirty = true; vorAutoSoon();
      renderVorGrid();
      toast(`Движок разложил: ${nSplit} пирог(ов), ${nRen} переимен., ${nDrop} огрызк(ов) → жёлтым. Проверьте и правьте — ваши правки главнее.`, "ok");
    } catch (e) { toast("Сбой раскладки: " + (e.message || ""), "err"); }
    finally { const b = $("#vorgStage1"); if (b) { b.disabled = false; } renderVorGrid(); }
  }

  function vorDecompUndo() {
    if (!P.vorRows.some(r => r._cmpChild)) return;
    vorSnapshot();
    P.vorRows = P.vorRows.filter(r => !r._cmpChild);
    P.vorRows.forEach(r => { if (r._cmpParent) { r._cmpParent = false; r._cmpDone = false; } });
    P.vorDirty = true; vorAutoSoon();
    renderVorGrid();
    toast("Разбор свёрнут — строки документа восстановлены");
  }

  async function vorAutoClean() {
    if (!P.vorRows || !P.vorRows.length) return;
    const idxMap = [], rows = [];
    P.vorRows.forEach((r, i) => { if (!(r.name || "").trim()) return; idxMap.push(i); rows.push({ name: r.name }); });
    if (!rows.length) return;
    const _sec = Math.max(40, Math.ceil(rows.length / 150) * 60);
    $("#vorState").innerHTML = `<span class="vor-spin"></span> Очищаю наименования (AI, ≈${_sec}с)…`;
    _busyOpen("Этап 1 · очистка наименований", `ИИ читает ${rows.length} строк — примерно ${_sec} секунд`,
              "Повторно нажимать не нужно: каждый запуск — это платные обращения к ИИ");
    try {
      const d = await apiJson("/api/vor/clean", { method: "POST", body: JSON.stringify({ rows }) });
      let n = 0;
      let nfb = 0;
      (d.results || []).forEach(res => {
        const r = P.vorRows[idxMap[res.i]]; if (!r || !res.clean) return;
        r._raw = r.name; r._clean = res.clean; if (!r._sec) r.type = _autoType(res.clean);
        if (res.params && Object.keys(res.params).length) r._params = res.params;
        r._fb = !!res.fb; if (res.fb && !r._sec) nfb++;
        if (res.clean !== r.name) n++;
      });
      P.vorDirty = true;
      renderVorGrid();
      $("#vorState").textContent = "";
      _noteAiFromClean(d.llm);
      if (d.llm && n) toast(`Очищено наименований: ${n}` + (nfb ? ` · ⚠ без AI: ${nfb} (🟡)` : ""));
      else if (!d.llm) toast("AI офлайн — имена очищены базово", "info");
    } catch (e) { $("#vorState").textContent = ""; }
    finally { _busyClose(); }
  }

  async function vorRunNormalize() {
    const btn = $("#vorgNorm"); btn.disabled = true; const old = btn.textContent;
    const idxMap = [], rows = [];
    let curSec = "";
    P.vorRows.forEach((r, i) => {
      if (r._sec) { curSec = r.name || ""; return; }
      idxMap.push(i); rows.push({ name: r.name || "", disc: r.disc || P.vorDisc || "", qty: r.qty, section: curSec });
    });
    if (!rows.length) { toast("Нет строк для нормализации", "err"); btn.disabled = false; return; }
    btn.textContent = `Нормализую ${rows.length}… (≈${Math.max(50, Math.ceil(rows.length / 150) * 120)}с)`;
    toast("AI-нормализация запущена — это займёт до минуты", "info");
    try {
      const d = await apiJson("/api/vor/normalize", { method: "POST", body: JSON.stringify({ rows, top_k: 5 }) });
      let normed = 0;
      (d.results || []).forEach(res => {
        const r = P.vorRows[idxMap[res.i]]; if (!r) return;
        r._norm = res.normalized || "";
        r._disc = res.disc || null;
        r._src = null; r._conf = null;
        if (res.normalized && res.normalized !== r.name) normed++;
        r._m = { disc: res.disc || "(AI)", covered: true, candidates: res.node ? [res.node] : [] };
        r._mi = 0;
      });
      P.vorDirty = true;
      renderVorGrid();
      const eng = d.llm ? "Claude" : "предочистка (LLM офлайн)";
      toast(`Нормализовано: ${normed}/${rows.length} · движок: ${eng}`);
    } catch (e) { toast("Сбой нормализации: " + (e.message || ""), "err"); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  let _autoT = null, _autoBusy = false;
  function _autoMark(txt, cls) {
    const el = $("#vorAutoState");
    if (el) { el.textContent = txt || ""; el.className = "vor-auto" + (cls ? " " + cls : ""); }
  }
  async function vorAutoSave(reason) {
    if (_autoBusy || P.vorBusy) return false;
    if (!P.vorDirty || !P.activeProject || P.vorIndex == null) return false;
    if (!P.vorRows || !P.vorRows.length) return false;
    _autoBusy = true;
    _autoMark("сохраняю…");
    try {
      await apiJson("/api/project/update_vor", { method: "POST", body: JSON.stringify({
        n: P.activeProject.n, vor_index: P.vorIndex, rows: _cleanVorRows() }) });
      P.vorDirty = false;
      const t = new Date();
      _autoMark(`✓ сохранено ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
                + (reason ? ` · ${reason}` : ""), "ok");
      return true;
    } catch (e) {
      _autoMark("⚠ не сохранилось — нажмите 💾", "err");
      return false;
    } finally { _autoBusy = false; }
  }
  function vorAutoSoon() {
    clearTimeout(_autoT);
    if (!P.vorDirty) return;
    _autoMark("есть несохранённые правки");
    _autoT = setTimeout(() => vorAutoSave(), 25000);
  }

  async function vorSaveRows() {
    const ap = P.activeProject; if (!ap) return;
    const cleaned = _cleanVorRows();
    try {
      if (P.vorIndex == null) {
        const vor = { filename: P.lastVor && P.lastVor.filename, ts: new Date().toISOString().slice(0, 19).replace("T", " "),
                      document: P.vorDoc, stats: { rows: cleaned.filter(r => !r._sec).length }, extractor: P.vorExtractor, rows: cleaned };
        const r = await apiJson("/api/project/add_vor", { method: "POST", body: JSON.stringify({ n: ap.n, vor }) });
        P.vorIndex = (r.n_vors || 1) - 1; ap.vors = ap.vors || []; ap.vors.push(vor);
        P.vorDirty = false;
        toast(`ВОР привязан к проекту (всего: ${r.n_vors})`);
      } else {
        await apiJson("/api/project/update_vor", { method: "POST", body: JSON.stringify({ n: ap.n, vor_index: P.vorIndex, rows: cleaned }) });
        P.vorDirty = false;
        toast("Правки ВОР сохранены");
      }

      const t = new Date();
      _autoMark(`✓ сохранено ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`, "ok");
    } catch (e) { toast("Не удалось сохранить ВОР", "err"); }
  }

  function wire() {
    const pill0 = $("#sbornikPill");
    if (pill0 && P.enginePill === null) P.enginePill = pill0.textContent;

    const tp = $("#tabProject"), tv = $("#tabVor"), te = $("#tabEngine");
    if (tp) tp.onclick = () => showView("project");
    if (tv) tv.onclick = () => {
      if (!wizardComplete(P.activeProject)) {
        toast("Сначала пройдите визард в «Проекте»: выберите тип → распознайте ВОР → заполните критерии объекта", "err");
        return;
      }
      showView("vor");
    };
    if (te) te.onclick = () => showView("engine");
    const tval = $("#tabValidator");
    if (tval) tval.onclick = () => showView("validator");
    updateVorTabGate();

    const lc = $("#limClose"); if (lc) lc.onclick = () => $("#limModal").classList.add("hidden");
    const lm = $("#limModal"); if (lm) lm.onclick = e => { if (e.target === lm) lm.classList.add("hidden"); };

    window.addEventListener("beforeunload", (e) => {
      let dirty = !!P.vorDirty;
      try { if (!dirty && typeof window.engineDirty === "function") dirty = window.engineDirty(); } catch (er) {}
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });

    window.__onCycleComplete = onCycleComplete;
    window.cycleActive = () => !!((P.vorRows && P.vorRows.length) || (typeof window.engineHasDraft === "function" && window.engineHasDraft()));
    const cc = $("#cycleCancelBtn"); if (cc) cc.onclick = cancelCycle;
    updateCycleUI();

    const nb = $("#projNewBtn"); if (nb) nb.onclick = newProject;

    const renderIfProject = () => { const tp = $("#tabProject"); if (tp && tp.classList.contains("active")) renderProject(); };
    const loginEl = $("#login");
    if (loginEl && !loginEl.classList.contains("hidden")) {
      const obs = new MutationObserver(() => {
        if (loginEl.classList.contains("hidden")) { obs.disconnect(); renderIfProject(); }
      });
      obs.observe(loginEl, { attributes: true, attributeFilter: ["class"] });
    } else if (S && S.token) {
      renderIfProject();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
