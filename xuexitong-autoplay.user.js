// ==UserScript==
// @name         学习通 自动连播 · 播完即停
// @namespace    local.lcs.chaoxing
// @version      7.6.0
// @updateURL    https://cdn.jsdelivr.net/gh/MOLIDA-3301/xuexitong-autoplay@main/xuexitong-autoplay.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/MOLIDA-3301/xuexitong-autoplay@main/xuexitong-autoplay.user.js
// @description  目录+任务点状态驱动：PPT 一键秒过、视频自动点播放、播完后补推课件；v7.6 面板改三色指示灯，状态栏「动作状态机」实时显示正在播放视频 / 正在划 PPT / 正在跳转，文字随状态跑马变色
// @author       Little Code Sauce
// @match        *://*.chaoxing.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ==================== 配置区：想改就改这里 ==================== */
  const CFG = {
    rate:         1.5,    // 倍速。1=原速；1.5=学习通官方允许的上限（推荐）
    mute:         true,   // 自动静音（浏览器要求静音才允许自动播放）
    autoNext:     true,   // 播完自动前往下一节
    closePopup:   true,   // 自动关「请点击继续观看」这类防挂机弹窗
    keepAlive:    true,   // 被暂停 / 切走 / 假死就自动恢复
    skipNonVideo: true,   // 遇到非视频节点（文档等）自动跳过
    waitAfterEnd: 4,      // 播完后等几秒（先让页面自己跳，跳不动才手动点）
    tick:         1000,   // 轮询间隔 ms
    panel:        true,   // 右下角悬浮面板
    maxItems:     400,    // 目录项扫描上限（防卡）
    jumpRetry:    3,      // 连续几次跳转无反应就停（v2 漏定义，导致这条保护失效）
    docAdvance:   true,   // 图文课件（PPT/文档）自动推进
    // v6：7000 → 2400。7 秒 × 10 屏 ≈ 70 秒才翻完一个 PPT（实测「滚的慢」）。
    //     加快是安全的：v5 起有「目录确认」这道闸门，翻到底但目录说没完成会原地继续，
    //     不会像 v4 那样被判定"读完"就飞走。
    docStep:      2400,   // 课件推进间隔 ms
    playRetry:    2500,   // v6：视频没起来时，重试「点播放按钮 / play()」的间隔 ms
    warmup:       25000,  // v6：进入新节点后的视频预热窗口 ms（这段时间内更积极地点播放）
    // v5：取消 v4 的 45 秒"推不动就跳"。v4 因为指纹没算滚动位置，
    //     明明在滚也被判"无变化"，45 秒一到就跳 —— 实测把整门课全飞了。
    docGiveUp:    180000, // 第一轮宽限：无视频满 3 分钟仍未完成，先看目录状态再决定
    docGiveUp2:   420000, // 第二轮宽限：仍未完成才前进（记入「需人工」）
    docStillMax:  6,      // v5：连续几次推进后内容仍无变化 → 认为本节读完（v4 的 4 次太急）
    minVideo:     60,     // 视为「真视频」的最小边长 px（过滤隐藏的占位 video）
    videoReady:   90000,  // v5：有 video 元素但元数据迟迟不就绪（duration=NaN），最多等这么久
    /* ----------------------------------------------------------------
       v7：同一节点「上面是视频、下面是 PPT」时，视频播完不要立刻跳。
       v6 的 tick 是 if (hasVideo) { ...resetDoc(); } else { advanceDoc(); }
       —— 只要本节点有视频，课件推进分支永远进不去，且每轮 tick 都把
       docPagedAt 清零。实测 2.3 节：视频 7:17:44 播完 → 7:17:48 跳走，
       下方 PPT 从头到尾停在第一页（用户反馈「PPT 被掠过」）。
       现在：视频 done 之后继续 advanceDoc()，把本节点课件余量推光才跳。
       ---------------------------------------------------------------- */
    docSweep:     true,   // 视频节点也补推课件
    sweepMin:     600,    // 课件「可滚余量」超过这个值才算真课件（排掉页面自身滚动）
    sweepTail:    240,    // 余量小于这个值视为推到底
    /* v7.2：sweepMax 的单位改了 —— 从「tick 轮数」改成「真推进次数」。
       v7.1 的 bug：sweepRounds 在 tick 里无条件 +1（每秒一轮），
       advanceDoc() 自己却还有 2400ms 节流 → 40 轮 = 40 秒 = 只有 16 次
       真的推动了，16 × 659px = 10544px。
       实测 3.1 节：屏阅阅读器 35 页 × 659px = 22730px，需要 34.5 次、
       83 秒 —— 推到 9227px（40%）就被上限砍掉、跳走，用户看到的
       仍然是「PPT 被跳过」。
       现在只统计真的改动了 scrollTop 的推进，另外补一条「连续推不动」
       出口：120 次 × 659px ≈ 79 屏，正常课件足够推完。 */
    sweepMax:     120,    // 单节点最多补推这么多次「有效推进」（防死循环）
    sweepStillMax: 15,    // 连续这么多次推不动 scrollTop → 判定到底，放行跳转
    /* ----------------------------------------------------------------
       v7.3：课件「秒过」—— 用户反馈 2.4 秒/屏太慢（35 页要 84 秒）。
       实测那个 pan-yz 屏阅阅读器是**翻页式**的：scrollTop 根本写不动
       （所以面板显示「手势」而不是「滚动」），只能靠手势翻页，而 v4 起的
       手势一次只发 3 次滚轮 deltaY=420 ≈ 1 屏。
       现在：先按 End（一键到底），再连发 docBoost 次 deltaY=docWheel 的
       滚轮 + 同数量的 PageDown —— 一次约 12 屏，35 页 ≈ 3 次推进。
       ---------------------------------------------------------------- */
    docFast:      true,   // 课件秒过（v7.4 起固定开启，UI 不再提供切换）
    docBoost:     12,     // 一次推进连发多少次手势事件（原固定 3）
    docWheel:     900,    // 单次滚轮 deltaY（原 420）
    docStepFast:  1200,   // 秒过模式的推进节流 ms（原 docStep=2400）
  };
  /* ============================================================== */

  const IS_TOP = (window.self === window.top);
  const HOST   = '__CX_AUTO__';
  const SS_FIN = 'cx_auto_finished_count';

  /* ---------------- 基础工具 ---------------- */
  const $  = (s, r) => { try { return (r || document).querySelector(s); } catch (e) { return null; } };
  const $$ = (s, r) => { try { return Array.prototype.slice.call((r || document).querySelectorAll(s)); } catch (e) { return []; } };

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -300 || r.top > window.innerHeight + 800) return false;
    let st;
    try { st = getComputedStyle(el); } catch (e) { return true; }
    if (!st) return true;
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    return true;
  }

  function text(el) {
    if (!el) return '';
    return ((el.innerText || el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim();
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60), x = s % 60;
    return m + ':' + (x < 10 ? '0' : '') + x;
  }

  function cls(el) {
    if (!el) return '';
    const c = el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;
    return '';
  }

  /* ---------------- 日志 ---------------- */
  const logs = [];
  function log() {
    const s = Array.prototype.slice.call(arguments).map(function (x) {
      return (typeof x === 'string') ? x : (function () { try { return JSON.stringify(x); } catch (e) { return String(x); } })();
    }).join(' ');
    logs.push(new Date().toLocaleTimeString() + '  ' + s);
    if (logs.length > 300) logs.shift();
    try { console.log('%c[学习通自动]', 'color:#16a34a;font-weight:700', s); } catch (e) {}
    if (IS_TOP) paint();
  }

  /* ---------------- 状态 ---------------- */
  const S = {
    running:      true,
    finished:     0,
    lastDoneAt:   0,
    rateBlocked:  false,
    quizNoticed:  false,
    blockedFrame: 0,
    noVideoAt:    0,
    jumpFails:    0,
    catCount:     0,
    catIndex:     -1,
    catHow:       '',
    lastJumpAt:   0,
    reason:       '',
    video:        null,
    tried:        {},     // label -> ts，避免反复点同一个跳不动的项
    docPagedAt:   0,      // 上次课件推进时间
    docSig:       '',     // 课件内容指纹（判断是否真的翻动了）
    docStill:     0,      // 连续几次推进后内容没变化
    docPages:     0,      // 本次课件已推进次数
    docBtn:       '',     // 上次点的翻页按钮文本
    lastDocActAt: 0,      // v4：上次课件真正有变化的时间（判断「推了很久都没用」）
    ghostVideo:   0,      // 被判定为「假 video」而忽略的元素数
    manualNeeded: 0,      // v4：推不动、被跳过的节点数（最后汇报给用户）
    doneMarkedKey:'',     // 已经处理过「任务点已完成」标记的节点 key
    giveUpRound:  0,      // v5：前进宽限轮次（0=第一轮 3 分钟，1=第二轮 7 分钟）
    nodeDone:     false,  // v5：目录显示本节点已完成的缓存
    nodeTodoNum:  0,      // v5：目录显示本节点还剩几个待完成
    docStillWarned:false, // v5：已提示过「翻到底但目录未完成」（只提示一次，防刷屏）
    sweepKey:     '',     // v7：当前正在补推课件的节点 key（变了就重置整套补推状态）
    sweepRounds:  0,      // v7.2：本节点已「有效推进」的次数（真改了 scrollTop 才算）
    sweepStill:   0,      // v7.2：连续没推动 scrollTop 的次数（防卡死出口）
    sweepDrained: false,  // v7：本节点课件已清完 / 已放弃
    sweepGaveUp:  false,  // v7.2：是「因上限或推不动而放弃」的（诊断用）
    pendingNextAfterDrain: false, // v7：正在等课件推完，推完才允许跳
    sweepLogAt:   0,      // v7：补推日志节流时间戳
    act:          null,   // v7.5：动作状态机 { k:键, at:时间戳, s:细节 } —— 状态栏实时显示的来源
  };

  const SS_TRIED = 'cx_auto_tried';
  try { S.finished = parseInt(sessionStorage.getItem(SS_FIN) || '0', 10) || 0; } catch (e) {}
  try { S.tried = JSON.parse(sessionStorage.getItem(SS_TRIED) || '{}') || {}; } catch (e) { S.tried = {}; }

  function persistTried() {
    try { sessionStorage.setItem(SS_TRIED, JSON.stringify(S.tried)); } catch (e) {}
  }
  function markTried(label) {
    if (!label) return;
    S.tried[label] = Date.now();
    persistTried();
  }
  function isTried(label) {
    const t = S.tried[label];
    if (!t) return false;
    if (Date.now() - t > 300000) { delete S.tried[label]; persistTried(); return false; }
    return true;
  }
  function clearTried() {
    S.tried = {};
    try { sessionStorage.removeItem(SS_TRIED); } catch (e) {}
  }

  function bumpFinished() {
    S.finished++;
    try { sessionStorage.setItem(SS_FIN, String(S.finished)); } catch (e) {}
  }

  /* ---------------- 遍历本页 + 所有可访问的 iframe ---------------- */
  function walkDocs() {
    const out = [];
    const seen = new Set();
    let blocked = 0;
    (function rec(doc, depth) {
      if (!doc || seen.has(doc) || depth > 6) return;
      seen.add(doc);
      out.push(doc);
      let fs;
      try { fs = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
      for (let i = 0; i < fs.length; i++) {
        let d = null;
        try { d = fs[i].contentDocument; } catch (e) { d = null; }
        if (d) rec(d, depth + 1); else blocked++;
      }
    })(document, 0);
    S.blockedFrame = blocked;
    return out;
  }

  /* ---------------- 伪造页面可见性 ---------------- */
  function patchVis(doc) {
    if (!doc || doc.__cxVis) return;
    doc.__cxVis = true;
    try { Object.defineProperty(doc, 'hidden',          { configurable: true, get: function () { return false; } }); } catch (e) {}
    try { Object.defineProperty(doc, 'visibilityState', { configurable: true, get: function () { return 'visible'; } }); } catch (e) {}
    ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'blur', 'pagehide'].forEach(function (t) {
      try { doc.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true); } catch (e) {}
    });
  }

  /* ---------------- 接管视频 ---------------- */

  // v5：**不再用 duration 判真假**。
  //     v4 的条件是 `duration > 0 && isFinite(duration)`，结果把一个
  //     1398x786 的**真视频**判成了假 —— 因为它当时还没加载完元数据，
  //     duration 是 NaN。于是脚本认为"本节点无视频"，把整个带视频的
  //     章节当图文课件推进，45 秒后跳走。实测：所有视频节点全被跳过。
  //
  //     真假判据改为：尺寸够大 + 祖先链可见 + 没有明确的加载错误。
  //     duration=NaN 只代表「还没加载」，等一下就会播。
  function isRealVideo(v) {
    if (!v) return false;
    let r = null;
    try { r = v.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width < CFG.minVideo || r.height < CFG.minVideo) return false;
    let n = v;
    for (let k = 0; k < 6 && n && n !== document.body; k++) {
      let st = null;
      try { st = getComputedStyle(n); } catch (e) { break; }
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      n = n.parentElement;
    }
    if (v.error) return false;                 // 明确的解码 / 拉流错误
    if (v.networkState === 3) return false;    // NETWORK_NO_SOURCE：确实没有源
    return true;
  }

  /* ---------------- v6：把封面上的播放按钮点起来 ---------------- */
  // 学习通的视频播放器是「点了才加载」：点击之后它才去请求地址、设置 src。
  // 所以「找到并点中播放按钮」比「调 video.play()」更优先、也更关键 ——
  // 没有这一步，video 永远是 readyState=0 / duration=NaN / paused=true。
  function clickPlayButton(doc, v) {
    const d = doc || (v && v.ownerDocument) || document;

    // ① 播放器标准大按钮（video.js / xgplayer / prism / dplayer 都覆盖）
    const sels = [
      '.vjs-big-play-button', '.xgplayer-start', '.prism-big-play-btn', '.dplayer-play-icon',
      '[class*="big-play"]', '[class*="bigPlay"]', '[class*="BigPlay"]',
      '[class*="play-btn"]', '[class*="playBtn"]', '[class*="play_btn"]',
      '[class*="playButton"]', '[class*="play-button"]', '[class*="play_button"]',
      '[id*="play-btn"]', '[id*="playBtn"]', '[id*="play_button"]', '[id*="playButton"]',
      '[aria-label*="播放"]', '[title="播放"]', '[title*="播放"]'
    ];
    for (let i = 0; i < sels.length; i++) {
      let hit = null;
      try { hit = d.querySelector(sels[i]); } catch (e) { continue; }
      if (!hit || !visible(hit)) continue;
      if (/下一|上一|列表|目录|下一節/.test(text(hit))) continue;   // 别把"下一節"当成播放键
      if (safeClick(hit)) return 'sel:' + sels[i];
    }

    // ② 在 video 的祖先容器里找「唯一一个像播放按钮的小图标」
    let box = v ? v.parentElement : null;
    for (let up = 0; up < 4 && box; up++, box = box.parentElement) {
      const kids = $$('div,span,a,i,button,em', box);
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k === v) continue;
        const c = cls(k) + ' ' + (k.id || '');
        if (!/play|Play|start|Start|mask|cover|poster/i.test(c)) continue;
        let r = null;
        try { r = k.getBoundingClientRect(); } catch (e) { continue; }
        if (!r) continue;
        // 播放按钮一般是个「不太小、也不算巨大、叠在视频区域里」的方块
        if (r.width < 20 || r.height < 20 || r.width > 300 || r.height > 300) continue;
        if (!visible(k)) continue;
        if (safeClick(k)) return 'ancestor:' + c.trim().slice(0, 24);
      }
    }

    // ③ 直接点 video 本身 —— 不少自定义播放器把 click 绑在它上面
    if (v && visible(v)) { if (safeClick(v)) return 'video-self'; }
    return '';
  }

  function takeVideo(doc) {
    let all = [];
    try { all = Array.prototype.slice.call(doc.querySelectorAll('video')); } catch (e) { return false; }
    if (!all.length) return false;

    let v = null, ghost = 0;
    for (let i = 0; i < all.length; i++) {
      if (isRealVideo(all[i])) { v = all[i]; break; }
      ghost++;
    }
    S.ghostVideo = ghost;
    if (!v) return false;

    if (!v.__cx) {
      v.__cx = { done: false, lastT: -1, stuck: 0, playAt: 0, btnClicks: 0, firstAt: 0 };
      v.addEventListener('ended', function () { markDone(v, 'ended 事件'); }, true);
      // 元数据一到就立刻播，不等下一次轮询
      v.addEventListener('loadedmetadata', function () { try { v.muted = true; v.play(); } catch (e) {} }, true);
      v.addEventListener('canplay', function () { try { if (v.paused) { v.muted = true; v.play(); } } catch (e) {} }, true);
    }

    S.video = v;

    /* v7.5：把「视频此刻到底在干什么」实时打点给状态栏。
       takeVideo() 每轮 tick（1 秒）都会被调用，所以这条 act 会持续保鲜。 */
    try {
      const dur = (v.duration > 0 && isFinite(v.duration)) ? v.duration : 0;
      if (!v.currentSrc || v.readyState < 1 || !dur) setAct('vload', '');
      else if (v.ended)  setAct('vend', '');
      else if (v.paused) setAct('vpause', '');
      else setAct('video', '');   // v7.6：剩余时长交给进度行，避免同一行重复两次
    } catch (e) {}

    const now = Date.now();
    if (!v.__cx.firstAt) v.__cx.firstAt = now;

    if (CFG.mute) { try { v.muted = true; v.volume = 0; } catch (e) {} }

    if (Math.abs((v.playbackRate || 1) - CFG.rate) > 0.02) {
      let ok = false;
      try { v.playbackRate = CFG.rate; ok = Math.abs(v.playbackRate - CFG.rate) < 0.06; } catch (e) { ok = false; }
      if (!ok && CFG.rate !== 1) S.rateBlocked = true;
    }

    /* ----------------------------------------------------------------
       v6：视频起不来（paused=true ｜ currentTime=0 ｜ duration=NaN）。
       实测根因 —— 学习通那个播放器是「点了才加载」：
         src 为空 / readyState=0，光调 video.play() 永远不会开始，
         必须先把封面上的播放按钮点一下，它才会去拉流。
       v5 的门槛是 readyState>=1，恰好把这种情况全部挡在门外 —— 所以表现
       就是「进了视频节点，封面一直躺着不动」。
       现在：① 去掉 readyState 门槛  ② 冷启动时主动点播放按钮  ③ 每 2.5 秒重试
       ---------------------------------------------------------------- */
    const cold = !v.currentSrc || v.readyState < 1 || !(v.duration > 0);

    if (CFG.keepAlive && v.paused && !v.ended) {
      const warm = (now - v.__cx.firstAt) < CFG.warmup;   // 刚进节点 → 点得更积极
      if (now - (v.__cx.playAt || 0) > (warm ? 1200 : CFG.playRetry)) {
        v.__cx.playAt = now;
        if (cold) {
          const hit = clickPlayButton(null, v);
          if (hit) {
            v.__cx.btnClicks++;
            if (v.__cx.btnClicks === 1) {
              log('▶ 视频未加载（readyState=' + v.readyState + ' ｜ duration=' + v.duration + '）—— 点了播放按钮，等它拉流');
            }
          }
        }
        try {
          const p = v.play();
          if (p && p.catch) p.catch(function () { try { v.muted = true; } catch (e) {} });
        } catch (e) {}
      }
    }

    if (v.__cx.lastT === v.currentTime && !v.paused) {
      v.__cx.stuck++;
      if (v.__cx.stuck >= 8) { v.__cx.stuck = 0; try { v.play(); } catch (e) {} }
    } else {
      v.__cx.stuck = 0;
    }
    v.__cx.lastT = v.currentTime;

    // v5：播完判定拆开 —— ended 事件独立成立（不依赖 duration 是否有效）
    if (!v.__cx.done) {
      if (v.ended) markDone(v, 'ended/已结束');
      else if (v.duration > 0 && isFinite(v.duration) && (v.duration - v.currentTime) <= 0.6) {
        markDone(v, '播放到尾部');
      }
    }
    return true;
  }

  function markDone(v, how) {
    if (!v || !v.__cx || v.__cx.done) return;
    v.__cx.done = true;
    log('✅ 本节点视频已播完（' + how + '）');
    if (IS_TOP) onNodeDone('本页');
    else { try { window.top.postMessage({ __cx: 1, type: 'done' }, '*'); } catch (e) {} }
  }

  /* ================================================================
     目录扫描 —— 不依赖 class 名，靠「文本形如 1.1 xxx」识别
     ================================================================ */

  // 章节编号：1 / 1.1 / 1.1.2 后面跟分隔符再跟文字
  const CAT_RE = /^\d{1,3}(?:[.．]\d{1,3}){0,2}\s*[、.．,，:：)）]?\s*\S/;

  function looksCatalog(t) {
    if (!t || t.length < 3 || t.length > 70) return false;
    if (!CAT_RE.test(t)) return false;
    if (/^\d+[.]?\d*\s*[%°]/.test(t)) return false;      // 排除 "12.5%" 这类
    // v4：排除「1個待完成任務點」这类 hover 气泡（简繁都排）。
    //     这类元素本身是数字开头，v3 会把它当成一个「章节」，跳过去点不动 → 卡死。
    if (/待完成|待學|待学|任務點|任务点|已完成|個任務|个任务/.test(t)) return false;
    return true;
  }

  // 收集「最内层」的目录条目（文档顺序、按文本去重）
  function collectCatalogItems(doc) {
    doc = doc || document;
    let all;
    try { all = $$('a,div,li,span,p,dd,dt,h1,h2,h3,h4,h5,td', doc); } catch (e) { return []; }

    const cand = [];
    for (let i = 0; i < all.length && cand.length < CFG.maxItems; i++) {
      const el = all[i];
      if (el.children && el.children.length > 10) continue;
      // v4：隐藏的 hover 气泡（「1個待完成任務點」）也必须排除。
      //     它的 innerText 是空的（自身隐藏），但 textContent 有内容，
      //     所以 text() 会把它读成一个「章节」。
      if (!visible(el)) continue;
      if (/tips|Tips|orangeNew|icon_Complete|badge|Badge/i.test(cls(el))) continue;
      const t = text(el);
      if (!looksCatalog(t)) continue;
      cand.push(el);
    }
    if (!cand.length) return [];

    // 只保留最内层：若候选 A 包含候选 B，A 丢弃
    const inner = cand.filter(function (el) {
      for (let i = 0; i < cand.length; i++) {
        if (cand[i] !== el && el.contains(cand[i])) return false;
      }
      return true;
    });

    // 按文本去重，保留文档序第一个
    const seen = {};
    const out = [];
    for (let i = 0; i < inner.length; i++) {
      const t = text(inner[i]);
      if (seen[t]) continue;
      seen[t] = 1;
      out.push(inner[i]);
    }

    // v4：按横坐标聚类 —— 真正的目录项排在同一竖列上，而右侧 hover 气泡
    //     会明显偏出去（实测：目录 x=1600，气泡 x=1899）。没有这一步，
    //     气泡会被当成一个章节，跳过去点不动，于是反复卡死。
    try {
      if (out.length >= 4) {
        const xs = out.map(function (el) {
          try { return Math.round(el.getBoundingClientRect().left); } catch (e) { return -9999; }
        });
        const buckets = {};
        for (let i = 0; i < xs.length; i++) {
          const k = Math.round(xs[i] / 50) * 50;
          buckets[k] = (buckets[k] || 0) + 1;
        }
        let bestK = null, bestN = 0;
        Object.keys(buckets).forEach(function (k) {
          if (buckets[k] > bestN) { bestN = buckets[k]; bestK = parseInt(k, 10); }
        });
        if (bestK !== null && bestN >= Math.max(3, Math.floor(out.length * 0.4))) {
          const kept = out.filter(function (el, i) { return Math.abs(xs[i] - bestK) <= 180; });
          if (kept.length >= 2) return kept;
        }
      }
    } catch (e) {}

    return out;
  }

  /* ================================================================
     v5 新增：读目录项的「已完成 / 待完成」状态
     ----------------------------------------------------------------
     这是「下一步该去哪」的正确依据。学习通自己在目录上标了状态：
       · 已完成  → class 含 icon_Completed
       · 待完成  → class 含 orangeNew（文本是待完成数量）
     实测这些标记元素与目录项不在同一个 DOM 分支里，所以用**纵向坐标**
     把它们配到最近的目录项上。

     v4 的策略是"推不动就跳下一项" —— 完全不看任务点做完没有，于是整门
     课被一节节跳过去（用户的反馈：「全飞了」）。改成状态驱动之后，
     只有目录明确显示「已完成」才会离开当前节点。
     ================================================================ */
  function catalogStatus(items) {
    const res = [];
    for (let i = 0; i < items.length; i++) res.push({ done: false, todo: false, num: 0, has: false });
    if (!items.length) return res;

    let marks = [];
    try {
      marks = $$('[class*="icon_Complete"],[class*="icon_Un"],[class*="orangeNew"],' +
                 '[class*="unfinish"],[class*="notFinish"],[class*="weiWanCheng"]');
    } catch (e) { return res; }
    if (!marks.length) return res;

    const cs = items.map(function (el) {
      try { const r = el.getBoundingClientRect(); return r.top + r.height / 2; } catch (e) { return -1e9; }
    });

    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (!visible(m)) continue;
      const c = cls(m);
      const isDone = /icon_Complete|已完成/i.test(c);
      const isTodo = /orangeNew|unfinish|notFinish|weiWanCheng/i.test(c);
      if (!isDone && !isTodo) continue;

      let cY = 0;
      try { const r = m.getBoundingClientRect(); cY = r.top + r.height / 2; } catch (e) { continue; }

      let best = -1, bd = 1e9;
      for (let j = 0; j < cs.length; j++) {
        const d = Math.abs(cs[j] - cY);
        if (d < bd) { bd = d; best = j; }
      }
      if (best < 0 || bd > 60) continue;

      if (isDone) { res[best].done = true; res[best].has = true; }
      else {
        res[best].todo = true; res[best].has = true;
        const n = parseInt(text(m), 10);
        if (n > 0) res[best].num = n;
      }
    }
    return res;
  }

  // 当前节点状态（目录口径）：已完成 / 待完成几个 / 定位到第几项
  function nodeStatusNow() {
    const items = collectCatalogItems();
    const st = catalogStatus(items);
    const cur = currentCatalogIndex(items);
    const s = (cur.i >= 0 && st[cur.i]) ? st[cur.i] : null;
    return {
      items: items, st: st, cur: cur,
      done: s ? s.done : false,
      todo: s ? s.todo : false,
      num:  s ? s.num  : 0
    };
  }

  /* v6：取某个目录项自身指向的 chapterId。
     为什么需要它 —— 诊断里出现过「当前定位 #7，却跳到了 #7」：
     定位那一刻 cur.i 是 -1（还没锁上），`i === cur.i` 这个排除条件形同虚设，
     于是脚本跳到了自己身上，原地打转。用 chapterId 兜一道，比靠下标可靠。 */
  function itemId(el) {
    if (!el) return '';
    let oc = '';
    try { oc = (el.getAttribute && el.getAttribute('onclick')) || ''; } catch (e) {}
    const m = oc.match(/\d{6,}/g);
    return (m && m.length) ? m[m.length - 1] : '';
  }

  function currentChapterId() {
    const m = location.search.match(/[?&]chapterId=(\d+)/i) || location.search.match(/chapterId=(\d+)/i);
    return m ? m[1] : '';
  }

  // 在目录列表里定位「当前正在学的那一节」
  function currentCatalogIndex(items) {
    if (!items || !items.length) return { i: -1, how: '' };
    const cid = currentChapterId();

    // ①-a 只看条目自身（onclick / href / id / data-*）—— 唯一可靠的精确匹配
    if (cid) {
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        let probe = '';
        try {
          probe = (el.getAttribute('onclick') || '') + ' ' +
                  (el.getAttribute('href') || '') + ' ' +
                  (el.getAttribute('data-id') || '') + ' ' +
                  (el.getAttribute('data-chapterid') || '') + ' ' +
                  (el.getAttribute('chapterid') || '') + ' ' +
                  (el.getAttribute('id') || '') + ' ' +
                  (el.outerHTML || '').slice(0, 600);
        } catch (e) {}
        if (probe.indexOf(cid) >= 0) return { i: i, how: 'chapterId(自身)' };
      }

      // ①-b 祖先兜底 —— 只认「祖先自身的 onclick / id / href」。
      //     v3 在这里读了祖先的 outerHTML，结果一级标题（它的容器里含有整章
      //     所有子项的 chapterId）总是先被命中，于是「当前节」永远被定位到
      //     「当前章」—— 这也是跳转老是从章首开始的根因。
      for (let i = 0; i < items.length; i++) {
        let n = items[i].parentElement;
        for (let k = 0; k < 3 && n; k++) {
          let pr = '';
          try {
            pr = (n.getAttribute('onclick') || '') + ' ' +
                 (n.getAttribute('id') || '') + ' ' +
                 (n.getAttribute('href') || '') + ' ' +
                 (n.getAttribute('data-chapterid') || '') + ' ' +
                 (n.getAttribute('chapterid') || '');
          } catch (e) {}
          if (pr.indexOf(cid) >= 0) return { i: i, how: 'chapterId(祖先)' };
          n = n.parentElement;
        }
      }
    }

    // ② class 里带 active / current / selected 等
    const HI = /(?:^|[\s_-])(active|actived|current|selected|sel|cur|now|on|checked|hover|this)(?:$|[\s_-])/i;
    for (let i = 0; i < items.length; i++) {
      let n = items[i];
      for (let k = 0; k < 5 && n && n !== document.body; k++) {
        if (HI.test(' ' + cls(n) + ' ')) return { i: i, how: 'class高亮' };
        n = n.parentElement;
      }
    }

    // ③ 背景色与「众数」不同（当前项通常有底色）
    try {
      const bgs = items.map(function (el) {
        let n = el;
        for (let k = 0; k < 3 && n && n !== document.body; k++) {
          let b = '';
          try { b = getComputedStyle(n).backgroundColor; } catch (e) {}
          if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b;
          n = n.parentElement;
        }
        return '';
      });
      const cnt = {};
      bgs.forEach(function (b) { if (b) cnt[b] = (cnt[b] || 0) + 1; });
      let topB = '', topN = 0;
      Object.keys(cnt).forEach(function (b) { if (cnt[b] > topN) { topN = cnt[b]; topB = b; } });
      if (topB && topN < items.length * 0.85) {
        for (let i = 0; i < items.length; i++) if (bgs[i] && bgs[i] !== topB) return { i: i, how: '底色' };
      }
    } catch (e) {}

    // ④ 页面上显示的当前章节标题文本 → 去目录里找包含它的条目
    try {
      const pool = $$('h1,h2,h3,h4,.chapter_title,[class*="chapterTitle"],[class*="chapter_title"],[class*="catalog_title"],[class*="caption"]');
      for (let i = 0; i < pool.length; i++) {
        const t = text(pool[i]);
        if (!t || t.length < 3 || t.length > 50) continue;
        for (let j = 0; j < items.length; j++) {
          const it = text(items[j]);
          if (it.indexOf(t) >= 0 || t.indexOf(it.replace(/^\d+(?:[.．]\d+)*\s*/, '')) >= 0) {
            return { i: j, how: '标题文本' };
          }
        }
      }
    } catch (e) {}

    return { i: -1, how: '' };
  }

  // 点目录条目：往上找带 onclick / 是 <a href> 的祖先
  function clickCatalogItem(item) {
    if (!item) return null;
    let target = item;
    let n = item;
    for (let i = 0; i < 6 && n && n !== document.body; i++) {
      let hasOn = false, isA = false;
      try {
        hasOn = !!(n.onclick || (n.getAttribute && n.getAttribute('onclick')));
        isA = (n.tagName === 'A' && n.getAttribute('href'));
      } catch (e) {}
      if (hasOn || isA) { target = n; break; }
      n = n.parentElement;
    }
    try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { target.click(); } catch (e) { return null; }
    return text(item) || text(target) || '(无文本)';
  }

  // 兜底：从整页 HTML 里抠出 chapterId 序列，按 URL 顺序推算下一个
  function chapterIdSequence() {
    let html = '';
    try { html = document.documentElement.innerHTML; } catch (e) { return []; }
    const re = /chapterid["'\s]*[:=]["'\s]*(\d{5,})/gi;
    const out = [], seen = {};
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen[m[1]]) continue;
      seen[m[1]] = 1;
      out.push(m[1]);
      if (out.length > 300) break;
    }
    return out;
  }

  function navToChapter(id) {
    try {
      const u = new URL(location.href);
      u.searchParams.set('chapterId', id);
      log('→ 直接导航到 chapterId=' + id);
      location.href = u.toString();
      return true;
    } catch (e) {
      log('导航失败：' + (e && e.message));
      return false;
    }
  }

  /* ---------------- 传统的「下一节」按钮（保留 + 扩充） ---------------- */
  // v4：站点有简体也有繁体（「下一節」「上一節」），两个字形都收。
  // 但**只收「跳章节」的词** ——「下一页 / 下一张 / 下一部」是课件翻页，
  // 绝不能出现在这里：goNext() 若点了翻页按钮，页面位置不变，
  // 跳转判定就会反复失败空转。
  const NEXT_WORDS = ['下一节', '下一節', '下一章', '下一讲', '下一講', '下一课', '下一課',
                      '下一个', '下一個',
                      '继续学习', '繼續學習', '继续播放', '继续观看'];

  function isDisabled(el) {
    if (!el) return false;
    if (el.disabled) return true;
    const c = cls(el) + ' ' + cls(el.parentElement);
    return /disabled|ban\b|grey|hui2?\b/i.test(c);
  }

  function findNextButton() {
    // v5：遍历所有可访问文档。v4 只在顶层文档里找，实测「下一節」按钮有时
    //     在内容 iframe 里 —— findNextButton 返回 null，跳转就只剩目录一条路，
    //     容错率骤降（v4 把官方按钮排在策略 1 其实没生效过）。
    const docs = docsList();
    for (let di = 0; di < docs.length; di++) {
      const d = docs[di];
      const ids = ['#prevNextFocusNext', '#prevNextFocusNext2', 'a.prev_next_next', '#next',
                   '.prev_next .next', '.prev_next_next', '[class*="nextChapter"]', '[class*="next_chapter"]'];
      for (let i = 0; i < ids.length; i++) {
        const el = $(ids[i], d);
        if (el && visible(el)) {
          const t = text(el) || ids[i];
          // 只认「跳章节」的措辞，「下一页」这类翻页词排除在外
          if (/下一\s*(节|節|章|讲|講|课|課|个|個)/.test(t) || /next/i.test(ids[i])) {
            return { el: el, label: t, disabled: isDisabled(el) };
          }
        }
      }
      // 按文本找（覆盖 .jb_btn_92 这类没有 id 的官方按钮）
      const pool = $$('a,button,input[type=button],input[type=submit],span,div,li,i', d);
      for (let i = 0; i < pool.length; i++) {
        const el = pool[i];
        if (el.children.length > 3) continue;
        if (!visible(el)) continue;
        const t = text(el);
        if (!t || t.length > 12) continue;
        for (let k = 0; k < NEXT_WORDS.length; k++) {
          if (t === NEXT_WORDS[k] || t.indexOf(NEXT_WORDS[k]) >= 0) {
            return { el: el, label: t, disabled: isDisabled(el) };
          }
        }
      }
    }
    return null;
  }

  function safeClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.click(); return true; } catch (e) { log('点击失败：' + (e && e.message)); return false; }
  }

  /* ================================================================
     图文课件（PPT / 文档）自动推进
     ----------------------------------------------------------------
     学习通的非视频任务点（PPT/文档/阅读）没有 <video>，靠「翻页 + 阅读
     时长」记进度。v2 遇到这种节点只会干等到 12 秒然后跳过，而任务点仍是
     未完成 → 立刻被目录拉回来 → A↔B 死循环。

     这里改成：周期性点翻页按钮（或滚动推进），内容连续多次没变化才认为
     本节读完了，然后走正常的"完成 → 下一节"流程。
     ================================================================ */

  // 翻页类按钮。
  // v5：**「下一节 / 下一節」必须从词表里剔除** —— 它是「跳章节」，不是「翻页」。
  //     v4 把它留在词表里，日志实测出现「🖱 课件翻页：点了「下一節」」，
  //     即脚本一边声称在翻 PPT、一边把整节跳掉了。这是「全飞了」的直接原因之一。
  const PAGE_WORDS = ['下一部', '下一页', '下一頁', '下一张', '下一張', '下一帧', '下一幀',
                      '下一步', '翻页', '翻頁', '继续阅读', '繼續閱讀'];
  // 绝不点的（后退 / 会中断学习的）
  const PAGE_BAD   = ['上一部', '上一页', '上一頁', '上一张', '上一張', '上一节', '上一節', '上一章',
                      '返回', '退出', '结束', '結束', '提交', '保存', '下载', '下載', '取消', '重做', '重置'];

  // v5：官方「跳章节」按钮的识别 —— 只要命中就不当课件翻页按钮用
  const CHAPTER_JUMP = /PCount\s*\.\s*next|getTeacherAjax|下一\s*[节節章讲講课課个個]/;

  // 课件不一定在顶层文档里 —— 学习通常把内容放在同源 iframe。
  // 以下三个探测函数都遍历所有可访问文档（跨域 iframe 读不到，不影响）。
  function docsList() {
    try { return walkDocs(); } catch (e) { return [document]; }
  }

  function findPageButton() {
    const docs = docsList();
    for (let di = 0; di < docs.length; di++) {
      const pool = $$('a,button,input[type=button],input[type=submit],span,div,li,i,em', docs[di]);
      for (let i = 0; i < pool.length; i++) {
        const el = pool[i];
        if (el.children.length > 2) continue;
        if (!visible(el)) continue;
        const t = text(el);
        if (!t || t.length > 10) continue;
        let bad = false;
        for (let k = 0; k < PAGE_BAD.length; k++) { if (t.indexOf(PAGE_BAD[k]) >= 0) { bad = true; break; } }
        if (bad) continue;
        // v5：官方跳章节按钮（onclick 带 PCount.next / getTeacherAjax）一律不当翻页按钮
        let probe = t;
        try {
          probe = t + ' ' + (el.getAttribute('onclick') || '') + ' ' +
                  (el.parentElement ? (el.parentElement.getAttribute('onclick') || '') : '');
        } catch (e) {}
        if (CHAPTER_JUMP.test(probe)) continue;
        for (let k = 0; k < PAGE_WORDS.length; k++) {
          if (t === PAGE_WORDS[k] || t.indexOf(PAGE_WORDS[k]) >= 0) {
            if (isDisabled(el)) continue;
            return { el: el, label: t };
          }
        }
      }
    }
    return null;
  }

  // 内容指纹：正文长度 + 图片数 + 滚动位置 + 首尾图片 src。
  // 翻页成功时这四样至少变一样。v4 补了图片 src —— PPT 是图片流，
  // 文本长度几乎不变，只有图片换了，没有这一项就看不出翻页。
  function docSignature() {
    let len = 0, imgs = 0, top = 0, pic = '';
    const docs = docsList();
    for (let di = 0; di < docs.length; di++) {
      const d = docs[di];
      let box = null;
      try {
        const hosts = ['.ans-attach-online', '.docContent', '#content', '.content',
                       '.reader', '.pdfContent', '[class*="docContent"]', '[class*="readContent"]'];
        for (let i = 0; i < hosts.length; i++) {
          const e = $(hosts[i], d);
          if (e && e.innerText && e.innerText.length > 60) { box = e; break; }
        }
      } catch (e) {}
      const root = box || d.body || d.documentElement;
      if (!root) continue;
      try { len += (root.innerText || '').length; } catch (e) {}
      try { imgs += root.querySelectorAll('img').length; } catch (e) {}
      // 文档级滚动（阅读器常滚 <html>，body.scrollTop 一直是 0）
      try { top += Math.round((d.scrollingElement || d.documentElement || root).scrollTop || 0); } catch (e) {}
      try { top += Math.round(root.scrollTop || 0); } catch (e) {}
      // v5 关键修正：把该文档里**所有** scrollTop > 0 的元素都算进来。
      //     v4 只算 scrollingElement / documentElement / root，而实测中真正被
      //     滚动的容器是另一个元素（诊断里它 class 为空、可滚 6577px），所以
      //     top 恒为 0 —— 指纹看不出滚动 → 明明在滚也被判"内容无变化" →
      //     45 秒一到就跳走。这是「PPT 没滑完就被跳过」的根因。
      try {
        let sum = 0;
        const all = $$('*', d);
        for (let k = 0; k < all.length && k < 1500; k++) {
          const st = all[k].scrollTop;
          if (st > 0) sum += st;
        }
        top += Math.round(sum);
      } catch (e) {}
      // 首 / 尾图片的 src 尾部片段 —— 翻页时最先变的就是它
      try {
        const im = root.querySelectorAll('img');
        if (im.length) {
          pic += String(im[0].src || '').slice(-26) + '/';
          if (im.length > 1) pic += String(im[im.length - 1].src || '').slice(-26);
          pic += '|';
        }
      } catch (e) {}
    }
    return len + '|' + imgs + '|' + top + '|' + pic.length + ':' + pic.slice(0, 60);
  }

  // 找主滚动容器（长文档型课件要靠滚动推进）
  // v4：① 文档级滚动（scrollingElement / documentElement / body）也算，
  //        很多阅读器滚的是 <html> 而不是某个 div
  //     ② 不再限定 div/section/article，扫描范围放宽到全部元素
  //     ③ 门槛从 200px 降到 120px，并放大容器权重
  function scrollBox() {
    const docs = docsList();
    let best = null, bestH = 0;

    function consider(e) {
      if (!e) return;
      let sh = 0, ch = 0;
      try { sh = e.scrollHeight - e.clientHeight; ch = e.clientHeight; } catch (e2) { return; }
      if (!(sh > 120) || !(ch > 60)) return;
      const score = sh + (ch >= window.innerHeight * 0.35 ? 1000 : 0);
      if (score > bestH) { bestH = score; best = e; }
    }

    for (let di = 0; di < docs.length; di++) {
      const d = docs[di];
      try { consider(d.scrollingElement); } catch (e) {}
      try { consider(d.documentElement); } catch (e) {}
      try { consider(d.body); } catch (e) {}

      let cand = [];
      try { cand = $$('div,section,article,main,ul,ol,form', d); } catch (e) { cand = []; }
      for (let i = 0; i < cand.length && i < 2000; i++) consider(cand[i]);

      // 常见标签没命中 → 再扫全部元素（限 4000，防卡）
      if (!best) {
        let all = [];
        try { all = $$('*', d); } catch (e) { all = []; }
        for (let i = 0; i < all.length && i < 4000; i++) consider(all[i]);
      }
    }
    return best;
  }

  /* ----------------------------------------------------------------
     v7：课件专用滚动元素 + 余量探测
     ----------------------------------------------------------------
     为什么要单开一个 docScroller()：
       scrollBox() 是「全文档取最优」，用于推进本身够用（实测它总能选中
       PPT：22730px 远大于主文档 1942px）。但用它做「推完了没」的判定
       会误判 —— 纯视频节点里没有 PPT iframe 时它会退回主文档（约 1942px），
       被当成"还有课件没翻完"。
       这里改用 iframe 的 URL 精确锁定课件：屏阅阅读器 / pdf 模块 / doc 模块，
       视频 iframe、主文档、about:blank 全部排除。
     ---------------------------------------------------------------- */
  const DOC_URL_RE = /ananas\/modules\/(pdf|doc)|pan-yz\.chaoxing\.com\/screen|\/screen\/v2\//;

  function docScroller() {
    let docs = [];
    try { docs = docsList(); } catch (e) { return null; }
    let best = null, bestMax = 0, bestTop = 0, bestUrl = '';
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (d === document) continue;
      let href = '';
      try { href = String((d.location && d.location.href) || ''); } catch (e) { continue; }
      if (!DOC_URL_RE.test(href)) continue;
      let els = [];
      try { els = [d.scrollingElement, d.documentElement, d.body]; } catch (e) { els = []; }
      for (let k = 0; k < els.length; k++) {
        const e = els[k];
        if (!e) continue;
        let m = 0;
        try { m = (e.scrollHeight || 0) - (e.clientHeight || 0); } catch (e2) { continue; }
        if (m > bestMax) {
          bestMax = m; best = e;
          try { bestTop = e.scrollTop || 0; } catch (e3) { bestTop = 0; }
          bestUrl = href;
        }
      }
    }
    return best ? { el: best, max: bestMax, top: bestTop, url: bestUrl } : null;
  }

  // 本节课件剩余量。left 是判据：> sweepTail 说明还没推到底。
  // 顺带一个天然保护 —— 若 iframe 里停的是**上一节**已经推到底的课件，
  // 它的 top 已经接近 max，left 很小，这里就不会重复推。
  function docSurface() {
    const s = docScroller();
    if (!s) return { max: 0, top: 0, left: 0, url: '' };
    return { max: s.max, top: s.top, left: Math.max(0, s.max - s.top), url: s.url };
  }

  /* ----------------------------------------------------------------
     v4：前进手势 —— 针对「没有按钮、也没有可写 scrollTop」的阅读器
     ----------------------------------------------------------------
     超星有些课件用的是屏阅式阅读器（iframe 里一页页图片），它既不提供
     文本翻页按钮，滚动也不落在任何我们可以直接写 scrollTop 的元素上，
     而是靠监听 wheel / 键盘 / 拖拽手势来翻页。v3 只会「点按钮 + 改
     scrollTop」，在这类阅读器上一动都推不动。

     下面三路手势都是**在目标文档内部**派发合成事件（同源可访问时有效）。
     ---------------------------------------------------------------- */
  function gestureForward(d) {
    let acted = false;
    const W = d.defaultView;
    if (!W) return false;
    const vw = W.innerWidth || 1000;
    const vh = W.innerHeight || 700;

    // ① 滚轮
    try {
      const cx = Math.round(vw / 2), cy = Math.round(vh / 2);
      let target = null;
      try { target = d.elementFromPoint ? d.elementFromPoint(cx, cy) : null; } catch (e) {}
      target = target || d.body || d.documentElement;
      if (target && W.WheelEvent) {
        // v7.3：次数与力度都放大 —— 原来固定 3 次 × 420px ≈ 1 屏；
        //       秒过模式下连发 docBoost 次 × docWheel px ≈ 12 屏
        const times = CFG.docFast ? CFG.docBoost : 3;
        const dy    = CFG.docFast ? CFG.docWheel : 420;
        for (let n = 0; n < times; n++) {
          target.dispatchEvent(new W.WheelEvent('wheel', {
            bubbles: true, cancelable: true, composed: true,
            deltaX: 0, deltaY: dy, deltaZ: 0, deltaMode: 0,
            clientX: cx, clientY: cy
          }));
        }
        acted = true;
      }
    } catch (e) {}

    // ② 键盘（PageDown / 方向键 —— 阅读器几乎都支持）
    try {
      const tgt = d.body || d.documentElement;
      if (tgt && W.KeyboardEvent) {
        const fire = function (key, code, kc) {
          const opt = {
            bubbles: true, cancelable: true, composed: true,
            key: key, code: code, keyCode: kc, which: kc
          };
          try { tgt.dispatchEvent(new W.KeyboardEvent('keydown', opt)); } catch (e) {}
          try { tgt.dispatchEvent(new W.KeyboardEvent('keyup', opt)); } catch (e) {}
        };
        /* v7.3：先按 End —— 屏阅 / PDF 阅读器普遍支持一键跳末页。
           支持就一次到底；不支持也只是空按一下，后面滚轮照旧兜底。 */
        if (CFG.docFast) fire('End', 'End', 35);
        const keys = [
          ['PageDown', 'PageDown', 34],
          ['ArrowDown', 'ArrowDown', 40],
          ['ArrowRight', 'ArrowRight', 39]
        ];
        // v7.3：原实现每轮只发一次按键（≈1 屏），这里按 docBoost 连发
        const reps = CFG.docFast ? CFG.docBoost : 1;
        for (let r = 0; r < reps; r++) {
          for (let i = 0; i < keys.length; i++) fire(keys[i][0], keys[i][1], keys[i][2]);
        }
        acted = true;
      }
    } catch (e) {}

    // ③ 拖拽（向左滑 = 下一页）
    try {
      const cy = Math.round(vh * 0.5);
      const x0 = Math.round(vw * 0.66);
      let target = null;
      try { target = d.elementFromPoint ? d.elementFromPoint(x0, cy) : null; } catch (e) {}
      target = target || d.body;
      if (target && W.MouseEvent) {
        const mk = function (type, x, btns) {
          return new W.MouseEvent(type, {
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: x, clientY: cy, button: 0, buttons: btns
          });
        };
        target.dispatchEvent(mk('mousedown', x0, 1));
        for (let n = 1; n <= 8; n++) {
          target.dispatchEvent(mk('mousemove', x0 - n * 55, 1));
        }
        target.dispatchEvent(mk('mouseup', Math.max(10, x0 - 440), 0));
        acted = true;
      }
    } catch (e) {}

    return acted;
  }

  function advanceDoc() {
    if (!CFG.docAdvance) return false;
    const now = Date.now();
    // v7.3：秒过模式用更短的节流（docStepFast），逐屏模式保持原值
    const step = CFG.docFast ? CFG.docStepFast : CFG.docStep;
    if (now - S.docPagedAt < step) return false;
    S.docPagedAt = now;

    const sig = docSignature();
    if (sig === S.docSig) {
      S.docStill++;
      log('课件推进后内容没变化（' + S.docStill + '/' + CFG.docStillMax + '）');
    } else {
      S.docStill = 0;
      S.docSig = sig;
      S.docPages++;                       // v4：指纹真的变了才算「推进了」
      S.lastDocActAt = now;
    }

    // 连续多次推不动 → 本节内容已尽。
    // v5：但"内容翻到底"≠"任务点完成" —— 还要目录也确认，才离开。
    //     否则就会出现 v4 那种情况：PPT 没滑完，脚本自己认为读完了，跳走。
    if (S.docStill >= CFG.docStillMax && S.docPages > 0) {
      let done = false, todo = 0;
      try { const ns = nodeStatusNow(); done = ns.done; todo = ns.num; } catch (e) {}
      if (done) {
        // v7：这是「视频播完后补推课件」的场景 —— 本节点任务点分在视频播完时
        //     已经计过一次，这里只收尾：标记清完 + 放行跳转，绝不能再调
        //     onNodeDone（否则重复 bumpFinished，还可能触发第二次 goNext）。
        if (S.pendingNextAfterDrain) {
          log('✅ 课件补推到底（共推进 ' + S.docPages + ' 次，目录已确认）—— 可以跳了');
          S.docPages = 0; S.docStill = 0;
          S.sweepDrained = true;
          S.pendingNextAfterDrain = false;
          if (IS_TOP && S.running) { try { goNext(); } catch (e) {} }
          return true;
        }
        log('✅ 图文课件已翻到底 + 目录确认已完成（共推进 ' + S.docPages + ' 次）');
        S.docPages = 0; S.docStill = 0;
        onNodeDone('课件翻到底+目录确认');
        return true;
      }
      if (!S.docStillWarned) {
        S.docStillWarned = true;
        log('课件已翻到底，但目录显示**未完成**' + (todo ? '（还剩 ' + todo + ' 个）' : '') + ' —— 原地继续，不跳');
      }
      S.docStill = 0;   // 重置，避免每个推进周期都刷同一句日志
    }

    // ① 文本翻页按钮 —— 最直接
    const pb = findPageButton();
    if (pb) {
      S.docBtn = pb.label;
      S.docPages = S.docPages || 0;
      log('🖱 课件翻页：点了「' + pb.label + '」');
      setAct('doc', '翻页「' + pb.label + '」');
      safeClick(pb.el);
      return true;
    }

    // ② 可写 scrollTop 的滚动容器
    //    v7：优先推「课件 iframe」里的滚动元素（docScroller 用 URL 精确锁定），
    //        取不到再退回全文档取最优的 scrollBox()。
    const dsc = docScroller();
    const box = dsc ? dsc.el : scrollBox();
    if (box) {
      const before = box.scrollTop;
      try { box.scrollTop = before + Math.max(300, box.clientHeight * 0.9); } catch (e) {}
      if (box.scrollTop !== before) {
        S.docBtn = '滚动(' + (cls(box) || box.tagName || '?').slice(0, 18) + ')';
        log('↕ 课件滚动推进 → ' + Math.round(box.scrollTop));
        setAct('doc', '滚动 ' + Math.round(box.scrollTop) + 'px');
        return true;
      }
    }

    // ③ 手势四路（滚轮 / 键盘 / 拖拽）—— 屏阅式阅读器走这一路
    //    v7：跳过视频 iframe —— 方向键 / 滚轮会被播放器吃掉，对推课件毫无用处
    const docsAll = docsList();
    let acted = false;
    for (let i = 0; i < docsAll.length; i++) {
      const dd = docsAll[i];
      if (dd === document) continue;
      let hh = '';
      try { hh = String((dd.location && dd.location.href) || ''); } catch (e) { continue; }
      if (/ananas\/modules\/video/.test(hh)) continue;
      try { if (gestureForward(dd) && !acted) acted = true; } catch (e) {}
    }
    if (acted) {
      S.docBtn = '手势(滚轮/键盘/拖拽)';
      log('✋ 课件手势推进（滚轮+键盘+拖拽）');
      setAct('doc', '手势翻页');
      return true;
    }

    return false;
  }

  function resetDoc() {
    S.docPagedAt = 0; S.docSig = ''; S.docStill = 0; S.docPages = 0; S.docBtn = '';
    S.lastDocActAt = 0; S.docStillWarned = false;
  }

  // 页面自己给出的"任务点已完成"标记 —— 这是最可靠的完成信号，
  // 比"翻到底了""时长播完了"都直接，优先采信它。
  function checkDoneMark() {
    if (!IS_TOP) return false;
    const key = nodeKey();
    if (S.doneMarkedKey === key) return false;
    const docs = docsList();
    for (let i = 0; i < docs.length; i++) {
      let t = '';
      try { t = (docs[i].body && docs[i].body.innerText) || ''; } catch (e) { continue; }
      // v4：站点有简体也有繁体版本，两个字形都要认，否则完成信号永远收不到
      if (/任务点\s*已完成|已完成该任务点|任务点完成|任務點\s*已完成|已完成該任務點|任務點完成|此任務點已完成|已看完/.test(t)) {
        S.doneMarkedKey = key;
        log('✅ 页面显示「任务点已完成」');
        onNodeDone('页面完成标记');
        return true;
      }
    }
    return false;
  }

  /* ---------------- 核心：前往下一个任务点 ---------------- */
  function goNext() {
    if (!S.running) return false;
    setAct('jump', '');   // v7.5：状态栏立刻显示「正在跳转下一节」

    const items = collectCatalogItems();
    S.catCount = items.length;

    const cur = currentCatalogIndex(items);
    S.catIndex = cur.i;
    S.catHow = cur.how;

    let st = [];
    try { st = catalogStatus(items); } catch (e) { st = []; }

    /* ----------------------------------------------------------------
       策略 1（v5 提到最前）：目录里第一个「待完成」项。
       这是唯一有意义的目标 —— 它直接对应「还有几个任务点没做」。
       排除当前项，否则原地打转。
       v4 是「按顺序跳下一项」，不看状态，所以一旦判定失误就一路飞过去。
       ---------------------------------------------------------------- */
    const cid0 = currentChapterId();
    for (let i = 0; i < items.length; i++) {
      if (i === cur.i) continue;
      if (!st[i] || !st[i].todo) continue;
      const lab = text(items[i]);
      if (!lab || isTried(lab)) continue;
      // v6：目标项自身的 chapterId 不能等于当前章节 —— 挡住「跳到原地」
      const tid = itemId(items[i]);
      if (tid && cid0 && tid === cid0) continue;
      const got = clickCatalogItem(items[i]);
      if (got) {
        log('→ 目录待完成项 #' + i + '（待完成 ' + (st[i].num || '?') + ' 个）«' + lab.slice(0, 32) + '»');
        markTried(lab);
        S.giveUpRound = 0;
        afterJump(lab);
        return true;
      }
    }

    /* 策略 2：官方「下一節 / 下一节」按钮。
       页面自带入口（onclick="PCount.next(...)"），跳完目录与内容 iframe
       都会正确重建 —— 比点目录可靠。 */
    const n0 = findNextButton();
    if (n0) {
      if (n0.disabled) { finish('「' + n0.label + '」已禁用 —— 已到课程末尾'); return false; }
      log('→ 点击官方「' + n0.label + '」');
      safeClick(n0.el);
      S.giveUpRound = 0;
      afterJump(n0.label);
      return true;
    }

    /* 策略 3：目录 —— 当前项的下一项 */
    if (items.length >= 2 && cur.i >= 0) {
      let allTried = true;
      for (let nx = cur.i + 1; nx < items.length; nx++) {
        if (text(items[nx]) !== text(items[cur.i]) && !isTried(text(items[nx]))) { allTried = false; break; }
      }
      if (allTried && cur.i < items.length - 1) {
        if (S.jumpFails >= 2) {
          finish('目录里剩下的项点了都没反应 —— 已停止（点「⏭ 下一节」可强制重试）');
          return false;
        }
        S.jumpFails++;
        clearTried();
        log('目录项都试过了，清空重试标记再来一轮（第 ' + S.jumpFails + ' 轮）');
      }

      for (let nx = cur.i + 1; nx < items.length; nx++) {
        const lab = text(items[nx]);
        if (lab === text(items[cur.i])) continue;          // 同文本跳过
        if (isTried(lab)) continue;                        // 点过没反应的跳过
        const tid2 = itemId(items[nx]);                     // v6：别跳到当前章节自己
        if (tid2 && cid0 && tid2 === cid0) continue;
        const got = clickCatalogItem(items[nx]);
        if (got) {
          log('→ 目录下一项（' + cur.how + ' 定位 #' + cur.i + '）→ #' + nx + ' «' + lab.slice(0, 32) + '»');
          markTried(lab);
          S.giveUpRound = 0;
          afterJump(lab);
          return true;
        }
      }
    }

    /* 策略 4：chapterId 序列推算（整页导航兜底） */
    const seq = chapterIdSequence();
    const cid = currentChapterId();
    if (cid && seq.length >= 2) {
      const at = seq.indexOf(cid);
      if (at >= 0 && at < seq.length - 1) {
        if (navToChapter(seq[at + 1])) { S.giveUpRound = 0; afterJump('id:' + seq[at + 1]); return true; }
      }
      // 当前 id 不在序列里，但序列非空 → 取第一个不等于当前 id 的
      for (let i = 0; i < seq.length; i++) {
        if (seq[i] !== cid) { if (navToChapter(seq[i])) { S.giveUpRound = 0; afterJump('id:' + seq[i]); return true; } break; }
      }
    }

    finish('目录项 ' + items.length + ' 个 ｜ 定位=' + (S.catHow || '失败') +
           ' ｜ 没找到「下一节」按钮 ｜ chapterId 序列空 —— 无法继续，已停止');
    return false;
  }

  // 目录里第一个「像未完成」的项：橙色数字 / 未完成类名
  function firstUnfinished(items) {
    // a) 橙点
    const marks = $$('[class*="orange"],[class*="Orange"],[class*="unfinish"],[class*="notFinish"],[class*="notfinish"],[class*="weiWanCheng"],[class*="weiwancheng"]');
    for (let i = 0; i < marks.length; i++) {
      if (!visible(marks[i])) continue;
      // 标记在某个目录项内部
      for (let j = 0; j < items.length; j++) {
        const it = items[j];
        if (it.contains(marks[i])) {
          if (!isTried(text(it))) return { el: it, how: '橙标' };
        }
      }
      // 标记不在项内 → 取标记后面的第一个目录项
      let n = marks[i];
      for (let k = 0; k < 6 && n; k++) {
        for (let j = 0; j < items.length; j++) {
          if (items[j] === n) {
            if (!isTried(text(items[j]))) return { el: items[j], how: '橙标邻接' };
          }
        }
        n = n.parentElement;
      }
    }
    // b) 目录项自身带未完成语义的类名
    for (let i = 0; i < items.length; i++) {
      let n = items[i];
      for (let k = 0; k < 4 && n && n !== document.body; k++) {
        const c = cls(n);
        if (/unfinish|notfinish|not_finish|weiWanCheng|weiwancheng|todo/i.test(c)) {
          if (!isTried(text(items[i]))) return { el: items[i], how: '类名' };
        }
        n = n.parentElement;
      }
    }
    return null;
  }

  function nodeKey() {
    const a = [];
    try { $$('iframe').forEach(function (f) { if (f.src) a.push(f.src); }); } catch (e) {}
    return location.pathname + location.search + '#' + a.join('|');
  }

  function afterJump(label) {
    S.lastJumpAt = Date.now();
    const before = nodeKey();
    const beforeUrl = location.href;
    setTimeout(function () {
      if (!S.running) return;
      if (location.href !== beforeUrl || nodeKey() !== before) {
        S.jumpFails = 0;
        resetDoc();
        log('已进入下一个节点 ✓');
      } else {
        delete S.tried[label];
        persistTried();
        log('「' + label + '」点了没反应，解除标记以便换策略重试');
      }
    }, 4000);
  }

  function onNodeDone(src) {
    const now = Date.now();
    if (now - S.lastDoneAt < 6000) return;
    S.lastDoneAt = now;
    bumpFinished();
    S.jumpFails = 0;
    resetDoc();
    setAct('done', src);
    log('✅ 任务点完成（' + src + '），累计 ' + S.finished + ' 个');

    if (!CFG.autoNext) return;

    /* ----------------------------------------------------------------
       v7：本节还有没推完的课件 → 先不跳。
       「上面视频、下面 PPT」的节点，视频播完只代表视频那个任务点做完，
       下方课件还停在第一页。v6 在这里直接 goNext()，PPT 就被整节掠过。
       现在挂起这次跳转，交给 tick() 的补推逻辑；课件推完（或超过
       sweepMax 轮）时再走。计分已经在上面的 bumpFinished() 记过一次，
       后面放行时不会再记 —— 见 advanceDoc() 里的 pendingNextAfterDrain 分支。
       ---------------------------------------------------------------- */
    if (CFG.docSweep) {
      // 先把本节点的补推状态对上（takeVideo → markDone → 这里，可能早于 tick）
      const nk0 = nodeKey();
      if (S.sweepKey !== nk0) { S.sweepKey = nk0; S.sweepDrained = false; S.sweepRounds = 0; }
      if (!S.sweepDrained) {
        const surf = docSurface();
        if (surf.max > CFG.sweepMin && surf.left > CFG.sweepTail) {
          S.pendingNextAfterDrain = true;
          setAct('sweep', '第 0 次');
          log('⏳ 本节下方还有课件（可滚 ' + surf.max + 'px ｜ 已滚 ' + Math.round(surf.top) +
              'px ｜ 还剩 ' + surf.left + 'px）—— 先推完再跳');
          return;
        }
      }
    }

    const key = nodeKey();
    setTimeout(function () {
      if (!S.running) return;
      if (nodeKey() === key) {
        log('页面没有自动跳转，手动前往下一个任务点');
        S.jumpFails++;
        if (S.jumpFails >= CFG.jumpRetry) {
          finish('连续 ' + CFG.jumpRetry + ' 次跳转都没反应，已停止');
          return;
        }
        goNext();
      } else {
        log('页面已自动跳转 ✓');
      }
    }, CFG.waitAfterEnd * 1000);
  }

  /* ---------------- 关闭防挂机弹窗 ---------------- */
  const SAFE_BTN = ['继续观看', '继续播放', '继续学习', '继续听课', '我知道了', '知道了', '立即播放', '继续'];
  const BAD_BTN  = ['提交', '交卷', '结束', '退出', '放弃', '删除', '取消', '返回', '重做', '重置', '清空', '注销', '上一节'];

  function looksQuiz(h) {
    if (h.querySelector('input[type=radio],input[type=checkbox],textarea,select')) return true;
    const t = h.innerText || '';
    return /单选题|多选题|判断题|填空题|问答题|请作答|提交答案|随堂测验|课堂互动/.test(t);
  }

  function closePopups(doc) {
    const hosts = $$('.layui-layer, [class*="popup"], [class*="dialog"], [class*="layer"], [class*="modal"], [class*="mask"], #popup_container, [class*="ans-tip"], [class*="notice"], [class*="tips"]', doc);
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i];
      if (!visible(h)) continue;
      let r;
      try { r = h.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width > window.innerWidth * 0.97 && r.height > window.innerHeight * 0.97) continue;

      if (looksQuiz(h)) {
        if (!S.quizNoticed) { S.quizNoticed = true; log('⚠ 检测到测验 / 答题弹窗 —— 需要你人工处理（脚本不会乱点）'); }
        continue;
      }

      const btns = $$('a,button,input[type=button],input[type=submit],span,div', h);
      for (let j = 0; j < btns.length; j++) {
        const b = btns[j];
        if (b.children.length > 1) continue;
        if (!visible(b)) continue;
        const t = text(b);
        if (!t || t.length > 12) continue;
        let bad = false;
        for (let k = 0; k < BAD_BTN.length; k++) { if (t.indexOf(BAD_BTN[k]) >= 0) { bad = true; break; } }
        if (bad) continue;
        let hit = false;
        for (let k = 0; k < SAFE_BTN.length; k++) { if (t.indexOf(SAFE_BTN[k]) >= 0) { hit = true; break; } }
        if (hit) {
          log('🖱 关闭弹窗：点了「' + t + '」');
          safeClick(b);
          break;
        }
      }
    }
  }

  /* ---------------- 诊断 ---------------- */
  function diagReport() {
    const L = [];
    L.push('===== 学习通自动连播 v7.5.0 · 诊断 =====');
    L.push('时间: ' + new Date().toLocaleString());
    L.push('URL : ' + location.href);
    L.push('chapterId: ' + (currentChapterId() || '(无)'));
    L.push('状态: running=' + S.running + ' finished=' + S.finished + ' reason=' + (S.reason || '-'));
    L.push('可访问文档: ' + walkDocs().length + ' ｜ 跨域 iframe: ' + S.blockedFrame);

    const items = collectCatalogItems();
    const cur = currentCatalogIndex(items);
    let stArr = [];
    try { stArr = catalogStatus(items); } catch (e) {}
    L.push('');
    L.push('--- 目录项 (' + items.length + ' 个)，当前定位: ' + (cur.i >= 0 ? ('#' + cur.i + ' via ' + cur.how) : '失败') + ' ---');
    for (let i = 0; i < items.length && i < 40; i++) {
      const el = items[i];
      let oc = '';
      try { oc = el.getAttribute('onclick') || ''; } catch (e) {}
      let a = el.parentElement, ocA = '';
      for (let k = 0; k < 3 && a; k++) {
        try { ocA = a.getAttribute('onclick') || ''; } catch (e) {}
        if (ocA) break;
        a = a.parentElement;
      }
      const r = (function () { try { return el.getBoundingClientRect(); } catch (e) { return null; } })();
      const s = stArr[i] || {};
      const tag = s.done ? '  [已完成]' : (s.todo ? ('  [待完成' + (s.num ? ' ' + s.num : '') + ']') : '');
      L.push('  #' + i + ' «' + text(el).slice(0, 30) + '»' + tag);
      L.push('      class="' + cls(el).slice(0, 80) + '"  parent.class="' + cls(el.parentElement).slice(0, 80) + '"');
      L.push('      pos=(' + (r ? Math.round(r.left) + ',' + Math.round(r.top) : '?') + ',' + (r ? Math.round(r.width) + 'x' + Math.round(r.height) : '?') + ')');
      if (oc) L.push('      onclick="' + oc.slice(0, 160) + '"');
      if (ocA) L.push('      parent.onclick="' + ocA.slice(0, 160) + '"');
    }

    const nb = findNextButton();
    L.push('');
    L.push('--- 「下一节」按钮: ' + (nb ? ('✔ «' + nb.label + '» disabled=' + nb.disabled) : '✘ 没找到') + ' ---');

    const seq = chapterIdSequence();
    L.push('');
    L.push('--- 页面内 chapterId 序列 (' + seq.length + ' 个): ' + seq.slice(0, 20).join(', '));
    const cid = currentChapterId();
    if (cid) L.push('    当前 id 在序列中的位置: ' + seq.indexOf(cid));

    const docs = walkDocs();
    L.push('');
    L.push('--- 视频（真 / 假判定）---');
    docs.forEach(function (d, i) {
      let vs = [];
      try { vs = d.querySelectorAll('video'); } catch (e) {}
      let url = '?';
      try { url = (d === document) ? location.href : (d.location ? d.location.href : 'same-doc'); } catch (e) { url = 'cross-origin'; }
      L.push('  [' + i + '] video=' + vs.length + '  ' + String(url).slice(0, 100));
      Array.prototype.forEach.call(vs, function (v, j) {
        const r = (function () { try { return v.getBoundingClientRect(); } catch (e) { return null; } })();
        L.push('        #' + j + ' 时长=' + v.duration + ' 进度=' + v.currentTime +
               ' 暂停=' + v.paused + ' 倍速=' + v.playbackRate +
               ' 尺寸=' + (r ? Math.round(r.width) + 'x' + Math.round(r.height) : '?') +
               ' 真视频=' + isRealVideo(v));
        // v6：视频起不来时，这几项决定下一步怎么修
        L.push('             ready=' + v.readyState + ' 网络=' + v.networkState +
               ' src=' + ((v.currentSrc || v.src || '').slice(0, 56) || '(空)') +
               ' 播放键=' + (v.__cx ? ('点了 ' + (v.__cx.btnClicks || 0) + ' 次') : '未接管'));
      });
    });

    L.push('');
    L.push('--- 课件推进状态 ---');
    L.push('  节点状态: ' + (S.nodeDone ? '已完成' : (S.nodeTodoNum ? ('待完成 ' + S.nodeTodoNum + ' 个') : '未标记')) +
           ' ｜ 前进宽限轮次: ' + S.giveUpRound);
    L.push('  本节点无视频已 ' + (S.noVideoAt ? Math.round((Date.now() - S.noVideoAt) / 1000) + ' 秒' : '—') +
           ' ｜ 前进阈值 ' + Math.round(CFG.docGiveUp / 1000) + 's / ' + Math.round(CFG.docGiveUp2 / 1000) + 's');
    L.push('  已推进 ' + S.docPages + ' 次 ｜ 上次动作 «' + (S.docBtn || '-') + '» ｜ 连续无变化 ' + S.docStill + '/' + CFG.docStillMax);
    L.push('  需人工节点: ' + S.manualNeeded + ' ｜ 最后有效变化: ' +
           (S.lastDocActAt ? Math.round((Date.now() - S.lastDocActAt) / 1000) + ' 秒前' : '从未'));
    L.push('  内容指纹: ' + docSignature());
    const pbtn = findPageButton();
    L.push('  翻页按钮: ' + (pbtn ? ('✔ «' + pbtn.label + '»') : '✘ 没找到'));
    const sbox = scrollBox();
    L.push('  滚动容器: ' + (sbox ? (('"' + cls(sbox) + '"').slice(0, 62) + ' 可滚 ' + (sbox.scrollHeight - sbox.clientHeight) + 'px') : '✘ 没找到'));

    // v7：视频节点是否会补推课件，全靠这几行判断
    const dsc7 = docScroller();
    const sf7 = docSurface();
    L.push('  课件余量: ' + (sf7.max > 0
      ? ('可滚 ' + sf7.max + 'px ｜ 当前 ' + Math.round(sf7.top) + 'px ｜ 还剩 ' + sf7.left + 'px ｜ ' +
         (sf7.max > CFG.sweepMin ? (sf7.left > CFG.sweepTail ? '【判定：有课件待推】' : '【判定：已推到底】') : '【判定：不足 ' + CFG.sweepMin + 'px，不算课件】'))
      : '✘ 没有课件类 iframe'));
    L.push('  课件滚动元素: ' + (dsc7
      ? ((cls(dsc7.el) || dsc7.el.tagName) + '  «' + String(dsc7.url).slice(0, 58) + '»')
      : '✘'));
    L.push('  视频后补推: ' + (S.sweepKey
      ? (S.sweepDrained
          ? (S.sweepGaveUp
              ? ('已达上限放弃（有效推进 ' + (S.sweepRounds || 0) + '/' + CFG.sweepMax + ' 次）')
              : '已清完')
          : (S.pendingNextAfterDrain
              ? ('进行中（有效推进 ' + (S.sweepRounds || 0) + '/' + CFG.sweepMax +
                 ' 次 ｜ 连续推不动 ' + (S.sweepStill || 0) + '/' + CFG.sweepStillMax + '）')
              : '未触发'))
      : '未进入过视频节点'));

    // v4：逐个文档看「能不能滚」——判断屏阅式阅读器（PPT）走哪条路的关键
    L.push('');
    L.push('--- 各文档滚动能力 ---');
    docs.forEach(function (d, i) {
      let url = '?';
      try { url = (d === document) ? '(top)' : (d.location ? d.location.href : 'same-doc'); } catch (e) { url = 'cross-origin'; }
      let seSh = 0, seCh = 0;
      try {
        const se = d.scrollingElement || d.documentElement;
        seSh = se ? se.scrollHeight : 0;
        seCh = se ? se.clientHeight : 0;
      } catch (e) {}
      let nBig = 0, biggest = '';
      try {
        const el = $$('div,section,article,main', d);
        let bestH = 0;
        for (let k = 0; k < el.length && k < 2500; k++) {
          let diff = 0;
          try { diff = el[k].scrollHeight - el[k].clientHeight; } catch (e) { continue; }
          if (diff > 120) nBig++;
          if (diff > bestH) { bestH = diff; biggest = (cls(el[k]) || el[k].tagName) + ' +' + diff + 'px'; }
        }
      } catch (e) {}
      L.push('  [' + i + '] 可滚元素 ' + nBig + ' 个 ｜ 最大 «' + String(biggest).slice(0, 48) + '» ｜ doc ' + seSh + '/' + seCh);
      L.push('       ' + String(url).slice(0, 92));
    });

    L.push('');
    L.push('--- 页面可见按钮 / 链接文本（最多 200 个）---');
    try {
      const btns = $$('a,button,input[type=button],input[type=submit],span,div,li,i');
      const list = [];
      for (let i = 0; i < btns.length && list.length < 200; i++) {
        const e = btns[i];
        if (e.children.length > 1) continue;
        if (!visible(e)) continue;
        const t = text(e);
        if (!t || t.length > 16) continue;
        let oc = '';
        try { oc = (e.getAttribute('onclick') || '').slice(0, 60); } catch (ex) {}
        list.push('«' + t + '» ' + (cls(e) ? 'class="' + cls(e).slice(0, 34) + '" ' : '') + (oc ? 'onclick="' + oc + '"' : ''));
      }
      L.push('  共 ' + list.length + ' 个：');
      list.slice(0, 60).forEach(function (x) { L.push('    ' + x); });
      if (list.length > 100) {
        L.push('    ...（中间省略 ' + (list.length - 100) + ' 个）...');
        list.slice(-40).forEach(function (x) { L.push('    ' + x); });
      }
    } catch (e) {}

    L.push('');
    L.push('--- 日志（最后 25 条）---');
    logs.slice(-25).forEach(function (x) { L.push('  ' + x); });

    return L.join('\n');
  }

  /* ---------------- 悬浮面板 ---------------- */
  let hostEl = null, shadow = null;

  function buildPanel() {
    if (hostEl || !IS_TOP || !document.body || !CFG.panel) return;
    hostEl = document.createElement('div');
    hostEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      '.b{width:270px;font:12px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;background:linear-gradient(180deg,#1b1f29 0%,#14171f 100%);color:#d7dbe4;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.08);overflow:hidden}',
      '.hd{display:flex;align-items:center;gap:8px;padding:11px 12px 9px;cursor:move;user-select:none}',
      /* v7.6 红绿灯：三灯横排，每次只亮一颗 —— 绿=正常运行 / 黄=暂停·等待 / 红=停止·出错 */
      '.lights{display:flex;align-items:center;gap:5px;flex:0 0 auto;margin-right:auto}',
      '.l{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.10);transition:background .25s,box-shadow .25s,opacity .25s}',
      '.lights.on-g .g{background:#22c55e;box-shadow:0 0 9px rgba(34,197,94,.95)}',
      '.lights.on-y .y{background:#f59e0b;box-shadow:0 0 9px rgba(245,158,11,.95)}',
      '.lights.on-r .r{background:#ef4444;box-shadow:0 0 9px rgba(239,68,68,.95);animation:cxLampBlink .85s ease-in-out infinite}',
      '@keyframes cxLampBlink{0%,100%{opacity:1}50%{opacity:.22}}',
      '.ver{font-size:9.5px;font-weight:700;color:#545c6b;letter-spacing:.3px;flex:0 0 auto}',
      '.x{flex:0 0 auto;width:22px;height:22px;padding:0;border:0;border-radius:7px;background:rgba(255,255,255,.05);color:#6b7383;font-size:11px;line-height:1;cursor:pointer;font-family:inherit;transition:background .15s,color .15s}',
      '.x:hover{background:#7f1d1d;color:#fecaca}',
      /* v7.6 状态栏：只剩一行大字，文字自带状态色动效，铺满整栏 */
      '.stat{margin:0 12px 11px}',
      '.sx{display:block;font-size:13px;font-weight:700;line-height:1.45;letter-spacing:.3px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c9d1de}',
      /* 运行中 = 五彩跑马 */
      '.stat.run .sx{background:linear-gradient(90deg,#f472b6,#fbbf24,#4ade80,#22d3ee,#a78bfa,#f472b6);background-size:280% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:cxRainbow 3.4s linear infinite}',
      '@keyframes cxRainbow{from{background-position:0% 50%}to{background-position:280% 50%}}',
      /* 等待/暂停 = 黄 */
      '.stat.hold .sx{color:#fbbf24}',
      /* 本节完成 = 蓝 */
      '.stat.done .sx{color:#93c5fd}',
      /* 停止/出错 = 红 + 微闪 */
      '.stat.stop .sx{color:#fca5a5;animation:cxFlick 1.35s ease-in-out infinite}',
      '@keyframes cxFlick{0%,100%{opacity:1}50%{opacity:.42}}',
      '.grid{padding:0 12px 10px;display:grid;grid-template-columns:auto 1fr;gap:5px 10px;align-items:baseline}',
      '.k{color:#767e8d;font-size:10.5px;white-space:nowrap}',
      '.v{color:#e9ecf2;font-weight:600;font-size:11.5px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
      '.pw{height:6px;margin:0 12px 6px;border-radius:3px;background:rgba(255,255,255,.075);overflow:hidden}',
      '.pw>i{display:block;height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#34d399,#22c55e);transition:width .45s cubic-bezier(.4,0,.2,1)}',
      '.pt{display:flex;align-items:baseline;gap:8px;margin:0 12px 11px;font-size:10.5px;color:#767e8d;font-variant-numeric:tabular-nums}',
      '.pt .ctx{flex:1;min-width:0;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pt b{color:#a8b1c0;font-weight:600}',
      '.btns{display:flex;gap:7px;padding:0 12px 7px}',
      '.btns.end{padding-bottom:12px}',
      'button{flex:1;border:0;border-radius:9px;padding:8px 0;font-size:11.5px;font-weight:600;cursor:pointer;background:#2b3140;color:#c9cfdb;font-family:inherit;white-space:nowrap;transition:background .15s,transform .12s}',
      'button:hover{background:#39414f;transform:translateY(-1px)}',
      'button:active{transform:translateY(0)}',
      '.resume{background:#166534;color:#bbf7d0}.resume:hover{background:#15803d}',
      '.diag{background:#1e3a8a;color:#dbeafe}.diag:hover{background:#1d4ed8}',
      '.msg{padding:0 12px 10px;color:#fbbf24;font-size:10.5px;line-height:1.55;white-space:pre-wrap}',
      '.msg:empty{display:none}',
      'textarea{width:calc(100% - 24px);height:150px;margin:0 12px 10px;font:10px/1.45 monospace;background:#0a0f1a;color:#c7d2fe;border:1px solid #2b3140;border-radius:8px;padding:6px;box-sizing:border-box;display:none}',
      '</style>',
      '<div class="b">',
      '<div class="hd" id="hd"><div class="lights on-g" id="lights"><i class="l r"></i><i class="l y"></i><i class="l g"></i></div><span class="ver">v7.6.0</span><button class="x" id="stop" title="停用脚本（需刷新页面才能恢复）">✕</button></div>',
      '<div class="stat run" id="stat"><span class="sx" id="sx">初始化…</span></div>',
      '<div class="grid">',
      '<span class="k">已完成</span><span class="v" id="fn">0</span>',
      '<span class="k">课件推进</span><span class="v" id="doc">—</span>',
      '</div>',
      '<div class="pw"><i id="bar"></i></div>',
      '<div class="pt"><span id="pg">—</span><span class="ctx" id="ctx"></span><span><b id="pp">—</b></span></div>',
      '<div class="btns">',
      '<button id="pause">⏸ 暂停</button>',
      '<button id="skip">⏭ 下一节</button>',
      '</div>',
      '<div class="btns end">',
      '<button id="rate">1.5x</button>',
      '<button id="diag" class="diag">📋 诊断</button>',
      '</div>',
      '<div class="msg" id="msg"></div>',
      '<textarea id="ta" readonly></textarea>',
      '</div>'
    ].join('');

    document.documentElement.appendChild(hostEl);

    /* v7.4：按钮语义拆清 ——
       ⏸ 暂停/▶ 继续  挂起自动操作，进度全留，同键来回切
       ✕（右上角）     真正停用脚本
       ⏭ 下一节        当前节点立刻放行，去下一个待完成项
       （课件「秒过」自 v7.4 起固定开启，UI 已去掉切换开关）
       Nx              倍速循环                                                     */
    shadow.getElementById('rate').onclick = function () {
      const seq = [1, 1.25, 1.5, 2, 2.5, 3];
      const i = seq.indexOf(CFG.rate);
      CFG.rate = seq[(i + 1) % seq.length];
      S.rateBlocked = false;
      log('倍速 → ' + CFG.rate + 'x');
      paint();
    };
    shadow.getElementById('pause').onclick = function () {
      S.running = !S.running;
      if (S.running) { start(); log('▶ 已继续'); }
      else { log('⏸ 已暂停（进度保留，点「继续」恢复）'); }
      paint();
    };
    shadow.getElementById('stop').onclick = function () { finish('用户手动停止'); };
    shadow.getElementById('skip').onclick = function () {
      S.jumpFails = 0;
      clearTried();
      log('⏭ 手动前往下一节 →');
      goNext();
    };
    shadow.getElementById('diag').onclick = function () {
      const s = diagReport();
      const ta = shadow.getElementById('ta');
      ta.style.display = 'block';
      ta.value = s;
      try { ta.select(); document.execCommand('copy'); } catch (e) {}
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(s);
      } catch (e) {}
      this.textContent = '✓ 已复制';
      const self = this;
      setTimeout(function () { self.textContent = '📋 诊断'; }, 2500);
      console.log(s);
    };

    (function () {
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      const hd = shadow.getElementById('hd');
      hd.addEventListener('mousedown', function (e) {
        dragging = true;
        const r = hostEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        hostEl.style.right = 'auto'; hostEl.style.bottom = 'auto';
        hostEl.style.left = ox + 'px'; hostEl.style.top = oy + 'px';
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        hostEl.style.left = (ox + e.clientX - sx) + 'px';
        hostEl.style.top  = (oy + e.clientY - sy) + 'px';
      });
      window.addEventListener('mouseup', function () { dragging = false; });
    })();
  }

  /* ----------------------------------------------------------------
     v7.5 动作状态机 —— 状态栏「不实时」的根因修复。
     v7.4 的毛病：状态是从一堆滞后字段「推断」的，判定顺序里 nodeDone
     排在 hasV 前面 —— 于是「视频还在播 + 目录已标完成」的节点永远显示
     「本节已完成」，用户从来看不到视频状态；而「正在划 PPT」排在最后，
     有视频的节点根本轮不到。
     现在改成**动作发生时打点**：谁在干活，谁就把名字写进 S.act，
     paint() 只渲染最新鲜的那条。act 超过 ACT_FRESH 未更新即自动降级
     到兜底推断，所以不会卡在一个过期状态上。
     ---------------------------------------------------------------- */
  const ACT_FRESH = 9000;
  const ACT_MAP = {
    video:  { i: '▶',  t: '正在播放视频',           m: 'run'  },
    vpause: { i: '⏸',  t: '视频被暂停 · 正在恢复',   m: 'hold' },
    vload:  { i: '⏳', t: '正在加载视频',           m: 'hold' },
    vend:   { i: '✓',  t: '视频已播完',             m: 'done' },
    doc:    { i: '⚡', t: '正在划 PPT',              m: 'run'  },
    sweep:  { i: '⚡', t: '正在划 PPT · 补推',       m: 'run'  },
    jump:   { i: '⏭', t: '正在跳转下一节',          m: 'run'  },
    done:   { i: '✓',  t: '本节已完成',             m: 'done' },
    quiz:   { i: '⚠', t: '有测验弹窗 · 等人工作答',   m: 'hold' },
    idle:   { i: '…', t: '等待节点就绪',            m: 'hold' }
  };

  function setAct(k, s) {
    if (!S.act) S.act = { k: '', at: 0, s: '' };
    const t = Date.now();
    if (S.act.k === k && S.act.s === (s || '')) { S.act.at = t; return; }
    S.act.k = k; S.act.s = s || ''; S.act.at = t;
  }

  function paint() {
    if (!IS_TOP || !CFG.panel) return;
    if (!hostEl) buildPanel();
    if (!shadow) return;
    const sxEl = shadow.getElementById('sx');
    if (!sxEl) return;
    const ctxEl = shadow.getElementById('ctx');
    const stEl  = shadow.getElementById('stat');
    const lamps = shadow.getElementById('lights');

    const v = S.video;
    const hasV = !!(v && v.duration > 0 && isFinite(v.duration));
    const vp = hasV ? Math.min(1, v.currentTime / v.duration) : 0;
    const left = hasV ? Math.max(0, v.duration - v.currentTime) : 0;

    /* ① 先定「实时动作」：新鲜的 act 优先，过期才退回兜底推断 */
    const fresh = !!(S.act && (Date.now() - S.act.at) < ACT_FRESH);
    let k;
    if (fresh)                        k = S.act.k;
    else if (S.pendingNextAfterDrain) k = 'sweep';
    else if (S.nodeDone)              k = 'done';
    else if (hasV)                    k = (v.paused || v.ended) ? 'vend' : 'video';
    else if (S.docPages)              k = 'doc';
    else                              k = 'idle';

    /* ② 硬状态覆盖动作态：停止 / 暂停 / 测验弹窗优先级最高 */
    let icon, text, mode;
    if (!S.running) {
      if (S.reason) { icon = '⏹'; text = '已停止 · ' + S.reason;   mode = 'stop'; }
      else          { icon = '⏸'; text = '已暂停 · 点「继续」恢复'; mode = 'hold'; }
    } else if (S.quizNoticed) {
      icon = '⚠'; text = '有测验弹窗 · 等人工作答'; mode = 'hold';
    } else {
      const a = ACT_MAP[k] || ACT_MAP.idle;
      icon = a.i; text = a.t; mode = a.m;
    }

    /* ③ 副行 = 上下文：目录位置 / 剩余时长 / 补推进度 / 本次动作细节 */
    const parts = [];
    if (S.catIndex >= 0) parts.push('目录 #' + S.catIndex);
    if (hasV && !v.ended) parts.push('剩 ' + fmtTime(left));
    if (S.pendingNextAfterDrain) parts.push('补推 ' + (S.sweepRounds || 0) + '/' + CFG.sweepMax);
    if (S.nodeDone) parts.push('本节已完成');
    if (fresh && S.act.s) parts.push(S.act.s);

    sxEl.textContent = text;
    if (ctxEl) ctxEl.textContent = parts.join('  ·  ');
    if (stEl.className !== 'stat ' + mode) stEl.className = 'stat ' + mode;
    /* v7.6 红绿灯：绿=正常运行（含完成）/ 黄=暂停·等待 / 红=停止·出错 */
    const lamp = mode === 'stop' ? 'on-r' : (mode === 'hold' ? 'on-y' : 'on-g');
    if (lamps && lamps.className !== 'lights ' + lamp) lamps.className = 'lights ' + lamp;

    shadow.getElementById('fn').textContent = S.finished;

    const pb = shadow.getElementById('pause');
    if (pb) {
      pb.textContent = S.running ? '⏸ 暂停' : '▶ 继续';
      pb.className   = S.running ? '' : 'resume';
    }
    const rb = shadow.getElementById('rate');
    if (rb) rb.textContent = CFG.rate + 'x';

    const de = shadow.getElementById('doc');
    if (de) {
      let ds;
      if (S.docPages) {
        ds = S.docPages + ' 次' + (S.docBtn ? ' «' + S.docBtn + '»' : '');
      } else {
        ds = S.ghostVideo ? ('无（忽略 ' + S.ghostVideo + ' 个假 video）') : '无';
      }
      if (S.pendingNextAfterDrain) ds += ' ｜ 补推 ' + (S.sweepRounds || 0) + '/' + CFG.sweepMax;
      else if (S.sweepGaveUp)      ds += ' ｜ 已达上限 ' + (S.sweepRounds || 0) + '/' + CFG.sweepMax;
      de.textContent = ds;
    }

    /* v7.4：进度条两端分列 —— 左「已播 / 总长」，右「百分比」 */
    const pgt = shadow.getElementById('pg');
    const ppt = shadow.getElementById('pp');
    const bar = shadow.getElementById('bar');
    if (bar) {
      if (hasV) {
        pgt.textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration);
        ppt.textContent = (vp * 100).toFixed(0) + '%';
        bar.style.width = (vp * 100) + '%';
      } else {
        pgt.textContent = '—';
        ppt.textContent = '—';
        bar.style.width = '0%';
      }
    }

    let m = '';
    if (S.rateBlocked) m += '本课程可能锁了倍速，已按原速播\n';
    if (S.blockedFrame) m += S.blockedFrame + ' 个跨域 iframe 读不到（不影响）\n';
    if (!S.running && S.reason) m += '结束原因：' + S.reason;
    shadow.getElementById('msg').textContent = m.trim();
  }

  /* ---------------- 结束 ---------------- */
  function finish(reason) {
    S.running = false;
    S.reason = reason;
    log('⏹ 结束：' + reason);
    if (timer) { clearInterval(timer); timer = null; }
    try { window.top.postMessage({ __cx: 1, type: 'stop' }, '*'); } catch (e) {}
    if (!IS_TOP) return;

    paint();
    let n = 0;
    const iv = setInterval(function () {
      try { document.title = (n++ % 2) ? '✅ 已全部播完' : '🔔 学习通自动连播已结束'; } catch (e) {}
      if (n > 20) clearInterval(iv);
    }, 900);
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('学习通自动连播结束', { body: reason });
      }
    } catch (e) {}
  }

  /* ---------------- 主循环 ---------------- */
  let timer = null;

  let lastDoneCheck = 0;
  let lastStatusCheck = 0;

  function tick() {
    if (!S.running) return;

    // 页面自报「任务点已完成」—— 最高优先级信号
    if (IS_TOP && Date.now() - lastDoneCheck > 3000) {
      lastDoneCheck = Date.now();
      try { if (checkDoneMark()) return; } catch (e) {}
    }

    // v5：定期刷新「目录状态」与定位，供面板显示与前进判定共用
    if (IS_TOP && Date.now() - lastStatusCheck > 5000) {
      lastStatusCheck = Date.now();
      try {
        const ns = nodeStatusNow();
        S.nodeDone = ns.done;
        S.nodeTodoNum = ns.num;
        if (ns.items.length) {
          S.catCount = ns.items.length;
          S.catIndex = ns.cur.i;
          S.catHow = ns.cur.how;
        }
      } catch (e) {}
    }

    const docs = walkDocs();
    let hasVideo = false;

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      patchVis(d);
      if (CFG.closePopup) { try { closePopups(d); } catch (e) {} }
      if (takeVideo(d)) hasVideo = true;
    }

    if (hasVideo) {
      S.noVideoAt = 0;
      S.giveUpRound = 0;

      /* ------------------------------------------------------------
         v7 核心修正。
         v6 这里是「有视频 → resetDoc()，什么都不做」，课件推进分支
         永远进不去，而且每轮 tick（1 秒）都把 docPagedAt 清零。
         所以「上面视频、下面 PPT」的节点，PPT 一次都不会被推。
         实测 2.3 节：视频 7:17:44 播完 → 7:17:48 就跳走了。

         现在拆成两段：
           ① 进新节点时只重置一次（不再每轮清空）
           ② 视频 done 之后，继续把本节点课件推到底，推完才放行跳转
         ------------------------------------------------------------ */
      const nk = nodeKey();
      if (S.sweepKey !== nk) {
        S.sweepKey = nk;
        resetDoc();
        S.sweepRounds = 0;
        S.sweepStill  = 0;
        S.sweepDrained = false;
        S.sweepGaveUp  = false;
        S.pendingNextAfterDrain = false;
        S.sweepLogAt = 0;
      }

      const v = S.video;
      const vDone = !!(v && v.__cx && v.__cx.done);

      if (CFG.docSweep && vDone && !S.sweepDrained) {
        const surf = docSurface();
        if (surf.max > CFG.sweepMin && surf.left > CFG.sweepTail) {
          if (IS_TOP && S.running) {
            // 若 onNodeDone 因故没挂起跳转（例如被 6 秒守卫拦掉），这里补挂
            S.pendingNextAfterDrain = true;

            /* v7.2 核心修正：只统计「真的推动了」的次数。
               v7.1 在这里无条件 sweepRounds++，而 tick 每秒一次、
               advanceDoc() 自己还有 2400ms 节流 —— 于是 40 轮只换来
               16 次有效推进（10544px），35 页的 PPT 推到 40% 就被砍掉。
               现在拿 advanceDoc() 前后的 scrollTop 差值来判定走没走。 */
            /* v7.3 核心修正：判据从「scrollTop 差值」扩到「内容指纹变化」。
               pan-yz 屏阅阅读器是翻页式的，scrollTop 既写不动也不变，
               手势翻页时 movedBy 恒为 0 —— v7.2 因此把它当成「推不动」，
               15 次僵持后就放行跳转，用户看到 3.2 的 PPT 又被跳过。
               docSignature() 覆盖文本长度 / 图片数 / 全部元素 scrollTop /
               首尾图片 src，翻页时至少变一样，是可靠的推进信号。 */
            setAct('sweep', '第 ' + (S.sweepRounds || 0) + ' 次');
            let sigBefore = '';
            try { sigBefore = docSignature(); } catch (e) {}
            try { advanceDoc(); } catch (e) {}
            let sigAfter = sigBefore;
            try { sigAfter = docSignature(); } catch (e) {}

            const after   = docSurface();
            const movedBy = after.top - surf.top;
            const changed = (sigAfter !== sigBefore);

            if (movedBy > 8 || changed) {
              S.sweepRounds = (S.sweepRounds || 0) + 1;
              S.sweepStill  = 0;
            } else if (after.left > CFG.sweepTail) {
              // 真没推动（到底了，或还在节流窗口里）—— 不算推进，累计僵持计数
              S.sweepStill = (S.sweepStill || 0) + 1;
            }

            if (Date.now() - (S.sweepLogAt || 0) > 15000) {
              S.sweepLogAt = Date.now();
              log('📄 补推本节课件（已推进 ' + (S.sweepRounds || 0) + ' 次 ｜ 可滚 ' + after.max +
                  'px ｜ 当前 ' + Math.round(after.top) + 'px ｜ 还剩 ' + Math.round(after.left) + 'px）');
            }

            const maxed = (S.sweepRounds || 0) >= CFG.sweepMax;
            const stuck = (S.sweepStill  || 0) >= CFG.sweepStillMax;
            if (maxed || stuck) {
              S.sweepDrained = true;
              S.sweepGaveUp  = true;
              S.pendingNextAfterDrain = false;
              log('⚠ 课件补推结束（' + (maxed ? '已达 ' + CFG.sweepMax + ' 次上限'
                                              : '连续 ' + S.sweepStill + ' 次推不动') +
                  ' ｜ 共推进 ' + (S.sweepRounds || 0) + ' 次 ｜ 还剩 ' + Math.round(after.left) +
                  'px）—— 前往下一节');
              try { goNext(); } catch (e) {}
            }
          }
        } else {
          S.sweepDrained = true;
          S.sweepRounds = 0;
          S.sweepStill  = 0;
          if (S.pendingNextAfterDrain) {
            S.pendingNextAfterDrain = false;
            log('✅ 视频已播完 + 本节无待推课件 —— 前往下一个未完成任务点');
            if (IS_TOP && S.running) { try { goNext(); } catch (e) {} }
          }
        }
      }
    } else {
      S.video = null;
      if (!S.noVideoAt) S.noVideoAt = Date.now();
      // 非视频节点：全力推进课件（翻页 / 滚动），而不是干等
      if (IS_TOP && S.running) {
        setAct('doc', S.docPages ? ('已翻 ' + S.docPages + ' 次') : '');
        try { advanceDoc(); } catch (e) {}
      }

      /* ------------------------------------------------------------
         v5：前进判据整体重写。
         v4 是「无视频满 45 秒就跳」—— 不看有没有在推进、也不看任务点
         做完没有。实测把整门课一节节全跳过去（用户反馈「全飞了」）。
         v5 改成三道闸门，全过才前进：
           ① 停留够久（第一轮 3 分钟，第二轮再 7 分钟）
           ② 这段时间里**确实没有推进**（指纹 60 秒没变）
           ③ 目录明确显示当前节点「已完成」
         任一条不满足 → 原地继续做，绝不跳。
         ------------------------------------------------------------ */
      if (IS_TOP && S.running) {
        const waited = Date.now() - S.noVideoAt;
        const idle   = S.lastDocActAt ? (Date.now() - S.lastDocActAt) : waited;
        const limit  = (S.giveUpRound >= 1) ? CFG.docGiveUp2 : CFG.docGiveUp;

        if (waited > limit && idle > 60000) {
          let ns = null;
          try { ns = nodeStatusNow(); } catch (e) {}
          if (ns) { S.nodeDone = ns.done; S.nodeTodoNum = ns.num; }

          if (ns && ns.done) {
            log('目录显示本节点「已完成」→ 前往下一个未完成任务点');
            S.giveUpRound = 0;
            S.noVideoAt = Date.now();
            resetDoc();
            onNodeDone('目录已完成');
            return;
          }

          if (S.giveUpRound < 1) {
            S.giveUpRound = 1;
            S.noVideoAt = Date.now();
            log('⚠ 本节 ' + Math.round(waited / 1000) + ' 秒没有推进，但目录仍显示未完成 —— 继续等（再给 ' +
                Math.round(CFG.docGiveUp2 / 1000) + ' 秒）');
          } else {
            S.manualNeeded++;
            log('⚠ 本节长时间推不动（' + Math.round(waited / 1000) + ' 秒 ｜ 目录待完成 ' +
                (ns && ns.num ? ns.num : '?') + ' 个）—— 记为「需人工」并前进');
            S.giveUpRound = 0;
            S.noVideoAt = Date.now();
            resetDoc();
            goNext();
          }
        }
      }
    }

    if (IS_TOP) paint();
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, CFG.tick);
  }

  window.addEventListener('message', function (ev) {
    const d = ev.data;
    if (!d || !d.__cx) return;
    if (!IS_TOP) {
      if (d.type === 'stop' && S.running) { S.running = false; if (timer) { clearInterval(timer); timer = null; } }
      return;
    }
    if (d.type === 'done') onNodeDone('子框架');
  });

  /* ---------------- 鼠标保活 ---------------- */
  setInterval(function () {
    if (!S.running || !CFG.keepAlive) return;
    try {
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true,
        clientX: 120 + Math.random() * 400,
        clientY: 120 + Math.random() * 260
      }));
    } catch (e) {}
  }, 15000);

  /* ---------------- 对外接口 ---------------- */
  window[HOST] = {
    cfg: CFG,
    state: S,
    logs: logs,
    next: goNext,
    stop: finish,
    catalog: function () {
      const items = collectCatalogItems();
      const cur = currentCatalogIndex(items);
      const rows = items.map(function (el, i) {
        const r = (function () { try { return el.getBoundingClientRect(); } catch (e) { return null; } })();
        return i + (i === cur.i ? ' <<<当前' : '') + '  «' + text(el).slice(0, 34) + '»  ' +
               'class="' + cls(el).slice(0, 50) + '"  ' +
               (r ? '(' + Math.round(r.left) + ',' + Math.round(r.top) + ')' : '');
      });
      const out = '目录项 ' + items.length + ' 个，定位: ' + (cur.i >= 0 ? ('#' + cur.i + ' via ' + cur.how) : '失败') + '\n' + rows.join('\n');
      console.log(out);
      return out;
    },
    diag: function () {
      const s = diagReport();
      console.log(s);
      return s;
    },
    copyDiag: function () {
      const s = diagReport();
      try { if (navigator.clipboard) navigator.clipboard.writeText(s); } catch (e) {}
      console.log(s);
      return s;
    },
    destroy: function () {
      S.running = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (hostEl) { try { hostEl.remove(); } catch (e) {} hostEl = null; shadow = null; }
      try { delete window[HOST]; } catch (e) { window[HOST] = null; }
      try { sessionStorage.removeItem(SS_FIN); sessionStorage.removeItem(SS_TRIED); } catch (e) {}
      console.log('%c[学习通自动] 已卸载', 'color:#ef4444;font-weight:700');
    }
  };

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (IS_TOP) {
      buildPanel();
      start();
      log('v7.4 已启动 ▸ 倍速 ' + CFG.rate + 'x ｜ 静音 ' + CFG.mute +
          ' ｜ 课件秒过（一次约 ' + CFG.docBoost + ' 屏 ｜ 间隔 ' + (CFG.docStepFast / 1000) + 's）' +
          ' ｜ 目录状态驱动（宁停不跳）｜ 视频后补推课件 ' +
          (CFG.docSweep ? ('开（上限 ' + CFG.sweepMax + ' 次）') : '关'));
      setTimeout(function () {
        if (!S.running) return;
        const items = collectCatalogItems();
        const cur = currentCatalogIndex(items);
        S.catCount = items.length;
        S.catIndex = cur.i;
        S.catHow = cur.how;
        log('目录扫描：' + items.length + ' 项，当前位置 ' + (cur.i >= 0 ? ('#' + cur.i + ' (' + cur.how + ')') : '未定位'));
        try {
          const st = catalogStatus(items);
          const done = st.filter(function (x) { return x.done; }).length;
          const todo = st.filter(function (x) { return x.todo; }).length;
          log('任务点状态：已完成 ' + done + ' 项 ｜ 待完成 ' + todo + ' 项');
          if (cur.i >= 0 && st[cur.i]) { S.nodeDone = st[cur.i].done; S.nodeTodoNum = st[cur.i].num; }
        } catch (e) {}
        paint();
        // 启动时如果视频已播完（比如刷新后停在版权页），直接推一把
        const v = S.video;
        if (v && v.duration > 0 && isFinite(v.duration) && (v.duration - v.currentTime) <= 1) {
          log('检测到本节点已播完，直接前往下一节');
          setTimeout(goNext, 1500);
        }
      }, 2500);
      // v5：只有「目录明确说本节点已完成」才推一把。
      //     v4 这里是「9 秒没视频就前进」—— 这是「全飞了」的另一个注入点：
      //     页面还在加载、视频还没就绪，脚本已经把它跳掉了。
      setTimeout(function () {
        if (!S.running) return;
        if (S.video) return;
        try {
          const ns = nodeStatusNow();
          if (ns.cur.i >= 0 && ns.done) {
            log('目录显示本节点已完成 → 前进');
            goNext();
          }
        } catch (e) {}
      }, 9000);
    } else {
      start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
