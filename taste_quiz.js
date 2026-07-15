// taste_quiz.js
// 「性癖を科学的に正確に診断する」ものではなく、遊び感覚の簡易傾向診断。
// 状況・心理を選ばせる設問形式（直接的に「○○が好きか」を聞かない）で、
// 6軸のスコアを集計しタイプ名 + DLsite関連タグ検索リンクを表示する。
// 完全ローカル処理（chrome.storage等への保存や外部送信は一切行わない）。

// ── 軸の定義 ──
const AXES = {
  dominant: {
    label: "包容力・リード",
    emoji: "🛡️",
    phrase: "相手を導いたり支えたりすることに充実感を覚えるタイプ。",
    tags: ["溺愛", "年上ボイス", "包容力", "独占欲"],
  },
  submissive: {
    label: "委ねる・甘え",
    emoji: "🍯",
    phrase: "身を委ねて甘えられる relationship に安心感を覚えるタイプ。",
    tags: ["甘やかし", "溺愛される", "年下ボイス", "ご主人様"],
  },
  comfort: {
    label: "安心感・日常",
    emoji: "🏠",
    phrase: "穏やかで信頼できる日常的な関係性を大切にするタイプ。",
    tags: ["日常もの", "同棲", "ほのぼの", "ASMR"],
  },
  thrill: {
    label: "刺激・スリル",
    emoji: "⚡",
    phrase: "予測できない展開やドキドキする状況に惹かれるタイプ。",
    tags: ["シチュエーションボイス", "背徳感", "秘密の関係"],
  },
  romance: {
    label: "ロマンス・特別感",
    emoji: "🌹",
    phrase: "特別な瞬間やロマンチックな演出に心を動かされるタイプ。",
    tags: ["純愛", "溺愛", "記念日ボイス", "プロポーズ"],
  },
  gap: {
    label: "ギャップ萌え",
    emoji: "✨",
    phrase: "普段とのギャップや意外な一面に強く惹かれるタイプ。",
    tags: ["ツンデレ", "ギャップ萌え", "本音吐露"],
  },
};

// ── 設問データ ──
// 各選択肢は axes への加点(weight)を持つ。1問1〜2軸に効かせて曖昧さを抑える。
const QUESTIONS = [
  {
    text: "魅力を感じる要素はどれですか？",
    options: [
      { label: "外見", w: { romance: 2 } },
      { label: "声", w: { gap: 1, thrill: 1 } },
      { label: "性格", w: { comfort: 2 } },
      { label: "ギャップ", w: { gap: 2 } },
      { label: "雰囲気", w: { comfort: 1, romance: 1 } },
    ],
  },
  {
    text: "恋愛で一番ドキッとする瞬間は？",
    options: [
      { label: "見つめられたとき", w: { romance: 2 } },
      { label: "手が触れたとき", w: { thrill: 2 } },
      { label: "甘えられたとき", w: { dominant: 2 } },
      { label: "頼られたとき", w: { dominant: 2 } },
      { label: "意外な一面を見たとき", w: { gap: 2 } },
    ],
  },
  {
    text: "理想の関係性に近いのは？",
    options: [
      { label: "対等", w: { comfort: 2 } },
      { label: "リードしたい", w: { dominant: 3 } },
      { label: "リードされたい", w: { submissive: 3 } },
      { label: "状況によって変わる", w: { gap: 2, thrill: 1 } },
    ],
  },
  {
    text: "どんなシチュエーションに魅力を感じますか？",
    options: [
      { label: "日常の自然な雰囲気", w: { comfort: 2 } },
      { label: "特別なイベント", w: { romance: 2 } },
      { label: "二人きりの静かな時間", w: { comfort: 1, romance: 1 } },
      { label: "スリルのある状況", w: { thrill: 3 } },
    ],
  },
  {
    text: "相手に一番求めるものは？",
    options: [
      { label: "安心感", w: { comfort: 2 } },
      { label: "尊敬", w: { dominant: 1, comfort: 1 } },
      { label: "刺激", w: { thrill: 2 } },
      { label: "信頼", w: { comfort: 2 } },
      { label: "ユーモア", w: { gap: 1, romance: 1 } },
    ],
  },
  {
    text: "口調で惹かれやすいのはどちらですか？",
    options: [
      { label: "低く落ち着いた声", w: { dominant: 2 } },
      { label: "柔らかく甘い声", w: { submissive: 2 } },
      { label: "はきはきした声", w: { thrill: 1, dominant: 1 } },
      { label: "囁くような小さな声", w: { thrill: 2, gap: 1 } },
    ],
  },
  {
    text: "デートの誘い方として好きなのは？",
    options: [
      { label: "「一緒に来て」と手を引かれる", w: { dominant: 2 } },
      { label: "「行きたい……」とねだられる", w: { submissive: 2 } },
      { label: "さりげなく自然に誘われる", w: { comfort: 2 } },
      { label: "サプライズで連れ出される", w: { romance: 2, thrill: 1 } },
    ],
  },
  {
    text: "距離が縮まる瞬間として好きなのは？",
    options: [
      { label: "弱音や本音を打ち明けられたとき", w: { gap: 2, comfort: 1 } },
      { label: "自分だけに見せる態度があるとき", w: { gap: 2 } },
      { label: "困っているところを助けたとき", w: { dominant: 2 } },
      { label: "助けてもらったとき", w: { submissive: 2 } },
    ],
  },
  {
    text: "二人の時間で心地よいのは？",
    options: [
      { label: "何気ない会話がずっと続く", w: { comfort: 3 } },
      { label: "沈黙すら心地よい緊張感", w: { thrill: 2 } },
      { label: "終始甘い雰囲気に包まれる", w: { romance: 3 } },
      { label: "予定を決めずその場のノリで動く", w: { thrill: 2, gap: 1 } },
    ],
  },
  {
    text: "呼ばれ方で嬉しいのは？",
    options: [
      { label: "名前を優しく呼ばれる", w: { comfort: 2, romance: 1 } },
      { label: "「お前」「君」など少し強め", w: { dominant: 2 } },
      { label: "甘えたニックネーム", w: { submissive: 2 } },
      { label: "普段と違う呼び方に不意打ちされる", w: { gap: 2 } },
    ],
  },
  {
    text: "相手が嫉妬したときの反応で好みなのは？",
    options: [
      { label: "素直に「寂しかった」と言う", w: { comfort: 2 } },
      { label: "「離さない」と独占欲を見せる", w: { dominant: 2, thrill: 1 } },
      { label: "拗ねて甘えてくる", w: { submissive: 2, gap: 1 } },
      { label: "冷静なふりして目が離せてない", w: { gap: 2 } },
    ],
  },
  {
    text: "記念日やイベントの過ごし方は？",
    options: [
      { label: "特にせず、いつも通り一緒に過ごす", w: { comfort: 3 } },
      { label: "サプライズをしっかり用意したい", w: { romance: 3 } },
      { label: "ちょっとした非日常を楽しみたい", w: { thrill: 2 } },
      { label: "相手に主導権を委ねたい", w: { submissive: 2 } },
    ],
  },
  {
    text: "喧嘩した後の仲直りで好きな展開は？",
    options: [
      { label: "冷静に話し合って理解し合う", w: { comfort: 3 } },
      { label: "相手が折れて甘えてくる", w: { dominant: 2 } },
      { label: "自分から素直に謝る", w: { submissive: 1, comfort: 1 } },
      { label: "気まずさごと甘い空気に持っていかれる", w: { romance: 2, thrill: 1 } },
    ],
  },
  {
    text: "理想のシチュエーションボイスのジャンルは？",
    options: [
      { label: "同棲・日常系", w: { comfort: 3 } },
      { label: "年上のお姉さん/お兄さん系", w: { dominant: 2 } },
      { label: "年下・甘えん坊系", w: { submissive: 2 } },
      { label: "ツンデレ・ギャップ系", w: { gap: 3 } },
    ],
  },
  {
    text: "「らしくない」姿を見せられたら？",
    options: [
      { label: "ますます信頼したくなる", w: { comfort: 2 } },
      { label: "庇護欲が湧く", w: { dominant: 2 } },
      { label: "ドキッとして目が離せない", w: { gap: 3 } },
      { label: "特別な相手だと実感する", w: { romance: 2 } },
    ],
  },
];

// ── 状態 ──
const answers = new Array(QUESTIONS.length).fill(null);

function renderQuestions() {
  const form = document.getElementById("quizForm");
  form.innerHTML = "";

  QUESTIONS.forEach((q, qi) => {
    const card = document.createElement("div");
    card.className = "q-card";

    const num = document.createElement("div");
    num.className = "q-num";
    num.textContent = `Q${qi + 1} / ${QUESTIONS.length}`;

    const text = document.createElement("div");
    text.className = "q-text";
    text.textContent = q.text;

    const list = document.createElement("div");
    list.className = "opt-list";

    q.options.forEach((opt, oi) => {
      const label = document.createElement("label");
      label.className = "opt";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = `q${qi}`;
      input.value = String(oi);

      input.addEventListener("change", () => {
        answers[qi] = oi;
        list.querySelectorAll(".opt").forEach(el => el.classList.remove("sel"));
        label.classList.add("sel");
        updateProgress();
      });

      const span = document.createElement("span");
      span.textContent = opt.label;

      label.appendChild(input);
      label.appendChild(span);
      list.appendChild(label);
    });

    card.appendChild(num);
    card.appendChild(text);
    card.appendChild(list);
    form.appendChild(card);
  });
}

function updateProgress() {
  const answered = answers.filter(a => a !== null).length;
  const pct = Math.round((answered / QUESTIONS.length) * 100);
  document.getElementById("progressFill").style.width = `${pct}%`;
  document.getElementById("submitBtn").disabled = answered < QUESTIONS.length;
}

function computeScores() {
  const raw = {};
  Object.keys(AXES).forEach(k => { raw[k] = 0; });

  QUESTIONS.forEach((q, qi) => {
    const oi = answers[qi];
    if (oi === null) return;
    const w = q.options[oi].w || {};
    Object.entries(w).forEach(([axis, val]) => {
      if (axis in raw) raw[axis] += val;
    });
  });

  const max = Math.max(1, ...Object.values(raw));
  const pct = {};
  Object.keys(raw).forEach(k => { pct[k] = Math.round((raw[k] / max) * 100); });
  return { raw, pct };
}

function buildTypeName(sortedAxes) {
  const [top1, top2] = sortedAxes;
  const a1 = AXES[top1[0]];
  const a2 = AXES[top2[0]];
  return `${a1.emoji}${a1.label} × ${a2.emoji}${a2.label}`;
}

function buildDescription(sortedAxes) {
  const [top1, top2] = sortedAxes;
  const a1 = AXES[top1[0]];
  const a2 = AXES[top2[0]];
  return `${a1.phrase} また、${a2.phrase.replace(/^/, "")}`;
}

function collectTags(sortedAxes) {
  const [top1, top2] = sortedAxes;
  const list = [...AXES[top1[0]].tags, ...AXES[top2[0]].tags];
  return [...new Set(list)].slice(0, 8);
}

function dlsiteSearchUrl(tag) {
  return `https://www.dlsite.com/maniax/fsr/=/language/jp/keyword/${encodeURIComponent(tag)}/order%5B0%5D/trend/show_type/1`;
}

function showResult() {
  const { pct } = computeScores();
  const sorted = Object.entries(pct).sort((a, b) => b[1] - a[1]);

  document.getElementById("resultType").textContent = buildTypeName(sorted);
  document.getElementById("resultDesc").textContent = buildDescription(sorted);

  const barsEl = document.getElementById("resultBars");
  barsEl.innerHTML = "";
  sorted.forEach(([axis, val]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label">${AXES[axis].emoji} ${AXES[axis].label}</div>
      <div class="bar-track"><div class="bar-fill" data-w="${val}"></div></div>
      <div class="bar-pct">${val}%</div>
    `;
    barsEl.appendChild(row);
  });
  // アニメーション用に次フレームで幅を反映
  requestAnimationFrame(() => {
    barsEl.querySelectorAll(".bar-fill").forEach(el => {
      el.style.width = `${el.dataset.w}%`;
    });
  });

  const tagsEl = document.getElementById("resultTags");
  tagsEl.innerHTML = "";
  collectTags(sorted).forEach(tag => {
    const a = document.createElement("a");
    a.className = "tag-pill";
    a.href = dlsiteSearchUrl(tag);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `#${tag}`;
    tagsEl.appendChild(a);
  });

  document.getElementById("quizForm").style.display = "none";
  document.getElementById("submitBtn").style.display = "none";
  document.getElementById("progressFill").parentElement.style.display = "none";
  document.getElementById("result").style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetQuiz() {
  answers.fill(null);
  document.getElementById("result").style.display = "none";
  document.getElementById("quizForm").style.display = "";
  document.getElementById("submitBtn").style.display = "";
  document.getElementById("submitBtn").disabled = true;
  document.getElementById("progressFill").parentElement.style.display = "";
  document.getElementById("progressFill").style.width = "0%";
  renderQuestions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("submitBtn").addEventListener("click", () => {
  if (answers.some(a => a === null)) return;
  showResult();
});
document.getElementById("retryBtn").addEventListener("click", resetQuiz);

renderQuestions();
