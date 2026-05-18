// parser_patch.js
// 修正: /g フラグ付き正規表現をモジュールスコープに置くと test() で lastIndex が
//       進み、次回呼び出し時にマッチしなくなるバグを修正。
//       → 都度新しいRegExpインスタンスを返すファクトリ関数に変更。

function rjRe() { return /RJ\d+/gi; }

export function parseRJ(html) {
  if (!rjRe().test(html)) {
    return null;
  }

  const bodyTop = html.slice(0, 4000);

  const topRJs = [...bodyTop.matchAll(rjRe())]
    .map(v => v[0].toUpperCase());

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const title = doc.title || "";

  const titleRJs = [...title.matchAll(rjRe())]
    .map(v => v[0].toUpperCase());

  const allRJs = [...html.matchAll(rjRe())]
    .map(v => v[0].toUpperCase());

  const rj = titleRJs[0] || topRJs[0] || allRJs[0];

  if (!rj) return null;

  const circle =
    title.match(/【(.*?)】/)?.[1]?.trim() ||
    doc.querySelector(".maker_name")?.textContent?.trim() ||
    doc.querySelector("a[href*='maker_id']")?.textContent?.trim() ||
    "unknown";

  return {
    rj,
    circle,
    relations: allRJs.filter(v => v !== rj),
  };
}
