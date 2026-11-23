/* 宿舍补给计划 · 引擎
   数据来自 data.js（window.SUPPLY_DATA），本文件只管算和画。
   一个逻辑文件服务 5 个页面：按 body[data-page] 决定渲染哪块。 */
(function () {
  "use strict";

  var DATA = window.SUPPLY_DATA || { items: [], settings: {}, milestones: [] };
  var S = Object.assign({ safetyDays: 7, freeShip: 59, mergeWindow: 10, protectDays: 30 },
                        DATA.settings || {});
  var PAGE = (document.body && document.body.getAttribute("data-page")) || "index";

  /* ---------------- 日期 ---------------- */
  var NOW = new Date();
  var TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
           "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseD(s) { return new Date(s + "T00:00:00"); }
  function addD(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function diffD(a, b) { return Math.round((b - a) / 86400000); }
  function md(s) { return String(s).slice(5); }
  function money(n) { return "¥" + (Math.round(n * 100) / 100).toFixed(2); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------------- 本地存储 ---------------- */
  var LS = { extra: "supply_extra_prices_v1", ovr: "supply_overrides_v1",
             log: "supply_log_v1", items: "supply_custom_items_v1" };
  function load(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; }
    catch (e) { return dflt; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var EXTRA = load(LS.extra, {});
  var OVR = load(LS.ovr, {});
  var LOG = load(LS.log, []);
  var CUSTOM = load(LS.items, []);

  function applyOverrides() {
    DATA.items.forEach(function (it) {
      var o = OVR[it.cat];
      if (!o) return;
      if (typeof o.stock === "number") it.stock = o.stock;
      if (typeof o.rate === "number") it.rate = o.rate;
    });
  }
  function applyCustom() {
    CUSTOM.forEach(function (it) {
      if (!it || !it.cat) return;
      if (DATA.items.some(function (x) { return x.cat === it.cat; })) return;
      var o = Object.assign({}, it, {
        offers: (it.offers || []).slice(), hist: (it.hist || []).slice()
      });
      var ov = OVR[o.cat];
      if (ov) {
        if (typeof ov.stock === "number") o.stock = ov.stock;
        if (typeof ov.rate === "number") o.rate = ov.rate;
      }
      DATA.items.push(o);
    });
  }
  applyOverrides();
  applyCustom();

  /* ---------------- 状态 ---------------- */
  var ST = { safety: S.safetyDays, merge: S.mergeWindow, range: 90 };

  /* ---------------- 计算 ---------------- */
  function calcItem(it, safety) {
    var perDay = it.rate / 30;
    var pFast = (it.rateFast || it.rate) / 30;
    var pSlow = (it.rateSlow || it.rate) / 30;
    var dLeft = perDay > 0 ? it.stock / perDay : 1e9;
    var best = (it.offers && it.offers[0]) || null;
    var per100 = best ? best.price / best.total * 100 : null;
    var cover = best && perDay > 0 ? best.total / perDay : 1e9;
    var restockIn = dLeft - safety;
    return Object.assign({}, it, {
      dLeft: dLeft, best: best, per100: per100, cover: cover,
      runout: addD(TODAY, Math.round(Math.min(dLeft, 9999))),
      early: addD(TODAY, Math.round(Math.min(pFast > 0 ? it.stock / pFast : 9999, 9999))),
      late: addD(TODAY, Math.round(Math.min(pSlow > 0 ? it.stock / pSlow : 9999, 9999))),
      restock: addD(TODAY, Math.max(0, Math.round(restockIn))),
      urgent: restockIn <= 0
    });
  }

  function groupOrders(items) {
    var list = items.filter(function (i) { return i.best; })
                    .sort(function (a, b) { return a.restock - b.restock; });
    var orders = [];
    list.forEach(function (it) {
      var hit = null;
      for (var i = 0; i < orders.length; i++) {
        if (Math.abs(diffD(orders[i].date, it.restock)) <= ST.merge) { hit = orders[i]; break; }
      }
      if (hit) { hit.items.push(it); if (it.restock < hit.date) hit.date = it.restock; }
      else orders.push({ date: it.restock, items: [it] });
    });
    orders.sort(function (a, b) { return a.date - b.date; });
    orders.forEach(function (o) {
      o.total = o.items.reduce(function (s, i) { return s + i.best.price; }, 0);
      o.protectUntil = addD(o.date, S.protectDays);
      o.ms = DATA.milestones.filter(function (m) {
        var d = parseD(m.d);
        return d > o.date && d <= o.protectUntil;
      })[0] || null;
    });
    return orders;
  }

  function mergeHint(orders, idx) {
    var o = orders[idx], need = S.freeShip - o.total;
    if (need <= 0) return null;
    for (var j = idx - 1; j >= 0; j--) {
      var span = diffD(orders[j].date, o.date), merged = o.total + orders[j].total;
      if (span <= 60 && merged >= S.freeShip)
        return { type: "back", target: orders[j], span: span, merged: merged };
    }
    if (idx + 1 < orders.length) {
      var n = orders[idx + 1], sp2 = diffD(o.date, n.date), mg = o.total + n.total;
      if (sp2 <= 60 && mg >= S.freeShip)
        return { type: "fwd", target: n, span: sp2, merged: mg };
    }
    var best = null;
    for (var k = idx + 1; k < orders.length; k++) {
      orders[k].items.forEach(function (it) {
        var p = it.best.price;
        if (p >= need && (!best || p - need < best.over))
          best = { type: "item", it: it, date: orders[k].date, over: p - need };
      });
    }
    return best;
  }

  /* ---------------- 小工具 ---------------- */
  function set(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
  function txt(id, t) { var el = document.getElementById(id); if (el) el.textContent = t; }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.classList.add("on");
    setTimeout(function () { t.classList.remove("on"); }, 1800);
  }

  /* ---------------- 渲染 ---------------- */
  function renderHeader(items) {
    var soon = items.filter(function (i) { return i.dLeft <= 15; });
    var monthly = items.reduce(function (s, i) {
      return s + (i.best ? i.best.price / (i.cover / 30) : 0);
    }, 0);
    var lastT = 0;
    DATA.items.forEach(function (i) {
      (i.hist || []).forEach(function (x) {
        var t = parseD(x.d).getTime(); if (t > lastT) lastT = t;
      });
    });
    var stale = lastT ? diffD(new Date(lastT), TODAY) : null;
    txt("sub", "今天是 " + iso(TODAY) + " · " + items.length + " 个品类 · 数据会自动存本机");
    set("head-chips",
      '<span class="chip">' + (soon.length ? "⚠ " + soon.length + " 项快用完" : "✓ 暂无紧急") + "</span>" +
      '<span class="chip g">年支出 ' + money(monthly * 12) + "</span>" +
      '<span class="chip' + (stale != null && stale > 14 ? " w" : "") + '">' +
      (stale == null ? "无价格记录" : "价格 " + stale + " 天前") + "</span>");
  }

  function renderAlerts(items) {
    var soon = items.filter(function (i) { return i.dLeft <= 15; })
                    .sort(function (a, b) { return a.dLeft - b.dLeft; });
    txt("alert-n", soon.length);
    var empty = document.getElementById("alert-empty");
    if (empty) empty.style.display = soon.length ? "none" : "block";
    set("alerts", soon.map(function (i) {
      return '<div class="alarm"><div class="d">' + esc(i.cat) + "</div>" +
        '<div class="n">' + esc(iso(i.runout)) + " 用完 · 剩 " +
        Math.max(0, Math.round(i.dLeft)) + " 天</div>" +
        '<div class="left">建议 ' + esc(md(iso(i.restock))) + " 下单</div></div>";
    }).join(""));
  }

  function orderRows(o) {
    return o.items.map(function (i) {
      return "<tr><td>" + esc(i.cat) + '</td><td class="muted">' + esc(i.best.spec) +
        '</td><td class="num">' + money(i.best.price) + "</td></tr>";
    }).join("");
  }

  function renderNext(orders) {
    var nx = orders[0];
    if (!nx) { set("next", '<div class="sub">暂时不需要买。</div>'); return; }
    var free = nx.total >= S.freeShip;
    var hint = free ? null : mergeHint(orders, 0);
    var hintHtml = "";
    if (hint) {
      if (hint.type === "back")
        hintHtml = "把这一单提前 " + hint.span + " 天并到 " + iso(hint.target.date) +
                   " → 合计 " + money(hint.merged) + "，免运费";
      else if (hint.type === "fwd")
        hintHtml = "把 " + iso(hint.target.date) + " 那单提前过来 → 合计 " +
                   money(hint.merged) + "，两单都免运费";
      else
        hintHtml = "把「" + esc(hint.it.cat) + "」(" + money(hint.it.best.price) +
                   ") 提前 → 合计 " + money(nx.total + hint.it.best.price) + "，免运费";
    }
    set("next",
      '<div class="row" style="justify-content:space-between">' +
        "<div><b style=\"font-size:19px\">" + iso(nx.date) + "</b> " +
        '<span class="sub">（' + diffD(TODAY, nx.date) + " 天后）</span></div>" +
        "<div><b style=\"font-size:19px\">" + money(nx.total) + "</b> " +
        '<span class="tag ' + (free ? "ok" : "bad") + '">' +
        (free ? "免运费" : "差 " + money(S.freeShip - nx.total)) + "</span></div></div>" +
      '<table style="margin-top:8px"><tbody>' + orderRows(nx) + "</tbody></table>" +
      '<div class="sub" style="margin-top:8px">价保到 ' + iso(nx.protectUntil) +
      (nx.ms ? " · <b>覆盖 " + nx.ms.name + "</b>（" + md(nx.ms.d) + "），当天降价可退差" : "") +
      "</div>" +
      (hintHtml ? '<div class="tag warn" style="margin-top:8px">凑单：' + hintHtml + "</div>" : ""));
  }

  function renderOrders(orders) {
    var html = orders.map(function (o, idx) {
      var free = o.total >= S.freeShip;
      var hint = free ? null : mergeHint(orders, idx);
      var hintHtml = "";
      if (hint) {
        if (hint.type === "back")
          hintHtml = "凑单：提前 " + hint.span + " 天并到 " + iso(hint.target.date) +
                     " → " + money(hint.merged) + "，免运费";
        else if (hint.type === "fwd")
          hintHtml = "凑单：把 " + iso(hint.target.date) + " 那单提前过来 → " + money(hint.merged);
        else
          hintHtml = "凑单：把「" + esc(hint.it.cat) + "」提前 → " +
                     money(o.total + hint.it.best.price) + "，免运费";
      }
      return '<details' + (idx === 0 ? " open" : "") +
        ' style="border-bottom:1px solid var(--line);padding:10px 0">' +
        "<summary><span style=\"font-weight:700\">" + iso(o.date) + "</span> " +
        '<span class="sub">（' + diffD(TODAY, o.date) + " 天后 · " + o.items.length + " 项）</span>" +
        '<span style="float:right"><b>' + money(o.total) + "</b> " +
        '<span class="tag ' + (free ? "ok" : "bad") + '">' +
        (free ? "免运费" : "差 " + money(S.freeShip - o.total)) + "</span></span></summary>" +
        '<table style="margin-top:8px"><tbody>' + orderRows(o) + "</tbody></table>" +
        '<div class="sub" style="margin-top:6px">价保到 ' + iso(o.protectUntil) +
        (o.ms ? " · <b>覆盖 " + o.ms.name + "</b>（" + md(o.ms.d) + "）" : "") + "</div>" +
        (hintHtml ? '<div class="tag warn" style="margin-top:6px">' + hintHtml + "</div>" : "") +
        "</details>";
    }).join("");
    set("orders", html || '<div class="sub">暂无计划</div>');
  }

  function renderItems(items) {
    var tb = document.querySelector("#tbl tbody");
    if (!tb) return;
    tb.innerHTML = items.map(function (i, k) {
      var pct = Math.min(100, Math.max(0, 100 - i.dLeft / 90 * 100));
      return '<tr data-k="' + k + '">' +
        "<td><b>" + esc(i.cat) + '</b><div class="sub" style="font-size:12px">' +
        esc(i.name) + "</div></td>" +
        '<td class="num"><input type="number" step="1" min="0" value="' + Math.round(i.stock) +
        '" data-f="stock"><div class="sub" style="font-size:11px">' + esc(i.unit) + "</div></td>" +
        '<td class="num"><input type="number" step="1" min="0" value="' + Math.round(i.rate) +
        '" data-f="rate"></td>' +
        '<td class="num">' + iso(i.runout) +
        '<div class="sub" style="font-size:11px">' + Math.max(0, Math.round(i.dLeft)) +
        " 天后</div></td>" +
        '<td class="sub" style="white-space:nowrap">' + md(iso(i.early)) + " ~ " +
        md(iso(i.late)) + "</td>" +
        '<td class="num">' + (i.per100 != null ? i.per100.toFixed(3) : "—") +
        '<div class="sub" style="font-size:11px">元/100' + esc(i.unit) + "</div></td>" +
        '<td class="sub" style="font-size:12.5px">' +
        (i.best ? esc(i.best.spec) + " " + money(i.best.price) : "—") + "</td>" +
        '<td class="num">' + (i.cover < 9999 ? Math.round(i.cover) + " 天" : "—") +
        '<div class="hbar" style="margin-top:4px"><i style="width:' + pct + '%"></i></div></td>' +
        '<td style="white-space:nowrap">' +
        '<button class="ghost" data-checkin="' + esc(i.cat) + '" title="买了就点">🧾</button>' +
        '<button class="ghost" data-add="' + esc(i.cat) + '" title="只记价格">＋</button>' +
        "</td></tr>";
    }).join("");
  }

  /* ---------------- 价格模型：按「品类 + 规格」分开存 ----------------
     EXTRA[品类][specKey] = [{d, raw, total, per100}]
     每个规格一条独立历史，互不干扰。 */
  var LS_SPECS = "supply_extra_specs_v1";
  /* SPECS[品类] = { list:[{spec,total,ply}], author:true }
     没动过就沿用 data.js 的 offers；改/删/加过就以这里为准。ply = 层数（纸巾用，0=未标） */
  var SPECS = load(LS_SPECS, {});

  function specKey(spec, total) {
    var t = Number(total) || 0;
    return (spec || "未命名") + "@" + (Math.round(t * 1000) / 1000);
  }

  /* 老格式（EXTRA[品类] 是扁平数组）自动迁移成按规格分组 */
  (function migrateExtra() {
    var changed = false;
    Object.keys(EXTRA).forEach(function (cat) {
      if (!Array.isArray(EXTRA[cat])) return;
      var map = {};
      EXTRA[cat].forEach(function (x) {
        var k = specKey(x.spec, x.total);
        (map[k] = map[k] || []).push({
          d: x.d, raw: x.raw, total: x.total,
          per100: x.per100 || (x.raw / x.total * 100)
        });
      });
      EXTRA[cat] = map;
      changed = true;
    });
    if (changed) save(LS.extra, EXTRA);
  })();

  /* 老格式（只存"额外加的规格"数组）迁移成 authoritative 列表，避免丢掉 data.js 里的规格 */
  (function migrateSpecs() {
    var changed = false;
    Object.keys(SPECS).forEach(function (cat) {
      if (!Array.isArray(SPECS[cat])) return;
      var it = null;
      for (var i = 0; i < DATA.items.length; i++)
        if (DATA.items[i].cat === cat) it = DATA.items[i];
      var base = it ? (it.offers || []).map(function (o) {
        return { spec: o.spec, total: o.total, ply: o.ply || 0 };
      }) : [];
      SPECS[cat].forEach(function (s) {
        var k = specKey(s.spec, s.total);
        if (!base.some(function (b) { return specKey(b.spec, b.total) === k; }))
          base.push({ spec: s.spec, total: s.total, ply: s.ply || 0 });
      });
      SPECS[cat] = { list: base, author: true };
      changed = true;
    });
    if (changed) save(LS_SPECS, SPECS);
  })();

  function specList(it) {
    var s = SPECS[it.cat];
    if (s && s.list) return s.list;
    return (it.offers || []).map(function (o) {
      return { spec: o.spec, total: o.total, ply: o.ply || 0, cls: o.cls || "", price: o.price };
    });
  }

  function setSpecList(it, list) {
    SPECS[it.cat] = { list: list, author: true };
    save(LS_SPECS, SPECS);
  }

  /* 该品类下出现过的所有规格：你的清单 + 历史上录过价但已不在清单里的（孤儿） */
  function allSpecs(it) {
    var out = [], seen = {};
    specList(it).forEach(function (o) {
      var k = specKey(o.spec, o.total);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({
        spec: o.spec, total: o.total, unit: o.unit || it.unit, k: k,
        price: o.price == null ? null : o.price, ply: o.ply || 0, cls: o.cls || ""
      });
    });
    var map = EXTRA[it.cat] || {};
    Object.keys(map).forEach(function (k) {
      if (seen[k]) return;
      seen[k] = 1;
      var pts = map[k] || [];
      out.push({
        spec: k.split("@")[0], total: pts.length ? pts[0].total : 0,
        unit: it.unit, k: k, price: null, ply: 0, cls: "", orphan: true
      });
    });
    return out;
  }

  /* 某规格的完整价格历史（成交记录 + 手录）
     hist 里若有 spec 就精确匹配；没有则退回按总量匹配（同总量有多个规格时会串，尽量别依赖） */
  function specPoints(it, s) {
    var pts = [];
    (it.hist || []).forEach(function (h) {
      if (h.spec) {
        if (specKey(h.spec, h.total) === s.k) pts.push(h);
      } else if (s.total && Math.abs(h.total - s.total) < 1e-6) {
        pts.push(h);
      }
    });
    ((EXTRA[it.cat] || {})[s.k] || []).forEach(function (x) { pts.push(x); });
    pts.sort(function (a, b) { return String(a.d).localeCompare(String(b.d)); });
    return pts;
  }

  /* 单个规格的价格判断 */
  function specVerdict(pts, rangeDays) {
    var from = addD(TODAY, -rangeDays);
    var inR = pts.filter(function (p) { return parseD(p.d) >= from; });
    if (!inR.length) return { cls: "", text: "还没价格记录" };
    var dset = {}; inR.forEach(function (p) { dset[p.d] = 1; });
    if (Object.keys(dset).length < 2) return { cls: "", text: "只 1 次，再录几次" };
    var low = Math.min.apply(null, inR.map(function (p) { return p.per100; }));
    var high = Math.max.apply(null, inR.map(function (p) { return p.per100; }));
    var last = inR[inR.length - 1];
    var gap = (last.per100 - low) / (high || 1) * 100;
    return {
      cls: gap < 3 ? "ok" : (gap < 12 ? "warn" : "bad"),
      text: gap < 3 ? "近期低位" : (gap < 12 ? "中等位" : "偏高"),
      low: low, high: high, last: last
    };
  }

  /* ---------------- 每日录价：每个规格一行 ---------------- */
  function renderPriceEntry() {
    var tb = document.querySelector("#pl-tbl tbody");
    if (!tb) return;
    var dateEl = document.getElementById("pl-date");
    if (dateEl && !dateEl.value) dateEl.value = iso(TODAY);
    var d = (dateEl && dateEl.value) || iso(TODAY);

    var html = [], done = 0, total = 0;
    DATA.items.forEach(function (it, ci) {
      allSpecs(it).forEach(function (s, si) {
        total++;
        var pts = specPoints(it, s);
        var todayPts = (EXTRA[it.cat] || {})[s.k] || [];
        if (todayPts.some(function (x) { return x.d === d; })) done++;
        var last = pts.length ? pts[pts.length - 1] : null;
        html.push('<tr>' +
          "<td>" + (si === 0 ? "<b>" + esc(it.cat) + "</b> " +
            '<button class="ghost" data-newspec="' + esc(it.cat) + '" title="加一个规格">＋</button>' : "") + "</td>" +
          '<td class="sub">' + esc(s.spec) +
            (s.total ? "<br>" + s.total + esc(s.unit || it.unit) : "") + "</td>" +
          '<td class="num sub">' + (last ? money(last.raw) + "<br>" + md(last.d) : "—") + "</td>" +
          '<td class="num"><input type="number" step="0.01" min="0" id="pl-' + ci + "-" + si +
          '" placeholder="' + (last ? last.raw.toFixed(2) : "") + '"></td></tr>');
      });
    });
    tb.innerHTML = html.join("");
    txt("pl-progress", "这一天已录 " + done + "/" + total + " 个规格");
  }

  function savePriceEntry() {
    var dateEl = document.getElementById("pl-date");
    var d = (dateEl && dateEl.value) || iso(TODAY);
    var n = 0;
    DATA.items.forEach(function (it, ci) {
      allSpecs(it).forEach(function (s, si) {
        var inp = document.getElementById("pl-" + ci + "-" + si);
        if (!inp) return;
        var v = parseFloat(inp.value);
        if (!v || v <= 0) return;
        var per100 = +(v / s.total * 100).toFixed(4);
        EXTRA[it.cat] = EXTRA[it.cat] || {};
        var arr = (EXTRA[it.cat][s.k] || []).filter(function (x) { return x.d !== d; });
        arr.push({ d: d, raw: v, total: s.total, per100: per100 });
        EXTRA[it.cat][s.k] = arr;
        inp.value = "";
        n++;
      });
    });
    if (!n) { toast("没填任何价格"); return; }
    save(LS.extra, EXTRA);
    renderAll();
    toast("已录 " + n + " 个规格（" + d + "）");
  }

  function specColor(i) {
    return ["#4f46e5", "#059669", "#d97706", "#dc2626", "#7c3aed"][i % 5];
  }

  /* 多规格同图：每个规格一条线，颜色区分 */
  function multiChart(it, specsArr) {
    var W = 300, H = 96, P = 8;
    var from = addD(TODAY, -ST.range);
    var series = specsArr.map(function (s, i) {
      return {
        s: s, color: specColor(i),
        pts: specPoints(it, s).filter(function (p) { return parseD(p.d) >= from; })
      };
    });
    var all = [];
    series.forEach(function (x) { x.pts.forEach(function (p) { all.push(p); }); });
    if (!all.length)
      return '<div class="sub" style="height:' + H + 'px;display:flex;align-items:center;' +
             'justify-content:center">近 ' + ST.range + " 天没有价格记录</div>";

    var xs = all.map(function (p) { return parseD(p.d).getTime(); });
    var ys = all.map(function (p) { return p.per100; });
    var x0 = Math.min.apply(null, xs.concat([from.getTime()]));
    var x1 = Math.max.apply(null, xs.concat([TODAY.getTime()]));
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    var padY = (ymax - ymin) * 0.25 || Math.max(0.1, ymax * 0.1);
    var ly = ymin - padY, hy = ymax + padY;
    function X(t) { return P + (t - x0) / Math.max(1, x1 - x0) * (W - 2 * P); }
    function Y(v) { return H - P - (v - ly) / Math.max(1e-9, hy - ly) * (H - 2 * P); }

    var g = "";
    DATA.milestones.forEach(function (m) {
      var d = parseD(m.d);
      if (d < from || d > TODAY) return;
      var mx = X(d.getTime());
      g += '<line x1="' + mx + '" y1="' + P + '" x2="' + mx + '" y2="' + (H - P) +
           '" stroke="#c7d2fe" stroke-width="1" stroke-dasharray="3 3"/>' +
           '<text x="' + mx + '" y="' + (P + 8) + '" font-size="8" fill="#6366f1" ' +
           'text-anchor="middle">' + m.name + "</text>";
    });
    series.forEach(function (x) {
      if (!x.pts.length) return;
      if (x.pts.length > 1) {
        var dstr = x.pts.map(function (p, i) {
          return (i ? "L" : "M") + X(parseD(p.d).getTime()).toFixed(1) + " " + Y(p.per100).toFixed(1);
        }).join(" ");
        g += '<path d="' + dstr + '" fill="none" stroke="' + x.color +
             '" stroke-width="2" stroke-linejoin="round"/>';
      }
      x.pts.forEach(function (p) {
        g += '<circle cx="' + X(parseD(p.d).getTime()).toFixed(1) + '" cy="' +
             Y(p.per100).toFixed(1) + '" r="3" fill="' + x.color + '"/>';
      });
    });
    g += '<text x="' + P + '" y="' + (H - 1) + '" font-size="8" fill="#9ca3af">' +
         md(iso(from)) + "</text>";
    g += '<text x="' + (W - P) + '" y="' + (H - 1) +
         '" font-size="8" fill="#9ca3af" text-anchor="end">' + md(iso(TODAY)) + "</text>";
    return '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="' + H + '">' + g + "</svg>";
  }

  /* 分类配色：低饱和、彼此拉开；刻意不用黄色系——黄色留给「本组最优」高亮 */
  var CLS_COLORS = {
    "3层": { bg: "#eef2ff", bd: "#a5b4fc", tx: "#4338ca" },
    "4层": { bg: "#e0f2fe", bd: "#93c5fd", tx: "#075985" },
    "瓶装": { bg: "#f0fdf4", bd: "#86efac", tx: "#166534" },
    "袋装": { bg: "#fdf2f8", bd: "#f9a8d4", tx: "#9d174d" }
  };
  var CLS_FALLBACK = [
    { bg: "#f5f3ff", bd: "#c4b5fd", tx: "#5b21b6" },
    { bg: "#f0fdfa", bd: "#5eead4", tx: "#115e59" },
    { bg: "#fdf2f8", bd: "#f9a8d4", tx: "#9d174d" }
  ];
  function clsStyle(name) {
    if (CLS_COLORS[name]) return CLS_COLORS[name];
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return CLS_FALLBACK[h % CLS_FALLBACK.length];
  }

  /* 规格对比表：按分类分组，本组最优用浅黄标出 */
  function cmpTable(it, specsArr) {
    var rows = specsArr.map(function (s) {
      var pts = specPoints(it, s);
      return { s: s, last: pts.length ? pts[pts.length - 1] : null, n: pts.length };
    });

    var groups = [], gmap = {};
    rows.forEach(function (r) {
      var key = r.s.cls || (r.s.ply ? (r.s.ply + "层") : "未分类");
      if (!gmap[key]) { gmap[key] = { name: key, items: [] }; groups.push(gmap[key]); }
      gmap[key].items.push(r);
    });
    groups.sort(function (a, b) {
      var ua = a.name === "未分类" ? 1 : 0, ub = b.name === "未分类" ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return (b.items[0].s.total || 0) - (a.items[0].s.total || 0);
    });

    var u = it.unit;
    var html = '<div class="scroll"><table class="cmp"><thead><tr>' +
      "<th>规格</th><th class=\"num\">总量</th><th class=\"num\">最近价</th>" +
      '<th class="num">元/100' + esc(u) + '</th><th class="num">日期</th><th></th>' +
      "</tr></thead><tbody>";

    groups.forEach(function (g) {
      var best = null;
      g.items.forEach(function (r) {
        if (!r.last || !r.s.total) return;
        if (!best || r.last.per100 < best.last.per100) best = r;
      });
      var st = clsStyle(g.name);
      html += '<tr class="grp"><td colspan="6">' +
        '<span class="cls" style="background:' + st.bg + ";border-color:" + st.bd +
        ";color:" + st.tx + '">' + esc(g.name) + "</span>" +
        (best ? '<span class="sub">本组最优 ' + best.last.per100.toFixed(3) + " 元/100" +
          esc(u) + "（" + esc(best.s.spec) + "）</span>" : "") +
        "</td></tr>";

      g.items.forEach(function (r) {
        var isBest = (best === r);
        html += "<tr" + (isBest ? ' class="bestrow" style="background:#fffbeb"' : "") + ">" +
          "<td>" + (isBest ? '<b style="color:#b45309">★ </b>' : "") + esc(r.s.spec) +
          (r.s.orphan ? ' <span class="tag">旧记录</span>' : "") + "</td>" +
          '<td class="num sub">' + (r.s.total ? r.s.total + esc(r.s.unit || u) : "—") + "</td>" +
          '<td class="num">' + (r.last ? money(r.last.raw) : "—") + "</td>" +
          '<td class="num"><b>' + (r.last ? r.last.per100.toFixed(3) : "—") + "</b></td>" +
          '<td class="num sub">' + (r.last ? md(r.last.d) : "—") + "</td>" +
          '<td style="white-space:nowrap">' +
            '<button class="ghost" data-specedit="' + esc(it.cat) + "|" + esc(r.s.k) +
              '" title="改规格">✎</button>' +
            '<button class="ghost" data-specdel="' + esc(it.cat) + "|" + esc(r.s.k) +
              '" title="删规格">✕</button>' +
          "</td></tr>";
      });
    });
    html += "</tbody></table></div>";

    /* 分类之间比一比 */
    var parts = groups.filter(function (g) { return g.name !== "未分类"; }).map(function (g) {
      var b = null;
      g.items.forEach(function (r) {
        if (r.last && (b === null || r.last.per100 < b)) b = r.last.per100;
      });
      return b === null ? null : { name: g.name, v: b };
    }).filter(Boolean);
    if (parts.length >= 2) {
      parts.sort(function (a, b) { return a.v - b.v; });
      var lo = parts[0], hi = parts[parts.length - 1];
      html += '<div class="sub" style="margin-top:6px">分类对比：' + esc(lo.name) + " 最优 " +
        lo.v.toFixed(3) + " · " + esc(hi.name) + " 最优 " + hi.v.toFixed(3) +
        "（" + esc(lo.name) + " 便宜 " + ((1 - lo.v / hi.v) * 100).toFixed(0) +
        "%，但不是同一类东西，值不值看你自己权衡）</div>";
    }
    return html;
  }

  function chartCard(it) {
    var specsArr = allSpecs(it);
    var chartSpecs = specsArr.filter(function (s) {
      return specPoints(it, s).length >= 2;
    });
    var chart = chartSpecs.length
      ? '<details style="margin-top:8px"><summary class="sub">价格曲线（' + chartSpecs.length +
        " 个规格有 2 个以上价格点）</summary>" + multiChart(it, chartSpecs) + "</details>"
      : "";

    var fc = "";
    var nm = DATA.milestones.filter(function (m) { return parseD(m.d) > TODAY; })[0];
    if (nm) {
      var worst = null;
      specsArr.forEach(function (s) {
        var v = specVerdict(specPoints(it, s), ST.range);
        if (v.low == null || !v.last) return;
        var gap = (v.last.per100 - v.low) / (v.high || 1) * 100;
        if (!worst || gap > worst.gap) worst = { gap: gap, v: v, s: s };
      });
      if (worst && worst.gap >= 12) {
        var target = worst.v.low * 1.05;
        fc = '<div class="sub" style="margin-top:6px">' + esc(worst.s.spec) +
          " 偏高 → 可等 <b>" + nm.name + "</b>（" + md(nm.d) + "，" +
          diffD(TODAY, parseD(nm.d)) + " 天后），预计回到 ~" + target.toFixed(3) +
          " 元/100" + esc(it.unit) + "</div>";
      }
    }

    return '<div style="border:1px solid var(--line);border-radius:12px;padding:12px">' +
      '<div class="row" style="justify-content:space-between;margin-bottom:4px"><b>' +
      esc(it.cat) + "</b>" +
      '<span class="sub">' + specsArr.length + " 个规格 · 单位 " + esc(it.unit) + "</span></div>" +
      cmpTable(it, specsArr) + chart + fc + "</div>";
  }

  function renderCharts(items) {
    set("charts", items.map(chartCard).join(""));
  }

  function renderCost(items, orders) {
    var monthly = items.reduce(function (s, i) {
      return s + (i.best ? i.best.price / (i.cover / 30) : 0);
    }, 0);
    var risk = orders.filter(function (o) { return o.total < S.freeShip; }).length * 6;
    set("cost",
      "<div><div class=\"sub\">消耗品年支出</div><div style=\"font-size:20px;font-weight:700\">" +
      money(monthly * 12) + '</div><div class="sub">月均 ' + money(monthly) + "</div></div>" +
      "<div><div class=\"sub\">本次计划的运费风险</div><div style=\"font-size:20px;font-weight:700\">" +
      money(risk) + '</div><div class="sub">' + orders.length + " 单里 " +
      orders.filter(function (o) { return o.total < S.freeShip; }).length +
      " 单不足 " + money(S.freeShip) + "</div></div>" +
      "<div><div class=\"sub\">价格样本</div><div style=\"font-size:20px;font-weight:700\">" +
      items.reduce(function (s, i) { return s + (i.hist || []).length; }, 0) + " 条</div>" +
      '<div class="sub">' + items.filter(function (i) { return (i.hist || []).length >= 2; }).length +
      " 个品类可算价差</div></div>");
  }

  function renderLog() {
    var el = document.getElementById("loglist");
    if (!el) return;
    if (!LOG.length) {
      el.innerHTML = '<div class="sub">还没有打卡记录。买完去「物品清单」点行尾 🧾，库存和价格会一起更新。</div>';
      return;
    }
    el.innerHTML = '<div class="sub" style="margin-bottom:4px">最近打卡（共 ' + LOG.length + " 条）</div>" +
      LOG.slice(0, 8).map(function (r) {
        return '<div class="logline"><span>' + esc(r.d) + " · " + esc(r.cat) + " ×" + r.qty +
          "</span><span>" + money(r.price) + ' <span class="sub">(' +
          Number(r.per100).toFixed(3) + " 元/100" + esc(r.unit || "") + ")</span></span></div>";
      }).join("");
  }

  function renderFoot() {
    set("foot",
      "口径 · 免运费：京东自营满 " + money(S.freeShip) + " 免基础运费 " + money(6) + "；" +
      "价保：家庭清洁/纸品、个人护理、食品饮料 " + S.protectDays + " 天，" +
      "入口「我的订单 → 服务中心 → 价格保护」；单位价 = 价格 ÷ 总规格量 × 100。<br>" +
      "当前策略：安全库存 " + ST.safety + " 天、合并窗口 " + ST.merge + " 天。" +
      "库存/打卡/自定义品类存在本机 localStorage，不上传。");
  }

  function renderAll() {
    var items = DATA.items.map(function (it) { return calcItem(it, ST.safety); });
    var orders = groupOrders(items);
    renderHeader(items);
    if (PAGE === "index") { renderAlerts(items); renderNext(orders); renderFoot(); }
    if (PAGE === "plan") { renderOrders(orders); }
    if (PAGE === "items") { renderItems(items); }
    if (PAGE === "price") { renderPriceEntry(); renderCharts(items); }
    if (PAGE === "cost") { renderCost(items, orders); renderLog(); renderFoot(); }
  }

  /* ---------------- 打卡 ---------------- */
  var SH = { cat: null };
  function findItem(cat) {
    for (var i = 0; i < DATA.items.length; i++) if (DATA.items[i].cat === cat) return DATA.items[i];
    return null;
  }
  function openCheckin(cat) {
    var it = findItem(cat);
    if (!it || !it.offers.length) return;
    var best = it.offers[0];
    SH.cat = cat;
    txt("sh-title", "打卡 · " + cat);
    txt("sh-sub", best.spec + " · 当前单价 " + money(best.price) +
        " · 库存 " + Math.round(it.stock) + " " + it.unit);
    var q = document.getElementById("sh-qty"), p = document.getElementById("sh-price");
    if (q) q.value = 1;
    if (p) p.value = best.price.toFixed(2);
    previewCheckin();
    var s = document.getElementById("sheet");
    if (s) s.hidden = false;
  }
  function closeCheckin() {
    var s = document.getElementById("sheet");
    if (s) s.hidden = true;
    SH.cat = null;
  }
  function previewCheckin() {
    var it = findItem(SH.cat);
    if (!it || !it.offers.length) return;
    var best = it.offers[0];
    var q = document.getElementById("sh-qty"), p = document.getElementById("sh-price");
    var qty = Math.max(1, Math.round(parseFloat(q && q.value) || 1));
    var price = parseFloat(p && p.value) || 0;
    var addQty = qty * best.total;
    var base = best.price / best.total * 100;
    var per100 = price > 0 ? price / addQty * 100 : null;
    var note = "填个实付总价才能算单位价";
    if (per100 != null) {
      note = "单位价 <b>" + per100.toFixed(3) + " 元/100" + it.unit + "</b>" +
        (per100 < base - 0.001 ? "（比当前便宜 " + ((1 - per100 / base) * 100).toFixed(0) + "%）"
          : (per100 > base + 0.001 ? "（比当前贵）" : "（与当前持平）"));
    }
    set("sh-calc", "库存 " + Math.round(it.stock) + " → <b>" +
        Math.round(it.stock + addQty) + " " + it.unit + "</b>（+" + addQty + "）<br>" + note);
  }
  function submitCheckin() {
    var it = findItem(SH.cat);
    if (!it || !it.offers.length) return closeCheckin();
    var best = it.offers[0];
    var q = document.getElementById("sh-qty"), p = document.getElementById("sh-price");
    var qty = Math.max(1, Math.round(parseFloat(q && q.value) || 1));
    var price = parseFloat(p && p.value);
    if (!price || price <= 0) { toast("请填实付总价"); return; }
    var addQty = qty * best.total;
    it.stock = Math.round((it.stock + addQty) * 100) / 100;
    OVR[it.cat] = OVR[it.cat] || {};
    OVR[it.cat].stock = it.stock;
    save(LS.ovr, OVR);
    var per100 = +(price / addQty * 100).toFixed(4);
    LOG.unshift({ d: iso(TODAY), cat: it.cat, unit: it.unit, qty: qty,
                  price: price, total: best.total, spec: best.spec, per100: per100 });
    LOG = LOG.slice(0, 300);
    save(LS.log, LOG);
    var ckKey = specKey(best.spec, best.total);
    EXTRA[it.cat] = EXTRA[it.cat] || {};
    var ckArr = (EXTRA[it.cat][ckKey] || []).filter(function (x) { return x.d !== iso(TODAY); });
    ckArr.push({ d: iso(TODAY), raw: price, total: best.total, per100: per100 });
    EXTRA[it.cat][ckKey] = ckArr;
    save(LS.extra, EXTRA);
    closeCheckin();
    renderAll();
    toast("已记录：" + it.cat + " +" + addQty + it.unit);
  }

  function addItem() {
    var g = function (id) { return document.getElementById(id); };
    var v = function (id) { return (g(id) && g(id).value || "").trim(); };
    var n = function (id) { return parseFloat(g(id) && g(id).value); };
    var cat = v("np-cat"), unit = v("np-unit"), spec = v("np-spec") || "1件";
    var total = n("np-total"), price = n("np-price");
    var stock = n("np-stock") || 0, rate = n("np-rate") || 0;
    if (!cat || !unit || !(total > 0) || !(price > 0)) {
      toast("品类、单位、每件总量、单价 都要填"); return;
    }
    if (findItem(cat)) { toast("已经有这个品类了"); return; }
    var it = {
      cat: cat, name: cat + " " + spec, unit: unit, stock: stock, rate: rate,
      rateFast: rate * 1.15, rateSlow: rate * 0.85,
      offers: [{ name: cat + " " + spec, spec: spec, total: total, unit: unit, price: price }],
      hist: [], lastLow: null
    };
    CUSTOM.push(it); save(LS.items, CUSTOM);
    DATA.items.push(it);
    ["np-cat", "np-unit", "np-spec", "np-total", "np-price", "np-stock", "np-rate"]
      .forEach(function (k) { if (g(k)) g(k).value = ""; });
    renderAll();
    toast("已添加：" + cat);
  }

  /* ---------------- 导入导出 ---------------- */
  function exportJSON() {
    var payload = { version: 1, exportedAt: iso(TODAY), dataDate: DATA.updated,
                    overrides: OVR, extra: EXTRA, log: LOG, custom: CUSTOM, specs: SPECS };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cloud.json";
    document.body.appendChild(a); a.click(); a.remove();
    toast("已导出 cloud.json");
  }
  function mergePayload(p) {
    if (p.overrides) Object.keys(p.overrides).forEach(function (k) {
      OVR[k] = OVR[k] || {};
      Object.keys(p.overrides[k]).forEach(function (f) {
        if (typeof p.overrides[k][f] === "number") OVR[k][f] = p.overrides[k][f];
      });
    });
    if (p.extra) Object.keys(p.extra).forEach(function (k) {
      EXTRA[k] = EXTRA[k] || [];
      p.extra[k].forEach(function (r) {
        var dup = EXTRA[k].some(function (x) {
          return x.d === r.d && Math.abs(x.raw - r.raw) < 1e-9;
        });
        if (!dup) EXTRA[k].push(r);
      });
    });
    if (Array.isArray(p.log)) p.log.forEach(function (r) {
      var dup = LOG.some(function (x) {
        return x.d === r.d && x.cat === r.cat && Math.abs(x.price - r.price) < 1e-9;
      });
      if (!dup) LOG.push(r);
    });
    LOG.sort(function (a, b) { return String(b.d).localeCompare(String(a.d)); });
    if (Array.isArray(p.custom)) p.custom.forEach(function (it) {
      if (it && it.cat && !CUSTOM.some(function (x) { return x.cat === it.cat; })) CUSTOM.push(it);
    });
    if (p.specs) Object.keys(p.specs).forEach(function (cat) {
      SPECS[cat] = SPECS[cat] || [];
      (p.specs[cat] || []).forEach(function (s) {
        if (!s || !s.spec) return;
        var k = specKey(s.spec, s.total);
        if (!SPECS[cat].some(function (x) { return specKey(x.spec, x.total) === k; }))
          SPECS[cat].push(s);
      });
    });
    save(LS.ovr, OVR); save(LS.extra, EXTRA); save(LS.log, LOG);
    save(LS.items, CUSTOM); save(LS_SPECS, SPECS);
    applyOverrides(); applyCustom();
  }
  function importJSON(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        mergePayload(JSON.parse(String(rd.result)));
        closeCheckin(); renderAll(); toast("导入成功");
      } catch (e) { toast("解析失败：" + e.message); }
    };
    rd.readAsText(file, "utf-8");
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "imp" && t.files && t.files[0]) { importJSON(t.files[0]); t.value = ""; return; }
    if (t.dataset && t.dataset.f) {
      var tr = t.closest("tr"), k = +tr.getAttribute("data-k");
      var v = parseFloat(t.value);
      if (!isNaN(v) && v >= 0) {
        var f = t.dataset.f === "stock" ? "stock" : "rate";
        var cat = DATA.items[k].cat;
        DATA.items[k][f] = v;
        OVR[cat] = OVR[cat] || {};
        OVR[cat][f] = v;
        save(LS.ovr, OVR);
      }
      renderAll();
    }
    if (t.id === "safety") { ST.safety = +t.value; renderAll(); }
    if (t.id === "merge") { ST.merge = +t.value; renderAll(); }
    if (t.id === "pl-date") { renderPriceEntry(); }
  });

  document.addEventListener("input", function (e) {
    var id = e.target && e.target.id;
    if (id === "sh-qty" || id === "sh-price") previewCheckin();
  });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.r) { ST.range = +t.dataset.r; renderAll(); paintRange(); return; }
    if (t.dataset.checkin) { openCheckin(t.dataset.checkin); return; }
    if (t.dataset.newspec) {
      var ncat = t.dataset.newspec, nit = findItem(ncat);
      if (!nit) return;
      var label = window.prompt("新规格的名字（例：80抽×8包、3kg×2瓶）", "");
      if (!label) return;
      var tot = parseFloat(window.prompt("这一件一共多少" + nit.unit + "？（数字，例 640）", ""));
      if (!tot || tot <= 0) return;
      var clsRaw = window.prompt("分类（纸巾填 3层/4层，洗手液填 瓶装/袋装，其它留空）", "");
      var cls = String(clsRaw || "").trim();
      var pm = /(\d)\s*层/.exec(cls) || /(\d)\s*层/.exec(label);
      var list = specList(nit).slice();
      var nk = specKey(label, tot);
      if (!list.some(function (x) { return specKey(x.spec, x.total) === nk; })) {
        list.push({ spec: label, total: tot, cls: cls, ply: pm ? +pm[1] : 0 });
        setSpecList(nit, list);
      }
      renderAll();
      toast("已加规格：" + label);
      return;
    }
    if (t.dataset.specedit) { editSpec(t.dataset.specedit); return; }
    if (t.dataset.specdel) { delSpec(t.dataset.specdel); return; }
    if (t.id === "pl-save") { savePriceEntry(); return; }
    if (t.id === "exp") { exportJSON(); return; }
    if (t.id === "impbtn") { document.getElementById("imp").click(); return; }
    if (t.id === "np-add") { addItem(); return; }
    if (t.id === "sh-ok") { submitCheckin(); return; }
    if (t.id === "sh-cancel" || t.id === "sh-x") { closeCheckin(); return; }
    if (t.id === "reset") {
      ST.safety = S.safetyDays; ST.merge = S.mergeWindow;
      var a = document.getElementById("safety"), b = document.getElementById("merge");
      if (a) a.value = ST.safety;
      if (b) b.value = ST.merge;
      renderAll(); return;
    }
    if (t.dataset.add) {
      var cat = t.dataset.add, it = findItem(cat);
      var best = it && it.offers[0];
      if (!best) return;
      var v = window.prompt("补录一次价格 —— " + cat + "（" + best.spec +
                            "）\n请输入实付总价（元）：", String(best.price));
      if (v == null) return;
      var price = parseFloat(v);
      if (!price || price <= 0) return;
      var per100 = +(price / best.total * 100).toFixed(4);
      var addKey = specKey(best.spec, best.total);
      EXTRA[cat] = EXTRA[cat] || {};
      var addArr = (EXTRA[cat][addKey] || []).filter(function (x) { return x.d !== iso(TODAY); });
      addArr.push({ d: iso(TODAY), raw: price, total: best.total, per100: per100 });
      EXTRA[cat][addKey] = addArr;
      save(LS.extra, EXTRA);
      renderAll(); toast("已记录价格");
      return;
    }
  });

  /* 规格的改 / 删 */
  function splitRef(ref) {
    var i = String(ref).indexOf("|");
    return { cat: String(ref).slice(0, i), k: String(ref).slice(i + 1) };
  }

  function editSpec(ref) {
    var r = splitRef(ref), it = findItem(r.cat);
    if (!it) return;
    var list = specList(it).slice(), idx = -1;
    for (var i = 0; i < list.length; i++)
      if (specKey(list[i].spec, list[i].total) === r.k) { idx = i; break; }
    if (idx < 0) return;
    var cur = list[idx];
    var spec = window.prompt("规格名字（例：80抽×4包）", cur.spec);
    if (!spec) return;
    var tot = parseFloat(window.prompt("这一件一共多少" + it.unit + "？（数字）", String(cur.total)));
    if (!tot || tot <= 0) return;
    var clsRaw = window.prompt("分类（纸巾填 3层/4层，洗手液填 瓶装/袋装，其它留空）", cur.cls || "");
    var cls = String(clsRaw || "").trim();
    var pm = /(\d)\s*层/.exec(cls) || /(\d)\s*层/.exec(spec);
    list[idx] = { spec: spec, total: tot, cls: cls, ply: pm ? +pm[1] : 0 };
    setSpecList(it, list);
    renderAll();
    toast("已更新规格");
  }

  function delSpec(ref) {
    var r = splitRef(ref), it = findItem(r.cat);
    if (!it) return;
    if (!window.confirm("删掉这个规格？历史价格会保留，之后显示为「旧记录」")) return;
    var list = specList(it).filter(function (s) { return specKey(s.spec, s.total) !== r.k; });
    setSpecList(it, list);
    renderAll();
    toast("已删除规格");
  }

  function paintRange() {
    document.querySelectorAll("button[data-r]").forEach(function (b) {
      b.classList.toggle("on", +b.dataset.r === ST.range);
    });
  }

  /* ---------------- 启动 ---------------- */
  var sa = document.getElementById("safety"), me = document.getElementById("merge");
  if (sa) sa.value = ST.safety;
  if (me) me.value = ST.merge;
  renderAll();
  paintRange();

  /* 同目录的 cloud.json 作为云端基准：只在本地完全空白时采纳，避免覆盖你的操作 */
  try {
    fetch("cloud.json", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (!d) return;
      var empty = !d.overrides || !Object.keys(d.overrides).length;
      var noLog = !d.log || !d.log.length;
      var noExtra = !d.extra || !Object.keys(d.extra).length;
      var noCustom = !d.custom || !d.custom.length;
      if (empty && noLog && noExtra && noCustom) return;
      if (!Object.keys(OVR).length && !LOG.length && !CUSTOM.length) {
        mergePayload(d); renderAll(); toast("已载入云端基准");
      }
    }).catch(function () {});
  } catch (e) {}
})();
