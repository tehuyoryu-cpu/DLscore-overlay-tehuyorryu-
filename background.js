// background.js
// クローラーロジックは crawler_tab.js（専用タブ）に移管済み。
// ここではタブの開閉管理・AI レビュー・FETCH メッセージのみを担う。

// ── keepalive（MV3 サービスワーカーのスリープ防止）──
setInterval(() => {
  chrome.storage.local.get(null, () => { void chrome.runtime.lastError; });
}, 20_000);

// ── 定数 ──
const _PROG_KEY        = "dlsite_comp_progress";
const _COMP_KEY        = "dlsite_compilations_v1";
const _COMP_PENDING_KEY = "dlsite_comp_pending_v1";
const FETCH_TIMEOUT_MS = 15_000;
const _SCORE_TTL       = 6 * 60 * 60 * 1000;
const _REFRESH_ALARM   = "dlscore_score_refresh";

// ── bug③修正: SW 再起動時に残留「走査中」フラグをクリア ──
// _crawlerTabId は再起動で null にリセットされるが storage の running フラグは残る
chrome.storage.local.get({ [_PROG_KEY]: null }, (res) => {
  if (res[_PROG_KEY]?.running) {
    chrome.storage.local.set({ [_PROG_KEY]: { running: false, phase: "停止（再開可能）" } });
  }
});

// ── IndexedDB（crawler_tab.js と同じ DB・v2）──
let _idb = null;

function _openDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("rj_crawler_db", 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("items"))
        d.createObjectStore("items", { keyPath: "url" });
      if (!d.objectStoreNames.contains("scores"))
        d.createObjectStore("scores", { keyPath: "rj" });
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror   = () => reject(req.error);
  });
}

async function _getScore(rj) {
  try {
    const db = await _openDB();
    return await new Promise((resolve) => {
      const req = db.transaction("scores", "readonly")
                    .objectStore("scores").get(rj.toUpperCase());
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}

async function _saveScore(rj, data) {
  try {
    const db = await _openDB();
    const tx = db.transaction("scores", "readwrite");
    tx.objectStore("scores").put({ rj: rj.toUpperCase(), data, fetchedAt: Date.now() });
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = j; });
  } catch {}
}

// ── 定期スコア更新アラーム（6時間ごと）──
chrome.alarms.create(_REFRESH_ALARM, {
  delayInMinutes:  60,   // 初回は起動1時間後
  periodInMinutes: 360,  // 以降6時間ごと
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== _REFRESH_ALARM) return;
  if (_crawlerTabId !== null) return; // 既に走査中なら skip

  chrome.storage.local.get({ [_COMP_KEY]: [] }, (res) => {
    if (chrome.runtime.lastError || (res[_COMP_KEY] || []).length === 0) return;
    // 更新モードでタブを開く
    chrome.storage.local.set({ dlsite_crawler_mode: "refresh" }, () => {
      chrome.tabs.create(
        { url: chrome.runtime.getURL("crawler_tab.html"), active: false },
        (tab) => {
          if (chrome.runtime.lastError) {
            chrome.storage.local.remove("dlsite_crawler_mode");
            return;
          }
          _crawlerTabId = tab.id;
        }
      );
    });
  });
});

// ── クローラータブ管理 ──
let _crawlerTabId = null;

// タブが手動で閉じられた場合も確実に状態をリセット
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
    if (_crawlerTabId !== null) {
      sendResponse({ ok: false, reason: "already_running" });
      return;
    }
    // popup から受け取った mode（"crawl" / "resume"）を storage 経由でタブに渡す
    const mode = msg.mode === "resume" ? "resume" : "crawl";
    chrome.storage.local.set({ dlsite_crawler_mode: mode }, () => {
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
    });
    return true;
  }

  // ── 総集編クローラー: 停止 ──
  if (msg.type === "STOP_COMPILATION") {
    if (_crawlerTabId !== null) {
      // タブに停止シグナルを送る（タブが自分で後始末して閉じる）
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
        const db = await _openDB();
        await new Promise((r, j) => {
          const tx = db.transaction("scores", "readwrite");
          tx.objectStore("scores").clear();
          tx.oncomplete = r; tx.onerror = j;
        });
        _idb = null; // 次回 _openDB() で再接続
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, err: String(e) }); }
    })();
    return true;
  }

  // ── 総集編データ全初期化（RJリスト + 走査状態 + IndexedDB 全削除） ──
  if (msg.type === "CLEAR_ALL_DATA") {
    const storageKeys = [
      "dlsite_compilations_v1",
      "dlsite_comp_works_v1",
      "dlsite_processed_comps_v1",
      "dlsite_crawl_state",
      "dlsite_comp_progress",
      "dlsite_comp_pending_v1",
    ];
    (async () => {
      try {
        await new Promise(r => chrome.storage.local.remove(storageKeys, r));
        const db = await _openDB();
        await new Promise((r, j) => {
          const tx = db.transaction(["scores", "items"], "readwrite");
          tx.objectStore("scores").clear();
          tx.objectStore("items").clear();
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

  // ── 価格データ取得（IndexedDB → dlwatcher.com の順でキャッシュ優先）──
  if (msg.type === "FETCH") {
    (async () => {
      // IndexedDB に新鮮なキャッシュがあればそれを返す
      const cached = await _getScore(msg.rj);
      if (cached && Date.now() - cached.fetchedAt < _SCORE_TTL) {
        sendResponse({ ok: true, data: cached.data });
        return;
      }
      // なければ dlwatcher.com から取得してキャッシュに保存
      const url        = "https://dlwatcher.com/product/" + msg.rj + ".json";
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res  = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        clearTimeout(timer);
        await _saveScore(msg.rj, data); // IndexedDB に保存
        sendResponse({ ok: true, data });
      } catch (err) {
        clearTimeout(timer);
        sendResponse({ ok: false, err: String(err) });
      }
    })();
    return true;
  }
});
