// analytics.js

const GENRE_HIST_KEY = "dlsite_genre_hist_v1";

const CHART_COLORS = [
  "#7c6dfa","#22d472","#f5a623","#f04060","#4a9eff",
  "#c084fc","#34d399","#fb923c","#f472b6","#60a5fa",
  "#a78bfa","#86efac","#fcd34d","#fca5a5","#93c5fd",
];

// タブ切り替え
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
  const freq   = new Map(); // genre → { count, scoreSum }
  const works  = Object.entries(hist);

  for (const [rj, entry] of works) {
    for (const genre of (entry.genres || [])) {
      if (!freq.has(genre)) freq.set(genre, { count: 0, scoreSum: 0 });
      const g = freq.get(genre);
      g.count++;
      g.scoreSum += entry.score || 0;
    }
  }

  // スコア重み付き頻度でソート（count * avgScore）
  return [...freq.entries()]
    .map(([genre, { count, scoreSum }]) => ({
      genre,
      count,
      avgScore: count > 0 ? Math.round(scoreSum / count) : 0,
      weight:   count * (scoreSum / count || 50),
    }))
    .sort((a, b) => b.weight - a.weight);
}

// ── Canvas 円グラフ ──
function drawPieChart(canvas, slices) {
  const size = canvas.width;
  const ctx  = canvas.getContext("2d");
  const cx   = size / 2;
  const cy   = size / 2;
  const r    = size / 2 - 8;

  ctx.clearRect(0, 0, size, size);

  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return;

  let angle = -Math.PI / 2;
  slices.forEach(({ value, color }) => {
    const sweep = (value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // 細い境界線
    ctx.strokeStyle = "#080810";
    ctx.lineWidth = 2;
    ctx.stroke();
    angle += sweep;
  });

  // 中央の抜き円（ドーナツ）
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = "#141422";
  ctx.fill();
}

// ── グラフパネル描画 ──
function renderGraph(hist) {
  const el    = document.getElementById("graph-content");
  const works = Object.entries(hist);

  if (works.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">📊</div>
      まだデータがありません
      <div class="empty-hint">DLsiteの作品詳細ページを開くと自動的に記録されます</div>
    </div>`;
    return;
  }

  const stats      = buildGenreStats(hist);
  const topGenres  = stats.slice(0, 14);
  const otherCount = stats.slice(14).reduce((s, x) => s + x.count, 0);
  const totalViews = works.length;
  const avgScore   = Math.round(works.reduce((s, [, v]) => s + (v.score || 0), 0) / works.length);
  const topGenre   = topGenres[0]?.genre || "—";

  // 合計件数（重複ジャンルあり）
  const totalSlices = [...topGenres.map((g, i) => ({
    value: g.count,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }))];
  if (otherCount > 0) totalSlices.push({ value: otherCount, color: "#262640" });

  const totalGenreCount = topGenres.reduce((s, g) => s + g.count, 0) + otherCount;

  el.innerHTML = `
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
      <div class="chart-wrap">
        <div class="chart-title">性癖グラフ</div>
        <canvas id="pieCanvas" width="200" height="200"></canvas>
      </div>
      <div class="chart-wrap" style="padding:16px">
        <div class="chart-title">ジャンル内訳</div>
        <div class="legend" id="legendContainer"></div>
      </div>
    </div>
  `;

  // 円グラフ描画
  drawPieChart(document.getElementById("pieCanvas"), totalSlices);

  // 凡例
  const legendEl = document.getElementById("legendContainer");
  topGenres.forEach((g, i) => {
    const pct = Math.round(g.count / totalGenreCount * 100);
    legendEl.innerHTML += `
      <div class="legend-item">
        <div class="legend-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></div>
        <div class="legend-name">${g.genre}</div>
        <div class="legend-pct">${pct}%</div>
        <div class="legend-count">${g.count}</div>
      </div>`;
  });
  if (otherCount > 0) {
    const pct = Math.round(otherCount / totalGenreCount * 100);
    legendEl.innerHTML += `
      <div class="legend-item">
        <div class="legend-dot" style="background:#262640"></div>
        <div class="legend-name">その他</div>
        <div class="legend-pct">${pct}%</div>
        <div class="legend-count">${otherCount}</div>
      </div>`;
  }
}

// ── おすすめパネル描画 ──
function renderRecommendations(hist) {
  const el    = document.getElementById("rec-content");
  const works = Object.entries(hist);

  if (works.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">🔍</div>
      まだデータがありません
      <div class="empty-hint">DLsiteの作品詳細ページを開くと自動的に記録されます</div>
    </div>`;
    return;
  }

  // 高スコア作品（スコア降順、上位30件）
  const topWorks = works
    .filter(([, v]) => v.score >= 60)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
    .slice(0, 30);

  // 好みジャンル（上位8件）
  const stats      = buildGenreStats(hist);
  const topGenres  = stats.slice(0, 8);

  let html = `<div class="section-title">高評価だった作品</div>`;

  if (topWorks.length === 0) {
    html += `<div class="empty" style="padding:30px 0">
      スコア60以上の作品がまだありません
    </div>`;
  } else {
    html += `<div class="work-grid">`;
    for (const [rj, entry] of topWorks) {
      const score     = entry.score || 0;
      const color     = score >= 75 ? "#22d472" : score >= 50 ? "#f5a623" : "#f04060";
      const dlsiteUrl = `https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`;
      const genres    = (entry.genres || []).slice(0, 3)
        .map(g => `<span class="genre-tag">${g}</span>`).join("");
      html += `
        <a class="work-card" href="${dlsiteUrl}" target="_blank">
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

  // 好みジャンル検索リンク
  if (topGenres.length > 0) {
    html += `
      <div class="search-links">
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
  const hist = res[GENRE_HIST_KEY] || {};
  renderGraph(hist);
  renderRecommendations(hist);
});
