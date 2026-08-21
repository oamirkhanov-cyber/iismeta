"use strict";

(function () {
  const V = { card: null, autoFields: new Set(), lastRoute: null, hist: [], pendingVerdict: "",
             pendingComment: "", debTimer: null, kaskadAnswers: [], kaskadAnswersFor: null,
             kaskadAxis: {}, kaskadLeafPick: null, raskladkaOpen: false };

  function defaultCard() {
    return {
      series: { e: true, c: true }, scenario: "new", tip_objekta: null, domain: "обычное",
      etazhnost: null, seism: 8, gruppa_gruntov: null,
      flags: { bolota: false, merzlye: false, skalnye: false, ugv: false, prosadochnye: false,
               les: false, vysokogorie: null, zharko: false, pustynya: false,
               stesnennost: false, deystvuyushchee: false, ohrannye_zony: false,
               dvizhenie_transporta: false, gornaya_mestnost: false },
      vyvoz_km: null, grunt_nasypey: "mestny", project_text: "",
    };
  }

  const TIP_NO_ETAZH = ["lineyny", "seti", "blagoustroystvo"];
  const DOMAIN_NO_ETAZH = ["тоннель", "мост", "лэп", "дорожное", "магистральные_трубопроводы"];
  function computeDisabled(c) {
    const d = { etazhnost: false, merzlye: false, pustynya: false };
    if (TIP_NO_ETAZH.includes(c.tip_objekta) || DOMAIN_NO_ETAZH.includes(c.domain)) d.etazhnost = true;
    if (c.flags.vysokogorie !== "3000+") d.merzlye = true;
    if (c.flags.vysokogorie != null) d.pustynya = true;
    return d;
  }
  function applyInterlock(c) {
    const d = computeDisabled(c);
    if (d.etazhnost) c.etazhnost = null;
    if (d.merzlye) c.flags.merzlye = false;
    if (d.pustynya) c.flags.pustynya = false;
    return d;
  }

  function softWarnings(c) {
    const f = c.flags, w = [];
    const ground = ["bolota", "skalnye", "prosadochnye"].filter(k => f[k]);
    if (ground.length >= 2) w.push("необычное сочетание грунтов (" + ground.map(k => ({ bolota: "болота", skalnye: "скальные", prosadochnye: "просадочные" }[k])).join("+") + ") — в РУз бывает (Голодная степь), проверьте");
    if (f.skalnye && f.les) w.push("лес на скальном основании — необычно, проверьте");
    if (f.zharko && (c.flags.vysokogorie === "2500-3000" || c.flags.vysokogorie === "3000+")) w.push("жаркий климат на высоте 2500+ — необычно");
    return w;
  }

  function cardIsDefault(c) {
    return JSON.stringify(c) === JSON.stringify(defaultCard());
  }

  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  }
  function setPath(obj, path, val) {
    const ks = path.split(".");
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = val;
  }

  function debounce(fn, ms) {
    return function (...args) {
      clearTimeout(V.debTimer);
      V.debTimer = setTimeout(() => fn(...args), ms);
    };
  }

  function readCardFromForm() {
    const c = V.card;
    c.series.e = !!$("#valSerE")?.checked;
    c.series.c = !!$("#valSerC")?.checked;
    c.tip_objekta = $("#valTipObj")?.value || null;
    c.domain = $("#valDomain")?.value || "обычное";
    c.etazhnost = $("#valEtazh")?.value || null;
    const seism = parseInt($("#valSeism")?.value, 10);
    c.seism = Number.isFinite(seism) ? seism : null;
    const gr = parseInt($("#valGruppa")?.value, 10);
    c.gruppa_gruntov = Number.isFinite(gr) ? gr : null;
    c.flags.vysokogorie = $("#valVysokogorie")?.value || null;
    const vy = parseFloat(($("#valVyvoz")?.value || "").replace(",", "."));
    c.vyvoz_km = Number.isFinite(vy) ? vy : null;
    c.grunt_nasypey = $("#valGruntNasyp")?.value || "mestny";
    c.project_text = $("#valProjectText")?.value || "";
    document.querySelectorAll(".val-chip[data-flag]").forEach(el => {
      c.flags[el.dataset.flag] = el.classList.contains("on");
    });
  }

  function applyAuto(auto) {
    Object.entries(auto || {}).forEach(([path, val]) => {
      setPath(V.card, path, val);
      V.autoFields.add(path);
    });
  }

  function writeCardToForm() {
    const c = V.card;
    const dis = applyInterlock(c);
    if ($("#valSerE")) $("#valSerE").checked = c.series.e;
    if ($("#valSerC")) $("#valSerC").checked = c.series.c;
    if ($("#valTipObj")) $("#valTipObj").value = c.tip_objekta || "";
    if ($("#valDomain")) $("#valDomain").value = c.domain || "обычное";
    if ($("#valEtazh")) { $("#valEtazh").value = c.etazhnost || ""; $("#valEtazh").disabled = dis.etazhnost; }
    if ($("#valSeism")) $("#valSeism").value = c.seism == null ? "" : c.seism;
    if ($("#valGruppa")) $("#valGruppa").value = c.gruppa_gruntov == null ? "" : c.gruppa_gruntov;
    if ($("#valVysokogorie")) $("#valVysokogorie").value = c.flags.vysokogorie || "";
    if ($("#valVyvoz")) $("#valVyvoz").value = c.vyvoz_km == null ? "" : c.vyvoz_km;
    if ($("#valGruntNasyp")) $("#valGruntNasyp").value = c.grunt_nasypey || "mestny";
    document.querySelectorAll(".val-chip[data-flag]").forEach(el => {
      const f = el.dataset.flag;
      const off = !!dis[f];
      el.classList.toggle("on", !!c.flags[f] && !off);
      el.classList.toggle("auto", V.autoFields.has("flags." + f));
      el.classList.toggle("val-chip-off", off);
      el.title = off ? (f === "merzlye" ? "доступно только при высокогорье 3000+ (Памир)"
                        : f === "pustynya" ? "несовместимо с высокогорьем" : "недоступно") : (el.dataset.tip || el.title);
    });

    const warnEl = $("#valCardWarn");
    if (warnEl) {
      const w = softWarnings(c);
      warnEl.innerHTML = w.map(t => '<span class="val-warn-item">⚠ ' + esc(t) + '</span>').join("");
      warnEl.classList.toggle("hidden", !w.length);
    }
    const status = $("#valCardStatus");
    if (status) {
      const isDef = cardIsDefault(c);
      status.textContent = isDef ? "✓ Обычные условия — по умолчанию" : "⚠ Есть отклонения от обычных условий";
      status.classList.toggle("val-badge-ok", isDef);
      status.classList.toggle("val-badge-warn", !isDef);
    }
  }

  function resetCard() {
    V.card = defaultCard();
    V.autoFields.clear();
    writeCardToForm();
    doRoute();
  }

  async function doRoute() {
    readCardFromForm();
    const line = ($("#valLine")?.value || "").trim();

    if (V.kaskadAnswersFor && V.kaskadAnswersFor !== line) {
      V.kaskadAnswers = []; V.kaskadAxis = {}; V.kaskadLeafPick = null; V.kaskadAnswersFor = null;
    }
    const body = { line, unit: $("#valUnit")?.value || "", qty: $("#valQty")?.value || "",
                   title: $("#valTitle")?.value || "", card: V.card,
                   kaskad_answers: V.kaskadAnswers, kaskad_axis_answers: V.kaskadAxis,
                   kaskad_leaf_pick: V.kaskadLeafPick || "" };
    if (!line) { renderEmpty(); return; }
    let r;
    try {
      r = await (await api("/api/validator/route", { method: "POST", body: JSON.stringify(body) })).json();
    } catch (e) { toast("Валидатор: " + e.message, "err"); return; }
    V.lastRoute = r;
    if (r.card_auto && Object.keys(r.card_auto).length) applyAuto(r.card_auto);
    writeCardToForm();
    renderRoute(r);
    renderTrace(r.trace || []);
    pushHist(body, r);
    if (V.raskladkaOpen) renderRaskladka();
  }
  const doRouteDebounced = debounce(doRoute, 500);

  function renderEmpty() {
    const rb = $("#valRouteBody"); if (rb) rb.innerHTML = '<div class="val-empty">Начни печатать строку слева.</div>';
    const tr = $("#valTrace"); if (tr) tr.innerHTML = "";
    V.lastRoute = null;
  }

  function pushHist(body, r) {
    const code = r.position && r.position.code;
    const entry = { line: body.line, code: code || null, ok: !!code };

    const prev = V.hist[0];
    if (prev && (entry.line.startsWith(prev.line) || prev.line.startsWith(entry.line))) V.hist[0] = entry;
    else V.hist.unshift(entry);
    V.hist = V.hist.slice(0, 8);
    const el = $("#valHist"); if (!el) return;
    el.innerHTML = '<label style="margin:0;display:block;">Сессия · ' + V.hist.length + ' строк' + (V.hist.length===1?"а":"") + '</label>' +
      V.hist.map((h, i) => '<div class="' + (i === 0 ? "val-hist-cur" : "") + '">· ' + esc(h.line) +
        '<span class="val-hist-v" style="' + (h.ok ? "color:var(--ok)" : "color:var(--warn)") + '">' +
        (h.ok ? "✓" : "?") + '</span></div>').join("");
  }

  const TYPE_LABEL = { материал: "материал", замена_бетона: "замена бетона", поглощение: "поглощение",
                       спутник: "спутник", добавочная: "добавочная", "спутник-раздела": "спутник раздела",
                       кандидаты_работы: "кандидаты" };

  function renderKaskad(k) {
    if (!k || k["недоступен"]) return "";
    const itog = k["итог"] || "";
    const stop = itog.indexOf("СТОП") === 0;
    const stages = [["С0", k["С0_паспорт"]], ["С1", k["С1_раздел"]],
                    ["С2", k["С2_работа"]], ["С3·С4", k["С3_оси_С4_лист"]], ["С5", k["С5_куст"]]];
    let h = '<div class="val-kaskad"><label class="val-col-label">Сквозной каскад С0–С5 ' +
      '<span class="muted">(экспериментальный стенд)</span></label><div class="val-kchips">';
    stages.forEach(([id, st]) => {
      let cls = "kc-skip", mark = "·";
      if (st && !Array.isArray(st) && st["вопрос"]) { cls = "kc-q"; mark = "❓"; }
      else if (st && (Array.isArray(st) ? st.length : true)) { cls = "kc-ok"; mark = "✓"; }
      h += '<span class="val-kchip ' + cls + '">' + id + ' ' + mark + '</span>';
    });
    h += '</div>';

    const qStage = k["С1_раздел"] && k["С1_раздел"]["вопрос"] ? k["С1_раздел"]
      : (k["С2_работа"] && k["С2_работа"]["вопрос"] ? k["С2_работа"] : null);
    if (qStage) {
      h += '<div class="val-kq">❓ ' + esc(qStage["вопрос"]) + '</div>' +
        '<div><button class="btn btn-primary val-rask-open" id="valRaskOpen">🧩 Открыть раскладку</button></div>';
    }

    const s34 = k["С3_оси_С4_лист"];
    if (s34) {
      const leaf = s34["лист"];
      const codes = leaf && leaf["шортлист"] ? leaf["шортлист"] : (typeof leaf === "string" ? [leaf] : []);
      const sb = codes.length ? String(codes[0]).replace(/^[ЕЦУ]/, "").slice(0, 2) : null;
      const leafTxt = leaf && leaf["шортлист"] ? "шортлист: " + leaf["шортлист"].join(", ") : (leaf || "—");
      const lname = s34["лист_имя"] ? ' · ' + String(s34["лист_имя"]) : "";
      h += '<div class="val-kleaf">' + (sb ? '<span class="val-badge val-badge-ok">✓ сборник ' + esc(sb) + '</span> ' : "") +
        'лист главной: <b>' + esc(String(leafTxt)) + '</b>' + '<span class="muted">' + esc(lname) + '</span>';
      const g = s34["гейт_ед"];
      if (g) h += ' <span class="val-badge ' + (g["вердикт"] === "ok" ? "val-badge-ok" : "val-badge-warn") +
        '">ед.изм ' + esc(g["ед_ВОР"] || "") + ' vs ' + esc(g["измеритель_нормы"] || "") + ': ' + esc(g["вердикт"]) + '</span>';
      h += '</div>';
    }
    if (V.kaskadAnswers.length) h += '<div class="val-kanswered">ответы раскладки: ' +
      V.kaskadAnswers.map(a => '«' + esc(a) + '»').join(", ") +
      ' <button class="val-klink" id="valRaskReopen">🧩 изменить</button>' +
      ' <button class="val-klink" data-kans="__reset">↺ сбросить</button></div>';

    const kust = k["С5_куст"];
    if (Array.isArray(kust) && kust.length) {
      const inSmeta = kust.filter(s => s["статус"] === "в смету");
      h += '<div class="val-kkust">куст: ' + inSmeta.length + ' поз. в смету' +
        (kust.length > inSmeta.length ? ' · ' + (kust.length - inSmeta.length) + ' не включено' : '') + '</div>';
    }
    h += '<div class="val-kitog ' + (stop ? "kc-q" : "kc-ok") + '">' + esc(itog) + '</div></div>';
    return h;
  }

  function renderRoute(r) {
    const rb = $("#valRouteBody"); if (!rb) return;
    if (r.empty) { rb.innerHTML = '<div class="val-empty">Начни печатать строку слева.</div>'; return; }
    const pos = r.position || {};
    const bc = r.breadcrumb;
    const owns = !!r.kaskad_owns;
    let html = "";
    if (owns) {

    } else if (bc) {
      html += '<div class="val-crumbs">' +
        '<span class="val-crumb">Сб. ' + esc(bc.sbornik.n) + ' · ' + esc(bc.sbornik.name || "") + '</span>' +
        '<span class="val-arrow">→</span>' +
        '<span class="val-crumb">' + esc(bc.table.shnk) + ' · ' + esc(bc.table.name || "") + '</span>' +
        '<span class="val-arrow">→</span>' +
        '<span class="val-crumb val-crumb-hit">' + esc(bc.norm.code) + '</span></div>';
      html += '<div class="val-normname">' + esc(bc.norm.name || "") + ' · измеритель ' + esc(bc.norm.unit || "") + '</div>';
    } else if (pos.code) {
      html += '<div class="val-crumbs"><span class="val-crumb val-crumb-hit">' + esc(pos.code) + '</span></div>';
    } else {
      const why = pos.ask || (pos.work_candidates ? "неоднозначно — см. кандидатов ниже" : "маршрут не определён");
      html += '<div class="val-empty">? ' + esc(why) + '</div>';
    }

    if (r.c_route) {
      const c = r.c_route;
      html += '<div class="val-croute"><span class="val-badge val-badge-c">Ц · монтаж оборуд.' +
        (c.low_conf ? ' · низкая уверенность' : '') + '</span>' +
        '<span class="val-crumb val-crumb-hit">' + esc(c.code) + '</span> ' +
        '<span class="muted">сб.' + esc(c.sbornik) + ' · ' + esc(c.name || "") +
        (c.unit ? ' · ' + esc(c.unit) : '') + '</span></div>';
    }

    if ((r.smeta_out || []).length) {
      html += '<div class="val-smout"><div class="val-smout-title">→ Позиции в смету (' + r.smeta_out.length + ')</div>';
      r.smeta_out.forEach(p => {
        const kcls = p.kind === "главная" ? "sm-main" : (p.kind === "замена бетона" || p.kind === "материал") ? "sm-mat" : "sm-dop";
        html += '<div class="val-smout-row"><span class="val-smout-n">' + p.n + '</span>' +
          '<span class="val-smout-code ' + kcls + '">' + esc(p.code) + '</span>' +
          '<span class="val-smout-name">' + esc(p.name || "") + '</span>' +
          (p.unit ? '<span class="val-smout-unit">' + esc(p.unit) + '</span>' : '') +
          '<span class="val-smout-kind">' + esc(p.kind) + (p.note ? ' · ' + esc(p.note) : '') + '</span></div>';
      });
      html += '</div>';
    }

    if (r.kaskad_muted) {
      html += '<div class="val-kmuted">каскад: строку ведёт основной подбор (атомарная работа) — раскладка не требуется</div>';
    } else if (r.kaskad) {
      html += renderKaskad(r.kaskad);
    }
    if (!owns) (r.extras || []).forEach(ex => {
      const label = TYPE_LABEL[ex.type] || ex.type || "?";
      if (ex.candidates) {
        html += '<div class="val-dop"><span class="val-badge val-badge-warn">' + esc(label) + '</span><span>' +
          (ex.candidates.length) + ' кандидатов: ' +
          ex.candidates.map(c => esc(c.res_code || c.shnk || "")).join(", ") + '</span></div>';
      } else if (ex.why && !ex.code) {
        html += '<div class="val-dop"><span class="val-badge val-badge-mut">' + esc(label) + '</span><span>' + esc(ex.why) + '</span></div>';
      } else {
        html += '<div class="val-dop"><span class="val-badge val-badge-ok">' + esc(label) + '</span><span>' +
          esc(ex.code || "") + (ex.name ? " · " + esc(String(ex.name)) : "") +
          (ex.k != null ? " · k=" + esc(ex.k) : "") + (ex.host ? " · хозяин " + esc(ex.host) : "") + '</span></div>';
      }
    });
    if (!owns && pos.ask) {
      html += '<div class="val-dop"><span class="val-badge val-badge-mut">гейт</span><span class="muted">' + esc(pos.ask) + '</span></div>';
    }
    if (owns && !(r.corrections_hint || []).length) {

      html += '<div class="val-corr"><label class="val-col-label">Поправки техчасти</label>' +
        '<div class="val-corr-row muted">для обычных условий поправок нет — норма берётся как есть</div></div>';
    }
    if ((r.corrections_hint || []).length) {
      const hints = r.corrections_hint;
      const live = hints.filter(h => h.available);
      const hidden = hints.filter(h => !h.available);
      const nAct = live.filter(h => h.active).length;
      html += '<div class="val-corr"><label class="val-col-label">Поправки техчасти (' + hints.length +
        (nAct ? ' · активна ' + nAct : '') + (hidden.length ? ' · вне домена ' + hidden.length : '') + ')</label>';
      live.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)).forEach(h => {
        const km = Object.keys(h.k || {}).length ? ' <span class="muted">(' +
          Object.entries(h.k).map(([k, v]) => k + "=" + v).join(", ") + ')</span>' : "";
        const man = (h.manual || []).length ? ' <span class="val-corr-manual">уточнить: ' + h.manual.map(esc).join(", ") + '</span>' : "";
        html += '<div class="val-corr-row' + (h.active ? " val-corr-active" : "") + '"><b>' + esc(h.p_code) + '</b> ' +
          esc(h.text) + km + man + '</div>';
      });
      if (hidden.length) {
        const byDom = {};
        hidden.forEach(h => { byDom[h.domain_label || h.domain] = (byDom[h.domain_label || h.domain] || 0) + 1; });
        Object.entries(byDom).forEach(([lab, n]) => {
          html += '<div class="val-corr-cutline">🔒 доступны при домене «' + esc(lab) + '»: ' + n + ' шт (переключи домен стройки)</div>';
        });
      }
      html += "</div>";
    }
    if ((r.techchasti_ops || []).length) {
      const ops = r.techchasti_ops;
      const OP_LABEL = {
        "norm.redirect": "🔀 другой сборник", "norm.gate": "🧭 выбор нормы",
        "res.add": "➕ ресурс", "res.drop": "➖ ресурс", "res.scale": "× ресурс",
        "res.replace": "⇄ ресурс"
      };
      html += '<div class="val-corr"><label class="val-col-label">Техчасть · наработки (' + ops.length + ')</label>';
      ops.forEach(op => {
        html += '<div class="val-corr-row"><b>' + esc(OP_LABEL[op.op] || op.op) + '</b> ' +
          esc(op.citation || "") + ' <span class="muted">(' + esc(op.source || "") + ')</span></div>';
      });
      html += "</div>";
    }
    html += '<div class="val-verdicts">' +
      '<span class="val-vbtn val-vbtn-ok' + (V.pendingVerdict === "ok" ? " selected" : "") + '" data-v="ok">✓ Верно</span>' +
      '<span class="val-vbtn val-vbtn-no' + (V.pendingVerdict === "no" ? " selected" : "") + '" data-v="no">✗ Неверно</span>' +
      '<span class="val-vbtn val-vbtn-q' + (V.pendingVerdict === "question" ? " selected" : "") + '" data-v="question">? Вопрос</span></div>';
    html += '<textarea id="valComment" class="val-textarea val-comment" rows="2" placeholder="Комментарий к строке…">' +
      esc(V.pendingComment) + '</textarea>';
    html += '<button class="btn btn-primary val-save-btn" id="valSaveBtn">Записать в журнал</button>';
    rb.innerHTML = html;

    rb.querySelectorAll(".val-vbtn").forEach(b => b.onclick = () => {
      V.pendingVerdict = b.dataset.v;
      rb.querySelectorAll(".val-vbtn").forEach(x => x.classList.remove("selected"));
      b.classList.add("selected");
    });
    const cm = $("#valComment");
    if (cm) cm.oninput = () => { V.pendingComment = cm.value; };
    const sv = $("#valSaveBtn");
    if (sv) sv.onclick = saveToLog;

    const ro = $("#valRaskOpen"), rr = $("#valRaskReopen");
    if (ro) ro.onclick = openRaskladka;
    if (rr) rr.onclick = openRaskladka;
    rb.querySelectorAll("[data-kans]").forEach(b => b.onclick = () => {
      if (b.dataset.kans === "__reset") resetRask();
    });
  }

  function openRaskladka() {
    V.raskladkaOpen = true;
    let m = $("#raskModal");
    if (!m) {
      m = document.createElement("div");
      m.id = "raskModal"; m.className = "modal hidden";
      m.innerHTML = '<div class="modal-card rask-card"><div class="modal-head">' +
        '<div><h2>🧩 Раскладка строки</h2><div class="muted" id="raskSub"></div></div>' +
        '<div class="modal-actions">' +
        '<button id="raskReset" class="btn btn-ghost">↺ Сброс</button>' +
        '<button id="raskClose" class="btn btn-icon">✕</button></div></div>' +
        '<div id="raskBody" class="modal-body rask-body"></div>' +
        '<div class="rask-foot"><button id="raskApply" class="btn btn-primary">Применить и закрыть</button>' +
        '<span class="muted">выбирай ответы сверху вниз — каскад достроится сам</span></div></div>';
      document.body.appendChild(m);
      $("#raskClose").onclick = closeRaskladka;
      $("#raskApply").onclick = closeRaskladka;
      m.onclick = (e) => { if (e.target === m) closeRaskladka(); };
      $("#raskReset").onclick = resetRask;
    }
    m.classList.remove("hidden");
    renderRaskladka();
  }

  function closeRaskladka() {
    V.raskladkaOpen = false;
    const m = $("#raskModal"); if (m) m.classList.add("hidden");
  }

  function resetRask() {
    V.kaskadAnswers = []; V.kaskadAxis = {}; V.kaskadLeafPick = null; V.kaskadAnswersFor = null;
    doRoute();
  }

  function pickRask(ans, siblings) {
    const line = ($("#valLine")?.value || "").trim();
    if (V.kaskadAnswersFor !== line) { V.kaskadAnswers = []; V.kaskadAxis = {}; V.kaskadLeafPick = null; }
    V.kaskadAnswers = V.kaskadAnswers.filter(a => !(siblings || []).includes(a));
    V.kaskadAnswers.push(ans);
    V.kaskadAnswersFor = line;
    doRoute();
  }

  function pickAxis(qid, label) {
    V.kaskadAxis[qid] = label; V.kaskadLeafPick = null;
    V.kaskadAnswersFor = ($("#valLine")?.value || "").trim();
    doRoute();
  }

  function pickLeaf(code) {
    V.kaskadLeafPick = code;
    V.kaskadAnswersFor = ($("#valLine")?.value || "").trim();
    doRoute();
  }

  function renderRaskladka() {
    const host = $("#raskBody"); if (!host) return;
    const k = (V.lastRoute || {}).kaskad;
    const sub = $("#raskSub"); if (sub) sub.textContent = ($("#valLine")?.value || "");
    if (!k || k["недоступен"]) { host.innerHTML = '<div class="val-empty">Каскад недоступен для этой строки (нужен раздел ВОРа).</div>'; return; }
    V._raskGroups = [];
    const step = (title, q, opts) => {
      const gi = V._raskGroups.length; V._raskGroups.push(opts);
      return '<div class="rask-q"><div class="rask-qt">' + esc(title) + '</div>' +
        '<div class="rask-qq">❓ ' + esc(q) + '</div><div class="rask-opts">' +
        (opts || []).map(o => '<button class="rask-opt' + (V.kaskadAnswers.includes(o) ? " on" : "") +
          '" data-ra="' + esc(String(o)) + '" data-g="' + gi + '">' + esc(String(o)) + '</button>').join("") +
        '</div></div>';
    };
    const done = (title, txt) => '<div class="rask-q rask-ok"><div class="rask-qt">✓ ' + esc(title) +
      '</div><div class="rask-done">' + esc(txt) + '</div></div>';
    const wait = (title, txt) => '<div class="rask-q rask-wait"><div class="rask-qt">' + esc(title) +
      '</div><div class="muted">' + esc(txt) + '</div></div>';
    let h = "";
    const c1 = k["С1_раздел"] || {};
    if (c1["вопрос"]) h += step("1 · Дисциплина раздела", c1["вопрос"], c1["варианты"] || []);
    else h += done("1 · Дисциплина раздела", (c1["дисциплина"] || "") + " → сборники " + (c1["sbs"] || []).join(", "));
    const c2 = k["С2_работа"] || {};
    if (c1["вопрос"]) h += wait("2 · Что за работа", "сначала выберите дисциплину выше");
    else if (c2["вопрос"]) h += step("2 · Что за работа", c2["вопрос"], c2["варианты"] || []);
    else h += done("2 · Что за работа", (c2["элемент"] || "") + " · " + (c2["закрыто"] || ""));
    const s34 = k["С3_оси_С4_лист"];
    const resolved = s34 && !c1["вопрос"] && !c2["вопрос"];

    if (resolved && (s34["оси_вопросы"] || []).length) {
      h += '<div class="rask-q"><div class="rask-qt">3 · Параметры (уточняют норму/куст)</div>';
      (s34["оси_вопросы"] || []).forEach(q => {
        h += '<div class="rask-axis"><div class="rask-axq">' + (q.is_inc ? "➕ " : "") + esc(q.question) + '</div>' +
          '<div class="rask-opts">' + (q["опции"] || []).map(o =>
            '<button class="rask-opt rask-opt-sm' + (q["выбран"] === o ? " on" : "") +
            '" data-ax="' + esc(q.q_id) + '" data-axl="' + esc(o) + '">' + esc(String(o)) + '</button>').join("") +
          '</div></div>';
      });
      h += '</div>';
    }

    if (resolved) {
      const leaf = s34["лист"];
      const shortlist = leaf && leaf["шортлист"] ? leaf["шортлист"] : null;
      const codes = shortlist || (typeof leaf === "string" ? [leaf] : []);
      const sb = codes.length ? String(codes[0]).replace(/^[ЕЦУ]/, "").slice(0, 2) : "?";
      const g = s34["гейт_ед"];
      const kust = k["С5_куст"] || []; const ins = kust.filter(s => s["статус"] === "в смету").length;
      h += '<div class="rask-res"><div class="rask-rt">Подобрано: сборник ' + esc(sb) + '</div>';
      if (shortlist) {
        h += '<div class="rask-rb">оси не делят близнецов — выбери код:</div><div class="rask-opts">' +
          shortlist.map(c => '<button class="rask-opt" data-leaf="' + esc(c) + '">' + esc(c) + '</button>').join("") + '</div>';
      } else {
        h += '<div class="rask-rb">лист: ' + esc(String(leaf || "—")) +
          (s34["лист_имя"] ? ' <span class="muted">· ' + esc(String(s34["лист_имя"])) + '</span>' : "") + '</div>';
      }
      h += (g ? '<div class="rask-gate ' + (g["вердикт"] === "ok" ? "ok" : "warn") + '">ед.изм ' + esc(g["ед_ВОР"] || "") +
          ' vs ' + esc(g["измеритель_нормы"] || "") + ': ' + esc(g["вердикт"]) + '</div>' : '') +
        '<div class="muted">куст: ' + ins + ' поз. в смету' + (kust.length > ins ? ' · ' + (kust.length - ins) + ' не включено' : '') + '</div></div>';
    }
    host.innerHTML = h;
    host.querySelectorAll("[data-ra]").forEach(b => b.onclick = () => pickRask(b.dataset.ra, V._raskGroups[+b.dataset.g] || []));
    host.querySelectorAll("[data-ax]").forEach(b => b.onclick = () => pickAxis(b.dataset.ax, b.dataset.axl));
    host.querySelectorAll("[data-leaf]").forEach(b => b.onclick = () => pickLeaf(b.dataset.leaf));
  }

  async function saveToLog() {
    if (!V.pendingVerdict) { toast("Сначала выбери вердикт: верно/неверно/вопрос", "err"); return; }
    const line = $("#valLine")?.value || "";
    try {
      await api("/api/validator/log", { method: "POST", body: JSON.stringify({
        line, title: $("#valTitle")?.value || "", unit: $("#valUnit")?.value || "",
        qty: $("#valQty")?.value || "", route: V.lastRoute, verdict: V.pendingVerdict,
        comment: V.pendingComment }) });
      toast("Записано в журнал");
      V.pendingVerdict = ""; V.pendingComment = "";
      renderRoute(V.lastRoute);
      loadLog();
    } catch (e) { toast("Не удалось записать: " + e.message, "err"); }
  }

  function renderTrace(trace) {
    const el = $("#valTrace"); if (!el) return;
    if (!trace.length) { el.innerHTML = ""; return; }
    el.innerHTML = trace.map((t, i) => {
      const cls = t.status === "warn" ? "val-step-warn" : t.status === "skip" ? "val-step-skip" : "";
      const arrow = i < trace.length - 1 ? '<div class="val-sarr">→</div>' : "";
      return '<div class="val-step ' + cls + '"><div class="val-step-n">' + (i) + ' · ' + esc(t.step) + '</div>' +
        '<div class="val-step-f">' + esc(t.file) + '<br>' + esc(t.fn) + '</div>' +
        '<div class="val-step-r">' + esc(t.result) + '</div></div>' + arrow;
    }).join("");
  }

  async function loadLog() {
    const el = $("#valLogBody"); if (!el) return;
    let d;
    try { d = await (await api("/api/validator/log")).json(); }
    catch (e) { el.innerHTML = '<div class="val-empty">Журнал недоступен: ' + esc(e.message) + '</div>'; return; }
    const rows = d.rows || [];
    if (!rows.length) { el.innerHTML = '<div class="val-log-row val-log-ghost">Журнал пуст — запиши первую строку слева.</div>'; return; }
    const vIcon = { ok: '<span style="color:var(--ok)">✓</span>', no: '<span style="color:#f87171">✗</span>',
                   question: '<span style="color:var(--warn)">?</span>' };
    el.innerHTML = rows.map(r => {
      const code = r.route && r.route.position && r.route.position.code;
      return '<div class="val-log-row" data-id="' + r.id + '">' +
        '<div class="val-log-t">' + (vIcon[r.verdict] || "") + '<span class="val-log-nm">' + esc(r.line) + '</span></div>' +
        '<div class="val-log-m">' + esc(code || "—") + ' · ' + esc(r.ts) + '</div>' +
        '<textarea class="val-textarea val-log-comment" rows="1" data-id="' + r.id + '">' + esc(r.comment || "") + '</textarea></div>';
    }).join("");
    el.querySelectorAll(".val-log-comment").forEach(ta => {
      ta.onblur = async () => {
        try { await api("/api/validator/comment", { method: "POST",
          body: JSON.stringify({ id: +ta.dataset.id, comment: ta.value }) }); }
        catch (e) { toast("Не сохранено: " + e.message, "err"); }
      };
    });
  }

  async function exportCsv() {
    try {
      const r = await api("/api/validator/export");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "validator_log.csv"; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } catch (e) { toast("Экспорт не удался: " + e.message, "err"); }
  }

  function wireChips() {
    document.querySelectorAll("#validatorView .val-chip[data-flag]").forEach(el => {
      el.onclick = (e) => {
        if (e.target.tagName === "INPUT") return;
        if (el.classList.contains("val-chip-off")) return;
        el.classList.toggle("on");
        V.autoFields.delete("flags." + el.dataset.flag);
        doRoute();
      };
    });
    ["valSerE", "valSerC", "valTipObj", "valDomain", "valEtazh", "valVysokogorie", "valGruntNasyp"].forEach(id => {
      const el = $("#" + id); if (el) el.onchange = doRoute;
    });
    ["valSeism", "valGruppa", "valVyvoz"].forEach(id => {
      const el = $("#" + id); if (el) el.oninput = doRouteDebounced;
    });
    ["valLine", "valTitle", "valUnit", "valQty", "valProjectText"].forEach(id => {
      const el = $("#" + id); if (el) el.addEventListener("input", doRouteDebounced);
    });
    const rb = $("#valResetBtn"); if (rb) rb.onclick = resetCard;
    const eb = $("#valExportBtn"); if (eb) eb.onclick = exportCsv;
    const ct = $("#valCardToggle");
    if (ct) ct.onclick = () => {
      const panel = document.querySelector(".val-card-panel");
      const collapsed = panel.classList.toggle("val-card-collapsed");
      ct.textContent = collapsed ? "▸ развернуть" : "▾ свернуть";
    };
  }

  function wire() {
    if (!$("#validatorView")) return;
    V.card = defaultCard();
    writeCardToForm();
    wireChips();
    const tv = $("#tabValidator");
    if (tv) tv.addEventListener("click", () => { if (!V._loadedOnce) { V._loadedOnce = true; loadLog(); } });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
