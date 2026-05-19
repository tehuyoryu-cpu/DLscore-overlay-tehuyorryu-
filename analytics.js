// analytics.js

const GENRE_HIST_KEY = "dlsite_genre_hist_v1";

const CHART_COLORS = [
  "#7c6dfa","#22d472","#f5a623","#f04060","#4a9eff",
  "#c084fc","#34d399","#fb923c","#f472b6","#60a5fa",
  "#a78bfa","#86efac","#fcd34d","#fca5a5","#93c5fd",
];

// 期間定義
const PERIODS = [
  { key: "day",      label: "今日" },
  { key: "month",    label: "1ヶ月" },
  { key: "3months",  label: "3ヶ月" },
  { key: "6months",  label: "半年" },
  { key: "year",     label: "1年" },
  { key: "all",      label: "全て" },
];
const PERIOD_MS = {
  day:     86_400_000,
  month:   30 * 86_400_000,
  "3months": 90 * 86_400_000,
  "6months": 180 * 86_400_000,
  year:    365 * 86_400_000,
  all:     Infinity,
};

let _currentPeriod = "all";
let _chartType     = "pie";  // "pie" | "bar"
let _fullHist      = {};

// ── 期間フィルタ ──
function filterByPeriod(hist, period) {
  if (period === "all") return hist;
  const cutoff = Date.now() - PERIOD_MS[period];
  return Object.fromEntries(
    Object.entries(hist).filter(([, v]) => (v.viewedAt || 0) >= cutoff)
  );
}

// ── タブ切り替え ──
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
  });
});

// ── ジャンル集計 ──
function buildGenreStats(hist) {
  const freq = new Map();
  for (const [, entry] of Object.entries(hist)) {
    for (const genre of (entry.genres || [])) {
      if (!freq.has(genre)) freq.set(genre, { count: 0, scoreSum: 0 });
      const g = freq.get(genre);
      g.count++;
      g.scoreSum += entry.score || 0;
    }
  }
  return [...freq.entries()]
    .map(([genre, { count, scoreSum }]) => ({
      genre, count,
      avgScore: count > 0 ? Math.round(scoreSum / count) : 0,
      weight:   count * (scoreSum / count || 50),
    }))
    .sort((a, b) => b.weight - a.weight);
}

// ── Canvas 円グラフ ──
function drawPieChart(canvas, slices) {
  const size = canvas.width;
  const ctx  = canvas.getContext("2d");
  const cx = size / 2, cy = size / 2, r = size / 2 - 8;
  ctx.clearRect(0, 0, size, size);
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) return;
  let angle = -Math.PI / 2;
  for (const { value, color } of slices) {
    const sweep = (value / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = "#080810"; ctx.lineWidth = 2; ctx.stroke();
    angle += sweep;
  }
  // ドーナツ穴
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = "#141422"; ctx.fill();
}

// ── 棒グラフ（SVG）──
function buildBarChart(slices, totalCount) {
  if (!slices.length) return "";
  const maxVal = Math.max(...slices.map(s => s.value));
  const rows = slices.map(({ value, color, label }) => {
    const pct  = Math.round(value / totalCount * 100);
    const barW = Math.round(value / maxVal * 100);
    return `<div class="bar-row">
      <div class="bar-label">${label}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${barW}%;background:${color}"></div>
      </div>
      <div class="bar-val">${pct}% <span class="bar-cnt">${value}</span></div>
    </div>`;
  }).join("");
  return `<div class="bar-chart">${rows}</div>`;
}

// ── グラフパネル描画 ──
function renderGraph(hist) {
  const el    = document.getElementById("graph-content");
  const works = Object.entries(hist);

  if (works.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">📊</div>まだデータがありません
      <div class="empty-hint">DLsiteの作品詳細ページを開くと自動的に記録されます</div>
    </div>`;
    return;
  }

  const stats     = buildGenreStats(hist);
  const topGenres = stats.slice(0, 14);
  const otherCnt  = stats.slice(14).reduce((s, x) => s + x.count, 0);
  const totalViews = works.length;
  const avgScore   = works.length
    ? Math.round(works.reduce((s, [, v]) => s + (v.score || 0), 0) / works.length)
    : 0;
  const topGenre   = topGenres[0]?.genre || "—";
  const totalGenreCnt = topGenres.reduce((s, g) => s + g.count, 0) + otherCnt;

  const slices = [
    ...topGenres.map((g, i) => ({ value: g.count, color: CHART_COLORS[i % CHART_COLORS.length], label: g.genre })),
    ...(otherCnt > 0 ? [{ value: otherCnt, color: "#262640", label: "その他" }] : []),
  ];

  // 期間ボタン生成
  const periodBtns = PERIODS.map(p =>
    `<button class="period-btn${p.key === _currentPeriod ? " active" : ""}" data-period="${p.key}">${p.label}</button>`
  ).join("");

  // グラフ部分
  const chartSection = _chartType === "pie"
    ? `<div class="chart-wrap">
        <div class="chart-title">性癖グラフ</div>
        <canvas id="pieCanvas" width="200" height="200"></canvas>
       </div>`
    : `<div class="chart-wrap bar-wrap">
        <div class="chart-title">ジャンル分布</div>
        ${buildBarChart(slices, totalGenreCnt)}
       </div>`;

  el.innerHTML = `
    <div class="graph-controls">
      <div class="period-btns">${periodBtns}</div>
      <button class="chart-toggle" id="chartToggle">${_chartType === "pie" ? "📊 棒グラフ" : "🥧 円グラフ"}</button>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-lbl">閲覧作品数</div>
        <div class="stat-val">${totalViews}</div>
        <div class="stat-unit">作品</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">平均スコア</div>
        <div class="stat-val">${avgScore}</div>
        <div class="stat-unit">点</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">最多ジャンル</div>
        <div class="stat-val" style="font-size:16px;padding-top:4px">${topGenre}</div>
        <div class="stat-unit">${topGenres[0]?.count || 0} 作品</div>
      </div>
    </div>

    <div class="chart-section">
      ${chartSection}
      <div class="chart-wrap" style="padding:16px">
        <div class="chart-title">ジャンル内訳</div>
        <div class="legend" id="legendContainer"></div>
      </div>
    </div>
  `;

  // 円グラフ描画
  if (_chartType === "pie") {
    drawPieChart(document.getElementById("pieCanvas"), slices);
  }

  // 凡例
  const legendEl = document.getElementById("legendContainer");
  topGenres.forEach((g, i) => {
    const pct = Math.round(g.count / totalGenreCnt * 100);
    legendEl.innerHTML += `<div class="legend-item">
      <div class="legend-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></div>
      <div class="legend-name">${g.genre}</div>
      <div class="legend-pct">${pct}%</div>
      <div class="legend-count">${g.count}</div>
    </div>`;
  });
  if (otherCnt > 0) {
    const pct = Math.round(otherCnt / totalGenreCnt * 100);
    legendEl.innerHTML += `<div class="legend-item">
      <div class="legend-dot" style="background:#262640"></div>
      <div class="legend-name">その他</div>
      <div class="legend-pct">${pct}%</div>
      <div class="legend-count">${otherCnt}</div>
    </div>`;
  }

  // 期間ボタンのイベント
  el.querySelectorAll(".period-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _currentPeriod = btn.dataset.period;
      renderGraph(filterByPeriod(_fullHist, _currentPeriod));
    });
  });

  // グラフ切り替えボタン
  document.getElementById("chartToggle")?.addEventListener("click", () => {
    _chartType = _chartType === "pie" ? "bar" : "pie";
    renderGraph(filterByPeriod(_fullHist, _currentPeriod));
  });
}

// ── おすすめパネル描画 ──
function renderRecommendations(hist) {
  const el    = document.getElementById("rec-content");
  const works = Object.entries(hist);

  if (works.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">🔍</div>まだデータがありません
      <div class="empty-hint">DLsiteの作品詳細ページを開くと自動的に記録されます</div>
    </div>`;
    return;
  }

  const topWorks = works
    .filter(([, v]) => v.score >= 60)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
    .slice(0, 30);

  const stats     = buildGenreStats(hist);
  const topGenres = stats.slice(0, 8);

  let html = `<div class="section-title">高評価だった作品</div>`;

  if (topWorks.length === 0) {
    html += `<div class="empty" style="padding:30px 0">スコア60以上の作品がまだありません</div>`;
  } else {
    html += `<div class="work-grid">`;
    for (const [rj, entry] of topWorks) {
      const score     = entry.score || 0;
      const color     = score >= 75 ? "#22d472" : score >= 50 ? "#f5a623" : "#f04060";
      const dlsiteUrl = `https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`;
      const genres    = (entry.genres || []).slice(0, 3)
        .map(g => `<span class="genre-tag">${g}</span>`).join("");
      html += `<a class="work-card" href="${dlsiteUrl}" target="_blank">
        <div class="work-rj">${rj}</div>
        <div class="work-title">${entry.title || rj}</div>
        <div class="work-circle">${entry.circle || ""}</div>
        <div class="work-footer">
          <div class="work-score" style="color:${color};background:${color}1a">${score}</div>
          <div class="work-genres">${genres}</div>
        </div>
      </a>`;
    }
    html += `</div>`;
  }

  if (topGenres.length > 0) {
    html += `<div class="search-links">
      <div class="search-links-title">好みジャンルで探す</div>
      <div class="link-list">`;
    for (const g of topGenres) {
      const q   = encodeURIComponent(g.genre);
      const url = `https://www.dlsite.com/maniax/fsr/=/keyword_creater/${q}/show_type/1`;
      html += `<a class="genre-link" href="${url}" target="_blank">${g.genre} (${g.count})</a>`;
    }
    html += `</div></div>`;
  }

  el.innerHTML = html;
}

// ── 初期化 ──
chrome.storage.local.get({ [GENRE_HIST_KEY]: {} }, res => {
  _fullHist = res[GENRE_HIST_KEY] || {};
  renderGraph(filterByPeriod(_fullHist, _currentPeriod));
  renderRecommendations(_fullHist);
});
