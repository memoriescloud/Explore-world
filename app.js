/* EPC 答题辅助 · 前端逻辑（纯原生 JS，无依赖） */
(function () {
  "use strict";

  var BANK = window.QUESTIONS || [];
  var BY_ID = {};
  BANK.forEach(function (q) { BY_ID[q.id] = q; });

  var DAILY_GOAL = 50; // 每日练习目标题数
  var MAX_SAME_DAY = 3;            // 同一题同一日最多出现次数（≤3）
  var REPEAT_WINDOW_MS = 20 * 60 * 1000; // 连续 20 分钟内同一题最多出现 1 次（<2）
  var RECENCY_WINDOW_DAYS = 3;     // 近 N 日内出现过的题，抽取概率递减
  var RECENCY_FACTOR = 0.5;        // 每在近 N 日内多出现一天，权重乘此系数（<1，越小衰减越强）

  /* ---------------- 存储 ---------------- */
  function loadK(key, def) {
    try { var v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function saveK(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
    if (SYNC_KEYS.indexOf(key) >= 0 && !applyingRemote) scheduleSync();
  }

  var wrong = loadK("epc_wrong_v1", {});     // { id: {wrongCount, lastWrongTs, added} }
  var stats = loadK("epc_stats_v1", {});      // { id: {correct, wrong} }
  var settings = loadK("epc_settings_v1", { lastMode: "overall" });
  var daily = loadK("epc_daily_v1", {});      // { "YYYY-MM-DD": {count, correct, wrong} }
  var correctDay = loadK("epc_correct_v1", {}); // { "YYYY-MM-DD": { id: true } } 当日已答对的题
  var shownC = loadK("epc_shown_v1", {});       // { id: 累计被抽中次数 } 用于「全部答过后的均衡抽取」

  function saveWrong() { saveK("epc_wrong_v1", wrong); }
  function saveStats() { saveK("epc_stats_v1", stats); }
  function saveSettings() { saveK("epc_settings_v1", settings); }
  function saveDaily() { saveK("epc_daily_v1", daily); }
  function saveShownC() { saveK("epc_shown_v1", shownC); }
  function saveAll() { saveWrong(); saveStats(); saveDaily(); settings.lastMode = settings.lastMode || "overall"; toast("进度已保存"); }

  /* ---------------- 云端同步（方案 A：跨设备自动同步） ---------------- */
  var SYNC_KEYS = ["epc_wrong_v1", "epc_stats_v1", "epc_settings_v1", "epc_daily_v1", "epc_seen_v1", "epc_correct_v1", "epc_shown_v1"];
  var applyingRemote = false;   // 应用远端数据时，抑制本地 saveK 触发回推
  var pushTimer = null;
  var syncOnline = false;       // 是否连上同步服务

  function genUid() {
    var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var buf = new Array(32);
    for (var i = 0; i < 32; i++) buf[i] = chars[Math.floor(Math.random() * chars.length)];
    return buf.join("");
  }
  function getUid() {
    if (!settings.syncUid || !/^[A-Za-z0-9_-]{8,64}$/.test(settings.syncUid)) {
      settings.syncUid = genUid(); saveSettings();
    }
    return settings.syncUid;
  }
  function snapshot() {
    var o = {};
    SYNC_KEYS.forEach(function (k) {
      try { o[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { o[k] = null; }
    });
    return o;
  }
  function applySnapshot(payload) {
    if (!payload) return false;
    applyingRemote = true;
    SYNC_KEYS.forEach(function (k) { if (payload[k] !== undefined) saveK(k, payload[k]); });
    // 重新绑定内存变量
    wrong = loadK("epc_wrong_v1", {});
    stats = loadK("epc_stats_v1", {});
    settings = loadK("epc_settings_v1", { lastMode: "overall" });
    daily = loadK("epc_daily_v1", {});
    seen = loadK("epc_seen_v1", {});
    correctDay = loadK("epc_correct_v1", {});
    shownC = loadK("epc_shown_v1", {});
    applyingRemote = false;
    return true;
  }
  function scheduleSync() {
    if (applyingRemote) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushSync, 700);
  }
  function pushSync() {
    if (applyingRemote) return;
    var uid = getUid();
    var payload = snapshot();
    var ts = Date.now();
    var body = JSON.stringify({ uid: uid, ts: ts, payload: payload });
    fetch("/api/data?uid=" + encodeURIComponent(uid), {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: body
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && (j.ok || j.ignored)) {
        syncOnline = true;
        settings.lastSyncTs = ts;
        try { localStorage.setItem("epc_settings_v1", JSON.stringify(settings)); } catch (e) {}
        updateSyncUI();
      }
    }).catch(function () { syncOnline = false; updateSyncUI(); });
  }
  function pullSync(cb) {
    var uid = getUid();
    fetch("/api/data?uid=" + encodeURIComponent(uid), { method: "GET" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.payload && j.ts && j.ts > (settings.lastSyncTs || 0)) {
          applySnapshot(j.payload);
          settings.lastSyncTs = j.ts;
          try { localStorage.setItem("epc_settings_v1", JSON.stringify(settings)); } catch (e) {}
          syncOnline = true;
          updateSyncUI();
          rerenderCurrent();
        } else { syncOnline = true; updateSyncUI(); }
        if (cb) cb();
      })
      .catch(function () { syncOnline = false; updateSyncUI(); if (cb) cb(); });
  }
  function syncNow() { pullSync(function () { pushSync(); }); }

  // 后台定时自动拉取：让另一台设备的新进度无需手动点「立即同步」也自动生效
  var autoSyncTimer = null;
  function pullAuto() {
    if (applyingRemote) return;
    var uid = getUid();
    fetch("/api/data?uid=" + encodeURIComponent(uid), { method: "GET" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.payload && j.ts && j.ts > (settings.lastSyncTs || 0)) {
          applySnapshot(j.payload);          // 更新内存变量并落盘
          settings.lastSyncTs = j.ts;
          try { localStorage.setItem("epc_settings_v1", JSON.stringify(settings)); } catch (e) {}
          syncOnline = true;
          updateSyncUI();
          // 仅在首页时自动刷新界面（避免在答题途中被打断）；其他界面下次操作自动生效
          if (!currentMode) rerenderCurrent();
        } else { syncOnline = true; updateSyncUI(); }
      })
      .catch(function () { syncOnline = false; updateSyncUI(); });
  }
  function startAutoSync() {
    if (autoSyncTimer) return;
    autoSyncTimer = setInterval(function () {
      if (document.visibilityState === "visible") pullAuto();
    }, 12000);
  }
  function rerenderCurrent() { if (currentMode) setMode(currentMode); else goHome(); }
  function syncLabel() {
    if (!syncOnline) return "📱 本地进度已保存（未连接同步服务）";
    if (settings.lastSyncTs) {
      var d = new Date(settings.lastSyncTs);
      return "☁ 已同步 · 上次 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    return "☁ 已连接同步服务";
  }
  function updateSyncUI() {
    var els = document.querySelectorAll(".js-sync-status");
    for (var i = 0; i < els.length; i++) els[i].textContent = syncLabel();
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("savedTip");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1200);
  }

  /* ---------------- 日期 / 每日统计 ---------------- */
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function todayKey() { return fmtKey(new Date()); }
  function todayStat() {
    var k = todayKey();
    if (!daily[k]) daily[k] = { count: 0, correct: 0, wrong: 0 };
    return daily[k];
  }
  function streakDays() {
    var s = 0;
    var d = new Date();
    if (!(daily[todayKey()] && daily[todayKey()].count > 0)) d.setDate(d.getDate() - 1);
    while (true) {
      var k = fmtKey(d);
      if (daily[k] && daily[k].count > 0) { s++; d.setDate(d.getDate() - 1); }
      else break;
    }
    return s;
  }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function typeLabel(t) {
    return { single: "单选题", multiple: "多选题", judge: "判断题", short: "简答题" }[t] || t;
  }
  function optLetter(i) { return "ABCDE"[i]; }
  function isCorrect(q, selected) {
    if (q.type === "multiple") {
      return selected.slice().sort().join("") === q.answer.split("").sort().join("");
    }
    return selected.length === 1 && selected[0] === q.answer;
  }
  function correctAnswerDisplay(q) {
    if (q.type === "short") return q.refAnswer || "（无参考答案）";
    return q.answer.split("").map(function (ch) {
      var i = "ABCDE".indexOf(ch);
      return ch + ". " + (q.options[i] != null ? q.options[i] : "");
    }).join("；");
  }
  function getQ(id) { return BY_ID[id]; }

  /* ---------------- 抽题重复控制 ----------------
     记录每题当日被「展示」的时间戳，约束：
       · 同一题同一日出现次数 ≤ MAX_SAME_DAY
       · 连续 REPEAT_WINDOW_MS 内同一题出现 < 2 次（即至多 1 次）
  */
  var seen = loadK("epc_seen_v1", {}); // { "YYYY-MM-DD": { id: [ts,...] } }
  function saveSeen() { saveK("epc_seen_v1", seen); }
  function pruneSeen() {
    var cutoff = fmtKey(new Date(Date.now() - 8 * 24 * 3600 * 1000));
    Object.keys(seen).forEach(function (k) { if (k < cutoff) delete seen[k]; });
  }
  function markShown(id) {
    var k = todayKey();
    if (!seen[k]) seen[k] = {};
    if (!seen[k][id]) seen[k][id] = [];
    seen[k][id].push(Date.now());
    shownC[id] = (shownC[id] || 0) + 1; // 累计被抽次数（用于均衡抽取）
    pruneSeen(); saveSeen(); saveShownC();
  }
  function shownToday(id) {
    var d = seen[todayKey()];
    return d && d[id] ? d[id].length : 0;
  }
  function shownInWindow(id) {
    var d = seen[todayKey()];
    if (!d || !d[id]) return false;
    var cut = Date.now() - REPEAT_WINDOW_MS;
    for (var i = 0; i < d[id].length; i++) if (d[id][i] >= cut) return true;
    return false;
  }
  // 当日已答对记录（规则：一题单日答对后，当日不再出现）
  function saveCorrectDay() { saveK("epc_correct_v1", correctDay); }
  function pruneCorrectDay() {
    var cutoff = fmtKey(new Date(Date.now() - 8 * 24 * 3600 * 1000));
    Object.keys(correctDay).forEach(function (k) { if (k < cutoff) delete correctDay[k]; });
  }
  function markCorrectToday(id) {
    var k = todayKey();
    if (!correctDay[k]) correctDay[k] = {};
    correctDay[k][id] = true;
    pruneCorrectDay(); saveCorrectDay();
  }
  function correctToday(id) {
    var d = correctDay[todayKey()];
    return !!(d && d[id]);
  }
  // 是否从未作答过（用于「优先练习未答题」）
  function answeredEver(id) { return !!stats[id]; }

  // 近 N 日内，某题在其中出现过的「天数」（含今天）
  function recentDaysCount(id, days) {
    var cnt = 0;
    for (var i = 0; i < days; i++) {
      var d = new Date(); d.setDate(d.getDate() - i);
      var k = fmtKey(d);
      if (seen[k] && seen[k][id] && seen[k][id].length) cnt++;
    }
    return cnt;
  }
  // 加权抽取：权重越大越可能被选中
  function weightedPick(items, weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return items[Math.floor(Math.random() * items.length)];
    var r = Math.random() * total;
    for (i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
    return items[items.length - 1];
  }
  // 单题抽取权重
  function drawWeight(id, fullyCovered) {
    var w = 1;
    // 规则2：近 RECENCY_WINDOW_DAYS 日内出现过的题，概率递减
    var recent = recentDaysCount(id, RECENCY_WINDOW_DAYS);
    if (recent > 0) w *= Math.pow(RECENCY_FACTOR, recent);
    // 规则1：池内题目全部答过一次后，按累计被抽次数均衡——越少被抽权重越高
    if (fullyCovered) {
      var sc = shownC[id] || 0;
      w *= 1 / (1 + sc);
    }
    return w < 1e-9 ? 1e-9 : w; // 防止权重归零导致永远抽不到
  }

  function isEligible(id) {
    if (correctToday(id)) return false;               // 规则：当日已答对则当日不再出现
    if (shownToday(id) >= MAX_SAME_DAY) return false; // 当日同题已到上限
    if (shownInWindow(id)) return false;              // 20 分钟内已出现过
    return true;
  }
  // 从候选池中挑一道满足限制的题目；无候选人时逐级放宽，保证总能出题
  // 「当日已答对不再出现」为硬约束，仅在极端（全部答对/池耗尽）时才作最后兜底
  function drawId(pool) {
    if (!pool || pool.length === 0) return null;
    var cand = pool.filter(isEligible);
    if (cand.length === 0) cand = pool.filter(function (id) { return !correctToday(id) && shownToday(id) < MAX_SAME_DAY; });
    if (cand.length === 0) cand = pool.filter(function (id) { return !correctToday(id); });
    if (cand.length === 0) cand = pool; // 兜底：池内全部已答对，才允许再次出现，避免卡死
    // 整库（统一题库）题目是否全部已作答过（规则1 触发条件：整库全部答过一次后均衡抽取）
    // 注：按统一题库判定，而非按各模式题池，保证「全部答过」以整库 217 题为标准
    var fullyCovered = BANK.every(function (q) { return answeredEver(q.id); });
    // 未全部作答时，优先练习还未作答过的题目
    if (!fullyCovered) {
      var fresh = cand.filter(function (id) { return !answeredEver(id); });
      if (fresh.length) cand = fresh;
    }
    // 加权抽取：近 3 日降权 + （全部作答后）累计出现越少权重越高
    var weights = cand.map(function (id) { return drawWeight(id, fullyCovered); });
    var id = weightedPick(cand, weights);
    markShown(id);
    return id;
  }

  /* ---------------- 答题记录 ---------------- */
  function recordAnswer(q, correct) {
    if (!stats[q.id]) stats[q.id] = { correct: 0, wrong: 0 };
    if (correct) stats[q.id].correct++; else stats[q.id].wrong++;
    if (correct) markCorrectToday(q.id); // 当日答对 → 当日不再出现
    // 每日练习统计
    var t = todayStat();
    t.count++;
    if (correct) t.correct++; else t.wrong++;
    if (!correct) {
      if (!wrong[q.id]) wrong[q.id] = { wrongCount: 0, lastWrongTs: Date.now(), added: false };
      wrong[q.id].wrongCount++;
      wrong[q.id].lastWrongTs = Date.now();
    }
    saveAll();
  }
  function removeWrong(id) { delete wrong[id]; saveWrong(); toast("已移出错题本"); }
  function addWrongManual(id) {
    if (!wrong[id]) { wrong[id] = { wrongCount: 0, lastWrongTs: Date.now(), added: true }; saveWrong(); toast("已加入错题本"); }
  }
  function inWrong(id) { return !!wrong[id]; }

  /* ---------------- 通用答题卡片 ---------------- */
  // opts: { onAnswered(q,correct,selected), goNext(), extraActions(q,correct,selected) -> [btnSpec] }
  function renderQuizCard(parent, q, opts) {
    parent.innerHTML = "";
    var card = document.createElement("div");
    card.className = "card";
    var metaHtml = '<div class="meta-row">' +
      '<span class="badge">' + typeLabel(q.type) + "</span>" +
      (q.category ? '<span class="badge cat">' + esc(q.category) + "</span>" : "") +
      (q.knowledge ? '<span class="badge cat">知识点：' + esc(q.knowledge) + "</span>" : "") +
      (q.difficulty ? '<span class="badge diff">难度：' + esc(q.difficulty) + "</span>" : "") +
      "</div>";
    card.innerHTML = '<p class="stem">' + esc(q.stem) + "</p>" + metaHtml;

    var body = document.createElement("div");
    card.appendChild(body);

    var resultBox = document.createElement("div");
    resultBox.className = "result";
    card.appendChild(resultBox);

    parent.appendChild(card);

    var submitted = false;
    var selected = [];

    function buildResult(correct, selectedLetters) {
      resultBox.className = "result show " + (correct ? "ok" : "bad");
      var html = '<div class="ans-title">' + (correct ? "✓ 回答正确" : "✗ 回答错误") + "</div>";
      html += '<div>正确答案：' + esc(correctAnswerDisplay(q)) + "</div>";
      resultBox.innerHTML = html;

      var acts = document.createElement("div");
      acts.className = "actions";
      // 模式自定义按钮
      var extras = (opts.extraActions && opts.extraActions(q, correct, selectedLetters)) || [];
      extras.forEach(function (b) {
        var el = document.createElement("button");
        el.className = "btn " + (b.cls || "");
        el.textContent = b.label;
        el.onclick = b.onClick;
        acts.appendChild(el);
      });
      // 下一题
      var next = document.createElement("button");
      next.className = "btn primary";
      next.textContent = "下一题 →";
      next.onclick = function () { opts.goNext(); };
      acts.appendChild(next);
      resultBox.appendChild(acts);
    }

    if (q.type === "short") {
      // 简答题：自评 + 参考答案
      var refShown = false;
      var assessRow = document.createElement("div");
      assessRow.className = "actions";
      var showRef = document.createElement("button");
      showRef.className = "btn";
      showRef.textContent = "显示参考答案";
      showRef.onclick = function () {
        if (refShown) return;
        refShown = true;
        var ref = document.createElement("div");
        ref.className = "ref-answer";
        ref.innerHTML = "<b>参考答案：</b><br>" + esc(q.refAnswer || "（无）");
        body.appendChild(ref);
      };
      var okBtn = document.createElement("button");
      okBtn.className = "btn ok"; okBtn.textContent = "我答对了";
      var badBtn = document.createElement("button");
      badBtn.className = "btn bad"; badBtn.textContent = "我答错了";
      var onAssess = function (correct) {
        submitted = true;
        recordAnswer(q, correct);
        if (opts.onAnswered) opts.onAnswered(q, correct, []);
        buildResult(correct, []);
        // 隐藏自评按钮
        assessRow.style.display = "none";
      };
      okBtn.onclick = function () { onAssess(true); };
      badBtn.onclick = function () { onAssess(false); };
      assessRow.appendChild(showRef); assessRow.appendChild(okBtn); assessRow.appendChild(badBtn);
      body.appendChild(assessRow);
      return;
    }

    // 客观题
    var optWrap = document.createElement("div");
    optWrap.className = "options";
    var optEls = [];
    q.options.forEach(function (txt, i) {
      var L = optLetter(i);
      var o = document.createElement("div");
      o.className = "opt" + (q.type === "multiple" ? " multi" : "");
      o.innerHTML = '<div class="tick">' + L + "</div><div class='label'>" + esc(txt) + "</div>";
      o.onclick = function () {
        if (submitted) return;
        if (q.type === "multiple") {
          var idx = selected.indexOf(L);
          if (idx >= 0) { selected.splice(idx, 1); o.classList.remove("selected"); }
          else { selected.push(L); o.classList.add("selected"); }
        } else {
          selected = [L];
          optEls.forEach(function (e) { e.classList.remove("selected"); });
          o.classList.add("selected");
        }
      };
      optEls.push(o);
      optWrap.appendChild(o);
    });
    body.appendChild(optWrap);

    var actions = document.createElement("div");
    actions.className = "actions";
    var submit = document.createElement("button");
    submit.className = "btn primary";
    submit.textContent = "确认提交";
    submit.onclick = function () {
      if (submitted) return;
      if (selected.length === 0) { toast("请先选择答案"); return; }
      submitted = true;
      var correct = isCorrect(q, selected);
      optEls.forEach(function (o, i) {
        var L = optLetter(i);
        if (q.answer.indexOf(L) >= 0) o.classList.add("correct");
        else if (selected.indexOf(L) >= 0) o.classList.add("wrong");
      });
      recordAnswer(q, correct);
      if (opts.onAnswered) opts.onAnswered(q, correct, selected.slice());
      buildResult(correct, selected.slice());
    };
    actions.appendChild(submit);
    body.appendChild(actions);
  }

  /* ---------------- 顺序刷题（整体测试 / 错题练习 / 模块练习） ---------------- */
  // 改为「按需动态抽题」，每抽一道都遵守重复限制（当日≤3、20分钟内<2）
  function runOneByOne(key, getIds, infoFn, extraFor, sig) {
    var curKey = key + "Cur", nKey = key + "N", sigKey = key + "Sig";
    function drawNext() {
      var ids = getIds();
      if (!ids.length) { settings[curKey] = null; saveSettings(); return; }
      var id = drawId(ids);
      settings[curKey] = id;
      settings[nKey] = (settings[nKey] == null ? 0 : settings[nKey]) + 1;
      saveSettings();
    }
    // 初次进入 / 模块切换 / 当前题失效 → 抽新题
    if (settings[curKey] == null || !getQ(settings[curKey]) || settings[sigKey] !== sig) {
      settings[sigKey] = sig;
      drawNext();
    }
    function renderCurrent() {
      if (getIds().length === 0) { emptyState("没有可练习的题目"); return; }
      if (settings[curKey] == null) drawNext();
      var q = getQ(settings[curKey]);
      if (!q) { drawNext(); q = getQ(settings[curKey]); }
      if (!q) { emptyState("没有可练习的题目"); return; }
      var n = settings[nKey] || 1;
      renderQuizCard(app, q, {
        onAnswered: function () {},
        goNext: function () { drawNext(); renderCurrent(); },
        extraActions: function (qq, correct, sel) { return extraFor ? extraFor(qq, correct, sel) : []; }
      });
      updateModeInfo(infoFn(n, q));
    }
    renderCurrent();
  }

  /* ---------------- 模式：整体测试 ---------------- */
  function renderOverall() {
    if (BANK.length === 0) { emptyState("题库为空"); return; }
    runOneByOne("overall", function () { return BANK.map(function (q) { return q.id; }); },
      function (n) { return "整体测试 · 第 " + n + " 题（优先未答题·当日答对不再出现·每日≤3·20分钟内≤1·均衡抽取·近3日降权）"; },
      null);
  }

  /* ---------------- 模式：随机测试（10题，不含简答） ---------------- */
  function renderRandom() {
    var RANDOM_N = 10;
    var s = settings.randomSession;
    // 新会话仅初始化结构；题目在每一步动态抽取，遵守重复限制
    if (!s || s.finished || s.ids == null) {
      s = { ids: [], idx: 0, results: {}, finished: false, curId: null };
      settings.randomSession = s; saveSettings();
    }
    var poolAll = BANK.filter(function (q) { return q.type !== "short"; }).map(function (q) { return q.id; });
    if (poolAll.length === 0) { emptyState("没有可用于随机测试的题型"); return; }
    function drawForIndex() {
      // 优先从未在本轮出现的题中抽，再受全局重复限制约束
      var used = Object.keys(s.results).map(Number);
      var unused = poolAll.filter(function (id) { return used.indexOf(id) < 0; });
      var cand = unused.length ? unused : poolAll;
      var id = drawId(cand);
      s.ids[s.idx] = id; s.curId = id; saveSettings();
      return id;
    }
    function renderCurrent() {
      if (s.idx >= RANDOM_N) { return finishScreen(); }
      var id = s.curId;
      // 续练：当前题已抽取则直接复用（不重复计数）；否则新抽
      if (id == null || s.ids[s.idx] !== id) id = drawForIndex();
      var q = getQ(id);
      if (!q) { s.curId = null; id = drawForIndex(); q = getQ(id); }
      if (!q) { emptyState("没有可练习的题目"); return; }
      renderQuizCard(app, q, {
        onAnswered: function (qq, correct) { s.results[qq.id] = correct; saveSettings(); },
        goNext: function () { s.idx++; s.curId = null; saveSettings(); renderCurrent(); },
        extraActions: function () { return []; }
      });
      updateModeInfo("随机测试（不含简答）· 第 " + (s.idx + 1) + " / " + RANDOM_N + " 题");
    }
    function finishScreen() {
      s.finished = true; saveSettings();
      var total = s.ids.length;
      var correct = 0;
      s.ids.forEach(function (id) { if (s.results[id]) correct++; });
      var rate = total ? Math.round((correct / total) * 100) : 0;
      updateModeInfo("本次测试完成");
      app.innerHTML = "";
      var card = document.createElement("div");
      card.className = "card";
      var wrongIds = s.ids.filter(function (id) { return !s.results[id]; });
      var html = "<h3 style='margin-top:0'>测试成绩</h3>";
      html += "<div class='stat-grid' style='margin:14px 0'>";
      html += statBox(correct, "答对题数");
      html += statBox(total - correct, "答错题数");
      html += statBox(rate + "%", "正确率");
      html += "</div>";
      if (wrongIds.length) {
        html += "<h4>本次答错的题目</h4>";
        wrongIds.forEach(function (id) {
          var q = getQ(id);
          html += "<div class='qitem' data-id='" + id + "'><div class='qi-stem'>" + esc(q.stem) + "</div>" +
            "<div class='qi-meta'><span class='badge'>" + typeLabel(q.type) + "</span>" +
            (q.category ? "<span class='badge cat'>" + esc(q.category) + "</span>" : "") + "</div>" +
            "<div class='qi-ans mark-wrong'>正确答案：" + esc(correctAnswerDisplay(q)) + "</div></div>";
        });
      } else {
        html += "<p class='empty'>🎉 全部答对，太棒了！</p>";
      }
      var acts = document.createElement("div");
      acts.className = "actions";
      var again = document.createElement("button");
      again.className = "btn primary"; again.textContent = "再测一次";
      again.onclick = function () { settings.randomSession = null; saveSettings(); renderRandom(); };
      var back = document.createElement("button");
      back.className = "btn"; back.textContent = "返回整体测试";
      back.onclick = function () { setMode("overall"); };
      acts.appendChild(again); acts.appendChild(back);
      card.innerHTML = html;
      card.appendChild(acts);
      app.appendChild(card);
      // 点击错题查看详情
      Array.prototype.forEach.call(card.querySelectorAll(".qitem"), function (el) {
        el.onclick = function () { openDetail(parseInt(el.getAttribute("data-id"), 10)); };
      });
    }
    renderCurrent();
  }

  /* ---------------- 模式：错题汇总 ---------------- */
  function renderWrongList() {
    var ids = Object.keys(wrong).map(Number);
    if (ids.length === 0) { emptyState("还没有错题，继续加油！"); return; }
    updateModeInfo("共 " + ids.length + " 道错题");
    app.innerHTML = "";
    // 操作条
    var bar = document.createElement("div");
    bar.className = "actions";
    bar.style.marginBottom = "14px";
    var clear = document.createElement("button");
    clear.className = "btn bad"; clear.textContent = "清空错题本";
    clear.onclick = function () {
      if (confirm("确定清空全部错题？此操作不可恢复。")) { wrong = {}; saveWrong(); toast("已清空错题本"); renderWrongList(); }
    };
    var practice = document.createElement("button");
    practice.className = "btn primary"; practice.textContent = "去错题练习";
    practice.onclick = function () { setMode("wrongPractice"); };
    bar.appendChild(practice); bar.appendChild(clear);
    app.appendChild(bar);

    ids.forEach(function (id) {
      var q = getQ(id); if (!q) return;
      var w = wrong[id];
      var item = document.createElement("div");
      item.className = "qitem";
      var lastWrong = w.lastWrongTs ? new Date(w.lastWrongTs).toLocaleString("zh-CN") : "—";
      item.innerHTML =
        "<div class='qi-meta'><span class='badge'>" + typeLabel(q.type) + "</span>" +
        (q.category ? "<span class='badge cat'>" + esc(q.category) + "</span>" : "") +
        "<span class='badge diff'>答错 " + w.wrongCount + " 次</span></div>" +
        "<div class='qi-stem'>" + esc(q.stem) + "</div>" +
        "<div class='qi-ans'>最近答错：" + lastWrong + "</div>";
      item.onclick = function () { openDetail(id); };
      app.appendChild(item);
    });
  }

  /* ---------------- 模式：错题练习 ---------------- */
  function renderWrongPractice() {
    var ids = Object.keys(wrong).map(Number);
    if (ids.length === 0) { emptyState("错题本为空，去“整体测试”或“随机测试”积累错题吧！"); return; }
    runOneByOne("wrongPractice",
      function () { return Object.keys(wrong).map(Number); },
      function (n) { return "错题练习 · 第 " + n + " 题（同一题每日≤3、20分钟内≤1）"; },
      function (q, correct, sel) {
        var btns = [];
        btns.push({
          label: "移出错题本", cls: "btn ghost",
          onClick: function () {
            removeWrong(q.id);
            settings.wrongPracticeCur = null; settings.wrongPracticeN = null; saveSettings();
            renderWrongPractice();
          }
        });
        if (inWrong(q.id)) {
          btns.push({ label: "保留并继续", cls: "btn", onClick: function () { toast("已保留在错题本"); } });
        }
        return btns;
      });
  }

  /* ---------------- 模式：按科目类别分模块练习 ---------------- */
  function renderCategoryList() {
    inCategoryPractice = false;
    updateModeInfo("按科目类别分模块练习");
    app.innerHTML = "";
    var cats = {};
    BANK.forEach(function (q) { var c = q.category || "（未分类）"; (cats[c] = cats[c] || []).push(q.id); });
    var names = Object.keys(cats).sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });

    var tip = document.createElement("p");
    tip.className = "cat-tip";
    tip.textContent = "选择一个科目类别开始模块练习（抽题顺序随机，可断点续练）。";
    app.appendChild(tip);

    var grid = document.createElement("div");
    grid.className = "cat-grid";
    names.forEach(function (name) {
      var ids = cats[name];
      var done = ids.filter(function (id) { var s = stats[id]; return s && (s.correct + s.wrong) > 0; });
      var p = ids.length ? Math.round((done.length / ids.length) * 100) : 0;
      var item = document.createElement("button");
      item.className = "cat-card";
      item.innerHTML =
        "<div class='cat-name'>" + esc(name) + "</div>" +
        "<div class='cat-meta'>" + done.length + " / " + ids.length + " 已练习</div>" +
        "<div class='cat-bar'><span style='width:" + p + "%'></span></div>";
      item.onclick = function () { startCategoryPractice(name); };
      grid.appendChild(item);
    });
    app.appendChild(grid);
  }
  function startCategoryPractice(cat) {
    inCategoryPractice = true;
    var ids = BANK.filter(function (q) { return (q.category || "（未分类）") === cat; }).map(function (q) { return q.id; });
    if (!ids.length) { emptyState("该科目暂无题目"); return; }
    runOneByOne("category", function () { return ids; },
      function (n) { return "模块练习 · " + cat + " · 第 " + n + " 题（同一题每日≤3、20分钟内≤1）"; },
      null, cat);
  }

  /* ---------------- 模式：题目搜索 ---------------- */
  function renderSearch() {
    updateModeInfo("按关键字检索题干 / 选项 / 答案 / 科目");
    app.innerHTML = "";
    var bar = document.createElement("div");
    bar.className = "search-bar";
    var input = document.createElement("input");
    input.type = "text"; input.placeholder = "输入关键字，如：限额设计、EPC、招采…";
    bar.appendChild(input);
    app.appendChild(bar);

    var chips = document.createElement("div");
    chips.className = "chips";
    var types = [["all", "全部"], ["single", "单选"], ["multiple", "多选"], ["judge", "判断"], ["short", "简答"]];
    var activeType = "all";
    types.forEach(function (t) {
      var c = document.createElement("span");
      c.className = "chip" + (t[0] === "all" ? " active" : "");
      c.textContent = t[1]; c.setAttribute("data-t", t[0]);
      c.onclick = function () {
        activeType = t[0];
        Array.prototype.forEach.call(chips.children, function (x) { x.classList.remove("active"); });
        c.classList.add("active");
        doFilter();
      };
      chips.appendChild(c);
    });
    app.appendChild(chips);

    var count = document.createElement("div");
    count.className = "result-count";
    app.appendChild(count);

    var list = document.createElement("div");
    app.appendChild(list);

    function doFilter() {
      var kw = input.value.trim().toLowerCase();
      var res = BANK.filter(function (q) {
        if (activeType !== "all" && q.type !== activeType) return false;
        if (!kw) return true;
        var hay = [q.stem, q.category, q.knowledge, q.refAnswer, q.answer]
          .concat(q.options || []).join(" ").toLowerCase();
        return hay.indexOf(kw) >= 0;
      });
      count.textContent = "匹配到 " + res.length + " 道题";
      list.innerHTML = "";
      if (res.length === 0) { list.innerHTML = "<div class='empty'>没有匹配的题目</div>"; return; }
      res.slice(0, 300).forEach(function (q) {
        var item = document.createElement("div");
        item.className = "qitem";
        var ansText = q.type === "short" ? ("参考答案：" + (q.refAnswer || "—")) : ("正确答案：" + correctAnswerDisplay(q));
        var wmark = inWrong(q.id) ? " <span class='mark-wrong'>[错题]</span>" : "";
        item.innerHTML =
          "<div class='qi-meta'><span class='badge'>" + typeLabel(q.type) + "</span>" +
          (q.category ? "<span class='badge cat'>" + esc(q.category) + "</span>" : "") + wmark + "</div>" +
          "<div class='qi-stem'>" + esc(q.stem) + "</div>" +
          "<div class='qi-ans'>" + esc(ansText) + "</div>";
        item.onclick = function () { openDetail(q.id); };
        list.appendChild(item);
      });
    }
    input.addEventListener("input", doFilter);
    doFilter();
  }

  /* ---------------- 模式：我的进度 ---------------- */
  function renderProgress() {
    updateModeInfo("答题练习进度概览");
    var total = BANK.length;
    var practicedIds = Object.keys(stats).filter(function (id) { var s = stats[id]; return s && (s.correct + s.wrong) > 0; });
    var correctSum = 0, wrongSum = 0;
    practicedIds.forEach(function (id) { correctSum += stats[id].correct; wrongSum += stats[id].wrong; });
    var answered = correctSum + wrongSum;
    var rate = answered ? Math.round((correctSum / answered) * 100) : 0;
    var wrongCount = Object.keys(wrong).length;
    var t = todayStat();

    app.innerHTML = "";
    var card = document.createElement("div");
    card.className = "card";
    var html = "<h3 style='margin-top:0'>练习概览</h3><div class='stat-grid'>";
    html += statBox(total, "题库总数");
    html += statBox(practicedIds.length, "已练习");
    html += statBox(answered, "累计作答");
    html += statBox(rate + "%", "总正确率");
    html += statBox(wrongCount, "当前错题");
    html += "</div>";

    // 今日目标
    var pct = Math.min(100, Math.round((t.count / DAILY_GOAL) * 100));
    html += "<h4 style='margin:22px 0 10px'>今日目标（" + DAILY_GOAL + " 题）</h4>";
    html += "<div class='today-row'>";
    html += ringSvg(pct, 84, 9);
    html += "<div class='today-info'>";
    html += "<div class='today-num'>" + t.count + " / " + DAILY_GOAL + " 题</div>";
    if (t.count >= DAILY_GOAL) html += "<div class='today-state ok'>🎉 今日目标已达成！</div>";
    else html += "<div class='today-state'>还差 <b>" + (DAILY_GOAL - t.count) + "</b> 题完成今日目标</div>";
    html += "<div class='today-sub'>今日正确率 " + (t.count ? Math.round((t.correct / t.count) * 100) : 0) + "% ｜ 连续打卡 " + streakDays() + " 天</div>";
    html += "</div></div>";

    // 近 7 日练习
    html += last7Chart();

    // 各题型进度
    html += "<h4 style='margin:24px 0 10px'>各题型进度</h4><div class='progress-list'>";
    ["single", "multiple", "judge", "short"].forEach(function (tp) {
      var all = BANK.filter(function (q) { return q.type === tp; });
      var done = all.filter(function (q) { var s = stats[q.id]; return s && (s.correct + s.wrong) > 0; });
      var p = all.length ? Math.round((done.length / all.length) * 100) : 0;
      html += "<div class='pl-row'><div class='pl-name'>" + typeLabel(tp) + "</div>" +
        "<div class='pl-bar bar'><span style='width:" + p + "%'></span></div>" +
        "<div style='width:90px;text-align:right;color:#6b7280;font-size:13px'>" + done.length + "/" + all.length + "</div></div>";
    });
    html += "</div>";
    card.innerHTML = html;
    app.appendChild(card);

    // 云端同步卡片
    var scard = document.createElement("div");
    scard.className = "card sync-card";
    scard.innerHTML = syncCardHtml();
    app.appendChild(scard);
    bindSyncCard(scard);
  }

  function syncCardHtml() {
    var uid = getUid();
    var html = "<h3 style='margin-top:0'>☁ 云端同步（跨设备）</h3>";
    html += "<div class='sync-status js-sync-status'>" + syncLabel() + "</div>";
    html += "<div class='sync-row'><span class='sync-k'>同步码</span><code class='sync-code' id='syncCode'>" + uid + "</code>" +
            "<button class='btn sm' id='copyUid'>复制</button></div>";
    html += "<div class='sync-tip'>把同一同步码填到其它设备，练习记录即自动同步。同步码即密钥，请勿泄露。</div>";
    html += "<div class='sync-actions'>" +
            "<button class='btn' id='syncNow'>立即同步</button>" +
            "<button class='btn ghost' id='exportBtn'>导出备份</button>" +
            "<button class='btn ghost' id='importBtn'>导入备份</button></div>";
    html += "<div class='sync-row' style='margin-top:10px'><input id='uidInput' class='sync-input' placeholder='输入 / 更换同步码' /><button class='btn sm' id='setUid'>设置</button></div>";
    html += "<input type='file' id='importFile' accept='application/json' style='display:none' />";
    return html;
  }
  function bindSyncCard(root) {
    var codeEl = root.querySelector("#syncCode");
    var copyBtn = root.querySelector("#copyUid");
    if (copyBtn) copyBtn.onclick = function () {
      var u = getUid();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(u).then(function () { toast("同步码已复制"); },
          function () { toast("复制失败，请手动选择文本"); });
      } else { toast("请手动复制：" + u); }
    };
    var nowBtn = root.querySelector("#syncNow");
    if (nowBtn) nowBtn.onclick = function () { syncNow(); toast("正在同步…"); };
    var setBtn = root.querySelector("#setUid");
    if (setBtn) setBtn.onclick = function () {
      var v = (root.querySelector("#uidInput").value || "").trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) { toast("同步码需 8–64 位字母/数字"); return; }
      settings.syncUid = v; settings.lastSyncTs = 0; saveSettings();
      if (codeEl) codeEl.textContent = v;
      toast("同步码已设置，正在同步…");
      syncNow();
    };
    var expBtn = root.querySelector("#exportBtn");
    if (expBtn) expBtn.onclick = function () {
      var data = { uid: getUid(), exportedAt: Date.now(), payload: snapshot() };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "epc-backup-" + fmtKey(new Date()) + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast("已导出备份");
    };
    var impBtn = root.querySelector("#importBtn");
    var fileEl = root.querySelector("#importFile");
    if (impBtn && fileEl) impBtn.onclick = function () { fileEl.click(); };
    if (fileEl) fileEl.onchange = function () {
      var f = fileEl.files && fileEl.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          if (d && d.payload) {
            applySnapshot(d.payload);
            settings.lastSyncTs = d.exportedAt || Date.now();
            saveSettings();
            rerenderCurrent();
            toast("已从备份导入");
          } else { toast("导入失败：缺少数据"); }
        } catch (e) { toast("导入失败：文件格式错误"); }
      };
      rd.readAsText(f);
    };
  }

  function last7Chart() {
    var d = new Date();
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var dd = new Date(d); dd.setDate(d.getDate() - i);
      var k = fmtKey(dd);
      var rec = daily[k] || { count: 0, correct: 0 };
      var wk = ["日", "一", "二", "三", "四", "五", "六"][dd.getDay()];
      var mm = (dd.getMonth() + 1 < 10 ? "0" : "") + (dd.getMonth() + 1);
      var dd2 = (dd.getDate() < 10 ? "0" : "") + dd.getDate();
      days.push({
        label: mm + "-" + dd2 + " 周" + wk,
        count: rec.count,
        acc: rec.count ? Math.round((rec.correct / rec.count) * 100) : null,
        isToday: i === 0
      });
    }
    // 从左到右日期递增：最左为 6 天前，最右为今天（idx0=最早，idx6=今日）

    var W = 720, H = 250, padL = 46, padR = 40, padT = 24, padB = 38;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = days.length;
    var xFor = function (idx) { return padL + (n === 1 ? plotW / 2 : plotW * idx / (n - 1)); };
    var maxCount = DAILY_GOAL;
    days.forEach(function (dy) { if (dy.count > maxCount) maxCount = dy.count; });
    var yCount = function (v) { return padT + plotH * (1 - v / maxCount); };
    var yAcc = function (v) { return padT + plotH * (1 - v / 100); };

    // 仅取「有数据」的点（count>0 / acc 非空），空日置 null —— 曲线只在有数据的点之间连成
    var countPts = days.map(function (dy, idx) { return dy.count > 0 ? xFor(idx) + "," + yCount(dy.count) : null; }).filter(Boolean);
    var accPts = days.map(function (dy, idx) { return dy.acc != null ? xFor(idx) + "," + yAcc(dy.acc) : null; }).filter(Boolean);

    var svg = "<svg class='wk-svg' viewBox='0 0 " + W + " " + H + "' preserveAspectRatio='xMidYMid meet'>";
    // 横向网格 + 左轴(完成数量) & 右轴(准确率)
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      var y = padT + plotH * (1 - p);
      svg += "<line x1='" + padL + "' y1='" + y + "' x2='" + (W - padR) + "' y2='" + y + "' stroke='#eef2f7' stroke-width='1'/>";
      svg += "<text x='" + (padL - 6) + "' y='" + (y + 4) + "' text-anchor='end' font-size='11' fill='#94a3b8'>" + Math.round(maxCount * p) + "</text>";
      svg += "<text x='" + (W - padR + 6) + "' y='" + (y + 4) + "' text-anchor='start' font-size='11' fill='#94a3b8'>" + Math.round(100 * p) + "%</text>";
    });
    // 目标线（完成数量 = DAILY_GOAL）
    var gy = yCount(DAILY_GOAL);
    svg += "<line x1='" + padL + "' y1='" + gy + "' x2='" + (W - padR) + "' y2='" + gy + "' stroke='#f59e0b' stroke-width='1.5' stroke-dasharray='5 4'/>";
    svg += "<text x='" + (W - padR) + "' y='" + (gy - 5) + "' text-anchor='end' font-size='11' fill='#d97706'>目标 " + DAILY_GOAL + "</text>";
    // 准确率曲线（绿）—— 仅在有数据（≥2 点）时连线
    if (accPts.length > 1) svg += "<polyline points='" + accPts.join(" ") + "' fill='none' stroke='#16a34a' stroke-width='2.5' stroke-linejoin='round'/>";
    else if (accPts.length === 1) { var a = accPts[0].split(","); svg += "<circle cx='" + a[0] + "' cy='" + a[1] + "' r='3.5' fill='#16a34a'/>"; }
    // 完成数量曲线（蓝）—— 仅在有数据（≥2 点）时连线
    if (countPts.length > 1) svg += "<polyline points='" + countPts.join(" ") + "' fill='none' stroke='#2563eb' stroke-width='2.5' stroke-linejoin='round'/>";
    else if (countPts.length === 1) { var c = countPts[0].split(","); svg += "<circle cx='" + c[0] + "' cy='" + c[1] + "' r='3.5' fill='#2563eb'/>"; }
    // 数据点 + 数值标注：空日（未练习）不显示答题数与准确率，仅保留日期标签
    days.forEach(function (dy, idx) {
      var cx = xFor(idx);
      if (dy.count > 0) {
        svg += "<circle cx='" + cx + "' cy='" + yCount(dy.count) + "' r='3.5' fill='#2563eb'/>";
        svg += "<text x='" + cx + "' y='" + (yCount(dy.count) - 9) + "' text-anchor='middle' font-size='11' font-weight='700' fill='#1d4ed8'>" + dy.count + "</text>";
      }
      if (dy.acc != null) {
        svg += "<circle cx='" + cx + "' cy='" + yAcc(dy.acc) + "' r='3.5' fill='#16a34a'/>";
        svg += "<text x='" + cx + "' y='" + (yAcc(dy.acc) + 16) + "' text-anchor='middle' font-size='11' font-weight='700' fill='#15803d'>" + dy.acc + "%</text>";
      }
      var lblCls = dy.isToday ? "wk-xl today" : "wk-xl";
      svg += "<text class='" + lblCls + "' x='" + cx + "' y='" + (H - padB + 20) + "' text-anchor='middle' font-size='12'>" + dy.label + "</text>";
    });
    svg += "</svg>";

    var html = "<h4 style='margin:24px 0 10px'>近 7 日练习（最近 7 天，右端为今日）</h4>";
    html += "<div class='week-legend' style='margin-bottom:6px'><span class='lg-line c-blue'></span>完成数量（左轴）　<span class='lg-line c-green'></span>准确率（右轴）</div>";
    html += svg;
    return html;
  }

  function ringSvg(pct, size, stroke) {
    pct = Math.max(0, Math.min(100, pct));
    var r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    var color = pct >= 100 ? "#16a34a" : "#1d4ed8";
    return "<svg width='" + size + "' height='" + size + "' viewBox='0 0 " + size + " " + size + "'>" +
      "<circle cx='" + (size / 2) + "' cy='" + (size / 2) + "' r='" + r + "' fill='none' stroke='#eef2f7' stroke-width='" + stroke + "'/>" +
      "<circle cx='" + (size / 2) + "' cy='" + (size / 2) + "' r='" + r + "' fill='none' stroke='" + color + "' stroke-width='" + stroke + "' stroke-linecap='round' stroke-dasharray='" + c + "' stroke-dashoffset='" + off + "' transform='rotate(-90 " + (size / 2) + " " + (size / 2) + ")'/>" +
      "<text x='50%' y='50%' text-anchor='middle' dominant-baseline='central' font-size='" + Math.round(size * 0.26) + "' font-weight='700' fill='#1f2937'>" + pct + "%</text>" +
      "</svg>";
  }

  function statBox(num, lbl) {
    return "<div class='stat'><div class='num'>" + num + "</div><div class='lbl'>" + lbl + "</div></div>";
  }

  /* ---------------- 题目详情弹窗 ---------------- */
  var modalRoot = document.getElementById("modalRoot");
  var modalBox = document.getElementById("modalBox");
  function closeModal() { modalRoot.classList.add("hidden"); }
  modalRoot.querySelector(".modal-mask").onclick = closeModal;

  function openDetail(id) {
    var q = getQ(id); if (!q) return;
    var html = "<button class='close' onclick='window.__closeModal()'>×</button>";
    html += "<p class='stem'>" + esc(q.stem) + "</p>";
    html += "<div class='meta-row'><span class='badge'>" + typeLabel(q.type) + "</span>" +
      (q.category ? "<span class='badge cat'>" + esc(q.category) + "</span>" : "") + "</div>";
    if (q.type !== "short" && q.options && q.options.length) {
      html += "<div class='options'>";
      q.options.forEach(function (txt, i) {
        var L = optLetter(i);
        var cls = "opt" + (q.answer.indexOf(L) >= 0 ? " correct" : "");
        html += "<div class='" + cls + "'><div class='tick'>" + L + "</div><div class='label'>" + esc(txt) + "</div></div>";
      });
      html += "</div>";
    }
    html += "<div class='result show " + (q.type === "short" ? "" : "ok") + "'>";
    html += "<div class='ans-title'>正确答案</div>" + esc(correctAnswerDisplay(q)) + "</div>";
    html += "<div class='actions'><button class='btn' id='__wbtn'>" +
      (inWrong(id) ? "移出错题本" : "加入错题本") + "</button></div>";
    modalBox.innerHTML = html;
    modalRoot.classList.remove("hidden");
    document.getElementById("__wbtn").onclick = function () {
      if (inWrong(id)) removeWrong(id); else addWrongManual(id);
      openDetail(id); // 刷新
    };
  }
  window.__closeModal = closeModal;

  /* ---------------- 首页（图标入口） ---------------- */
  var ICONS = {
    overall: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='16 3 21 3 21 8'/><line x1='4' y1='20' x2='21' y2='3'/><polyline points='21 16 21 21 16 21'/><line x1='15' y1='15' x2='21' y2='21'/><line x1='4' y1='4' x2='9' y2='9'/></svg>",
    random: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='3'/><circle cx='8.5' cy='8.5' r='1.2' fill='currentColor'/><circle cx='15.5' cy='15.5' r='1.2' fill='currentColor'/><circle cx='12' cy='12' r='1.2' fill='currentColor'/></svg>",
    wrongList: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'/><line x1='12' y1='9' x2='12' y2='13'/><line x1='12' y1='17' x2='12.01' y2='17'/></svg>",
    wrongPractice: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><circle cx='12' cy='12' r='5'/><circle cx='12' cy='12' r='1.5' fill='currentColor'/></svg>",
    search: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='7'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg>",
    progress: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='6' y1='20' x2='6' y2='12'/><line x1='12' y1='20' x2='12' y2='4'/><line x1='18' y1='20' x2='18' y2='9'/></svg>",
    goal: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z'/><line x1='4' y1='22' x2='4' y2='15'/></svg>",
    grid: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7'/><rect x='14' y='3' width='7' height='7'/><rect x='14' y='14' width='7' height='7'/><rect x='3' y='14' width='7' height='7'/></svg>"
  };

  var FEATURES = [
    { key: "overall", title: "整体测试", desc: "每次随机一题，覆盖全部题型", cls: "c-blue", icon: ICONS.overall, fn: function () { setMode("overall"); } },
    { key: "random", title: "随机测试", desc: "每次 10 题（不含简答），交卷出成绩", cls: "c-purple", icon: ICONS.random, fn: function () { setMode("random"); } },
    { key: "wrongPractice", title: "错题练习", desc: "只在错题本里抽题，可手动移除", cls: "c-amber", icon: ICONS.wrongPractice, fn: function () { setMode("wrongPractice"); } },
    { key: "wrongList", title: "错题汇总", desc: "查看所有错题与答错次数", cls: "c-red", icon: ICONS.wrongList, fn: function () { setMode("wrongList"); } },
    { key: "search", title: "题目搜索", desc: "按关键字检索题目与答案", cls: "c-teal", icon: ICONS.search, fn: function () { setMode("search"); } },
    { key: "category", title: "模块练习", desc: "按科目类别分模块刷题", cls: "c-green", icon: ICONS.grid, fn: function () { setMode("category"); } },
    { key: "progress", title: "我的进度", desc: "练习概览 · 每日目标 · 近 7 日", cls: "c-indigo", icon: ICONS.progress, fn: function () { setMode("progress"); } }
  ];

  function renderHome() {
    app.innerHTML = "";
    var t = todayStat();
    var pct = Math.min(100, Math.round((t.count / DAILY_GOAL) * 100));

    // 今日目标横幅
    var banner = document.createElement("div");
    banner.className = "daily-goal";
    var done = t.count >= DAILY_GOAL;
    banner.innerHTML =
      "<div class='dg-icon'>" + ICONS.goal + "</div>" +
      "<div class='dg-main'>" +
        "<div class='dg-title'>今日练习目标 · " + DAILY_GOAL + " 题</div>" +
        "<div class='dg-bar'><span style='width:" + pct + "%' class='" + (done ? "done" : "") + "'></span></div>" +
        "<div class='dg-sub'>" +
          (done ? "🎉 今日目标已达成，继续保持！" : "已完成 <b>" + t.count + "</b> / " + DAILY_GOAL + " 题，还差 <b>" + (DAILY_GOAL - t.count) + "</b> 题") +
          " ｜ 连续打卡 <b>" + streakDays() + "</b> 天" +
          " ｜ <span class='js-sync-status'>" + syncLabel() + "</span>" +
        "</div>" +
      "</div>" +
      "<div class='dg-ring'>" + ringSvg(pct, 76, 8) + "</div>";
    app.appendChild(banner);

    // 图标网格
    var grid = document.createElement("div");
    grid.className = "home-grid";
    FEATURES.forEach(function (f) {
      var card = document.createElement("button");
      card.className = "home-card " + f.cls;
      card.innerHTML =
        "<div class='hc-icon'>" + f.icon + "</div>" +
        "<div class='hc-text'><div class='hc-title'>" + f.title + "</div>" +
        "<div class='hc-desc'>" + f.desc + "</div></div>" +
        "<div class='hc-arrow'>→</div>";
      card.onclick = f.fn;
      grid.appendChild(card);
    });
    app.appendChild(grid);
  }

  /* ---------------- 通用 ---------------- */
  var app = document.getElementById("app");
  var subbar = document.getElementById("subbar");
  function updateModeInfo(txt) { document.getElementById("modeInfo").textContent = txt; }
  function emptyState(msg) {
    app.innerHTML = "<div class='empty'><div class='big'>📭</div>" + esc(msg) + "</div>";
  }

  var MODE_TITLE = {
    overall: "整体测试", random: "随机测试", wrongList: "错题汇总",
    wrongPractice: "错题练习", search: "题目搜索", category: "模块练习", progress: "我的进度"
  };
  var currentMode = null;
  var inCategoryPractice = false;
  function goHome() {
    subbar.classList.add("hidden");
    renderHome();
  }
  function onBack() {
    if (currentMode === "category" && inCategoryPractice) { renderCategoryList(); }
    else { goHome(); }
  }
  function setMode(mode) {
    settings.lastMode = mode; saveSettings();
    currentMode = mode;
    subbar.classList.remove("hidden");
    document.getElementById("modeTitle").textContent = MODE_TITLE[mode] || "";
    updateModeInfo("");
    if (mode === "overall") renderOverall();
    else if (mode === "random") renderRandom();
    else if (mode === "wrongList") renderWrongList();
    else if (mode === "wrongPractice") renderWrongPractice();
    else if (mode === "search") renderSearch();
    else if (mode === "category") renderCategoryList();
    else if (mode === "progress") renderProgress();
  }

  document.getElementById("backBtn").onclick = onBack;

  // 题库信息
  (function () {
    var s = BANK.length ? ("已加载 " + BANK.length + " 道题（单选/多选/判断/简答）") : "未找到题库数据";
    document.getElementById("bankMeta").textContent = s;
  })();

  // 若通过链接带 ?uid= 进入，自动采用该同步码
  (function parseUid() {
    try {
      var p = new URLSearchParams(location.search);
      var u = p.get("uid");
      if (u && /^[A-Za-z0-9_-]{8,64}$/.test(u)) { settings.syncUid = u; saveSettings(); }
    } catch (e) {}
  })();

  // 启动：先尝试从云端拉取（若已连接同步服务），再渲染首页
  pullSync(function () { rerenderCurrent(); });
  startAutoSync(); // 开启后台每 12 秒自动拉取，实现免点同步
  goHome();
})();
