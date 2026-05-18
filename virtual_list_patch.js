// virtual_list_patch.js
// 修正: renderCount をモジュールグローバルに置いていたため、複数リストや
//       検索変更後のリセットが正しく機能しないバグを修正。
//       → インスタンス単位で状態を持つファクトリ関数に変更。
//
// 使い方:
//   const vl = createVirtualList(50);
//   vl.getVisible(list);   // 先頭 50 件
//   vl.showMore();         // +50 件追加
//   vl.reset();            // 検索変更時などにリセット

export function createVirtualList(pageSize = 50) {
  let count = pageSize;
  return {
    getVisible(list) { return list.slice(0, count); },
    showMore()       { count += pageSize; },
    reset()          { count = pageSize; },
  };
}
