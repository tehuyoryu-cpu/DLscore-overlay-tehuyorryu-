// db_patch.js
// 修正: else ブランチで `event` がスコープ外のため ReferenceError になるバグを修正。
//       → 呼び出し側から transaction を渡すシグネチャに変更。
//
// 呼び出し側 (db.js onupgradeneeded) の書き方:
//   req.onupgradeneeded = (event) => {
//     upgradeDB(req.result, event.oldVersion, event.target.transaction);
//   };

export const DB_VERSION = 2;

export function upgradeDB(database, oldVersion, transaction) {
  let store;

  if (oldVersion < 1) {
    store = database.createObjectStore("items", {
      keyPath: "url",
    });
  } else {
    // oldVersion >= 1 の場合は既存ストアをトランザクション経由で取得
    store = transaction.objectStore("items");
  }

  if (!store.indexNames.contains("rj")) {
    store.createIndex("rj", "rj", { unique: false });
  }

  if (!store.indexNames.contains("circle")) {
    store.createIndex("circle", "circle", { unique: false });
  }

  if (!store.indexNames.contains("savedAt")) {
    store.createIndex("savedAt", "savedAt", { unique: false });
  }
}
