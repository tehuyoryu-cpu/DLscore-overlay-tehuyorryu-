// crawler_tab.js
// 動作モード: "crawl"（保存済み状態から再開）/ "refresh"（スコア再取得のみ）

// ── 定数 ──
const _COMP_KEY       = "dlsite_compilations_v1";   // 収録作品RJ（バッジ表示対象）
const _COMP_PENDING_KEY = "dlsite_comp_pending_v1";  // 要確認候補（低信頼度の推定、人の承認待ち）
const _COMP_WORKS_KEY = "dlsite_comp_works_v1";      // 総集編作品RJ（Phase Bの入力のみ）
const _PROG_KEY       = "dlsite_comp_progress";
const _PROCESSED_KEY  = "dlsite_processed_comps_v1";
const _STATE_KEY      = "dlsite_crawl_state";

const _DLSITE_FSR  = p =>
  `https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/ana_flg/all/order%5B0%5D/trend/genre%5B0%5D/515/options_and_or/and/per_page/100/page/${p}/show_type/1`;
const _DLSITE_WORK = rj =>
  `https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`;
const _CIRCLE_URL  = (makerId, page = 1) =>
  `https://www.dlsite.com/maniax/fsr/=/sex_category%5B0%5D/male/maker_id/${makerId}/per_page/100/page/${page}/show_type/1`;
const _DLDSHARE_BASE  = "https://dldshare.net/archives/tag/%E7%B7%8F%E9%9B%86%E7%B7%A8";
const _DLWATCHER_BASE = "https://dlwatcher.com/product/";

const _LIST_TO       = 12_000;
const _DETAIL_TO     = 14_000;
const _SCORE_TO      = 12_000;
const _LIST_DELAY    = 200;
const _DETAIL_DELAY  = 450;
const _CIRCLE_DELAY  = 500;  // サークル作品取得（DLsite に配慮）
const _DLDS_DELAY    = 150;
const _SCORE_DELAY   = 300;
const _DETAIL_CONCUR = 3;
const _DLDS_CONCUR   = 8;
const _SCORE_CONCUR  = 4;
const _SCORE_TTL     = 6 * 60 * 60 * 1000;
const _SAVE_N        = 20;

let _running = true;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STOP_CRAWLER_TAB") { _running = false; setStatus("停止中…"); }
});

function setStatus(t) { const e = document.getElementById("status"); if (e) e.textContent = t; }

// ════════════════════════════════
// IndexedDB
// ════════════════════════════════
let _idb = null;
function _openDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((res, rej) => {
    const req = indexedDB.open("rj_crawler_db", 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("items"))  d.createObjectStore("items",  { keyPath: "url" });
      if (!d.objectStoreNames.contains("scores")) d.createObjectStore("scores", { keyPath: "rj"  });
    };
    req.onsuccess = () => { _idb = req.result; res(_idb); };
    req.onerror   = () => rej(req.error);
  });
}
async function _dbSaveItems(items) {
  try { const db = await _openDB(); const tx = db.transaction("items","readwrite");
    items.forEach(i => tx.objectStore("items").put(i));
    await new Promise((r,j) => { tx.oncomplete=r; tx.onerror=j; }); } catch {}
}
async function _getScore(rj) {
  try { const db = await _openDB();
    return await new Promise(r => {
      const req = db.transaction("scores","readonly").objectStore("scores").get(rj.toUpperCase());
      req.onsuccess = () => r(req.result ?? null); req.onerror = () => r(null);
    }); } catch { return null; }
}
async function _saveScores(entries) {
  try { const db = await _openDB(); const tx = db.transaction("scores","readwrite");
    entries.forEach(e => tx.objectStore("scores").put(e));
    await new Promise((r,j) => { tx.oncomplete=r; tx.onerror=j; }); } catch {}
}

// ════════════════════════════════
// 再開ステート
// ════════════════════════════════
async function _loadState()      { const r = await chrome.storage.local.get({[_STATE_KEY]:null}); return r[_STATE_KEY]; }
async function _clearState()     { await chrome.storage.local.remove(_STATE_KEY); }
async function _saveState(patch) {
  const r = await chrome.storage.local.get({[_STATE_KEY]:{}});
  const s = {...(r[_STATE_KEY]||{}), ...patch};
  await chrome.storage.local.set({[_STATE_KEY]:s}); return s;
}

// ════════════════════════════════
// フェッチ
// ════════════════════════════════
async function _getText(url, to=_LIST_TO) {
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),to);
  try { const r=await fetch(url,{signal:c.signal}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }
  finally { clearTimeout(t); }
}
async function _getJSON(url) {
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),_SCORE_TO);
  try { const r=await fetch(url,{signal:c.signal}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
  finally { clearTimeout(t); }
}
const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════
// 抽出ユーティリティ
// ════════════════════════════════

// 検索結果ページ → 総集編作品RJ（product_idリンクのみ）
function _extractListingRJs(html) {
  return [...new Set(
    [...html.matchAll(/\/product_id\/(RJ\d{4,})\.html/gi)].map(m => m[1].toUpperCase())
  )];
}

/**
 * 作品詳細ページ → 収録作品RJ
 *
 * 優先順位:
 *   1. DOMParser で作品内容セクション（#work_outline / .work_parts_container）を解析
 *      a. テキスト中の RJxxxxxx を抽出
 *      b. product_idリンク内のRJを抽出（RJテキストを書かないサークル対策）
 *   2. 作品内容が空ならページ全体の product_id リンクを検索
 *
 * RJもリンクも書かないサークルは _estimateFromCircle() が担当する
 */
function _extractDetailRJs(html, selfRJ) {
  const self  = selfRJ.toUpperCase();
  const rjSet = new Set();

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // ── 1. 作品内容セクションを特定 ──
    // DLsite の DOM: #work_outline > .work_parts > .work_parts_area > .work_parts_container
    let contentEl = null;

    // 見出し「作品内容」「収録」を含む work_parts を優先探索
    for (const h of doc.querySelectorAll(".work_parts_title, h2, h3, dt")) {
      const t = h.textContent.trim();
      if (t.includes("作品内容") || t.includes("収録") || t.includes("内容")) {
        contentEl = h.closest(".work_parts") || h.closest(".work_parts_container") || h.parentElement;
        if (contentEl) break;
      }
    }

    // フォールバック: #work_outline → .work_parts_container → body
    if (!contentEl) contentEl = doc.querySelector("#work_outline");
    if (!contentEl) contentEl = doc.querySelector(".work_parts_container");
    if (!contentEl) contentEl = doc.body;

    if (contentEl) {
      // a. テキスト中のRJ
      [...contentEl.textContent.matchAll(/RJ\d{4,}/gi)]
        .forEach(m => rjSet.add(m[0].toUpperCase()));

      // b. product_idリンク内のRJ（RJテキストを書かないサークル対策）
      contentEl.querySelectorAll("a[href]").forEach(a => {
        const m = a.href.match(/\/product_id\/(RJ\d{4,})/i);
        if (m) rjSet.add(m[1].toUpperCase());
      });
    }

    // ── 2. 作品内容で0件なら、ページ全体の product_id リンクを走査 ──
    if (rjSet.size === 0 || (rjSet.size === 1 && rjSet.has(self))) {
      doc.querySelectorAll("a[href*='/product_id/RJ']").forEach(a => {
        const m = a.href.match(/\/product_id\/(RJ\d{4,})/i);
        if (m) rjSet.add(m[1].toUpperCase());
      });
    }

  } catch {
    // DOMParser 失敗時は regex フォールバック
    [...html.matchAll(/RJ\d{4,}/gi)].forEach(m => rjSet.add(m[0].toUpperCase()));
  }

  rjSet.delete(self);
  return [...rjSet];
}

/**
 * RJ未記載総集編への対応: 同サークル作品からスコアリングで推定
 *
 * 戦略:
 *   - 総集編タイトルを正規化（「総集編」「まとめ」等を除去）
 *   - 残ったキーワードが一致するサークル作品を収録候補とする
 *   - キーワード1件以上一致（スコア30以上）で候補に採用
 *   - 最大20件に制限（ノイズ防止）
 *
 * 注意: リンクも書かない・タイトルも無関係なケースは手動登録が必要
 */
// ── 推定エンジン委譲（comp_analyzer.js の estimateContents を使用）──
// RJ もリンクも書かないサークルへのフォールバック
// 正確性優先: 高信頼度(high)は自動マーク、低信頼度(review)は要確認キューに回す。
async function _estimateFromCircle(html, selfRJ) {
  try {
    return await estimateContents(selfRJ, html, _getText, _getJSON, _sleep, () => _running);
  } catch (e) {
    console.warn("[CompAnalyzer] 推定失敗:", selfRJ, String(e));
    return { high: [], review: [] };
  }
}

// dldshare ユーティリティ
function _dldsArticleUrls(html) {
  return [...html.matchAll(/href="(https:\/\/dldshare\.net\/archives\/\d[^"#?]*)"/gi)].map(m=>m[1]);
}
function _dldsRJs(html) { return [...html.matchAll(/RJ\d{4,}/gi)].map(m=>m[0].toUpperCase()); }
function _dldsHasNext(html) { return /class=["']next page-numbers["']|rel=["']next["']/.test(html); }

// ── 進捗 ──
async function _prog(state) {
  setStatus([
    state.phase,
    state.page  != null && `${state.page}p`,
    state.total > 0     && `${state.fetched}/${state.total}件`,
    state.rj    != null && `RJ ${state.rj}件`,
    state.score != null && `スコア ${state.score}件`,
  ].filter(Boolean).join("  ·  "));
  await chrome.storage.local.set({[_PROG_KEY]: state});
}

async function _mergeToCompKey(rjIterable) {
  const ex = await chrome.storage.local.get({[_COMP_KEY]:[]});
  const merged = [...new Set([...ex[_COMP_KEY], ...rjIterable])].sort();
  await chrome.storage.local.set({[_COMP_KEY]: merged});
  return merged.length;
}

/**
 * 要確認キューへのマージ。
 * キーは rj+compRj のペア単位（同じ作品が複数の総集編候補になり得るため）。
 * 既に _COMP_KEY（確定マーク済み）に入っている rj は積まない（承認待ちが無意味なため）。
 * 同じペアが既にキューにあれば、スコアが高い方・reasonsが新しい方で上書きする。
 */
async function _mergeToPendingKey(entries) {
  if (!entries || entries.length === 0) return 0;
  const r = await chrome.storage.local.get({[_COMP_PENDING_KEY]:[], [_COMP_KEY]:[]});
  const confirmedSet = new Set(r[_COMP_KEY]);
  const map = new Map(r[_COMP_PENDING_KEY].map(e => [`${e.rj}::${e.compRj}`, e]));
  for (const e of entries) {
    if (confirmedSet.has(e.rj)) continue; // 既に確定済みなら確認不要
    const key = `${e.rj}::${e.compRj}`;
    const existing = map.get(key);
    if (!existing || e.score > existing.score) {
      map.set(key, { ...e, addedAt: existing?.addedAt ?? Date.now() });
    }
  }
  const merged = [...map.values()].sort((a, b) => b.score - a.score);
  await chrome.storage.local.set({[_COMP_PENDING_KEY]: merged});
  return merged.length;
}
async function _mergeToCompWorksKey(rjIterable) {
  const ex = await chrome.storage.local.get({[_COMP_WORKS_KEY]:[]});
  const merged = [...new Set([...ex[_COMP_WORKS_KEY], ...rjIterable])].sort();
  await chrome.storage.local.set({[_COMP_WORKS_KEY]: merged});
  return merged.length;
}

// ════════════════════════════════
// Phase A: DLsite ジャンル515 一覧
// 総集編「作品」RJを _COMP_WORKS_KEY に収集（bug①修正: _COMP_KEY と分離）
// ════════════════════════════════
async function _phaseA(S) {
  if (S.dlsiteDone) return;
  let page = S.dlsitePage ?? 1;
  await _prog({ running:true, phase:"DLsite 一覧収集中", page, rj:0 });

  while (_running) {
    let html; try { html = await _getText(_DLSITE_FSR(page)); } catch { break; }
    const found = _extractListingRJs(html);
    if (found.length === 0) break;
    const total = await _mergeToCompWorksKey(found);
    S.dlsitePage = page + 1;
    await _saveState({ dlsitePage:S.dlsitePage, phase:1 });
    await _prog({ running:true, phase:"DLsite 一覧収集中", page, rj:total });
    page++;
    await _sleep(_LIST_DELAY);
  }
  if (!_running) return;
  S.dlsiteDone = true;
  await _saveState({ dlsiteDone:true });
}

// ════════════════════════════════
// Phase B: 総集編詳細 → 収録RJ抽出
// bug①修正: _COMP_WORKS_KEY のみを入力とする
// bug②修正: rjAll は per-item で保存
// ════════════════════════════════
async function _phaseB() {
  const r = await chrome.storage.local.get({[_COMP_WORKS_KEY]:[], [_PROCESSED_KEY]:[]});
  const compWorks = r[_COMP_WORKS_KEY];
  const processed = new Set(r[_PROCESSED_KEY]);
  const toFetch   = compWorks.filter(rj => !processed.has(rj));
  if (toFetch.length === 0) return;

  const total = toFetch.length;
  let idx=0, fetched=0;
  const newDone=[], items=[];

  await _prog({ running:true, phase:"商品詳細取得中", fetched:0, total, rj:0 });

  async function worker() {
    while (_running) {
      const i = idx++;
      if (i >= toFetch.length) break;
      const rj = toFetch[i];
      let contained = [];

      try {
        const html = await _getText(_DLSITE_WORK(rj), _DETAIL_TO);

        // 1. 作品内容から直接抽出（DOMParser + リンク）— 確実な情報源なのでそのまま自動マーク
        contained = _extractDetailRJs(html, rj);

        // 2. 0件の場合: 同サークル作品からスコアリング推定
        //    正確性優先: high(高信頼度)のみ自動マーク、review(低信頼度)は要確認キューへ
        if (contained.length === 0) {
          const est = await _estimateFromCircle(html, rj);
          contained = est.high;
          if (est.review.length > 0) await _mergeToPendingKey(est.review);
        }

        newDone.push(rj);
        // bug②修正: contained は この作品専用の RJ リスト（自動マーク分のみ、要確認分は含まない）
        items.push({ url: _DLSITE_WORK(rj), rjAll: contained, savedAt: Date.now() });

      } catch {
        newDone.push(rj); // 失敗も処理済みにして無限リトライを防ぐ
      }

      if (contained.length > 0) await _mergeToCompKey(contained);

      fetched++;
      if (fetched % _SAVE_N === 0) {
        await chrome.storage.local.set({[_PROCESSED_KEY]: [...processed, ...newDone]});
        const ex = await chrome.storage.local.get({[_COMP_KEY]:[]});
        await _prog({ running:true, phase:"商品詳細取得中", fetched, total, rj:ex[_COMP_KEY].length });
      }
      await _sleep(_DETAIL_DELAY);
    }
  }

  await Promise.all(Array.from({ length: _DETAIL_CONCUR }, worker));
  await chrome.storage.local.set({[_PROCESSED_KEY]: [...processed, ...newDone]});
  if (items.length > 0) await _dbSaveItems(items);
}

// ════════════════════════════════
// Phase C: dldshare.net（補助）
// ════════════════════════════════
async function _phaseC(S) {
  if (!S.dldshareListDone) {
    let page = S.dldshareListPage ?? 1;
    S.articleUrls = S.articleUrls ?? [];
    const urlSet = new Set(S.articleUrls);
    await _prog({ running:true, phase:"dldshare 収集中", page });

    while (_running) {
      const url = page===1 ? _DLDSHARE_BASE : `${_DLDSHARE_BASE}/page/${page}`;
      let html; try { html = await _getText(url); } catch { break; }
      _dldsArticleUrls(html).forEach(u => urlSet.add(u));
      S.articleUrls = [...urlSet]; S.dldshareListPage = page+1;
      await _saveState({ dldshareListPage:S.dldshareListPage, articleUrls:S.articleUrls, phase:1 });
      await _prog({ running:true, phase:"dldshare 収集中", page });
      if (!_dldsHasNext(html)) break;
      page++;
      await _sleep(_DLDS_DELAY);
    }
    if (!_running) return;
    S.dldshareListDone = true;
    await _saveState({ dldshareListDone:true });
  }

  S.processedUrls = S.processedUrls ?? [];
  const doneSet = new Set(S.processedUrls);
  const toFetch = (S.articleUrls ?? []).filter(u => !doneSet.has(u));
  if (toFetch.length === 0) return;

  const total = S.articleUrls.length;
  const rjSet = new Set(S.dldshareRJs ?? []);
  let idx=0, fetched=0;

  await _saveState({ phase:2, articleUrls:S.articleUrls, processedUrls:S.processedUrls });
  await _prog({ running:true, phase:"dldshare 記事取得中", fetched:S.processedUrls.length, total, rj:rjSet.size });

  async function worker() {
    while (_running) {
      const i = idx++;
      if (i >= toFetch.length) break;
      const url = toFetch[i];
      try { _dldsRJs(await _getText(url)).forEach(rj => rjSet.add(rj)); S.processedUrls.push(url); }
      catch { S.processedUrls.push(url); }
      fetched++;
      if (fetched % _SAVE_N === 0 || !_running) {
        S.dldshareRJs = [...rjSet];
        await _saveState({ processedUrls:S.processedUrls, dldshareRJs:S.dldshareRJs });
        await _mergeToCompKey(rjSet);
        await _prog({ running:true, phase:"dldshare 記事取得中", fetched:S.processedUrls.length, total, rj:rjSet.size });
      }
      await _sleep(_DLDS_DELAY);
    }
  }

  await Promise.all(Array.from({ length: _DLDS_CONCUR }, worker));
  S.dldshareRJs = [...rjSet];
  await _saveState({ processedUrls:S.processedUrls, dldshareRJs:S.dldshareRJs });
  await _mergeToCompKey(rjSet);
}

// ════════════════════════════════
// Phase D: dlwatcher スコア取得
// ════════════════════════════════
async function _phaseD(rjList, base={}) {
  const now=Date.now(), toFetch=[];
  for (const rj of rjList) {
    if (!_running) break;
    const c = await _getScore(rj);
    if (!c || now-c.fetchedAt>_SCORE_TTL) toFetch.push(rj);
  }
  if (toFetch.length===0) { await _prog({...base, phase:"スコア最新（更新不要）", score:rjList.length}); return; }

  const total=toFetch.length; let fetched=0,saved=0,idx=0; const batch=[];
  await _prog({...base, running:true, phase:"スコア取得中", fetched:0, total, score:0});

  async function worker() {
    while (_running) {
      const i=idx++; if (i>=toFetch.length) break;
      const rj=toFetch[i];
      try {
        const data=await _getJSON(`${_DLWATCHER_BASE}${rj}.json`);
        batch.push({rj:rj.toUpperCase(), data, fetchedAt:Date.now()}); saved++;
        if (batch.length>=50) await _saveScores(batch.splice(0,batch.length));
      } catch {}
      fetched++;
      if (fetched%10===0) await _prog({...base, running:true, phase:"スコア取得中", fetched, total, score:saved});
      await _sleep(_SCORE_DELAY);
    }
  }
  await Promise.all(Array.from({length:_SCORE_CONCUR}, worker));
  if (batch.length>0) await _saveScores(batch);
  await _prog({...base, running:true, phase:"スコア保存完了", fetched:total, total, score:saved});
}

// ════════════════════════════════
// メインクロール
// ════════════════════════════════
async function _crawl() {
  let S = (await _loadState()) ?? {};
  const stopped = () => {
    chrome.storage.local.set({[_PROG_KEY]:{running:false, phase:"停止（再開可能）"}});
    chrome.runtime.sendMessage({type:"CRAWLER_DONE"});
  };
  try {
    await _phaseA(S); if (!_running) { stopped(); return; }
    await _phaseB();  if (!_running) { stopped(); return; }
    await _phaseC(S); if (!_running) { stopped(); return; }
    const fin = await chrome.storage.local.get({[_COMP_KEY]:[]});
    await _phaseD(fin[_COMP_KEY], {running:true, rj:fin[_COMP_KEY].length});
    await _clearState();
    const done = await chrome.storage.local.get({[_COMP_KEY]:[]});
    await chrome.storage.local.set({[_PROG_KEY]:{running:false, phase:"完了", rj:done[_COMP_KEY].length}});
    chrome.runtime.sendMessage({type:"CRAWLER_DONE"});
  } catch(e) {
    await chrome.storage.local.set({[_PROG_KEY]:{running:false, phase:`エラー: ${e.message}`}});
    chrome.runtime.sendMessage({type:"CRAWLER_DONE"});
  }
}

async function _refreshScores() {
  try {
    const r = await chrome.storage.local.get({[_COMP_KEY]:[]});
    if (!r[_COMP_KEY].length) {
      await chrome.storage.local.set({[_PROG_KEY]:{running:false, phase:"更新対象なし"}}); return;
    }
    await _prog({running:true, phase:"スコア更新開始", rj:r[_COMP_KEY].length, score:0});
    await _phaseD(r[_COMP_KEY], {running:true, rj:r[_COMP_KEY].length});
    await chrome.storage.local.set({[_PROG_KEY]:{running:false, phase:"スコア更新完了", rj:r[_COMP_KEY].length}});
    chrome.runtime.sendMessage({type:"CRAWLER_DONE"});
  } catch(e) {
    await chrome.storage.local.set({[_PROG_KEY]:{running:false, phase:`エラー: ${e.message}`}});
    chrome.runtime.sendMessage({type:"CRAWLER_DONE"});
  }
}

(async () => {
  const res  = await chrome.storage.local.get({dlsite_crawler_mode:"crawl"});
  const mode = res.dlsite_crawler_mode;
  await chrome.storage.local.remove("dlsite_crawler_mode");
  if (mode==="refresh") await _refreshScores(); else await _crawl();
})().finally(() => setTimeout(() => window.close(), 1500));
