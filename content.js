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
  };

  let settings = { ...DEFAULTS };

  let cache = (() => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { return {}; }
  })();

  let priceHist = (() => {
    try { return JSON.parse(localStorage.getItem(PRICE_HIST_KEY)) || {}; }
    catch { return {}; }
  })();

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
    if (!genres.length && !title) return;
    chrome.storage.local.get({ [GENRE_HIST_KEY]: {} }, res => {
      if (chrome.runtime.lastError) return;
      const hist = res[GENRE_HIST_KEY];
      hist[rj] = { title, genres, circle, score, viewedAt: Date.now() };
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
      if (stored && stored.date === jstDateStr()) {
        seenRJsToday = new Set(stored.rjs);
      } else {
        seenRJsToday = new Set();
        saveSeenRJs();
      }
    } catch {
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

  function attachTouchTooltip(el, getTooltipText) {
    if (!IS_TOUCH) return;
    let tip = null;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tip) { tip.remove(); tip = null; return; }
      tip = document.createElement("div");
      tip.style.cssText = [
        "position:absolute", "z-index:2147483647",
        "background:#222", "color:#eee", "font-size:11px",
        "padding:6px 8px", "border-radius:5px",
        "white-space:pre", "box-shadow:0 2px 8px rgba(0,0,0,.4)",
        "pointer-events:none",
      ].join(";");
      tip.textContent = getTooltipText();
      el.style.position = el.style.position || "relative";
      el.appendChild(tip);
      setTimeout(() => { tip?.remove(); tip = null; }, 3000);
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
    applySettingsToRendered();
  });

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
    document.querySelector("#dlscore-main")?.remove();
    document.querySelectorAll("[data-dlscore-card]").forEach(el => el.remove());
    document.querySelectorAll("[data-dlscore-done]").forEach(el => { delete el.dataset.dlscoreDone; });
    runList();
    if (isDetail && mainRJ) fetchMainRJ();
  });

  const SKIP_HREF_PATTERN  = /(\/|[?&])(cart|trial|sample|dlzip|dlpurchase|add_cart|buy|coupon)([/?&#=]|$)/i;
  const SKIP_CLASS_PATTERN = /btn|button|cart|trial|sample|thumb|img|icon/i;

  function extractRJCardMap() {
    const rjCards = new Map();
    document.querySelectorAll("a[href]").forEach(a => {
      const m = a.href.match(/[/=](RJ\d{4,})/i);
      if (!m) return;
      const rj = m[1].toUpperCase();
      if (isDetail && rj === mainRJ) return;
      if (SKIP_HREF_PATTERN.test(a.href)) return;
      if (a.className && SKIP_CLASS_PATTERN.test(a.className)) return;
      if (a.children.length === 1 && a.children[0].tagName === "IMG") return;
      const card =
        a.closest(".work_box")           ||
        a.closest("article")             ||
        a.closest(".search_result_item") ||
        a.closest("li");
      if (!card) return;
      if (isDetail) {
        const withinList =
          card.closest(".recommend_list")      ||
          card.closest(".same_group_list")     ||
          card.closest(".work_slider")         ||
          card.closest("[class*='recommend']") ||
          card.closest("[class*='related']")   ||
          card.closest("[class*='pickup']")    ||
          card.closest("[class*='ranking']")   ||
          card.closest("[class*='slider']")    ||
          card.closest("[class*='list']");
        if (!withinList) return;
      }
      if (!rjCards.has(rj)) rjCards.set(rj, new Set());
      rjCards.get(rj).add(card);
    });
    return rjCards;
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
    const rjCardMap = extractRJCardMap();
    for (const [rj, cards] of rjCardMap.entries()) {
      if (rj === mainRJ) continue;
      processRJWithCards(rj, cards);
    }
  }

  let spaRunning     = false;
  let domStableTimer = null;

  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === window.__dlscoreUrl) return;
    window.__dlscoreUrl = newUrl;
    _pageVersion++;
    spaRunning = true;
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
        document.querySelectorAll("[data-dlscore-card]").forEach(el => el.remove());
        document.querySelectorAll("[data-dlscore-done]").forEach(el => { delete el.dataset.dlscoreDone; });
        fetchedRJs.clear();
        resultCache.clear();
        rawDataCache.clear();
        renderedCards.clear();
        runList();
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

  let mutTimer = null;
  new MutationObserver((mutations) => {
    if (spaRunning) return;
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
  }).observe(document.body, { childList: true, subtree: true });

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
