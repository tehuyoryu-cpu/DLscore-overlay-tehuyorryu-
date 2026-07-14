# DLsite Score Overlay — 総集編クローラー構造解説（他AI向け）

対象リポジトリ: `tehuyoryu-cpu/DLscore-overlay-tehuyorryu-`（`AI` ブランチ）
関連別プロジェクト: `tehuyoryu-cpu/siteruns23432`（`data` ブランチ、価格スコアの共有DB。本クローラーとは別物）

## 0. 前提：2つの独立したデータ収集パイプライン

この拡張機能には**互いに独立した2種類のデータ収集**が存在する。混同しないこと。

1. **価格スコアDB**（dlwatcher.com 直接クロールは廃止済み）
   → 拡張機能側では収集しない。`siteruns23432` リポジトリ側の別プロジェクト（PC常駐アプリ）が
     DLsiteを巡回して価格を収集し、`manifest.json` / `index/NN.json` / `shards/NNNN.json` を
     1日1回 push する。拡張の `background.js` は `raw.githubusercontent.com` 経由で
     manifest→index(FNV-1aハッシュで対象shardを特定)→shard の順に**読むだけ**。
2. **総集編（コンピレーション）RJ検出クローラー**（本ドキュメントの主題）
   → こちらは拡張機能自身が `crawler_tab.js` で実行する。「総集編作品に何のRJが収録されているか」を
     特定し、一覧・詳細ページに「📦 総集編あり」バッジを出すためのRJリストを作る。

## 1. 起動フロー

- ポップアップ（`popup.js` の `initCompFetchBtn()`）→ `chrome.runtime.sendMessage({type:"FETCH_COMPILATION", mode})`
- `background.js` がバックグラウンドタブ（`crawler_tab.html`）を非表示で開く
  （`_crawlerTabId` で多重起動をガード。タブが閉じられたら `chrome.tabs.onRemoved` で状態を強制リセット）
- `crawler_tab.html` は `comp_analyzer.js` → `crawler_tab.js` の順で読み込み、
  IIFE の中で即座に `_crawl()` を実行する
- 完了/停止/エラー時は `chrome.runtime.sendMessage({type:"CRAWLER_DONE"})` を送り、
  `background.js` が `_crawlerTabId = null` に戻す。タブは1.5秒後に自動で `window.close()`

停止は `popup.js` の「■ 停止」→ `STOP_COMPILATION` → `background.js` が該当タブへ
`STOP_CRAWLER_TAB` を転送 → `crawler_tab.js` の `_running` フラグが `false` になり、
実行中の各 Phase が安全にループを抜けて `_saveState()` してから終了する（再開可能）。

## 2. crawler_tab.js の3フェーズパイプライン

`_crawl()` は Phase A → B → C を**順番に**実行する。各フェーズは
`_STATE_KEY`（`dlsite_crawl_state`）に進捗を保存するため、途中で停止しても
`mode:"resume"` で同じ状態から再開できる（`_loadState()` が読み出す）。

### Phase A — DLsite ジャンル515（総集編ジャンル）の一覧ページを巡回
- URL: `_DLSITE_FSR(page)` — `genre[0]/515` で総集編ジャンルの検索結果を100件/ページで取得
- `_extractListingRJs(html)` が `/product_id/(RJ\d+)\.html` にマッチするリンクから
  「総集編**作品自体**のRJ」を抽出 → `_COMP_WORKS_KEY`（`dlsite_comp_works_v1`）にマージ
- ページを1つずつインクリメントし、該当RJが0件になったら終了（`S.dlsiteDone = true`）
- **注意**: ここで集めるのは「総集編という商品のRJ」であり、後述の`_COMP_KEY`（収録作品側）とは別キー
  （過去バグ①: 混同して同じキーに入れていたのを分離修正済み）

### Phase B — 各総集編の詳細ページから「収録されている個別作品のRJ」を抽出
- 入力: Phase A で集めた `_COMP_WORKS_KEY`。処理済みは `_PROCESSED_KEY`（`dlsite_processed_comps_v1`）で管理し、
  未処理分だけを対象にする（差分実行・再開に対応）
- `_DETAIL_CONCUR = 3` 並列ワーカーで `_DLSITE_WORK(rj)`（作品詳細ページ）を取得
- `_extractDetailRJs(html, selfRJ)` の優先順位:
  1. DOMParserで「作品内容」「収録」等の見出しを含む `.work_parts` セクションを特定
  2. そのセクション内のテキストから `RJ\d+` を正規表現抽出 + `product_id` リンクからもRJを抽出
     （テキストにRJを書かず、リンクだけ貼るサークル対策）
  3. セクションが特定できない/0件なら `#work_outline` → `.work_parts_container` → `body` の順にフォールバック
  4. それでも0件（またはRJが自分自身しか無い）場合、ページ全体の `product_id` リンクを走査
  5. DOMParser自体が失敗したら正規表現で全文からRJ抽出（最終フォールバック）
- **上記で0件だった場合のみ** `_estimateFromCircle()` を呼び、`comp_analyzer.js` の
  `estimateContents()` に委譲（詳細は下記セクション3）
- 抽出結果 `contained`（RJ配列）は **その総集編1件専用のリスト**として
  IndexedDB（`rj_crawler_db` の `items` ストア、`{url, rjAll, savedAt}`）に保存
  （過去バグ②: 全体を1つの配列に混ぜていたのを per-item 保存に修正済み）
- `contained` が1件以上あれば `_COMP_KEY`（`dlsite_compilations_v1`、バッジ表示対象の実体）にマージ
- 20件ごとに進捗を `chrome.storage.local` に書き込み、ポップアップ側の `storage.onChanged` でリアルタイム表示

### Phase C — dldshare.net（有志まとめサイト）を補助ソースとして巡回
- DLsite本体からは検出できない総集編（リンクもRJも書かないサークル等）を
  外部の同人コンテンツまとめブログから拾う補助フェーズ
- Cフェーズ内も2段階: (1) タグ一覧ページをページネーションで全件巡回して記事URLを収集
  (2) 各記事本文から正規表現 `RJ\d+` で全RJを抽出し `_COMP_KEY` にマージ
- `_DLDS_CONCUR = 8` 並列。`_dldsHasNext(html)` が `rel="next"` の有無で次ページ判定

Phase C 完了後、`_clearState()` で再開用ステートを消去し、`_PROG_KEY` に
`{running:false, phase:"完了", rj:件数}` を書いて終了。

## 3. comp_analyzer.js — RJ/リンク非記載サークルへの推定エンジン

Phase B で総集編の詳細ページに収録作品のRJ/リンクが一切見つからなかった場合のみ呼ばれる、
**タイトル類似度＋メタデータスコアリング**によるフォールバック。`estimateContents(compRJ, html, ...)` が本体。

処理は2フェーズに分かれており、**API呼び出しコストを最小化する設計**になっている:

- **Phase 1（ノーコスト）**: 総集編のサークルID（`parseCompMeta()` で詳細ページから抽出）で
  そのサークルの検索結果ページ（最大5ページ）を巡回し、`parseCandidatesFromSearch()` で
  「RJ → タイトル」のMapを作る（追加APIコール不要、HTML取得のみ）
- **Phase 1.5（事前フィルタ、ノーコスト）**: 総集編タイトルと各候補タイトルの
  bigram類似度（`ngramSim()`）でスコアリングし、上位 `MAX_API = 30` 件だけを次段階へ絞り込む
- **Phase 2（コストあり、上位候補のみ）**: 絞り込んだ候補のみ DLsite の
  `product/info` JSON API（`INFO_URL`）を叩いて詳細メタ（ページ数・発売日・イベント・タグ・ジャンル）を取得し、
  `scoreCandidate()` でフルスコアリング:
  - タイトルの共通接頭辞・bigram類似度（上限100点、二重加点防止済み）
  - イベント一致（`normalizeEvent()` で「コミケ」「例大祭」等の表記ゆれを正規化辞書で統一）
  - 発売日の近さ（90日/180日/365日で加点、730日超で減点。日付不明はペナルティなし＝Infinity問題を修正済み）
  - タグ一致数、ページ数の妥当性
  - `genre.id === 515`（総集編ジャンル）の候補は「別の総集編」として除外
  - `THRESHOLD = 60` 以上のみ採用
  - 総集編のページ数が判明していれば `findPageSubset()` で「収録作品のページ数を足し合わせると
    総集編のページ数に近い組み合わせ」を部分和探索し、一致すれば追加加点（+80点）
- 最終的に上位 `workCount*2`（不明なら20件）に絞って RJ配列を返す

`CONCUR = 5` 並列、各API呼び出し間に120msのスリープを挟んでDLsiteへの負荷を抑えている。

## 4. background.js との役割分担（重要な誤解ポイント）

`background.js` の冒頭コメントにある通り、**クローラーのロジック自体はすべて `crawler_tab.js` に移管済み**。
`background.js` が担うのは:

1. クローラー用タブの開閉管理（多重起動防止・強制リセット）
2. 総集編クローラーとは無関係な `FETCH`（価格スコアDB取得、GitHub raw経由）
3. `GENERATE_REVIEW`（Groq API を使ったAIレビュー生成、これも総集編とは無関係）
4. `CLEAR_SCORE_DB` / `CLEAR_ALL_DATA`（IndexedDB・chrome.storageの初期化）

つまり `background.js` を読んで「ここに総集編クロールのロジックがあるはず」と探しても無駄で、
実体は必ず `crawler_tab.js`（発見フェーズ）と `comp_analyzer.js`（推定エンジン）にある。

## 5. ストレージキー一覧（総集編クローラー関連のみ）

| キー | 保存先 | 内容 |
|---|---|---|
| `dlsite_compilations_v1` | chrome.storage.local | バッジ表示対象の「収録作品RJ」全件（`content.js`/`popup.js`が参照） |
| `dlsite_comp_works_v1` | chrome.storage.local | Phase Aで見つけた「総集編作品自体のRJ」（Phase Bの入力専用） |
| `dlsite_processed_comps_v1` | chrome.storage.local | Phase B で処理済みの総集編RJ（差分実行用） |
| `dlsite_crawl_state` | chrome.storage.local | 再開用ステート（各フェーズのページ番号・URL一覧等） |
| `dlsite_comp_progress` | chrome.storage.local | リアルタイム進捗表示用（ポップアップがonChangedで監視） |
| `rj_crawler_db`（IndexedDB） | ブラウザIndexedDB | `items`ストア: 総集編ごとの収録RJ詳細（`{url, rjAll, savedAt}`） |

## 6. 変更・拡張時の注意点

- Phase A/B/C は互いに **入力キーが厳密に分離**されている（`_COMP_WORKS_KEY` vs `_COMP_KEY`）。
  混同すると「総集編作品自体」と「収録作品」が同じリストに混ざり、バッジが誤爆する（過去バグ①の再発）。
- Phase B の `items.push()` は必ず総集編1件ごとに独立した `rjAll` を持たせること
  （複数件をまとめて1つの配列にすると、後から個別総集編の収録内容を追跡できなくなる＝過去バグ②）。
- `comp_analyzer.js` の推定は最終手段。Phase Bで直接抽出できるケースを優先し、
  推定ロジックの呼び出し条件（`contained.length === 0` の場合のみ）を安易に緩めないこと
  （API呼び出しコストとDLsiteへの負荷が増える）。
- スコアDB（GitHub raw / siteruns23432）とは完全に別システムなので、
  「スコアが取得できない」系の不具合と「総集編バッジが出ない」系の不具合は
  調査すべきファイルが異なる（前者は `background.js` の `_GITHUB_*` 定数群、
  後者は `crawler_tab.js` / `comp_analyzer.js`）。
