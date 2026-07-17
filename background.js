// background.js
// クローラーロジックは crawler_tab.js（専用タブ）に移管済み。
// ここではタブの開閉管理・AI レビュー・FETCH メッセージのみを担う。
//
// ★スコアデータは拡張側では取得しない方針。
//   共有DBは tehuyoryu-cpu/siteruns23432 の data ブランチ（別プロジェクト。PC側の
//   デスクトップアプリが自前でDLsiteを巡回して収集した価格データから
//   crawler/exportShards.js が manifest.json / index/NN.json / shards/NNNN.json を
//   生成し、1日1回 push する）。
//   拡張はそれを raw.githubusercontent.com 経由で manifest→index→shard の順に「拾うだけ」
//   （dlwatcher.com への直接アクセスは廃止）。
//   ローカルキャッシュ(IndexedDB)の有効期限は popup で 6時間/1日/1週間/1か月 から選択可能。

// ── keepalive（MV3 サービスワーカーのスリープ防止）──
setInterval(() => {
  chrome.storage.local.get(null, () => { void chrome.runtime.lastError; });
}, 20_000);

// ── 定数 ──
const _PROG_KEY        = "dlsite_comp_progress";
const _COMP_KEY        = "dlsite_compilations_v1";
const _COMP_PENDING_KEY = "dlsite_comp_pending_v1";
const FETCH_TIMEOUT_MS = 15_000;

// ── スコアキャッシュTTL（popup の「スコア更新頻度」設定から取得。未設定時は6時間）──
const TTL_KEY = "scoreTtlMs";
const TTL_OPTIONS = {
  "6h": 6  * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7  * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};
const DEFAULT_TTL_OPTION = "6h";

// N項: TTL設定の読み取りキャッシュ（100件同時スコア表示の重量化対策・続き）
// _getScoreTtlMs() は FETCH メッセージのたびに(=RJごとに)呼ばれていたため、
// 100件同時表示だと同じ設定値を得るためだけに chrome.storage.local.get の
// IPC往復が100回発生していた。値は popup 操作でしか変わらないので、
// メモリキャッシュしつつ storage.onChanged で即時無効化する。
let _ttlCache = null;
async function _getScoreTtlMs() {
  if (_ttlCache !== null) return _ttlCache;
  try {
    const res = await chrome.storage.local.get({ [TTL_KEY]: DEFAULT_TTL_OPTION });
    _ttlCache = TTL_OPTIONS[res[TTL_KEY]] ?? TTL_OPTIONS[DEFAULT_TTL_OPTION];
  } catch {
    _ttlCache = TTL_OPTIONS[DEFAULT_TTL_OPTION];
  }
  return _ttlCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && TTL_KEY in changes) _ttlCache = null; // 次回呼び出しで再取得
});

// ── GitHub raw（共有スコアDB）設定 ──
// 実データ配信元: tehuyoryu-cpu/siteruns23432 の data ブランチ。
// 実際の manifest.json を確認済み。ファイル構成は固定のハッシュ規則で決まり、
// manifest自体にはパステンプレートは含まれない(shardCount等の件数のみ):
//   manifest.json = { dataShards: 1024, idxShards: 64, hashAlgo: "fnv1a-32", ... }
//   index/{idxId 2桁0埋め}.json  = { "RJ01234567": <dataShard番号>, ... }
//     idxId = fnv1a(RJコード) % idxShards  ← RJコード自体でハッシュ分散
//   shards/{shardId 4桁0埋め}.json = { "RJ01234567": {p,s,d,os,po,dd,lp,lg}, ... }
//     shardId = fnv1a(maker_id) % dataShards ← サークル単位でハッシュ分散(index側から取得するので拡張側での計算は不要)
// shard内のキーは圧縮スキーマ(p=定価/s=セール価格/d=割引率/os=セール中/po=ポイントのみ/
// dd=年間セール日数/lp=過去最安値/lg=直近価格ログ)。content.js は dlwatcher.com 互換の
// 入れ子形式(currentPrice/lowestPrice/discountDaysOfLastYear/recentSalePriceLog)を前提に
// 書かれているため、_adaptShardEntry() でその場で変換して渡す(content.js側は無改修)。
const _GITHUB_OWNER      = "tehuyoryu-cpu";
const _GITHUB_REPO       = "siteruns23432";
const _GITHUB_BRANCH     = "data";
const _GITHUB_RAW_BASE   = `https://raw.githubusercontent.com/${_GITHUB_OWNER}/${_GITHUB_REPO}/${_GITHUB_BRANCH}/`;
const _GITHUB_TIMEOUT_MS = 8_000;
const _GH_META_TTL       = 60 * 60 * 1000; // manifest/index のローカルキャッシュ期間（1時間）
const _DEFAULT_DATA_SHARDS = 1024;
const _DEFAULT_IDX_SHARDS  = 64;

// FNV-1a 32bit。crawler/exportShards.js の fnv1a() と完全に同じ実装(同じ結果を返す必要がある)。
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ── SW 再起動時の状態整合 ──
// 旧実装は SW 再起動のたびに「走査中」フラグを無条件でクリアしていたが、
// MV3 の Service Worker は実行中のタブがあっても数十秒のアイドルで頻繁に
// 再起動されるため、実際にはクローラータブがまだ動いているのに popup 側が
// 「停止中」と誤表示し、ユーザーが再度「取得」を押して二重にタブを開いて
// しまう（＝タブが増殖して重くなる）原因になっていた。
// → 実際に crawler_tab.html のタブが存在するかを確認してから整合させる。
// （_reconcileCrawlerTabs は _crawlerTabId 宣言後に呼び出す）

// ── IndexedDB（crawler_tab.js と同じ DB。ローカルキャッシュ + GitHub shard キャッシュ）──
// v3: ghShards ストアを追加（GitHub raw の shard-N.json をキャッシュする用途）。
// crawler_tab.js 側は v2 のまま open しても問題ない（既存より低いバージョンは無視される）。
let _idb = null;

function _openDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("rj_crawler_db", 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("items"))
        d.createObjectStore("items", { keyPath: "url" });
      if (!d.objectStoreNames.contains("scores"))
        d.createObjectStore("scores", { keyPath: "rj" });
      if (!d.objectStoreNames.contains("ghShards"))
        d.createObjectStore("ghShards", { keyPath: "shard" });
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror   = () => reject(req.error);
  });
}

// M項: IndexedDB書き込みのバッチ化（100件同時スコア表示の重量化対策・続き）
// _saveScore/_saveShardCache は従来リクエストごとに独立した readwrite トランザクションを
// 開いていた。IndexedDBの同一storeへのreadwriteトランザクションはブラウザ内部で直列化
// されるため、100件が短時間に返ってくると数十〜百本のトランザクションが数珠つなぎに
// 実行され、コミット待ちの累積で体感の重さにつながる。
// 書き込みをMapにキューイングし、短いdebounce後に1トランザクションへまとめる。
function _createBatchedWriter(storeName, debounceMs = 80) {
  const queue = new Map();
  let timer = null;
  async function flush() {
    timer = null;
    if (queue.size === 0) return;
    const items = [...queue.values()];
    queue.clear();
    try {
      const db = await _openDB();
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      items.forEach(it => store.put(it));
      await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
    } catch {}
  }
  return {
    queue(key, value) {
      queue.set(key, value);
      if (!timer) timer = setTimeout(flush, debounceMs);
    },
    peek(key) { return queue.get(key) ?? null; }, // flush前でも読み取れるように
    clear() { queue.clear(); clearTimeout(timer); timer = null; }, // DBリセット時の取りこぼし書き戻し防止
  };
}
const _scoreWriter = _createBatchedWriter("scores");
const _shardWriter  = _createBatchedWriter("ghShards");

async function _getScore(rj) {
  const RJ = rj.toUpperCase();
  const pending = _scoreWriter.peek(RJ); // flush待ちのキューも先に確認（取りこぼし防止）
  if (pending) return pending;
  try {
    const db = await _openDB();
    return await new Promise((resolve) => {
      const req = db.transaction("scores", "readonly")
                    .objectStore("scores").get(RJ);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}

async function _saveScore(rj, data) {
  _scoreWriter.queue(rj.toUpperCase(), { rj: rj.toUpperCase(), data, fetchedAt: Date.now() });
}

// ── 汎用: タイムアウト付き fetch → JSON（失敗時は null）──
// セキュリティ強化: Content-Length が異常に大きいレスポンスは事前に弾く
// (共有DBリポジトリが乗っ取られた場合の帯域/メモリDoSへの防御)。
const _GH_MAX_BYTES = 4 * 1024 * 1024; // 4MB（shard/indexファイルとして十分すぎる余裕）

async function _fetchJSON(url) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), _GITHUB_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > _GH_MAX_BYTES) {
      console.warn("[DLscore] GitHub raw response too large, skipping:", url, cl);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── chrome.storage.local ラッパー（manifest/index の軽量キャッシュ用）──
function _storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [key]: null }, (res) => resolve(chrome.runtime.lastError ? null : res[key]));
  });
}
function _storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve(!chrome.runtime.lastError));
  });
}

// ── shard キャッシュ（IndexedDB。ファイル自体がそこそこ大きいため storage.local ではなくこちら）──
async function _getShardCache(shardNo) {
  const pending = _shardWriter.peek(shardNo); // flush待ちのキューも先に確認
  if (pending) return pending;
  try {
    const db = await _openDB();
    return await new Promise((resolve) => {
      const req = db.transaction("ghShards", "readonly").objectStore("ghShards").get(shardNo);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}
async function _saveShardCache(shardNo, data) {
  _shardWriter.queue(shardNo, { shard: shardNo, data, fetchedAt: Date.now() });
}

// ── manifest.json 取得（1時間キャッシュ、取得失敗時は古いキャッシュにフォールバック）──
// L項: 同時多発fetch対策（100件スコア表示時の重量化対策）
// スコア表示対象が一度に多いと、キャッシュ未確定のうちに同じmanifest/index/shardへの
// FETCHメッセージが並行で何十件も届く。従来はリクエストごとに独立してfetch()していたため、
// 同一ファイルへの重複ネットワークアクセスが発生していた（例: 100件同時表示で
// manifest.jsonへの同時fetchが最大100回走りうる）。in-flightのPromiseを共有キャッシュし、
// 同一キーへの後続呼び出しは新規fetchを起こさず既存Promiseを待つだけにする。
let _manifestInflight = null;
const _indexInflight = new Map(); // idxId → Promise
const _shardInflight  = new Map(); // shardId → Promise
async function _getGithubManifest() {
  const cached = await _storageGet("_ghManifestCache");
  if (cached && Date.now() - cached.fetchedAt < _GH_META_TTL) return cached.data;
  if (_manifestInflight) return _manifestInflight; // 重複fetch防止

  _manifestInflight = (async () => {
    const data = await _fetchJSON(`${_GITHUB_RAW_BASE}manifest.json`);
    if (data) {
      await _storageSet("_ghManifestCache", { data, fetchedAt: Date.now() });
      return data;
    }
    return cached?.data ?? null; // 取得失敗時は期限切れでも古いキャッシュを使う
  })();
  try {
    return await _manifestInflight;
  } finally {
    _manifestInflight = null;
  }
}

// ── index/{NN}.json 取得（RJ→dataShard番号 のマップ。RJコード自体でハッシュ分散済み）──
// 1キー(_ghIndexCache)の中に idxId ごとのキャッシュをネストして持たせる
// (storage.localのキー数を増やさず、CLEAR_SCORE_DB/CLEAR_ALL_DATA でも1回のremoveで済む)。
async function _getGithubIndex(manifest, rj) {
  const rawIdxShards = manifest.idxShards;
  const idxShards = (Number.isInteger(rawIdxShards) && rawIdxShards > 0)
    ? rawIdxShards
    : _DEFAULT_IDX_SHARDS; // manifestの値が不正(型崩れ/0/負数)なら既定値にフォールバック
  const idxId   = _fnv1a(rj) % idxShards;
  const idxPath = `index/${String(idxId).padStart(2, "0")}.json`;

  const all    = (await _storageGet("_ghIndexCache")) || {};
  const cached = all[idxId];
  if (cached && Date.now() - cached.fetchedAt < _GH_META_TTL) return cached.data;

  // 同一idxIdへの同時リクエストは1本のfetchに合流させる（64バケットしかないため
  // 100件同時表示だと同じidxIdに複数RJが集中しやすく、重複fetchの主要因になる）。
  if (_indexInflight.has(idxId)) return _indexInflight.get(idxId);

  const promise = (async () => {
    const data = await _fetchJSON(`${_GITHUB_RAW_BASE}${idxPath}`);
    if (data) {
      const latest = (await _storageGet("_ghIndexCache")) || {};
      latest[idxId] = { data, fetchedAt: Date.now() };
      await _storageSet("_ghIndexCache", latest);
      return data;
    }
    return cached?.data ?? null;
  })();
  _indexInflight.set(idxId, promise);
  try {
    return await promise;
  } finally {
    _indexInflight.delete(idxId);
  }
}

// ── shards/{NNNN}.json 取得（該当shardのみダウンロード。TTLは popup 設定に従う）──
// shard番号は index 側から既に得られているため、ここでの再ハッシュは不要。
async function _getGithubShard(shardId, ttlMs) {
  const cached = await _getShardCache(shardId);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.data;

  // 1024バケットとはいえ100件同時表示では同一shardに複数RJが乗ることがあるため、
  // ここでも同時fetchを1本化する。
  if (_shardInflight.has(shardId)) return _shardInflight.get(shardId);

  const promise = (async () => {
    const path = `shards/${String(shardId).padStart(4, "0")}.json`;
    const data = await _fetchJSON(`${_GITHUB_RAW_BASE}${path}`);
    if (data) {
      await _saveShardCache(shardId, data);
      return data;
    }
    return cached?.data ?? null;
  })();
  _shardInflight.set(shardId, promise);
  try {
    return await promise;
  } finally {
    _shardInflight.delete(shardId);
  }
}

// ── shard内の圧縮スキーマ → content.js が期待する dlwatcher互換の入れ子形式に変換 ──
// content.js の calcScore()/checkPriceAlert() はそれぞれ
//   data.currentPrice.price / data.currentPrice.regularPrice
//   data.lowestPrice.priceInfo.price
//   data.discountDaysOfLastYear
//   data.recentSalePriceLog
// を参照する前提で書かれているため、ここで変換して content.js 側は無改修のまま動かす。
function _adaptShardEntry(e) {
  if (!e || typeof e !== "object") return null;

  const toNum = (v, fallback) => (typeof v === "number" && Number.isFinite(v)) ? v : fallback;

  const regular = toNum(e.p, 0);
  const current = toNum(e.s, regular);
  const lowest  = toNum(e.lp, regular);
  const dd      = Math.max(0, Math.min(365, toNum(e.dd, 0)));
  // 配列でない/巨大な配列は無視（共有DBが乗っ取られた場合のメモリDoS対策として長さも制限）
  const lg = Array.isArray(e.lg)
    ? e.lg.filter(v => typeof v === "number" && Number.isFinite(v)).slice(0, 100)
    : [];

  return {
    currentPrice:            { price: current, regularPrice: regular },
    lowestPrice:              { priceInfo: { price: lowest } },
    discountDaysOfLastYear:   dd,
    recentSalePriceLog:       lg,
  };
}

// ── GitHub raw（manifest → index → shard）から該当RJのスコアデータを取得 ──
async function _fetchFromGithub(rj, ttlMs) {
  const RJ = rj.toUpperCase();

  const manifest = await _getGithubManifest();
  if (!manifest) return null;

  const index = await _getGithubIndex(manifest, RJ);
  if (!index || !(RJ in index)) return null; // 未収録のRJ

  const shardId = index[RJ];
  if (!Number.isInteger(shardId) || shardId < 0) return null; // index側の値が不正な場合は安全側に倒す

  const shard = await _getGithubShard(shardId, ttlMs);
  if (!shard || !shard[RJ]) return null;

  return _adaptShardEntry(shard[RJ]); // 不正な形のエントリなら内部で null を返す（呼び出し元は null を「未収録」と同様に扱う）
}

// ── 期限切れローカルキャッシュの定期クリーンアップ（ネットワークアクセスなし）──
const _CLEANUP_ALARM = "dlscore_cache_cleanup";
chrome.alarms.create(_CLEANUP_ALARM, { delayInMinutes: 30, periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== _CLEANUP_ALARM) return;
  try {
    const ttl = await _getScoreTtlMs();
    const db  = await _openDB();
    const now = Date.now();

    const tx  = db.transaction(["scores", "ghShards"], "readwrite");
    const scoresReq = tx.objectStore("scores").openCursor();
    scoresReq.onsuccess = () => {
      const cursor = scoresReq.result;
      if (!cursor) return;
      if (now - (cursor.value?.fetchedAt ?? 0) > ttl) cursor.delete();
      cursor.continue();
    };
    const shardReq = tx.objectStore("ghShards").openCursor();
    shardReq.onsuccess = () => {
      const cursor = shardReq.result;
      if (!cursor) return;
      if (now - (cursor.value?.fetchedAt ?? 0) > ttl) cursor.delete();
      cursor.continue();
    };
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
  } catch {}
});

// ── クローラータブ管理（総集編マーク機能。スコア取得とは無関係）──
let _crawlerTabId = null;

async function _reconcileCrawlerTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("crawler_tab.html") });
    if (tabs.length === 0) {
      _crawlerTabId = null;
      const res = await chrome.storage.local.get({ [_PROG_KEY]: null });
      if (res[_PROG_KEY]?.running) {
        await chrome.storage.local.set({ [_PROG_KEY]: { running: false, phase: "停止（再開可能）" } });
      }
      return;
    }
    // 過去のSW再起動バグ等で複数タブが増殖していた場合は最初の1つだけを残し、
    // 残りは閉じてブラウザの負荷を軽減する。
    _crawlerTabId = tabs[0].id;
    if (tabs.length > 1) {
      try { await chrome.tabs.remove(tabs.slice(1).map(t => t.id)); } catch {}
    }
  } catch { /* ignore */ }
}

_reconcileCrawlerTabs();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== _crawlerTabId) return;
  _crawlerTabId = null;
  chrome.storage.local.get({ [_PROG_KEY]: null }, (res) => {
    if (res[_PROG_KEY]?.running) {
      chrome.storage.local.set({ [_PROG_KEY]: { running: false, phase: "停止（タブを閉じました）" } });
    }
  });
});

// ── メッセージハンドラ ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── 総集編クローラー: タブを開いて実行 ──
  if (msg.type === "FETCH_COMPILATION") {
    (async () => {
      // _crawlerTabId は SW 再起動で失われている可能性があるため、都度実タブで確認する
      await _reconcileCrawlerTabs();
      if (_crawlerTabId !== null) {
        sendResponse({ ok: false, reason: "already_running" });
        return;
      }
      const mode = msg.mode === "resume" ? "resume" : "crawl";
      await chrome.storage.local.set({ dlsite_crawler_mode: mode });
      chrome.tabs.create(
        { url: chrome.runtime.getURL("crawler_tab.html"), active: false },
        (tab) => {
          if (chrome.runtime.lastError) {
            chrome.storage.local.remove("dlsite_crawler_mode");
            sendResponse({ ok: false, reason: "tab_open_failed" });
            return;
          }
          _crawlerTabId = tab.id;
          sendResponse({ ok: true, started: true });
        }
      );
    })();
    return true;
  }

  // ── 総集編クローラー: 停止 ──
  if (msg.type === "STOP_COMPILATION") {
    if (_crawlerTabId !== null) {
      chrome.tabs.sendMessage(_crawlerTabId, { type: "STOP_CRAWLER_TAB" }, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ ok: true });
  }

  // ── crawler_tab.js からの完了通知 ──
  if (msg.type === "CRAWLER_DONE") {
    _crawlerTabId = null;
  }

  // ── スコアDBのみリセット（IndexedDB scores を全削除） ──
  if (msg.type === "CLEAR_SCORE_DB") {
    (async () => {
      try {
        _scoreWriter.clear(); _shardWriter.clear(); // flush待ちキューの取りこぼし書き戻しを防止
        const db = await _openDB();
        await new Promise((r, j) => {
          const tx = db.transaction(["scores", "ghShards"], "readwrite");
          tx.objectStore("scores").clear();
          tx.objectStore("ghShards").clear();
          tx.oncomplete = r; tx.onerror = j;
        });
        _idb = null;
        await new Promise(r => chrome.storage.local.remove(["_ghManifestCache", "_ghIndexCache"], r));
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, err: String(e) }); }
    })();
    return true;
  }

  // ── 総集編データ全初期化 ──
  if (msg.type === "CLEAR_ALL_DATA") {
    const storageKeys = [
      "dlsite_compilations_v1",
      "dlsite_comp_works_v1",
      "dlsite_processed_comps_v1",
      "dlsite_crawl_state",
      "dlsite_comp_progress",
      "dlsite_comp_pending_v1",
      "_ghManifestCache",
      "_ghIndexCache",
    ];
    (async () => {
      try {
        _scoreWriter.clear(); _shardWriter.clear(); // flush待ちキューの取りこぼし書き戻しを防止
        await new Promise(r => chrome.storage.local.remove(storageKeys, r));
        const db = await _openDB();
        await new Promise((r, j) => {
          const tx = db.transaction(["scores", "items", "ghShards"], "readwrite");
          tx.objectStore("scores").clear();
          tx.objectStore("items").clear();
          tx.objectStore("ghShards").clear();
          tx.oncomplete = r; tx.onerror = j;
        });
        _idb = null;
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, err: String(e) }); }
    })();
    return true;
  }

  // ── 要確認候補（低信頼度推定）の承認: pendingから消してcompilationsに確定登録 ──
  if (msg.type === "APPROVE_PENDING") {
    (async () => {
      try {
        const r = await chrome.storage.local.get({ [_COMP_PENDING_KEY]: [], [_COMP_KEY]: [] });
        const pending = r[_COMP_PENDING_KEY].filter(e => !(e.rj === msg.rj && e.compRj === msg.compRj));
        const confirmed = [...new Set([...r[_COMP_KEY], msg.rj])].sort();
        await new Promise(res => chrome.storage.local.set(
          { [_COMP_PENDING_KEY]: pending, [_COMP_KEY]: confirmed }, res));
        sendResponse({ ok: true, pendingCount: pending.length });
      } catch (e) { sendResponse({ ok: false, err: String(e) }); }
    })();
    return true;
  }

  // ── 要確認候補の却下: pendingから消すだけ（confirmed化しない） ──
  if (msg.type === "REJECT_PENDING") {
    (async () => {
      try {
        const r = await chrome.storage.local.get({ [_COMP_PENDING_KEY]: [] });
        const pending = r[_COMP_PENDING_KEY].filter(e => !(e.rj === msg.rj && e.compRj === msg.compRj));
        await new Promise(res => chrome.storage.local.set({ [_COMP_PENDING_KEY]: pending }, res));
        sendResponse({ ok: true, pendingCount: pending.length });
      } catch (e) { sendResponse({ ok: false, err: String(e) }); }
    })();
    return true;
  }

  // ── AI レビュー生成（Groq 無料プラン）──
  if (msg.type === "GENERATE_REVIEW") {
    chrome.storage.local.get({ groqApiKey: "" }, ({ groqApiKey }) => {
      if (!groqApiKey) {
        sendResponse({ ok: false, err: "Groq APIキーが未設定です。console.groq.com で無料取得してポップアップに入力してください。" });
        return;
      }

      const styleSystems = {
        "煽情的": `あなたは成人向け作品の紹介文を書く書き手です。
以下の手本と同じ文体・密度・温度感で書いてください。

【手本①：従順系・耳元囁き】
耳の奥まで届き、鼓膜を揺らす柔らかい声。名前を呼ばれるたびに、筋肉から力がじわりと解けて、何も考えられなくなる。
「いい子にしてたら、もっと気持ちよくしてあげる」——その言葉の意味を、体が先に理解していた。
止めどもない快楽から逃れようとしても、本能的な欲求には逆らえない。

【手本②：支配・緊張感】
逃げ場はない。それをわかった上で、なお、とどまることしかできない。
触れるか触れないかの距離で止まり、返事を待つ。沈黙が、長く重くのしかかる。
恐怖や興奮、いろいろな感情が混ざり合って、混乱したからだは、息の仕方を忘れたまま、頷いた。
その瞬間、自分が何者で誰に使えるかを能動的に理解した。

【手本③：甘い堕落・中毒性】
事が済んで、日の出が出てくると、もう引き返せないと思った。まるで自分の尊厳が犯されたような気分だ。知性を失って獣のようになってから、記憶があいまいだ。
蜘蛛の巣のように、官能的で、甘くふしだらで粘着質な余韻が心に残っている。あぁ、きっと自分の人生は奴に壊されてしまう。
きっと飽きたら捨ててしまうだろうに、一度知ってしまったら戻れない——昨晩の快楽を、何を代償にしても失いたくない。

【守ること】
- 手本と同じ密度・温度感・余韻で、作品のシチュエーション・関係性・キャラクターに合わせて書く。勝手に物語を偽装しないこと。
- 聴覚（声・吐息・囁き）と触覚（熱・重さ・柔らかさ・距離感）を中心に描写する
- 全部言い切らず「この先」を想像させる焦らしと余白を必ず入れる
- 購買促進ワードは使わない。絵文字は文末に1〜2個のみ`,

        "丁寧": `あなたは誠実な同人作品レビュアーです。
作品の内容・雰囲気・技術的な特徴を正確に、読み手が「どんな体験か」を一読でイメージできるように伝えてください。
敬体（〜です・〜ます）で統一し、冗長にならず、一文一文に情報密度を持たせること。
絵文字は文意を補う場合のみ1〜2個まで。`,

        "ゆるい": `あなたはDLsiteをよく知るオタク仲間で、Xのポストに書くような感覚で感想を綴ります。
「〜だった」「〜なんだよね」「〜が刺さる」など自然な口語体で、テンションは高すぎず低すぎず。
良かった点を具体的に挙げつつ、読んだ人が「ちょっと気になる」と感じる余白を残すこと。
絵文字は自然に2〜3個まで。`,

        "評論家": `あなたは成人向けコンテンツを専門とする批評家です。
作品の構造・ジャンル的文脈・表現の達成度を鋭く言語化し、読み手に「この作品の本質」を伝えてください。
体言止め・倒置法・対比など文学的な表現技法を積極的に使い、格調と鋭さを両立させること。
絵文字は原則不要だが、強調として文末に1個だけ許容。`,
      };

      const systemPrompt = (styleSystems[msg.style] || styleSystems["煽情的"]) + `

共通ルール（必ず守ること）:
- 出力は本文のみ。タイトル・見出し・「以下に」等の前置き・引用符は一切つけない
- 「ぜひ」「おすすめ」「購入」「買って」「手に入れて」「お見逃しなく」など購買を促す言葉は絶対に使わない
- あらすじ・レビュー・仕様の情報を実際に反映させ、作品固有の具体性を持たせる。情報がない場合はジャンルから想像して補うことは決してしないこと。
- 文字数は150〜200字`;

      const infoLines = [
        "【作品情報】",
        "タイトル: " + msg.title,
        "サークル: " + (msg.circle || "不明"),
        "ジャンル: " + (msg.genres || "不明"),
        "価格: "    + (msg.price  || "不明"),
        msg.score != null ? "バイヤースコア: " + msg.score + "点" : null,
      ];
      if (msg.synopsis) infoLines.push("", "【あらすじ・紹介文】", msg.synopsis);
      if (msg.reviews?.length > 0) {
        infoLines.push("", "【ユーザーレビュー抜粋】");
        msg.reviews.forEach((r, i) => infoLines.push((i + 1) + ". " + r));
      }
      if (msg.specs && Object.keys(msg.specs).length > 0) {
        const specStr = Object.entries(msg.specs).slice(0, 5).map(([k, v]) => k + ": " + v).join(" / ");
        infoLines.push("", "【仕様】", specStr);
      }
      infoLines.push("", "上記をもとに紹介文を書いてください。");
      const userPrompt = infoLines.filter(v => v !== null).join("\n");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqApiKey },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 300,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userPrompt },
          ],
        }),
        signal: controller.signal,
      })
        .then(res => {
          if (!res.ok) return res.json().then(e => { throw new Error(e.error?.message || "HTTP " + res.status); });
          return res.json();
        })
        .then(data => { clearTimeout(timer); sendResponse({ ok: true, text: (data.choices?.[0]?.message?.content ?? "").trim() }); })
        .catch(err  => { clearTimeout(timer); sendResponse({ ok: false, err: String(err) }); });
    });
    return true;
  }

  // ── 価格データ取得 ──
  // ★方針転換: 拡張は GitHub raw の共有DBを「拾うだけ」。dlwatcher.com への直接アクセスは行わない。
  // 優先順位: ① IndexedDB キャッシュ(TTLは popup 設定に従う) → ② GitHub raw 共有DB
  // ②でも見つからない場合（Actions未収録のRJ）は、古いキャッシュがあれば使い回し、無ければ失敗を返す。
  if (msg.type === "FETCH") {
    (async () => {
      const ttlMs  = await _getScoreTtlMs();
      const cached = await _getScore(msg.rj);
      if (cached && Date.now() - cached.fetchedAt < ttlMs) {
        sendResponse({ ok: true, data: cached.data });
        return;
      }

      const ghData = await _fetchFromGithub(msg.rj, ttlMs);
      if (ghData) {
        await _saveScore(msg.rj, ghData);
        sendResponse({ ok: true, data: ghData });
        return;
      }

      if (cached) {
        sendResponse({ ok: true, data: cached.data, stale: true });
      } else {
        sendResponse({ ok: false, err: "not_found_in_shared_db" });
      }
    })();
    return true;
  }
});
