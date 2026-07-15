// popup.js

function initAccordion() {
  document.querySelectorAll(".section-hd").forEach(hd => {
    hd.addEventListener("click", () => {
      const body = document.getElementById(hd.dataset.target);
      if (!body) return;
      const open = body.classList.toggle("open");
      hd.classList.toggle("open", open);
    });
  });
}

const HELP_ITEMS = [
  {
    q: "スコアが表示されない",
    a: "①ページをリロード ②ポップアップ右下「キャッシュ削除」を押す（表示キャッシュ、TTL 30分）③それでも直らない場合は「データ管理」の「🔢 リセット」でスコアDB自体を再取得。共有DB(GitHub)に未収録の作品はスコアを取得できません。",
  },
  {
    q: "スコアのしくみ",
    a: "<strong>価格ポジション50% · 割引率25% · 希少性15% · トレンド10%</strong> の重み付き合計（0〜100点）。各要素はポップアップの「⚖️ スコア計算要素」でON/OFF可能。",
  },
  {
    q: "📦 総集編マークの使い方",
    a: "「📦 総集編マーク一覧」→「🔄 取得」を押すと <code>dldshare.net</code> を自動巡回してRJを収集。完了後、一覧・詳細ページにバッジが表示されます。",
  },
  {
    q: "走査が止まる / 遅い",
    a: "バックグラウンドタブで動作します。ブラウザがタブをスリープさせると停止することがあります。「■ 停止」→「🔄 再取得」で再開できます（差分はマージされます）。",
  },
  {
    q: "📉 最安値アラートとは",
    a: "セール中に過去最安値を更新した作品に表示されます。<strong>セール中のみ記録</strong>されます。",
  },
  {
    q: "⚠️ 定期セール警告とは",
    a: "年間セール日数が90日以上の作品に表示される衝動買い抑止マーク。ポップアップの「⚠️ 定期セール警告」トグルでOFFにできます。",
  },
  {
    q: "スコア更新頻度とは",
    a: "共有DB(GitHub)からスコアを再取得する間隔です。「データ管理」で 6時間/1日/1週間/1か月 から選択できます。短くすると最新の価格に追従しやすくなりますが、通信回数が増えます。",
  },
  {
    q: "🌐 タグ英語対訳とは",
    a: "ジャンル・タグの横に英語訳を薄く併記します。<code>tag_dict.js</code> の公式タグ辞書に登録がある語のみ対応。未対応語は無視されます。",
  },
  {
    q: "データはどこに保存される？",
    a: "設定・統計・総集編リストは <code>chrome.storage.local</code>。価格履歴は <code>localStorage</code>（上限300件）、スコアキャッシュは <code>IndexedDB</code>。外部送信はありません（共有スコアDB(GitHub raw)へのアクセスを除く）。",
  },
];

function initHelp() {
  const container = document.getElementById("helpList");
  if (!container) return;

  HELP_ITEMS.forEach(({ q, a }) => {
    const item = document.createElement("div");
    item.className = "help-item";

    const qEl = document.createElement("div");
    qEl.className = "help-q";
    qEl.innerHTML = `${q}<span class="h-arrow">▾</span>`;

    const aEl = document.createElement("div");
    aEl.className = "help-a";
    aEl.innerHTML = a;

    qEl.addEventListener("click", () => {
      const open = aEl.classList.toggle("open");
      qEl.classList.toggle("open", open);
    });

    item.appendChild(qEl);
    item.appendChild(aEl);
    container.appendChild(item);
  });
}

function openSection(id) {
  const body = document.getElementById(id);
  const hd   = body?.previousElementSibling;
  if (!body || !hd) return;
  body.classList.add("open");
  hd.classList.add("open");
}

function filterRJList(list, keyword) {
  const key = keyword.trim().toUpperCase();
  if (!key) return list;
  return list.filter(v => v.includes(key));
}

function createVirtualList(pageSize = 50) {
  let count = pageSize;
  return {
    getVisible(list) { return list.slice(0, count); },
    showMore()       { count += pageSize; },
    reset()          { count = pageSize; },
  };
}
const compVL = createVirtualList(50);

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
  showCompBadge:   true,
  scoreTtlMs:      "6h", // background.js の TTL_OPTIONS のキー("6h"/"1d"/"1w"/"1m")と対応
  translateTags:   false,
  enableAffiliate: true,
};

const STATS_KEY       = "dlsite_stats_v1";
const COMPILATION_KEY = "dlsite_compilations_v1";
const PENDING_KEY     = "dlsite_comp_pending_v1";

const BASE_WEIGHTS = {
  compPosition: 50,
  compDiscount: 25,
  compRarity:   15,
  compTrend:    10,
};

const COMP_KEYS = ["compPosition", "compDiscount", "compRarity", "compTrend"];

function updateWeightBar(s) {
  const total = COMP_KEYS.reduce((sum, k) => sum + (s[k] ? BASE_WEIGHTS[k] : 0), 0);
  document.querySelectorAll(".comp-row").forEach((row, i) => {
    const key     = COMP_KEYS[i];
    const enabled = s[key];
    const normW   = (total > 0 && enabled) ? Math.round(BASE_WEIGHTS[key] / total * 100) : 0;
    const wEl     = row.querySelector(".comp-weight");
    wEl.textContent = enabled ? `${normW}%` : "—";
    wEl.classList.toggle("zero", !enabled);
    document.getElementById(`seg-${i}`).style.width = `${normW}%`;
    row.classList.toggle("off", !enabled);
    row.querySelector(".comp-check").classList.toggle("on", enabled);
  });
}

function save(patch) {
  chrome.storage.local.set(patch, () => {
    if (chrome.runtime.lastError)
      console.warn("[DLscore popup] save error:", chrome.runtime.lastError.message);
  });
}

function parseThreshold(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function loadStats() {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  chrome.storage.local.get({ [STATS_KEY]: {} }, (res) => {
    if (chrome.runtime.lastError) return;
    const todaySt = res[STATS_KEY][today];
    const countEl = document.getElementById("statCount");
    if (!countEl) return;
    countEl.textContent = (todaySt?.count > 0) ? todaySt.count : "0";
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATS_KEY])       loadStats();
  if (area === "local" && changes[COMPILATION_KEY]) loadCompilationList();
  if (area === "local" && changes[PENDING_KEY])     loadPendingList();
});

function initCompFetchBtn() {
  const btn     = document.getElementById("fetchCompBtn");
  const stopBt  = document.getElementById("stopCompBtn");
  const freshBt = document.getElementById("freshCompBtn");
  const progEl  = document.getElementById("compProgress");
  const hdrEl   = document.querySelector("[data-target='s-comp-list']");
  if (!btn || !progEl) return;

  const STATE_KEY = "dlsite_crawl_state";

  function formatProgress(prog) {
    const parts = [];
    if (prog.phase)        parts.push(prog.phase);
    if (prog.page)         parts.push(`${prog.page}p`);
    if (prog.total > 0)    parts.push(`${prog.fetched}/${prog.total}件`);
    else if (prog.fetched) parts.push(`${prog.fetched}件`);
    if (prog.rj)           parts.push(`RJ ${prog.rj}件`);
    return parts.join("  ·  ");
  }

  function applyResumeState(state) {
    if (!state) {
      btn.textContent = btn.dataset.done ?? "🔄 取得";
      btn.dataset.mode = "crawl";
      if (freshBt) freshBt.style.display = "none";
      return;
    }
    const pct = state.phase === 2 && state.articleUrls?.length > 0
      ? Math.round(((state.processedUrls?.length ?? 0) / state.articleUrls.length) * 100)
      : null;
    btn.textContent  = pct != null ? `▶ 再開（${pct}%済）` : "▶ 再開";
    btn.dataset.mode = "resume";
    if (freshBt) freshBt.style.display = "";
  }

  const crawlDot = document.getElementById("crawlDot");

  function setRunningUI(running, text) {
    progEl.style.display = running ? "" : "none";
    if (text) progEl.textContent = text;
    btn.disabled = running;
    if (!running) {
      chrome.storage.local.get({ [STATE_KEY]: null }, (r) => applyResumeState(r[STATE_KEY]));
    } else {
      btn.textContent = "取得中…";
    }
    if (stopBt)   stopBt.style.display   = running ? "" : "none";
    if (freshBt)  freshBt.style.display  = running ? "none" : freshBt.style.display;
    if (crawlDot) crawlDot.classList.toggle("active", running);
    if (running)  openSection("s-comp-list");
    if (hdrEl)    hdrEl.style.opacity    = running ? "0.6" : "";
  }

  chrome.storage.local.get({ dlsite_comp_progress: null, [STATE_KEY]: null }, (res) => {
    if (res.dlsite_comp_progress?.running) {
      setRunningUI(true, formatProgress(res.dlsite_comp_progress));
    } else {
      applyResumeState(res[STATE_KEY]);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if ("dlsite_comp_progress" in changes) {
      const prog = changes["dlsite_comp_progress"].newValue;
      if (prog?.running) {
        setRunningUI(true, formatProgress(prog));
      } else {
        setRunningUI(false);
        loadCompilationList();
        if (prog?.phase === "完了") {
          chrome.storage.local.get({ [COMPILATION_KEY]: [] }, (r) => {
            const count = (r[COMPILATION_KEY] || []).length;
            btn.dataset.done = `✓ ${count}件`;
            btn.textContent  = btn.dataset.done;
            btn.classList.add("done");
            setTimeout(() => {
              btn.classList.remove("done");
              delete btn.dataset.done;
              applyResumeState(null);
            }, 3500);
          });
        }
      }
    }

    if (STATE_KEY in changes && !btn.disabled) {
      applyResumeState(changes[STATE_KEY].newValue ?? null);
    }
  });

  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode === "resume" ? "resume" : "crawl";
    delete btn.dataset.done;
    setRunningUI(true, mode === "resume" ? "再開中…" : "接続中…");

    chrome.runtime.sendMessage({ type: "FETCH_COMPILATION", mode }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        const reason = res?.reason === "already_running" ? "すでに実行中" : "失敗";
        setRunningUI(false);
        btn.textContent = `⚠️ ${reason}`;
        setTimeout(() => applyResumeState(null), 2500);
      }
    });
  });

  if (freshBt) {
    freshBt.style.display = "none";
    freshBt.addEventListener("click", () => {
      chrome.storage.local.remove(STATE_KEY, () => {
        btn.dataset.mode = "crawl";
        btn.textContent  = "🔄 取得";
        freshBt.style.display = "none";
      });
    });
  }

  if (stopBt) {
    stopBt.style.display = "none";
    stopBt.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "STOP_COMPILATION" });
      setRunningUI(false);
      progEl.style.display = "";
      progEl.textContent   = "停止中…（状態を保存しました）";
      setTimeout(() => { progEl.style.display = "none"; }, 2000);
    });
  }
}

function loadCompilationList() {
  const container = document.getElementById("compListContainer");
  if (!container) return;

  const keyword = document.getElementById("compSearch")?.value || "";

  chrome.storage.local.get({ [COMPILATION_KEY]: [] }, (res) => {
    if (chrome.runtime.lastError) return;
    const raw  = res[COMPILATION_KEY] || [];
    const list = filterRJList(raw, keyword);

    container.innerHTML = "";

    if (list.length === 0) {
      container.className   = "comp-list-empty";
      container.textContent = keyword ? "一致する作品がありません" : "マークされた作品はありません";
      return;
    }

    container.className = "comp-list";

    const visible = compVL.getVisible(list);

    visible.forEach(rj => {
      const item = document.createElement("div");
      item.className = "comp-item";

      const rjSpan = document.createElement("span");
      rjSpan.className   = "comp-item-rj";
      rjSpan.textContent = rj;

      const delBtn = document.createElement("button");
      delBtn.className   = "comp-item-del";
      delBtn.textContent = "✕";
      delBtn.title       = "リストから削除";
      delBtn.addEventListener("click", () => {
        chrome.storage.local.get({ [COMPILATION_KEY]: [] }, (r2) => {
          const updated = (r2[COMPILATION_KEY] || []).filter(r => r !== rj);
          chrome.storage.local.set({ [COMPILATION_KEY]: updated }, loadCompilationList);
        });
      });

      item.appendChild(rjSpan);
      item.appendChild(delBtn);
      container.appendChild(item);
    });

    if (visible.length < list.length) {
      const remaining = list.length - visible.length;
      const moreBtn = document.createElement("button");
      moreBtn.className   = "act-btn";
      moreBtn.style.cssText = "margin:4px 0 2px;width:100%";
      moreBtn.textContent = `さらに ${Math.min(50, remaining)} 件表示（残 ${remaining} 件）`;
      moreBtn.addEventListener("click", () => {
        compVL.showMore();
        loadCompilationList();
      });
      container.appendChild(moreBtn);
    }
  });
}

// ── 要確認候補（低信頼度推定・セミオート確認）────────────────────────────────
const pendingVL = createVirtualList(30);

function loadPendingList() {
  const container = document.getElementById("pendingListContainer");
  const badge     = document.getElementById("pendingBadge");
  if (!container) return;

  chrome.storage.local.get({ [PENDING_KEY]: [] }, (res) => {
    if (chrome.runtime.lastError) return;
    const list = res[PENDING_KEY] || [];

    if (badge) {
      if (list.length > 0) { badge.style.display = ""; badge.textContent = list.length; }
      else                 { badge.style.display = "none"; }
    }

    container.innerHTML = "";

    if (list.length === 0) {
      container.className   = "pending-list-empty";
      container.textContent = "要確認の候補はありません";
      return;
    }

    container.className = "pending-list";

    const visible = pendingVL.getVisible(list);

    visible.forEach(entry => {
      const item = document.createElement("div");
      item.className = "pending-item";

      const top = document.createElement("div");
      top.className = "pending-item-top";

      const rjLink = document.createElement("span");
      rjLink.className = "pending-item-rj";
      const a = document.createElement("a");
      a.href = `https://www.dlsite.com/maniax/work/=/product_id/${entry.rj}.html`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${entry.rj} ↗`;
      a.title = "作品ページを開いて確認";
      rjLink.appendChild(a);

      const scoreEl = document.createElement("span");
      scoreEl.className = "pending-item-score";
      scoreEl.textContent = `${entry.score}点`;

      top.appendChild(rjLink);
      top.appendChild(scoreEl);

      const compEl = document.createElement("div");
      compEl.className = "pending-item-comp";
      compEl.textContent = `総集編候補: ${entry.compRj}`;

      const reasonsEl = document.createElement("div");
      reasonsEl.className = "pending-item-reasons";
      (entry.reasons || []).forEach(r => {
        const tag = document.createElement("span");
        tag.className = "pending-reason-tag";
        tag.textContent = r;
        reasonsEl.appendChild(tag);
      });

      const actions = document.createElement("div");
      actions.className = "pending-item-actions";

      const approveBtn = document.createElement("button");
      approveBtn.className = "pending-act approve";
      approveBtn.textContent = "✓ 確定";
      approveBtn.addEventListener("click", () => {
        approveBtn.disabled = true;
        chrome.runtime.sendMessage(
          { type: "APPROVE_PENDING", rj: entry.rj, compRj: entry.compRj },
          () => { void chrome.runtime.lastError; loadPendingList(); }
        );
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.className = "pending-act reject";
      rejectBtn.textContent = "✕ 却下";
      rejectBtn.addEventListener("click", () => {
        rejectBtn.disabled = true;
        chrome.runtime.sendMessage(
          { type: "REJECT_PENDING", rj: entry.rj, compRj: entry.compRj },
          () => { void chrome.runtime.lastError; loadPendingList(); }
        );
      });

      actions.appendChild(approveBtn);
      actions.appendChild(rejectBtn);

      item.appendChild(top);
      item.appendChild(compEl);
      item.appendChild(reasonsEl);
      item.appendChild(actions);
      container.appendChild(item);
    });

    if (visible.length < list.length) {
      const remaining = list.length - visible.length;
      const moreBtn = document.createElement("button");
      moreBtn.className   = "act-btn";
      moreBtn.style.cssText = "margin:4px 0 2px;width:100%";
      moreBtn.textContent = `さらに ${Math.min(30, remaining)} 件表示（残 ${remaining} 件）`;
      moreBtn.addEventListener("click", () => {
        pendingVL.showMore();
        loadPendingList();
      });
      container.appendChild(moreBtn);
    }
  });
}

function initPopup() {
  try {
    // キャッシュ削除
    const cacheBtn = document.getElementById("cacheClear");
    if (cacheBtn) {
      cacheBtn.addEventListener("click", function () {
        const btn = this;
        btn.disabled = true;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!chrome.runtime.lastError && tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, { type: "CLEAR_CACHE" }, () => {
              void chrome.runtime.lastError;
            });
          }
          setTimeout(() => {
            btn.textContent = "キャッシュ削除";
            btn.classList.remove("done");
            btn.disabled = false;
          }, 1800);
        });
        btn.textContent = "削除しました ✓";
        btn.classList.add("done");
      });
    }

    // スコアDBリセット（バグ修正: 未実装だったハンドラ）
    const clearScoreBtn = document.getElementById("clearScoreDb");
    if (clearScoreBtn) {
      clearScoreBtn.addEventListener("click", function () {
        const btn = this;
        btn.disabled = true;
        chrome.runtime.sendMessage({ type: "CLEAR_SCORE_DB" }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            btn.textContent = "⚠️ 失敗";
          } else {
            btn.textContent = "✓ 完了";
            btn.classList.add("done");
          }
          setTimeout(() => {
            btn.textContent = "🔢 リセット";
            btn.classList.remove("done");
            btn.disabled = false;
          }, 2000);
        });
      });
    }

    // 総集編データ全初期化（バグ修正: 未実装だったハンドラ）
    const clearAllBtn = document.getElementById("clearAllData");
    if (clearAllBtn) {
      clearAllBtn.addEventListener("click", function () {
        if (!confirm("収集済みRJ・走査状態・スコアDB・要確認候補をすべて削除します。よろしいですか？")) return;
        const btn = this;
        btn.disabled = true;
        chrome.runtime.sendMessage({ type: "CLEAR_ALL_DATA" }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            btn.textContent = "⚠️ 失敗";
          } else {
            btn.textContent = "✓ 完了";
            btn.classList.add("done");
            loadCompilationList();
            loadPendingList();
          }
          setTimeout(() => {
            btn.textContent = "📦 初期化";
            btn.classList.remove("done");
            btn.disabled = false;
          }, 2000);
        });
      });
    }

    // 分析ページを開く
    const analyticsBtn = document.getElementById("openAnalytics");
    if (analyticsBtn) {
      analyticsBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("analytics.html") });
      });
    }

    // 傾向診断ページを開く
    const tasteQuizBtn = document.getElementById("openTasteQuiz");
    if (tasteQuizBtn) {
      tasteQuizBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("taste_quiz.html") });
      });
    }

    // RJ検索
    const searchEl = document.getElementById("compSearch");
    if (searchEl) {
      searchEl.addEventListener("input", () => {
        compVL.reset();
        loadCompilationList();
      });
    }
  } catch (e) {
    console.error("[DLscore popup] init error:", e);
  }

  chrome.storage.local.get(DEFAULTS, (s) => {
    // G項: hydration — ストレージ読み込み完了後にUIを表示（未初期化状態の一瞬を隠す）
    document.body.style.opacity = "1";

    if (chrome.runtime.lastError) {
      console.warn("[DLscore popup] storage error:", chrome.runtime.lastError.message);
      s = { ...DEFAULTS };
    }

    try {
      const greenEl  = document.getElementById("green");
      const yellowEl = document.getElementById("yellow");
      if (!greenEl || !yellowEl) return;

      ["showOverlay", "showCards", "useTextScore", "showSaleWarning", "showCompBadge", "translateTags", "enableAffiliate"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = s[id] ?? DEFAULTS[id];
        el.addEventListener("change", function () {
          save({ [id]: this.checked });
        });
      });

      const scoreTtlEl = document.getElementById("scoreTtl");
      if (scoreTtlEl) {
        scoreTtlEl.value = s.scoreTtlMs || DEFAULTS.scoreTtlMs;
        scoreTtlEl.addEventListener("change", function () {
          save({ scoreTtlMs: this.value });
        });
      }

      greenEl.value  = s.green;
      yellowEl.value = s.yellow;

      greenEl.addEventListener("input", function () {
        const v = parseThreshold(this.value);
        if (v === null) return;
        this.value = v; s.green = v;
        if (v <= s.yellow) {
          s.yellow = Math.max(0, v - 1);
          yellowEl.value = s.yellow;
          save({ yellow: s.yellow });
        }
        save({ green: v });
      });

      yellowEl.addEventListener("input", function () {
        const v = parseThreshold(this.value);
        if (v === null) return;
        this.value = v; s.yellow = v;
        if (v >= s.green) {
          s.green = Math.min(100, v + 1);
          greenEl.value = s.green;
          save({ green: s.green });
        }
        save({ yellow: v });
      });

      const dimEl = document.getElementById("dimBelow");
      if (dimEl) {
        dimEl.value = s.dimBelow ?? 0;
        dimEl.addEventListener("input", function () {
          const v = parseThreshold(this.value);
          if (v === null) { this.value = s.dimBelow; return; }
          this.value = v; s.dimBelow = v;
          save({ dimBelow: v });
        });
      }

      ["labelGreen", "labelYellow", "labelRed"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = s[id] || "";
        el.addEventListener("input", function () {
          s[id] = this.value.trim();
          save({ [id]: s[id] });
        });
      });

      updateWeightBar(s);
      document.querySelectorAll(".comp-row").forEach((row, i) => {
        const key = COMP_KEYS[i];
        row.addEventListener("click", () => {
          const next = !s[key];
          if (!next && COMP_KEYS.filter(k => k !== key && s[k]).length === 0) return;
          s[key] = next;
          save({ [key]: next });
          updateWeightBar(s);
        });
      });

      loadStats();
      loadCompilationList();
      loadPendingList();
      initCompFetchBtn();

    } catch (e) {
      console.error("[DLscore popup] init error:", e);
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { initAccordion(); initHelp(); initPopup(); });
} else {
  initAccordion();
  initHelp();
  initPopup();
}

// G項: ストレージ読み込みが長引いた場合のフォールバック表示（300ms上限）
setTimeout(() => { document.body.style.opacity = "1"; }, 300);
