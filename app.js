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
  var APP_VERSION = "1.8";         // 应用版本号（双段式 MAJOR.ITERATION，详见 CHANGELOG.md）

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
  var lastPushAt = 0;           // 上次实际发起推送的时间戳（用于最小同步间隔节流）
  var SYNC_MIN_INTERVAL = 30000; // 两次云端同步最小间隔 30 秒，避免高频请求触发平台配额
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
    // 距上次推送不足最小间隔时，把防抖时间顺延到刚好满足间隔，避免高频请求
    var wait = 700;
    var since = Date.now() - lastPushAt;
    if (since < SYNC_MIN_INTERVAL) wait = SYNC_MIN_INTERVAL - since;
    pushTimer = setTimeout(pushSync, wait);
  }
  function pushSync() {
    if (applyingRemote) return;
    var uid = getUid();
    var payload = snapshot();
    var ts = Date.now();
    lastPushAt = ts; // 记录本次推送发起时间，供节流判断
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
    }, 60000);
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

  /* ---------------- 方案②：设备配对（免同步码、免注册） ---------------- */
  function openPair() {
    var modal = document.getElementById("pairModal");
    var linkEl = document.getElementById("pairLink");
    var qrEl = document.getElementById("pairQr");
    if (!modal || !linkEl || !qrEl) { toast("配对组件未加载"); return; }
    fetch("/api/pair/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket: getUid() })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.token) { toast("生成配对链接失败"); return; }
      var url = location.origin + "/?pair=" + encodeURIComponent(j.token);
      linkEl.textContent = url;
      qrEl.innerHTML = "";
      var img = document.createElement("img");
      img.alt = "配对二维码";
      img.src = "https://api.qrserver.com/v1/create-qr-code/?size=168x168&data=" + encodeURIComponent(url);
      qrEl.appendChild(img);
      modal.classList.add("show");
    }).catch(function () { toast("生成配对链接失败，请检查网络"); });
  }
  function closePair() {
    var m = document.getElementById("pairModal");
    if (m) m.classList.remove("show");
  }
  function copyPair() {
    var t = document.getElementById("pairLink");
    if (!t || !t.textContent) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t.textContent).then(function () { toast("链接已复制"); },
        function () { toast("复制失败，请手动复制"); });
    } else { toast("请手动复制：" + t.textContent); }
  }
  // 通过 ?pair= 链接进入：加入同一份同步数据
  (function parsePair() {
    try {
      var p = new URLSearchParams(location.search);
      var token = p.get("pair");
      if (!token) return;
      fetch("/api/pair/accept?pair=" + encodeURIComponent(token), { method: "GET" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.bucket) {
            settings.syncUid = j.bucket; settings.lastSyncTs = 0; saveSettings();
            try { history.replaceState({}, "", location.pathname); } catch (e) {}
            toast("已加入同步，正在同步数据…");
            syncNow();
          } else {
            toast("配对失败：链接无效或已过期");
          }
        })
        .catch(function () { toast("配对失败，请检查网络"); });
    } catch (e) {}
  })();

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
    if (!daily[k]) daily[k] = { count: 0, correct: 0, wrong: 0, obj: 0 };
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
  function drawId(pool, relax) {
    if (!pool || pool.length === 0) return null;
    // 错题库模式：纯随机等概率抽取，跳过「每日≤3、20分钟内≤1」限制与加权，每道错题被抽到概率相同
    if (relax) {
      var rid = pool[Math.floor(Math.random() * pool.length)];
      markShown(rid);
      return rid;
    }
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
    t.count++; t.obj++; // obj=客观题计题量（准确率分母）；简答题仅计入 count
    if (correct) t.correct++; else t.wrong++;
    if (!correct) {
      if (!wrong[q.id]) wrong[q.id] = { wrongCount: 0, lastWrongTs: Date.now(), added: false, rightStreak: 0 };
      wrong[q.id].wrongCount++;
      wrong[q.id].lastWrongTs = Date.now();
      wrong[q.id].rightStreak = 0; // 答错 → 连续答对计数清零
    } else if (wrong[q.id]) {
      // 答对且在错题库 → 连续答对计数 +1（达 5 次由 UI 弹窗确认是否移除）
      wrong[q.id].rightStreak = (wrong[q.id].rightStreak || 0) + 1;
    }
    saveAll();
  }
  // 简答题：仅计入「每日答题量」（count），不计入正确/错误，故不影响准确率
  function recordShort(q) {
    var t = todayStat();
    t.count++;
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

      // 错题「连续答对 5 次」自动提示移除（所有答题模式通用）
      if (correct && inWrong(q.id) && (wrong[q.id].rightStreak || 0) >= 5) {
        var tip = document.createElement("div");
        tip.className = "auto-remove-tip";
        tip.textContent = "已连续答对 5 次，是否移出错题库？";
        acts.appendChild(tip);
        var yesBtn = document.createElement("button");
        yesBtn.className = "btn warn"; yesBtn.textContent = "确认移除";
        yesBtn.onclick = function () {
          removeWrong(q.id);
          if (opts.practiceKey === "wrongPractice") { settings.wrongPracticeCur = null; settings.wrongPracticeN = null; saveSettings(); }
          opts.goNext();
        };
        var noBtn = document.createElement("button");
        noBtn.className = "btn"; noBtn.textContent = "暂不移除";
        noBtn.onclick = function () { opts.goNext(); };
        acts.appendChild(yesBtn); acts.appendChild(noBtn);
        resultBox.appendChild(acts);
        return;
      }

      // 模式自定义按钮
      var extras = (opts.extraActions && opts.extraActions(q, correct, selectedLetters)) || [];
      extras.forEach(function (b) {
        var el = document.createElement("button");
        el.className = "btn " + (b.cls || "");
        el.textContent = b.label;
        el.onclick = b.onClick;
        acts.appendChild(el);
      });
      // 下一题（错题库模式下由「保留并继续」代替，故跳过）
      if (!opts.skipNext) {
        var next = document.createElement("button");
        next.className = "btn primary";
        next.textContent = "下一题 →";
        next.onclick = function () { opts.goNext(); };
        acts.appendChild(next);
      }
      resultBox.appendChild(acts);
    }

    if (q.type === "short") {
      // 简答题：显示参考答案 + 直接「下一题」；不评对错、不计入正确率
      var refShown = false;
      var shortRow = document.createElement("div");
      shortRow.className = "actions";
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
      var nextShort = document.createElement("button");
      nextShort.className = "btn primary";
      nextShort.textContent = "下一题 →";
      nextShort.onclick = function () {
        if (submitted) return;
        submitted = true;
        recordShort(q); // 仅计入每日答题量
        if (opts.onAnswered) opts.onAnswered(q, null);
        opts.goNext();
      };
      shortRow.appendChild(showRef); shortRow.appendChild(nextShort);
      body.appendChild(shortRow);
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
  function runOneByOne(key, getIds, infoFn, extraFor, sig, relax) {
    var curKey = key + "Cur", nKey = key + "N", sigKey = key + "Sig";
    function drawNext() {
      var ids = getIds();
      if (!ids.length) { settings[curKey] = null; saveSettings(); return; }
      var id = drawId(ids, relax);
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
      var goNext = function () { drawNext(); renderCurrent(); };
      renderQuizCard(app, q, {
        onAnswered: function () {},
        goNext: goNext,
        skipNext: relax, // 错题库模式（relax）下隐藏默认「下一题 →」，由「保留并继续」承担继续
        practiceKey: key, // 用于「连续答对 5 次」确认移除时判断是否为错题练习模式
        extraActions: function (qq, correct, sel) { return extraFor ? extraFor(qq, correct, sel, goNext) : []; }
      });
      updateModeInfo(infoFn(n, q));
    }
    renderCurrent();
  }

  /* ---------------- 模式：整体测试 ---------------- */
  function renderOverall() {
    if (BANK.length === 0) { emptyState("题库为空"); return; }
    runOneByOne("overall", function () { return BANK.map(function (q) { return q.id; }); },
      function (n) { return "整体测试 · 第 " + n + " 题"; },
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
      function (n) { return "错题练习 · 第 " + n + " 题"; },
      function (q, correct, sel, goNext) {
        var btns = [];
        btns.push({
          label: "移出错题本", cls: "btn warn",
          onClick: function () {
            removeWrong(q.id);
            settings.wrongPracticeCur = null; settings.wrongPracticeN = null; saveSettings();
            renderWrongPractice();
          }
        });
        if (inWrong(q.id)) {
          btns.push({ label: "保留并继续", cls: "btn primary", onClick: function () { toast("已保留在错题本"); goNext(); } });
        }
        return btns;
      },
      Date.now(), true);
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
      function (n) { return "模块练习 · " + cat + " · 第 " + n + " 题"; },
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

  /* ---------------- 近 7 日练习图（首页底部使用） ---------------- */

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
        acc: (rec.obj != null ? rec.obj : rec.count) ? Math.round((rec.correct / (rec.obj != null ? rec.obj : rec.count)) * 100) : null,
        isToday: i === 0
      });
    }
    // 从左到右日期递增：最左为 6 天前，最右为今天（idx0=最早，idx6=今日）

    var W = 720, H = 210, padL = 48, padR = 50, padT = 28, padB = 40;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = days.length;
    // 左右内缩：让首/末数据点离开坐标轴，避免最外侧柱子横跨到轴外遮挡刻度数字
    var inset = 34;
    var x0 = padL + inset, x1 = W - padR - inset;
    var xFor = function (idx) { return n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * idx / (n - 1); };
    var maxCount = DAILY_GOAL;
    days.forEach(function (dy) { if (dy.count > maxCount) maxCount = dy.count; });
    var yCount = function (v) { return padT + plotH * (1 - v / maxCount); };
    var yAcc = function (v) { return padT + plotH * (1 - v / 100); };
    var slot = (x1 - x0) / (n - 1);
    var barW = Math.min(38, slot * 0.5);

    var svg = "<svg class='wk-svg' viewBox='0 0 " + W + " " + H + "' preserveAspectRatio='xMidYMid meet'>";
    // 横向网格 + 双轴刻度（颜色加深，避免发灰不显眼）
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      var y = padT + plotH * (1 - p);
      svg += "<line x1='" + padL + "' y1='" + y + "' x2='" + (W - padR) + "' y2='" + y + "' stroke='#eef2f7' stroke-width='1'/>";
      svg += "<text x='" + (padL - 8) + "' y='" + (y + 4) + "' text-anchor='end' font-size='11.5' font-weight='600' fill='#64748b'>" + Math.round(maxCount * p) + "</text>";
      svg += "<text x='" + (W - padR + 8) + "' y='" + (y + 4) + "' text-anchor='start' font-size='11.5' font-weight='600' fill='#64748b'>" + Math.round(100 * p) + "%</text>";
    });
    // 柱状（每日答题量）—— 先画，标签加白描边防遮挡
    days.forEach(function (dy, idx) {
      if (dy.count > 0) {
        var x = xFor(idx) - barW / 2, y = yCount(dy.count), h = padT + plotH - y;
        svg += "<rect x='" + x + "' y='" + y + "' width='" + barW + "' height='" + h + "' rx='4' fill='#2563eb'/>";
      }
    });
    // 准确率曲线 + 数据点（绿，描边白底防遮挡）
    var accPts = days.map(function (dy, idx) { return dy.acc != null ? xFor(idx) + "," + yAcc(dy.acc) : null; }).filter(Boolean);
    if (accPts.length > 1) svg += "<polyline points='" + accPts.join(" ") + "' fill='none' stroke='#16a34a' stroke-width='2.5' stroke-linejoin='round'/>";
    else if (accPts.length === 1) { var a = accPts[0].split(","); svg += "<circle cx='" + a[0] + "' cy='" + a[1] + "' r='3.5' fill='#16a34a'/>"; }
    days.forEach(function (dy, idx) {
      if (dy.acc != null) {
        var cx = xFor(idx), cy = yAcc(dy.acc);
        var labelY = cy - 11;
        var barTop = dy.count > 0 ? yCount(dy.count) : Infinity;
        if (barTop < labelY - 2) {            // 当日柱子顶端高于标签，标签会被压入柱体
          labelY = barTop - 9;                // 上移到柱子顶端之上
          if (labelY < padT + 4) labelY = cy + 16; // 顶到上沿则回退到数据点下方
        }
        svg += "<circle cx='" + cx + "' cy='" + cy + "' r='4' fill='#16a34a' stroke='#fff' stroke-width='1.5'/>";
        // 白底圆角胶囊：确保任何背景下（含压在蓝柱上）都清晰可读
        var lw = (dy.acc + "%").length * 7 + 10;
        svg += "<rect x='" + (cx - lw / 2) + "' y='" + (labelY - 11) + "' width='" + lw + "' height='16' rx='8' fill='#fff' opacity='0.92'/>";
        svg += "<text x='" + cx + "' y='" + labelY + "' text-anchor='middle' font-size='11.5' font-weight='800' fill='#15803d'>" + dy.acc + "%</text>";
      }
    });
    // 目标虚线（最上层；标签移入图例，避免被柱子遮挡）
    var gy = yCount(DAILY_GOAL);
    svg += "<line x1='" + padL + "' y1='" + gy + "' x2='" + (W - padR) + "' y2='" + gy + "' stroke='#f59e0b' stroke-width='1.8' stroke-dasharray='6 4'/>";
    // 日期标签（置底）
    days.forEach(function (dy, idx) {
      var lblCls = dy.isToday ? "wk-xl today" : "wk-xl";
      svg += "<text class='" + lblCls + "' x='" + xFor(idx) + "' y='" + (H - padB + 22) + "' text-anchor='middle' font-size='12.5'>" + dy.label + "</text>";
    });
    // 答题量数字：最后绘制，始终位于最上层；白底胶囊防遮挡；与准确率标签同列重叠时上移错开
    days.forEach(function (dy, idx) {
      if (dy.count > 0) {
        var cx = xFor(idx), cyTop = yCount(dy.count);
        var cy = cyTop - 8;
        if (dy.acc != null) {
          var aY = yAcc(dy.acc) - 11;
          var barTop = cyTop;
          if (barTop < aY - 2) { aY = barTop - 9; if (aY < padT + 4) aY = yAcc(dy.acc) + 16; }
          if (Math.abs(cy - aY) < 14) cy = aY - 16; // 与准确率标签重叠则上移到其上方
        }
        if (cy < padT + 2) cy = padT + 2; // 顶到上沿保护
        var lw = String(dy.count).length * 7 + 10;
        svg += "<rect x='" + (cx - lw / 2) + "' y='" + (cy - 11) + "' width='" + lw + "' height='16' rx='8' fill='#fff' opacity='0.92'/>";
        svg += "<text x='" + cx + "' y='" + cy + "' text-anchor='middle' font-size='12' font-weight='800' fill='#1d4ed8'>" + dy.count + "</text>";
      }
    });
    svg += "</svg>";

    var html = "<h4 style='margin:0 0 10px'>近 7 日练习</h4>";
    // 图例居中显示在标题下方、图表上方；目标值移入图例，避免线上标签遮挡柱子
    html += "<div class='week-legend' style='margin-bottom:6px;text-align:center'>" +
      "<span class='lg-line c-blue'></span>每日答题量　" +
      "<span class='lg-line c-green'></span>准确率　" +
      "<span class='lg-line c-orange dash'></span>目标 " + DAILY_GOAL + " 题" +
      "</div>";
    html += svg;
    return html;
  }

  function ringSvg(pct, cls) {
    pct = Math.max(0, Math.min(100, pct));
    var size = 72, stroke = 8;
    var r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    var color = pct >= 100 ? "#16a34a" : "#1d4ed8";
    return "<svg class='" + (cls || "") + "' viewBox='0 0 " + size + " " + size + "'>" +
      "<circle cx='36' cy='36' r='" + r + "' fill='none' stroke='#dbe3f5' stroke-width='" + stroke + "'/>" +
      "<circle cx='36' cy='36' r='" + r + "' fill='none' stroke='" + color + "' stroke-width='" + stroke + "' stroke-linecap='round' stroke-dasharray='" + c + "' stroke-dashoffset='" + off + "' transform='rotate(-90 36 36)'/>" +
      "<text x='50%' y='50%' text-anchor='middle' dominant-baseline='central' font-size='19' font-weight='800' fill='#1f2937'>" + pct + "%</text>" +
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
    { key: "category", title: "模块练习", desc: "按科目类别分模块刷题", cls: "c-green", icon: ICONS.grid, fn: function () { setMode("category"); } }
  ];

  function overviewStats() {
    var correctSum = 0, wrongSum = 0;
    Object.keys(stats).forEach(function (id) {
      var s = stats[id]; if (s) { correctSum += s.correct || 0; wrongSum += s.wrong || 0; }
    });
    var answered = correctSum + wrongSum;
    var rate = answered ? Math.round((correctSum / answered) * 100) : 0;
    return { answered: answered, rate: rate };
  }

  function renderHome() {
    app.innerHTML = "";
    var t = todayStat();
    var pct = Math.min(100, Math.round((t.count / DAILY_GOAL) * 100));
    var ov = overviewStats();

    // 顶部合并区：练习概览（累计作答 / 总正确率 + 今日目标），三者同一行、垂直居中、不上下堆叠
    var cheerCls = "", cheerTxt;
    if (t.count >= DAILY_GOAL) {
      cheerCls = " celebrate";
      cheerTxt = "🎉 今日目标已达成，继续保持！";
    } else {
      cheerTxt = "还差 " + (DAILY_GOAL - t.count) + " 题完成目标，继续加油 💪";
    }

    var combo = document.createElement("div");
    combo.className = "card combo-card";
    combo.innerHTML =
      "<div class='combo'>" +
        "<div class='stat'><div class='num'>" + ov.answered + "</div><div class='lbl'>累计作答</div></div>" +
        "<div class='stat'><div class='num'>" + ov.rate + "%</div><div class='lbl'>总正确率</div></div>" +
        "<div class='ov-right'>" +
          ringSvg(pct, "ov-ring") +
          "<div class='meta'>" +
            "<div class='tag'>今日目标</div>" +
            "<div class='ov-goal-num'>" + t.count + " / " + DAILY_GOAL + " 题</div>" +
            "<div class='cheer-inline" + cheerCls + "'>" + cheerTxt + "</div>" +
          "</div>" +
        "</div>" +
      "</div>";
    app.appendChild(combo);

    // 图标网格（不含「我的进度」）
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

    // 近 7 日练习（首页底部）
    var wkCard = document.createElement("div");
    wkCard.className = "card";
    wkCard.style.marginTop = "10px"; // 与上方答题模块网格的间距适当加大
    wkCard.innerHTML = last7Chart();
    app.appendChild(wkCard);

    // 底部静默同步提示 + 设备同步入口（方案②：无需同步码）
    var foot = document.createElement("div");
    foot.className = "home-foot";
    var statusText;
    if (!syncOnline) {
      statusText = syncLabel(); // 未连接
    } else if (settings.lastSyncTs) {
      var d = new Date(settings.lastSyncTs);
      statusText = "云端同步开启 · 已同步 · 上次 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    } else {
      statusText = "云端同步开启 · 已连接同步服务";
    }
    foot.innerHTML =
      "<div class='sync-bar'>" +
        "<div class='sync-row1'>" +
          "<span class='sync-status'>" + statusText + "</span>" +
          "<button class='btn-add-device add-device' id='addDevice'>设备同步</button>" +
        "</div>" +
        "<div class='sync-note'>数据保存在本机浏览器，并自动跨设备云端同步。</div>" +
        "<div class='sync-ver'>v" + APP_VERSION + "  @四叶草🍀的祝福</div>" +
      "</div>";
    app.appendChild(foot);
    var ad = document.getElementById("addDevice");
    if (ad) ad.onclick = openPair;
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
    wrongPractice: "错题练习", search: "题目搜索", category: "模块练习"
  };
  var currentMode = null;
  var inCategoryPractice = false;
  function goHome() {
    subbar.classList.add("hidden");
    startAutoSync(); // 回到首页恢复后台自动轮询（答题模式下已暂停以省资源）
    renderHome();
  }
  function onBack() {
    if (currentMode === "category" && inCategoryPractice) { renderCategoryList(); }
    else { goHome(); }
  }
  function setMode(mode) {
    settings.lastMode = mode; saveSettings();
    currentMode = mode;
    // 进入任意答题/练习模式：暂停后台自动轮询，避免刷题期间持续请求消耗 Memory Time
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    subbar.classList.remove("hidden");
    document.getElementById("modeTitle").textContent = MODE_TITLE[mode] || "";
    updateModeInfo("");
    if (mode === "overall") renderOverall();
    else if (mode === "random") renderRandom();
    else if (mode === "wrongList") renderWrongList();
    else if (mode === "wrongPractice") renderWrongPractice();
    else if (mode === "search") renderSearch();
    else if (mode === "category") renderCategoryList();
  }

  document.getElementById("backBtn").onclick = onBack;

  // 题库信息
  (function () {
    var s = BANK.length ? ("已加载 " + BANK.length + " 道题（单选/多选/判断/简答）") : "未找到题库数据";
    document.getElementById("bankMeta").textContent = s;
  })();

  // 绑定「设备同步」配对弹窗按钮
  (function bindPairModal() {
    var pc = document.getElementById("pairClose"); if (pc) pc.onclick = closePair;
    var pcp = document.getElementById("pairCopy"); if (pcp) pcp.onclick = copyPair;
    var pd = document.getElementById("pairDone"); if (pd) pd.onclick = closePair;
    var pm = document.getElementById("pairModal");
    if (pm && pm.querySelector(".pair-box")) {
      pm.querySelector(".pair-box").onclick = function (e) { if (e.target === pm) closePair(); };
    }
  })();

  // 启动：先尝试从云端拉取（若已连接同步服务），再渲染首页
  pullSync(function () { rerenderCurrent(); });
  startAutoSync(); // 开启后台自动轮询（首页态），进入答题模式会自动暂停
  goHome();

  // 闲置自动保存：连续 2 分钟无任何有效操作，则保存进度并提示关闭页面，
  // 减少页面挂机对服务器 Memory Time 的占用。
  (function setupIdleGuard() {
    var IDLE_MS = 120000; // 2 分钟
    var idleTimer = null;
    var overlay = null;
    function resetIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      if (overlay) { overlay.remove(); overlay = null; }
      idleTimer = setTimeout(onIdle, IDLE_MS);
    }
    function onIdle() {
      saveAll(); // 自动保存全部进度到本地（含云端同步排队）
      overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(15,23,42,.92);color:#fff;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
        "z-index:9999;font-size:15px;text-align:center;padding:24px;line-height:1.8;";
      overlay.innerHTML =
        "⏱ 已闲置 2 分钟<br>进度已自动保存<br><br>" +
        "<span style='font-size:13px;opacity:.8'>请手动关闭此页面，以减少服务器资源占用</span>";
      document.body.appendChild(overlay);
      try { window.close(); } catch (e) {} // 多数浏览器会拦截，仅作尝试
    }
    // 仅把「点击/按键/触摸/滚动」视为有效操作（鼠标移动不计时，避免人离开却一直计时）
    ["click", "keydown", "touchstart", "scroll"].forEach(function (ev) {
      document.addEventListener(ev, resetIdle, true);
    });
    resetIdle();
  })();
})();
