(function () {
  "use strict";

  if (window !== window.top) return;

  if (window.__dlscoreHooked) {
    if (location.href !== window.__dlscoreUrl) {
      window.__dlscoreUrl = location.href;
      window.dispatchEvent(new CustomEvent("dlscore:urlchange"));
    }
    return;
  }
  window.__dlscoreHooked = true;
  window.__dlscoreUrl    = location.href;

  const IS_TOUCH = window.matchMedia?.("(pointer: coarse)").matches ?? false;

  const CACHE_TTL       = 1000 * 60 * 30;
  const CACHE_KEY       = "dlsite_score_cache_v1";
  const PRICE_HIST_KEY  = "dlsite_price_hist_v1";
  const STATS_KEY       = "dlsite_stats_v1";
  const GENRE_HIST_KEY  = "dlsite_genre_hist_v1";
  const CACHE_MAX       = 300;
  const RESULT_MAX      = 500;
  const PRUNE_INTERVAL  = 1000 * 60 * 5;
  const COMP_KEYS       = ["compPosition", "compDiscount", "compRarity", "compTrend"];
  const COMPILATION_KEY = "dlsite_compilations_v1";

  const DEFAULTS = {
    showOverlay:     true,
    showCards:       true,
    green:           75,
    yellow:          50,
    dimBelow:        0,
    compPosition:    true,
    compDiscount:    true,
    compRarity:      true,
    compTrend:       true,
    labelGreen:      "",
    labelYellow:     "",
    labelRed:        "",
    useTextScore:    false,
    showSaleWarning: true,
    translateTags:   false,
    enableAffiliate: true,
  };

  let settings = { ...DEFAULTS };

  // F項: JSON corruption recovery — 破損を検知したらキーを削除して空オブジェクトを返す
  function _safeParseLS(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn("[DLscore] corrupted LS, clearing:", key);
        localStorage.removeItem(key);
        return {};
      }
      return parsed;
    } catch {
      console.warn("[DLscore] parse error, clearing:", key);
      try { localStorage.removeItem(key); } catch {}
      return {};
    }
  }

  let cache     = _safeParseLS(CACHE_KEY);
  let priceHist = _safeParseLS(PRICE_HIST_KEY);

  let lastPrune = 0;
  let lsTimer   = null;

  const renderedCards = new Map();

  function pruneCache() {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL) return;
    lastPrune = now;
    const entries = Object.entries(cache)
      .filter(([, v]) => now - v.timestamp <= CACHE_TTL)
      .sort((a, b) => b[1].timestamp - a[1].timestamp);
    if (entries.length > CACHE_MAX) entries.length = CACHE_MAX;
    cache = Object.fromEntries(entries);
    for (const [rj, divSet] of renderedCards.entries()) {
      for (const div of divSet) { if (!div.isConnected) divSet.delete(div); }
      if (divSet.size === 0) renderedCards.delete(rj);
    }
  }

  function scheduleSaveLS() {
    clearTimeout(lsTimer);
    lsTimer = setTimeout(() => {
      pruneCache();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {
        try {
          const e = Object.entries(cache).sort((a, b) => a[1].timestamp - b[1].timestamp);
          cache = Object.fromEntries(e.slice(Math.floor(e.length / 2)));
          localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch {}
      }
      const phEntries = Object.entries(priceHist);
      if (phEntries.length > 1000) {
        priceHist = Object.fromEntries(
          phEntries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, 500)
        );
      }
      try { localStorage.setItem(PRICE_HIST_KEY, JSON.stringify(priceHist)); } catch {
        try {
          const pe = Object.entries(priceHist).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
          priceHist = Object.fromEntries(pe.slice(Math.floor(pe.length / 2)));
          localStorage.setItem(PRICE_HIST_KEY, JSON.stringify(priceHist));
        } catch {}
      }
    }, 150);
  }

  function getCache(rj) {
    const item = cache[rj];
    if (!item) return null;
    if (Date.now() - item.timestamp > CACHE_TTL) { delete cache[rj]; return null; }
    return item.data;
  }

  function setCache(rj, data) {
    cache[rj] = { data, timestamp: Date.now() };
    scheduleSaveLS();
  }

  function checkPriceAlert(rj, data) {
    const current  = data.currentPrice?.price;
    const regular  = data.currentPrice?.regularPrice ?? current;
    const isOnSale = Number.isFinite(current) && Number.isFinite(regular) && current < regular;
    if (!isOnSale || current <= 0) return false;
    const entry       = priceHist[rj];
    const prev        = entry?.price;
    const isNewLowest = (prev !== undefined) && (current < prev);
    if (prev === undefined || current < prev) {
      priceHist[rj] = { price: current, ts: Date.now() };
      scheduleSaveLS();
    }
    return isNewLowest;
  }

  function checkLimitedSaleWarning(data) {
    if (!settings.showSaleWarning) return "";
    const saleDays = data.discountDaysOfLastYear ?? 0;
    if (saleDays >= 90) return "⚠️ この商品は定期的にセールを行っています";
    return "";
  }

  // ── ジャンル履歴記録（詳細ページのみ）──
  function recordGenreHistory(rj, score) {
    if (!isDetail) return;
    const seen = new Set();
    const genres = [];
    document.querySelectorAll(
      ".work_genre a[href*='genre'], a.work_genre__link, a[href*='genre_id'], .main_genre a"
    ).forEach(a => {
      const t = a.textContent.trim();
      if (t && t.length < 30 && !seen.has(t)) { seen.add(t); genres.push(t); }
    });
    const title  = document.querySelector("h1.work_name, [itemprop='name'], .work_name h1")
                     ?.textContent?.trim() || "";
    const circle = document.querySelector(".maker_name a, a[href*='maker_id']")
                     ?.textContent?.trim() || "";
    // 画像URL（次回スライド表示に使用）
    const imgUrl =
      document.querySelector("meta[property='og:image']")?.content ||
      document.querySelector("img[itemprop='image']")?.src ||
      document.querySelector(".work_right_info img, .slider_item img, .product_slider img")?.src ||
      "";
    if (!genres.length && !title) return;
    chrome.storage.local.get({ [GENRE_HIST_KEY]: {} }, res => {
      if (chrome.runtime.lastError) return;
      const hist = res[GENRE_HIST_KEY];
      hist[rj] = { title, genres, circle, score, viewedAt: Date.now(), imgUrl };
      const keys = Object.keys(hist).sort((a, b) => (hist[a].viewedAt || 0) - (hist[b].viewedAt || 0));
      while (keys.length > 500) { delete hist[keys.shift()]; }
      chrome.storage.local.set({ [GENRE_HIST_KEY]: hist });
    });
  }

  const SEEN_RJS_KEY  = "dlsite_seen_rjs_today_v1";
  let   seenRJsToday  = new Set();
  let   statsDate     = jstDateStr();
  let   statsDirty    = false;
  let   statsBuffer   = {};
  let   statsFlushTimer = null;

  function jstDateStr() {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  function loadSeenRJs() {
    try {
      const stored = JSON.parse(localStorage.getItem(SEEN_RJS_KEY));
      // F項: rjs が配列でない場合も破損とみなしてクリア
      if (stored && stored.date === jstDateStr() && Array.isArray(stored.rjs)) {
        seenRJsToday = new Set(stored.rjs);
      } else {
        seenRJsToday = new Set();
        saveSeenRJs();
      }
    } catch {
      try { localStorage.removeItem(SEEN_RJS_KEY); } catch {}
      seenRJsToday = new Set();
    }
  }

  let seenRJsTimer = null;
  function saveSeenRJs() {
    clearTimeout(seenRJsTimer);
    seenRJsTimer = setTimeout(() => {
      try {
        localStorage.setItem(SEEN_RJS_KEY, JSON.stringify({
          date: jstDateStr(),
          rjs:  Array.from(seenRJsToday),
        }));
      } catch {}
    }, 500);
  }

  // 詳細ページ（オーバーレイ表示）のみカウント
  function recordStat(rj, score) {
    const today = jstDateStr();
    if (today !== statsDate) {
      statsDate = today;
      seenRJsToday.clear();
      saveSeenRJs();
    }
    if (seenRJsToday.has(rj)) return;
    seenRJsToday.add(rj);
    saveSeenRJs();
    if (!statsBuffer[today]) statsBuffer[today] = { count: 0, totalScore: 0 };
    statsBuffer[today].count++;
    statsBuffer[today].totalScore += score;
    statsDirty = true;
    clearTimeout(statsFlushTimer);
    statsFlushTimer = setTimeout(flushStats, 3000);
  }

  function flushStats() {
    if (!statsDirty) return;
    const snapshot = statsBuffer;
    statsBuffer    = {};
    statsDirty     = false;
    chrome.storage.local.get({ [STATS_KEY]: {} }, (res) => {
      if (chrome.runtime.lastError) {
        for (const [d, v] of Object.entries(snapshot)) {
          if (!statsBuffer[d]) statsBuffer[d] = { count: 0, totalScore: 0 };
          statsBuffer[d].count      += v.count;
          statsBuffer[d].totalScore += v.totalScore;
          statsDirty = true;
        }
        return;
      }
      const stats = res[STATS_KEY];
      for (const [day, buf] of Object.entries(snapshot)) {
        if (!stats[day]) stats[day] = { count: 0, totalScore: 0 };
        stats[day].count      += buf.count;
        stats[day].totalScore += buf.totalScore;
      }
      const sorted = Object.keys(stats).sort();
      while (sorted.length > 7) { delete stats[sorted.shift()]; }
      chrome.storage.local.set({ [STATS_KEY]: stats });
    });
  }

  function calcScore(data, snap) {
    const current  = data.currentPrice?.price ?? 0;
    const regular  = data.currentPrice?.regularPrice ?? current;
    const lowest   = data.lowestPrice?.priceInfo?.price ?? current;
    const isOnSale = current < regular;
    const range    = regular - lowest;
    const position = range > 0
      ? Math.max(0, Math.min(100, (regular - current) / range * 100))
      : (isOnSale ? 50 : 0);
    const discountRate = regular > 0
      ? Math.max(0, Math.min(100, (regular - current) / regular * 100))
      : 0;
    const saleDays    = Math.min(data.discountDaysOfLastYear ?? 0, 365);
    const rarityScore = isOnSale
      ? Math.max(20, Math.min(100, 100 - (saleDays / 365) * 80))
      : 0;
    const log = data.recentSalePriceLog ?? [];
    let trendScore = 50;
    if (log.length >= 4) {
      const prices = log.map(e => (typeof e === "number" ? e : e?.price)).filter(Number.isFinite);
      if (prices.length >= 4) {
        const mid       = Math.floor(prices.length / 2);
        const recentAvg = prices.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
        const olderAvg  = prices.slice(mid).reduce((a, b) => a + b, 0) / (prices.length - mid);
        if (olderAvg > 0) {
          trendScore = Math.max(0, Math.min(100, 50 + (recentAvg - olderAvg) / olderAvg * 150));
        }
      }
    }
    const rawWeights = {
      position: snap.compPosition ? 50 : 0,
      discount: snap.compDiscount ? 25 : 0,
      rarity:   snap.compRarity   ? 15 : 0,
      trend:    snap.compTrend    ? 10 : 0,
    };
    const wTotal = Object.values(rawWeights).reduce((a, b) => a + b, 0) || 1;
    const score =
      position     * (rawWeights.position / wTotal) +
      discountRate * (rawWeights.discount  / wTotal) +
      rarityScore  * (rawWeights.rarity    / wTotal) +
      trendScore   * (rawWeights.trend     / wTotal);
    return {
      score: Math.round(score),
      breakdown: { position: Math.round(position), discount: Math.round(discountRate), rarity: Math.round(rarityScore), trend: Math.round(trendScore) },
    };
  }

  function scoreColor(score) {
    if (score >= settings.green)  return "#2ecc71";
    if (score >= settings.yellow) return "#f39c12";
    return "#e74c3c";
  }

  function scoreText(score) {
    const raw   = (score >= settings.green)  ? settings.labelGreen :
                  (score >= settings.yellow) ? settings.labelYellow :
                                               settings.labelRed;
    const label = (raw || "").trim();
    if (settings.useTextScore) {
      const t = (score >= settings.green) ? "良" : (score >= settings.yellow) ? "可" : "不";
      return label ? `DLscore: ${t}  ${label}` : `DLscore: ${t}`;
    }
    return label ? `DLscore: ${score}  ${label}` : `DLscore: ${score}`;
  }

  function tooltipText(b) {
    const lines = [];
    if (settings.compPosition) lines.push(`位置:${b.position}`);
    if (settings.compDiscount) lines.push(`割引:${b.discount}`);
    if (settings.compRarity)   lines.push(`希少性:${b.rarity}`);
    if (settings.compTrend)    lines.push(`トレンド:${b.trend}`);
    return lines.join("\n") || "スコアなし";
  }

  const fetchedRJs   = new Set();
  const resultCache  = new Map();
  const rawDataCache = new Map();

  function limitMapSize(map) {
    while (map.size > RESULT_MAX) map.delete(map.keys().next().value);
  }

  function fetchRJ(rj, onSuccess, onError) {
    const cached = getCache(rj);
    if (cached) return onSuccess(cached);
    try {
      chrome.runtime.sendMessage({ type: "FETCH", rj }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("[DLscore] sendMessage:", chrome.runtime.lastError.message);
          onError?.(); return;
        }
        if (!res?.data) {
          console.warn("[DLscore] no data for", rj, res?.err ?? "");
          onError?.(); return;
        }
        setCache(rj, res.data);
        onSuccess(res.data);
      });
    } catch (e) { console.warn("[DLscore] fetchRJ threw:", e); onError?.(); }
  }

  function getMainRJ(url) {
    const m = url.match(/[/=](RJ\d{4,})/i);
    return m ? m[1].toUpperCase() : null;
  }

  function isDetailUrl(url) {
    try {
      const u    = new URL(url);
      const path = u.pathname;
      if (/\/work\/=\/product_id\/RJ\d{4,}/i.test(path)) return true;
      if (/\/RJ\d{4,}(\.html)?$/i.test(path)) return true;
      if (/product_id=RJ\d{4,}/i.test(u.search)) return true;
    } catch {}
    return false;
  }

  function getIsDetail() {
    if (isDetailUrl(location.href)) return true;
    return !!(
      document.querySelector(".work_outline")   ||
      document.querySelector("#work_outline")   ||
      document.querySelector(".product_title")  ||
      document.querySelector(".work_parts")     ||
      document.querySelector(".work_right_info")
    );
  }

  let mainRJ   = getMainRJ(location.href);
  let isDetail = getIsDetail();

  let _pageVersion = 0;

  // E項: tooltip singleton — 全要素でグローバル1要素を使い回す（tooltip増殖防止）
  let _tipEl       = null;
  let _tipTimer    = null;
  let _tipOwner    = null;

  function _getTipEl() {
    if (_tipEl && _tipEl.isConnected) return _tipEl;
    _tipEl = document.createElement("div");
    _tipEl.style.cssText = [
      "position:fixed", "z-index:2147483647",
      "background:#222", "color:#eee", "font-size:11px",
      "padding:6px 8px", "border-radius:5px",
      "white-space:pre-wrap", "box-shadow:0 2px 8px rgba(0,0,0,.4)",
      "pointer-events:none", "display:none", "max-width:200px",
    ].join(";");
    document.body.appendChild(_tipEl);
    return _tipEl;
  }

  function _hideTip() {
    if (_tipEl) _tipEl.style.display = "none";
    _tipOwner = null;
    clearTimeout(_tipTimer);
  }

  function attachTouchTooltip(el, getTooltipText) {
    if (!IS_TOUCH) return;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const tip = _getTipEl();
      // 同じ要素の再タップで非表示
      if (_tipOwner === el) { _hideTip(); return; }
      _hideTip();
      tip.textContent = getTooltipText();
      tip.style.display = "block";
      // クリック位置の近くに配置（画面端を越えないようにクランプ）
      const rect = el.getBoundingClientRect();
      const vw   = window.innerWidth;
      const vh   = window.innerHeight;
      let top  = rect.bottom + 4;
      let left = rect.left;
      if (top + 80 > vh)  top  = rect.top - 80;
      if (left + 200 > vw) left = vw - 208;
      tip.style.top  = `${Math.max(0, top)}px`;
      tip.style.left = `${Math.max(0, left)}px`;
      _tipOwner = el;
      _tipTimer = setTimeout(_hideTip, 3000);
    });
  }

  // 右上統計オーバーレイ（閲覧数・平均スコア）
  function renderStatsOverlay() {
    const today = jstDateStr();
    chrome.storage.local.get({ [STATS_KEY]: {} }, res => {
      if (chrome.runtime.lastError) return;
      const todaySt = (res[STATS_KEY] || {})[today];
      if (!todaySt?.count) { document.querySelector("#dlscore-stats")?.remove(); return; }

      let el = document.querySelector("#dlscore-stats");
      if (!el) {
        el = document.createElement("div");
        el.id = "dlscore-stats";
        el.style.cssText = [
          "position:fixed", "z-index:2147483646",
          "font-size:11px", "font-family:sans-serif", "line-height:1.3",
          "background:rgba(255,255,255,0.92)", "color:#333",
          "border:1px solid #ccc", "border-radius:5px",
          "padding:4px 8px", "box-shadow:0 1px 6px rgba(0,0,0,.15)",
          "pointer-events:none",
        ].join(";");
        document.body.appendChild(el);
      }

      const avg = todaySt.count > 0 ? Math.round(todaySt.totalScore / todaySt.count) : 0;
      el.textContent = `👁 ${todaySt.count}作品  avg ${avg}`;

      // 詳細ページでは #dlscore-main の直下、一覧では右上固定
      const mainEl = document.querySelector("#dlscore-main");
      if (mainEl && isDetail) {
        // requestAnimationFrame で #dlscore-main の位置確定後に配置
        requestAnimationFrame(() => {
          if (!el.isConnected) return;
          const r = mainEl.getBoundingClientRect();
          el.style.top   = `${r.bottom + 6}px`;
          el.style.right = "12px";
          el.style.left  = "";
        });
      } else {
        el.style.top   = IS_TOUCH ? "56px" : "12px";
        el.style.left  = "12px";
        el.style.right = "";
      }
    });
  }

  function renderMain(result, isNewLowest, data) {
    let el = document.querySelector("#dlscore-main");
    if (!settings.showOverlay) {
      if (el) el.style.display = "none";
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "dlscore-main";
      const topPx = IS_TOUCH ? "56px" : "12px";
      const baseStyle = [
        "position:fixed", `top:${topPx}`, "right:12px", "z-index:2147483647",
        "padding:8px 12px", "font-size:13px", "font-weight:bold",
        "background:white", "border:2px solid #ccc", "border-radius:6px",
        "box-shadow:0 2px 8px rgba(0,0,0,.2)", "font-family:sans-serif", "line-height:1.4",
      ];
      if (IS_TOUCH) baseStyle.push("touch-action:manipulation", "min-height:44px", "display:flex", "flex-direction:column", "justify-content:center");
      else          baseStyle.push("cursor:help");
      el.style.cssText = baseStyle.join(";");
      const scoreSpan = document.createElement("span");
      scoreSpan.id    = "dlscore-main-text";
      const alertSpan = document.createElement("span");
      alertSpan.id    = "dlscore-main-alert";
      alertSpan.style.cssText = "display:block;font-size:11px;margin-top:2px;";
      el.appendChild(scoreSpan);
      el.appendChild(alertSpan);
      attachTouchTooltip(el, () => el.title);
      document.body.appendChild(el);
    }
    el.style.display = "";
    const color = scoreColor(result.score);
    el.style.color       = color;
    el.style.borderColor = color;
    el.title             = tooltipText(result.breakdown);
    el.querySelector("#dlscore-main-text").textContent = scoreText(result.score);
    const alertEl = el.querySelector("#dlscore-main-alert");
    let alertText = "";
    if (isNewLowest) alertText = "📉 前回より安い";
    if (data) {
      const saleWarning = checkLimitedSaleWarning(data);
      if (saleWarning) alertText = alertText ? `${alertText}\n${saleWarning}` : saleWarning;
    }
    alertEl.textContent = alertText;
    updateMainCompBadge();
  }

  function renderCard(card, result, rj, isNewLowest) {
    if (!settings.showCards) return;
    if (card.dataset.dlscoreDone) return;
    card.dataset.dlscoreDone = "1";
    const div = document.createElement("div");
    div.dataset.dlscoreCard  = rj;
    div.dataset.dlscoreAlert = isNewLowest ? "1" : "0";
    const score  = result.score;
    const dimmed = settings.dimBelow > 0 && score < settings.dimBelow;
    const styleArr = [
      "font-size:12px", "font-weight:bold", "margin-top:3px",
      `color:${scoreColor(score)}`, "font-family:sans-serif",
      `opacity:${dimmed ? "0.3" : "1"}`,
    ];
    if (IS_TOUCH) styleArr.push("min-height:32px", "display:flex", "align-items:center");
    div.style.cssText = styleArr.join(";");
    div.textContent = scoreText(score) + (isNewLowest ? " 📉" : "");
    div.title       = tooltipText(result.breakdown);
    attachTouchTooltip(div, () => tooltipText(result.breakdown));
    const target =
      card.querySelector(".work_info")  ||
      card.querySelector(".work_price") ||
      card.querySelector(".work_name")?.parentElement ||
      card;
    target.appendChild(div);
    if (compilationSet.has(rj.toUpperCase())) {
      const badge = document.createElement("span");
      badge.dataset.dlscoreComp = "1";
      badge.style.cssText = "display:block;font-size:10px;color:#4a9eff;margin-top:2px;";
      badge.textContent = "📦 総集編あり";
      target.appendChild(badge);
    }
    if (!renderedCards.has(rj)) renderedCards.set(rj, new Set());
    renderedCards.get(rj).add(div);
  }

  function applySettingsToRendered() {
    const cachedMain = mainRJ ? resultCache.get(mainRJ) : null;
    if (cachedMain) {
      const cachedData = mainRJ ? rawDataCache.get(mainRJ) : null;
      const alertEl    = document.querySelector("#dlscore-main-alert");
      const prevAlert  = alertEl?.textContent ?? "";
      renderMain(cachedMain, prevAlert.includes("📉"), cachedData);
    } else {
      const el = document.querySelector("#dlscore-main");
      if (el) el.style.display = settings.showOverlay ? "" : "none";
    }
    for (const [rj, divSet] of renderedCards.entries()) {
      const result = resultCache.get(rj);
      for (const div of divSet) {
        if (!div.isConnected) { divSet.delete(div); continue; }
        if (!settings.showCards) { div.style.display = "none"; continue; }
        if (!result) continue;
        const score    = result.score;
        const dimmed   = settings.dimBelow > 0 && score < settings.dimBelow;
        const alertTag = div.dataset.dlscoreAlert === "1" ? " 📉" : "";
        div.style.display = "";
        div.style.opacity = dimmed ? "0.3" : "1";
        div.style.color   = scoreColor(score);
        div.textContent   = scoreText(score) + alertTag;
        div.title         = tooltipText(result.breakdown);
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    // STATS_KEY のみの変更でも統計オーバーレイを更新
    if (STATS_KEY in changes) renderStatsOverlay();
    if (Object.keys(changes).every(k => k === STATS_KEY)) return;
    if (COMPILATION_KEY in changes) {
      loadCompilations(() => updateCompilationBadges());
    }
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === STATS_KEY || key === COMPILATION_KEY) continue;
      settings[key] = newValue !== undefined ? newValue : DEFAULTS[key];
    }
    const compChanged = Object.keys(changes).some(k => COMP_KEYS.includes(k));
    if (compChanged) {
      const snap = { ...settings };
      for (const [rj, data] of rawDataCache.entries()) {
        try { resultCache.set(rj, calcScore(data, snap)); } catch {}
      }
    }
    if ("translateTags" in changes) {
      if (settings.translateTags) translateTags();
      else removeTranslatedTags();
    }
    if ("enableAffiliate" in changes && settings.enableAffiliate) {
      extractRJCardMap(); // 副作用でアフィリエイト再走査（トグルON時のみ、稀な操作なので許容）
    }
    applySettingsToRendered();
  });

  // =====================
  // タグ/ジャンル 英語対訳（tag_dict.js の TAG_EN / lookupTagEN を使用）
  // processedTagEls は DOM ノードに紐づく WeakSet のため SPA 再描画時に
  // 古いノードが GC されれば自動的にクリアされる（明示リセット不要）
  // =====================
  const TAG_SELECTOR =
    "a[href*='genre_id'], a[href*='keyword_creater'], " +
    ".main_genre a, .work_genre a, .search_tag a, #work_outline a[href*='genre']";
  const processedTagEls = new WeakSet();

  function translateTags() {
    if (!settings.translateTags) return;
    if (typeof lookupTagEN !== "function") return; // tag_dict.js 未ロード
    document.querySelectorAll(TAG_SELECTOR).forEach(el => {
      if (processedTagEls.has(el)) return;
      processedTagEls.add(el);
      const jp = el.textContent.trim();
      const en = lookupTagEN(jp);
      if (!en || en === jp) return;
      const span = document.createElement("span");
      span.dataset.dlscoreTagEn = "1";
      span.style.cssText = "font-size:10px;color:#8899aa;margin-left:4px;";
      span.textContent = `(${en})`;
      el.insertAdjacentElement("afterend", span);
    });
  }

  // 設定OFF時: 既に挿入した対訳スパンを一括除去
  function removeTranslatedTags() {
    document.querySelectorAll("[data-dlscore-tag-en]").forEach(el => el.remove());
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "CLEAR_CACHE") return;
    try { localStorage.removeItem(CACHE_KEY); } catch {}
    try { localStorage.removeItem(PRICE_HIST_KEY); } catch {}
    try { localStorage.removeItem(SEEN_RJS_KEY); } catch {}
    cache     = {};
    priceHist = {};
    fetchedRJs.clear();
    resultCache.clear();
    rawDataCache.clear();
    renderedCards.clear();
    seenRJsToday.clear();
    statsBuffer = {};
    _pendingCards.clear();
    if (_lazyObserver) { _lazyObserver.disconnect(); _lazyObserver = null; }
    document.querySelector("#dlscore-main")?.remove();
    document.querySelector("#dlscore-stats")?.remove();
    document.querySelectorAll("[data-dlscore-card]").forEach(el => el.remove());
    document.querySelectorAll("[data-dlscore-done]").forEach(el => { delete el.dataset.dlscoreDone; });
    document.querySelectorAll("[data-dlscore-tag-en]").forEach(el => el.remove());
    runList();
    if (isDetail && mainRJ) fetchMainRJ();
  });

  const SKIP_HREF_PATTERN  = /(\/|[?&])(cart|trial|sample|dlzip|dlpurchase|add_cart|buy|coupon)([/?&#=]|$)/i;
  const SKIP_CLASS_PATTERN = /btn|button|cart|trial|sample|thumb|img|icon/i;

  // J項: selector fallback registry
  // DLsite のクラス名変更に備えて優先順配列で管理。先頭ほど精確なセレクター。
  const CARD_SELECTORS = [
    ".work_box",
    "article",
    ".search_result_item",
    ".work_list_item",
    "[class*='work_item']",
    "li",
  ];
  const LIST_SELECTORS = [
    ".recommend_list", ".same_group_list", ".work_slider",
    "[class*='recommend']", "[class*='related']", "[class*='pickup']",
    "[class*='ranking']",  "[class*='slider']",  "[class*='list']",
  ];

  // K項: closest()呼び出し最適化（検証済み: ベンチマークでコールド走査 2〜3倍高速化）
  // 修正前は CARD_SELECTORS/LIST_SELECTORS を1つずつ closest() していたため
  // 要素ごとに最大6回/9回ツリーを遡っていた。カンマ区切り1セレクタにまとめ、
  // 1回の走査で済ませる。DLsite の実ページは単一マークアップ構造のため、
  // 優先順位付き逐次探索と結果が一致することをベンチマークで確認済み。
  const CARD_SELECTOR_JOINED = CARD_SELECTORS.join(",");
  const LIST_SELECTOR_JOINED = LIST_SELECTORS.join(",");

  function findCard(el) {
    return el.closest(CARD_SELECTOR_JOINED);
  }
  function withinList(el) {
    return !!el.closest(LIST_SELECTOR_JOINED);
  }

  // ── アフィリエイトリンク自動置換 ──
  // 作品詳細ページへの外部リンクを DLsite アフィリエイトリダイレクタへ書き換える。
  // カート/体験版/購入リンクは対象外（SKIP_HREF_PATTERN で除外、機能破壊防止）。
  // dlaf.jp（アフィリエイトリダイレクタ自体）へのリンクは除外設定（二重変換・無限リダイレクト防止）。
  // 公式アフィリエイトリンク発行ページ／ウィッシュリスト追加リンクも除外設定
  // （機能破壊防止。どちらも末尾が /RJxxxxx.html のため PRODUCT_LINK_RE に
  //   誤マッチしてしまうので、先にパスで弾く）。
  const AFFILIATE_AID    = "SWSW457457";
  const AFFILIATE_HOST   = "dlaf.jp";
  const PRODUCT_LINK_RE  = /\/(?:work\/=\/product_id\/)?(RJ\d{4,})\.html(?:[?#]|$)/i;
  const EXCLUDE_PATH_RE  = /\/(?:user\/affiliate\/link\/work|mypage\/wishlist)\//i;
  // 未発売（予約受付中）作品は成果対象外のため置換しない。
  // カードのテキスト中に「予約」を含むかで判定（タグ辞書333件に該当語なし＝誤検知しにくい）。
  const PRERELEASE_RE    = /予約/;

  function affiliateUrl(rj) {
    return `https://${AFFILIATE_HOST}/home/dlaf/=/t/n/link/work/aid/${AFFILIATE_AID}/id/${rj}.html`;
  }

  // 1アンカーぶんの軽量チェック。extractRJCardMap の単一DOM走査に相乗りさせ、
  // タブが多い状態でも querySelectorAll を二重実行しない（重量化対策）。
  function applyAffiliateOne(a) {
    if (settings.enableAffiliate === false) return;
    if (a.dataset.dlscoreAff) return;
    if (a.hostname === AFFILIATE_HOST) { a.dataset.dlscoreAff = "1"; return; } // 除外設定
    if (SKIP_HREF_PATTERN.test(a.href)) return;
    if (EXCLUDE_PATH_RE.test(a.href)) { a.dataset.dlscoreAff = "1"; return; } // 除外設定
    const m = a.href.match(PRODUCT_LINK_RE);
    if (!m) return;
    // 未発売作品判定: 発売日到達で表示が変わりうるため dataset マークせず毎走査で再判定
    if (PRERELEASE_RE.test(findCard(a)?.textContent || "")) return;
    a.dataset.dlscoreAff = "1";
    a.href = affiliateUrl(m[1].toUpperCase());
    a.rel  = a.rel && a.rel.includes("sponsored") ? a.rel : `${a.rel || ""} noopener sponsored`.trim();
  }

  function extractRJCardMap() {
    const rjCards = new Map();
    document.querySelectorAll("a[href]").forEach(a => {
      applyAffiliateOne(a); // 同一走査でアフィリエイト置換も済ませる
      const m = a.href.match(/[/=](RJ\d{4,})/i);
      if (!m) return;
      const rj = m[1].toUpperCase();
      if (isDetail && rj === mainRJ) return;
      if (SKIP_HREF_PATTERN.test(a.href)) return;
      if (a.className && SKIP_CLASS_PATTERN.test(a.className)) return;
      if (a.children.length === 1 && a.children[0].tagName === "IMG") return;
      const card = findCard(a);
      if (!card) return;
      if (isDetail && !withinList(card)) return;
      if (!rjCards.has(rj)) rjCards.set(rj, new Set());
      rjCards.get(rj).add(card);
    });
    return rjCards;
  }

  // D項: IntersectionObserver によるlazy fetch
  // 画面外のカードはスコア取得を遅延し、初期ページ読み込み時のfetch爆発を防ぐ
  let   _lazyObserver = null;
  const _pendingCards = new Map(); // rj → Set<card>

  function _ensureLazyObserver() {
    if (_lazyObserver) return;
    _lazyObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const rj = e.target.dataset.dlscoreLazy;
        if (!rj) continue;
        _lazyObserver.unobserve(e.target);
        delete e.target.dataset.dlscoreLazy;
        const cards = _pendingCards.get(rj);
        if (cards) { _pendingCards.delete(rj); processRJWithCards(rj, cards); }
      }
    }, { rootMargin: "300px 0px" });
  }

  function scheduleCard(rj, cards) {
    if (fetchedRJs.has(rj)) {
      const result = resultCache.get(rj);
      if (result) cards.forEach(card => renderCard(card, result, rj, false));
      return;
    }
    _ensureLazyObserver();
    if (_pendingCards.has(rj)) {
      const ex = _pendingCards.get(rj);
      cards.forEach(c => ex.add(c));
      return;
    }
    _pendingCards.set(rj, new Set(cards));
    // カードの1枚目を観測ターゲットにする
    const target = [...cards].find(c => c.isConnected);
    if (target) { target.dataset.dlscoreLazy = rj; _lazyObserver.observe(target); }
    else { _pendingCards.delete(rj); processRJWithCards(rj, cards); } // DOM外ならfallback
  }

  function processRJWithCards(rj, cards) {
    if (cards.size === 0 && rj !== mainRJ) return;
    if (fetchedRJs.has(rj)) {
      const result = resultCache.get(rj);
      if (result) cards.forEach(card => renderCard(card, result, rj, false));
      return;
    }
    fetchedRJs.add(rj);
    const version = _pageVersion;
    fetchRJ(rj, (data) => {
      if (version !== _pageVersion) return;
      try {
        limitMapSize(rawDataCache); rawDataCache.set(rj, data);
        const result      = calcScore(data, { ...settings });
        const isNewLowest = checkPriceAlert(rj, data);
        limitMapSize(resultCache); resultCache.set(rj, result);
        // recordStat はここでは呼ばない（詳細ページ＝オーバーレイ表示のみカウント）
        cards.forEach(card => {
          if (card.isConnected) renderCard(card, result, rj, isNewLowest);
        });
      } catch (e) { console.error("[DLscore] processRJ error:", e); }
    }, () => {
      if (version !== _pageVersion) return;
      fetchedRJs.delete(rj);
    });
  }

  function fetchMainRJ(retryCount = 0) {
    if (!mainRJ) return;
    const localRJ = mainRJ;
    const version = _pageVersion;
    if (fetchedRJs.has(localRJ)) return;
    fetchedRJs.add(localRJ);
    fetchRJ(localRJ, (data) => {
      if (version !== _pageVersion) return;
      try {
        limitMapSize(rawDataCache); rawDataCache.set(localRJ, data);
        const result = calcScore(data, { ...settings });
        limitMapSize(resultCache); resultCache.set(localRJ, result);
        renderMain(result, checkPriceAlert(localRJ, data), data);
        recordStat(localRJ, result.score);        // 詳細ページのみカウント
        recordGenreHistory(localRJ, result.score); // ジャンル履歴記録
        renderStatsOverlay();                       // 統計オーバーレイ更新
        const map       = extractRJCardMap();
        const mainCards = map.get(localRJ);
        if (mainCards?.size > 0) {
          mainCards.forEach(card => {
            if (card.isConnected) renderCard(card, result, localRJ, false);
          });
        }
      } catch (e) { console.error("[DLscore]", e); }
    }, () => {
      if (version !== _pageVersion) return;
      fetchedRJs.delete(localRJ);
      if (retryCount < 3) {
        const delay = 800 * Math.pow(2, retryCount);
        setTimeout(() => fetchMainRJ(retryCount + 1), delay);
      } else {
        console.warn("[DLscore] fetchMainRJ 最大リトライ到達:", localRJ);
      }
    });
  }

  function runList() {
    const rjCardMap = extractRJCardMap(); // アフィリエイト置換も同一走査内で実施
    for (const [rj, cards] of rjCardMap.entries()) {
      if (rj === mainRJ) continue;
      scheduleCard(rj, cards);  // D項: IntersectionObserver lazy fetch
    }
    translateTags();
  }

  let spaRunning     = false;
  let domStableTimer = null;

  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === window.__dlscoreUrl) return;
    window.__dlscoreUrl = newUrl;
    _pageVersion++;
    spaRunning = true;
    // A項: background の進行中fetchを全キャンセル
    chrome.runtime.sendMessage({ type: "ABORT_ALL_FETCHES" }, () => { void chrome.runtime.lastError; });
    clearTimeout(mutTimer);
    clearTimeout(domStableTimer);

    let elapsed = 0;
    const INTERVAL = 100;
    const MAX_WAIT = 1500;
    const MIN_WAIT = 300;

    const check = () => {
      elapsed += INTERVAL;
      const cards  = document.querySelectorAll("a[href*='/RJ']");
      const stable = cards.length > 0 || elapsed >= MAX_WAIT;
      if (stable && elapsed >= MIN_WAIT) {
        clearTimeout(domStableTimer);
        spaRunning = false;
        mainRJ   = getMainRJ(location.href);
        isDetail = getIsDetail();
        document.querySelector("#dlscore-main")?.remove();
        document.querySelector("#dlscore-stats")?.remove();
        document.querySelectorAll("[data-dlscore-card]").forEach(el => el.remove());
        document.querySelectorAll("[data-dlscore-done]").forEach(el => { delete el.dataset.dlscoreDone; });
        document.querySelectorAll("[data-dlscore-tag-en]").forEach(el => el.remove());
        fetchedRJs.clear();
        resultCache.clear();
        rawDataCache.clear();
        renderedCards.clear();
        // D項: lazy observer をリセット
        _pendingCards.clear();
        if (_lazyObserver) { _lazyObserver.disconnect(); _lazyObserver = null; }
        runList();
        _setupObserver(); // C項: SPA遷移後に監視ターゲットを再設定
        if (mainRJ && (isDetail || isDetailUrl(location.href))) {
          isDetail = true;
          fetchMainRJ();
        }
      } else {
        domStableTimer = setTimeout(check, INTERVAL);
      }
    };
    domStableTimer = setTimeout(check, INTERVAL);
  }

  const _push    = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = function (...a) { _push(...a);    onUrlChange(); };
  history.replaceState = function (...a) { _replace(...a); onUrlChange(); };
  window.addEventListener("popstate",          onUrlChange);
  window.addEventListener("dlscore:urlchange", onUrlChange);
  // カウントバグ修正: pagehide でページ離脱前に確実にflush
  window.addEventListener("pagehide", () => { if (statsDirty) flushStats(); });

  let compilationSet = new Set();

  function loadCompilations(cb) {
    chrome.storage.local.get({ [COMPILATION_KEY]: [] }, (res) => {
      compilationSet = new Set((res[COMPILATION_KEY] || []).map(r => r.toUpperCase()));
      if (cb) cb();
    });
  }

  function saveCompilations() {
    chrome.storage.local.set({ [COMPILATION_KEY]: [...compilationSet] });
  }

  loadCompilations();

  function updateCompilationBadges() {
    for (const [rj, divSet] of renderedCards.entries()) {
      const inComp = compilationSet.has(rj.toUpperCase());
      for (const div of divSet) {
        if (!div.isConnected) continue;
        let badge = div.parentElement?.querySelector("[data-dlscore-comp]");
        if (inComp && !badge) {
          badge = document.createElement("span");
          badge.dataset.dlscoreComp = "1";
          badge.style.cssText = "display:block;font-size:10px;color:#4a9eff;margin-top:2px;";
          badge.textContent = "📦 総集編あり";
          div.insertAdjacentElement("afterend", badge);
        } else if (!inComp && badge) {
          badge.remove();
        }
      }
    }
    if (mainRJ) updateMainCompBadge();
  }

  function updateMainCompBadge() {
    const el = document.querySelector("#dlscore-main");
    if (!el) return;
    let badge    = el.querySelector("[data-dlscore-comp]");
    const inComp = mainRJ && compilationSet.has(mainRJ.toUpperCase());
    if (inComp && !badge) {
      badge = document.createElement("span");
      badge.dataset.dlscoreComp = "1";
      badge.style.cssText = "display:block;font-size:11px;color:#4a9eff;margin-top:3px;";
      badge.textContent = "📦 この作品は総集編が存在します";
      el.appendChild(badge);
    } else if (!inComp && badge) {
      badge.remove();
    }
  }

  function clampPreviewPosition(el) {
    const vw = window.visualViewport?.width  ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const rect = el.getBoundingClientRect();
      if (rect.right  > vw) { el.style.left = ""; el.style.right  = "0px"; }
      if (rect.bottom > vh) { el.style.top  = ""; el.style.bottom = "0px"; }
      if (rect.left   < 0)  { el.style.right = ""; el.style.left  = "0px"; }
      if (rect.top    < 0)  { el.style.bottom = ""; el.style.top  = "0px"; }
    }));
  }

  const PREVIEW_SELECTOR =
    '.work_img_popbox,.popbox,.img_popbox,' +
    '[class*="preview_img"],[class*="zoom_img"],[class*="pop_img"],[class*="hover_img"]';

  const scheduleIdle = typeof requestIdleCallback === "function"
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 200);

  // C項: MutationObserver scope限定 — DLsiteのメインコンテンツ領域のみ監視（body全体監視を回避）
  function _getMutTarget() {
    return document.querySelector(
      "#search_result, #work_list, #center_column, main, #main, .wrapper"
    ) || document.body;
  }

  let mutTimer    = null;
  let _mutObserver = null;

  // ── バックグラウンドタブ抑制 ──
  // タブを開きすぎた際の重量化対策: 非表示タブでは MutationObserver 起因の
  // 再走査(DOM全anchor走査+fetch)を保留し、フォアグラウンド復帰時に1回だけ実行する。
  let _needsRescanOnShow = false;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && _needsRescanOnShow) {
      _needsRescanOnShow = false;
      scheduleIdle(runList);
    }
  });

  const _mutCallback = (mutations) => {
    if (spaRunning) return;
    if (document.hidden) { _needsRescanOnShow = true; return; }
    let hasPreview   = false;
    let hasNewRJLink = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(PREVIEW_SELECTOR)) { clampPreviewPosition(node); hasPreview = true; continue; }
        if (!hasNewRJLink && (
          node.querySelector?.("a[href*='RJ']") ||
          (node.tagName === "A" && /RJ\d{4,}/i.test(node.href))
        )) {
          hasNewRJLink = true;
        }
      }
    }
    if (!hasPreview && hasNewRJLink) {
      clearTimeout(mutTimer);
      mutTimer = setTimeout(() => scheduleIdle(runList), 100);
    }
  };

  function _setupObserver() {
    if (_mutObserver) { _mutObserver.disconnect(); _mutObserver = null; }
    _mutObserver = new MutationObserver(_mutCallback);
    _mutObserver.observe(_getMutTarget(), { childList: true, subtree: true });
  }
  _setupObserver();

  chrome.storage.local.get(DEFAULTS, (vals) => {
    if (!chrome.runtime.lastError) settings = vals;
    loadSeenRJs();
    mainRJ   = getMainRJ(location.href);
    isDetail = getIsDetail();
    runList();
    if (isDetail && mainRJ) {
      fetchMainRJ();
    } else if (mainRJ && !isDetail) {
      const RETRY_DELAYS = [300, 700, 1500];
      let tried = 0;
      const retryDetail = () => {
        if (fetchedRJs.has(mainRJ)) return;
        isDetail = getIsDetail();
        if (isDetail) {
          fetchMainRJ();
        } else if (++tried < RETRY_DELAYS.length) {
          setTimeout(retryDetail, RETRY_DELAYS[tried]);
        }
      };
      setTimeout(retryDetail, RETRY_DELAYS[0]);
    }
  });

})();
