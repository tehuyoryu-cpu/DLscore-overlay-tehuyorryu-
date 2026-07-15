// analytics.js

const GENRE_HIST_KEY = "dlsite_genre_hist_v1";

const CHART_COLORS = [
  "#7c6dfa","#22d472","#f5a623","#f04060","#4a9eff",
  "#c084fc","#34d399","#fb923c","#f472b6","#60a5fa",
  "#a78bfa","#86efac","#fcd34d","#fca5a5","#93c5fd",
];

const PERIODS = [
  { key:"day",     label:"今日"  },
  { key:"month",   label:"1ヶ月" },
  { key:"3months", label:"3ヶ月" },
  { key:"6months", label:"半年"  },
  { key:"year",    label:"1年"   },
  { key:"all",     label:"全て"  },
];
const PERIOD_MS = {
  day:86_400_000, month:30*86_400_000, "3months":90*86_400_000,
  "6months":180*86_400_000, year:365*86_400_000, all:Infinity,
};

let _currentPeriod = "all";
let _chartType     = "pie";
let _fullHist      = {};

function filterByPeriod(hist, period) {
  if (period === "all") return hist;
  const cutoff = Date.now() - PERIOD_MS[period];
  return Object.fromEntries(Object.entries(hist).filter(([,v])=>(v.viewedAt||0)>=cutoff));
}

// タブ切り替え
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.panel).classList.add("active");
  });
});

function buildGenreStats(hist) {
  const freq = new Map();
  for (const [,entry] of Object.entries(hist)) {
    for (const genre of (entry.genres||[])) {
      if (!freq.has(genre)) freq.set(genre,{count:0,scoreSum:0});
      const g=freq.get(genre); g.count++; g.scoreSum+=entry.score||0;
    }
  }
  return [...freq.entries()]
    .map(([genre,{count,scoreSum}])=>({
      genre, count,
      avgScore:count>0?Math.round(scoreSum/count):0,
      weight:count*(scoreSum/count||50),
    }))
    .sort((a,b)=>b.weight-a.weight);
}

// 円グラフ
function drawPieChart(canvas, slices) {
  const size=canvas.width, ctx=canvas.getContext("2d");
  const cx=size/2, cy=size/2, r=size/2-8;
  ctx.clearRect(0,0,size,size);
  const total=slices.reduce((s,x)=>s+x.value,0);
  if(!total) return;
  let angle=-Math.PI/2;
  for(const {value,color} of slices){
    const sweep=(value/total)*Math.PI*2;
    ctx.beginPath(); ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,angle,angle+sweep);
    ctx.closePath(); ctx.fillStyle=color; ctx.fill();
    ctx.strokeStyle="#080810"; ctx.lineWidth=2; ctx.stroke();
    angle+=sweep;
  }
  ctx.beginPath(); ctx.arc(cx,cy,r*0.48,0,Math.PI*2);
  ctx.fillStyle="#141422"; ctx.fill();
}

// 棒グラフ
function buildBarChart(slices, total) {
  if(!slices.length) return "";
  const maxV=Math.max(...slices.map(s=>s.value));
  return `<div class="bar-chart">${slices.map(({value,color,label})=>{
    const pct=Math.round(value/total*100);
    const barW=Math.round(value/maxV*100);
    return `<div class="bar-row">
      <div class="bar-label">${label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${barW}%;background:${color}"></div></div>
      <div class="bar-val">${pct}% <span class="bar-cnt">${value}</span></div>
    </div>`;
  }).join("")}</div>`;
}

// ─── グラフパネル ───
function renderGraph(hist) {
  const el=document.getElementById("graph-content");
  const works=Object.entries(hist);
  if(!works.length){
    el.innerHTML=`<div class="empty"><div class="empty-icon">📊</div>まだデータがありません
      <div class="empty-hint">DLsiteの作品詳細ページを開くと自動的に記録されます</div></div>`;
    return;
  }
  const stats=buildGenreStats(hist);
  const topGenres=stats.slice(0,14);
  const otherCnt=stats.slice(14).reduce((s,x)=>s+x.count,0);
  const totalViews=works.length;
  const avgScore=Math.round(works.reduce((s,[,v])=>s+(v.score||0),0)/works.length);
  const topGenre=topGenres[0]?.genre||"—";
  const totalGenreCnt=topGenres.reduce((s,g)=>s+g.count,0)+otherCnt;
  const slices=[
    ...topGenres.map((g,i)=>({value:g.count,color:CHART_COLORS[i%CHART_COLORS.length],label:g.genre})),
    ...(otherCnt>0?[{value:otherCnt,color:"#262640",label:"その他"}]:[]),
  ];

  const periodBtns=PERIODS.map(p=>
    `<button class="period-btn${p.key===_currentPeriod?" active":""}" data-period="${p.key}">${p.label}</button>`
  ).join("");

  const chartSection=_chartType==="pie"
    ?`<div class="chart-wrap"><div class="chart-title">性癖グラフ</div><canvas id="pieCanvas" width="200" height="200"></canvas></div>`
    :`<div class="chart-wrap bar-wrap"><div class="chart-title">ジャンル分布</div>${buildBarChart(slices,totalGenreCnt)}</div>`;

  el.innerHTML=`
    <div class="graph-controls">
      <div class="period-btns">${periodBtns}</div>
      <button class="chart-toggle" id="chartToggle">${_chartType==="pie"?"📊 棒グラフ":"🥧 円グラフ"}</button>
    </div>
    <div class="stats-row">
      <div class="stat-card"><div class="stat-lbl">閲覧作品数</div><div class="stat-val">${totalViews}</div><div class="stat-unit">作品</div></div>
      <div class="stat-card"><div class="stat-lbl">平均スコア</div><div class="stat-val">${avgScore}</div><div class="stat-unit">点</div></div>
      <div class="stat-card"><div class="stat-lbl">最多ジャンル</div><div class="stat-val" style="font-size:16px;padding-top:4px">${topGenre}</div><div class="stat-unit">${topGenres[0]?.count||0} 作品</div></div>
    </div>
    <div class="chart-section">
      ${chartSection}
      <div class="chart-wrap" style="padding:16px">
        <div class="chart-title">ジャンル内訳</div>
        <div class="legend" id="legendContainer"></div>
      </div>
    </div>`;

  if(_chartType==="pie") drawPieChart(document.getElementById("pieCanvas"),slices);

  const legendEl=document.getElementById("legendContainer");
  topGenres.forEach((g,i)=>{
    const pct=Math.round(g.count/totalGenreCnt*100);
    legendEl.innerHTML+=`<div class="legend-item">
      <div class="legend-dot" style="background:${CHART_COLORS[i%CHART_COLORS.length]}"></div>
      <div class="legend-name">${g.genre}</div>
      <div class="legend-pct">${pct}%</div>
      <div class="legend-count">${g.count}</div></div>`;
  });
  if(otherCnt>0){
    const pct=Math.round(otherCnt/totalGenreCnt*100);
    legendEl.innerHTML+=`<div class="legend-item">
      <div class="legend-dot" style="background:#262640"></div>
      <div class="legend-name">その他</div>
      <div class="legend-pct">${pct}%</div>
      <div class="legend-count">${otherCnt}</div></div>`;
  }

  el.querySelectorAll(".period-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      _currentPeriod=btn.dataset.period;
      renderGraph(filterByPeriod(_fullHist,_currentPeriod));
    });
  });
  document.getElementById("chartToggle")?.addEventListener("click",()=>{
    _chartType=_chartType==="pie"?"bar":"pie";
    renderGraph(filterByPeriod(_fullHist,_currentPeriod));
  });
}

// ─── 未閲覧作品取得 ───
async function fetchUnseenWorks(genreStats, seenRJSet) {
  const results=[];
  for(const g of genreStats.slice(0,4)){
    if(results.length>=20) break;
    try{
      const q=encodeURIComponent(g.genre);
      const html=await fetch(
        `https://www.dlsite.com/maniax/fsr/=/keyword_creater/${q}/order/trend/per_page/50/show_type/1`,
        {credentials:"omit"}
      ).then(r=>r.ok?r.text():Promise.reject(r.status));

      // HTMLから作品リストを抽出
      const doc=new DOMParser().parseFromString(html,"text/html");
      for(const a of doc.querySelectorAll("a[href*='/product_id/RJ']")){
        const m=a.href.match(/\/product_id\/(RJ\d{4,})\.html/i);
        if(!m) continue;
        const rj=m[1].toUpperCase();
        if(seenRJSet.has(rj)||results.find(r=>r.rj===rj)) continue;
        // カード要素から情報取得
        const card=a.closest("li,.work_box,article")||a.parentElement;
        const title=(a.getAttribute("title")||a.textContent||"").trim().slice(0,60)||rj;
        const circle=card?.querySelector(".maker_name a,.circle_name")?.textContent?.trim()||"";
        const imgEl=card?.querySelector("img[data-src],img[src]");
        const imgUrl=imgEl?.dataset?.src||imgEl?.src||"";
        if(title) results.push({rj,title,circle,imgUrl,genre:g.genre});
        if(results.length>=20) break;
      }
    }catch(e){ console.warn("[analytics] unseen fetch failed:",g.genre,e); }
  }
  return results;
}

// ─── おすすめパネル ───
async function renderRecommendations(hist) {
  const el=document.getElementById("rec-content");
  const works=Object.entries(hist);
  if(!works.length){
    el.innerHTML=`<div class="empty"><div class="empty-icon">🔍</div>まだデータがありません
      <div class="empty-hint">DLsiteの作品詳細ページを開くと自動的に記録されます</div></div>`;
    return;
  }

  // 閲覧済みRJセット
  const seenRJSet=new Set(works.map(([rj])=>rj));

  // 高評価作品（スライド形式）
  const topWorks=works
    .filter(([,v])=>v.score>=60)
    .sort((a,b)=>(b[1].score||0)-(a[1].score||0))
    .slice(0,30);

  const stats=buildGenreStats(hist);
  const topGenres=stats.slice(0,8);

  // 既閲覧スライドセクション
  const slideCards=topWorks.map(([rj,entry])=>{
    const score=entry.score||0;
    const color=score>=75?"#22d472":score>=50?"#f5a623":"#f04060";
    const url=`https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`;
    const genres=(entry.genres||[]).slice(0,3).map(g=>`<span class="genre-tag">${g}</span>`).join("");
    const imgHtml=entry.imgUrl
      ?`<div class="slide-img-wrap"><img class="slide-img" src="${entry.imgUrl}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
      :`<div class="slide-img-wrap slide-img-none">📦</div>`;
    return `<a class="slide-card" href="${url}" target="_blank">
      ${imgHtml}
      <div class="slide-body">
        <div class="slide-rj">${rj}</div>
        <div class="slide-title">${entry.title||rj}</div>
        <div class="slide-circle">${entry.circle||""}</div>
        <div class="slide-footer">
          <div class="slide-score" style="color:${color};background:${color}1a">${score}</div>
          <div class="work-genres">${genres}</div>
        </div>
      </div>
    </a>`;
  }).join("");

  let html=`
    <div class="section-title">高評価だった作品</div>
    <div class="slide-wrap" id="slideWrap">
      <button class="slide-arrow slide-prev" id="slidePrev">‹</button>
      <div class="slide-track" id="slideTrack">${slideCards}</div>
      <button class="slide-arrow slide-next" id="slideNext">›</button>
    </div>`;

  // 好みジャンル検索リンク
  if(topGenres.length>0){
    html+=`<div class="search-links"><div class="search-links-title">好みジャンルで探す</div><div class="link-list">`;
    for(const g of topGenres){
      const q=encodeURIComponent(g.genre);
      html+=`<a class="genre-link" href="https://www.dlsite.com/maniax/fsr/=/keyword_creater/${q}/show_type/1" target="_blank">${g.genre} (${g.count})</a>`;
    }
    html+=`</div></div>`;
  }

  // 未閲覧セクション（ローディング中にプレースホルダー）
  html+=`<div class="section-title" style="margin-top:24px">まだ見ていない作品</div>
    <div id="unseenSection"><div class="unseen-loading">🔍 好みジャンルから探しています…</div></div>`;

  el.innerHTML=html;

  // スライド矢印
  const track=document.getElementById("slideTrack");
  const CARD_W=220+12; // width + gap
  document.getElementById("slidePrev")?.addEventListener("click",()=>{ track.scrollBy({left:-CARD_W*2,behavior:"smooth"}); });
  document.getElementById("slideNext")?.addEventListener("click",()=>{ track.scrollBy({left:CARD_W*2,behavior:"smooth"}); });

  // 未閲覧作品を非同期取得
  const unseenEl=document.getElementById("unseenSection");
  if(!unseenEl) return;
  try{
    const unseen=await fetchUnseenWorks(stats,seenRJSet);
    if(!unseen.length){
      unseenEl.innerHTML=`<div class="empty" style="padding:20px 0">取得できませんでした（DLsiteへのアクセスが必要です）</div>`;
      return;
    }
    const unseenCards=unseen.map(({rj,title,circle,imgUrl,genre})=>{
      const url=`https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`;
      const imgHtml=imgUrl
        ?`<div class="slide-img-wrap"><img class="slide-img" src="${imgUrl}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        :`<div class="slide-img-wrap slide-img-none">📦</div>`;
      return `<a class="slide-card" href="${url}" target="_blank">
        ${imgHtml}
        <div class="slide-body">
          <div class="slide-rj">${rj}</div>
          <div class="slide-title">${title}</div>
          <div class="slide-circle">${circle}</div>
          <div class="slide-footer"><span class="genre-tag">${genre}</span></div>
        </div>
      </a>`;
    }).join("");
    unseenEl.innerHTML=`
      <div class="slide-wrap">
        <button class="slide-arrow slide-prev" onclick="this.nextElementSibling.scrollBy({left:-${CARD_W*2},behavior:'smooth'})">‹</button>
        <div class="slide-track">${unseenCards}</div>
        <button class="slide-arrow slide-next" onclick="this.previousElementSibling.scrollBy({left:${CARD_W*2},behavior:'smooth'})">›</button>
      </div>`;
  }catch(e){
    unseenEl.innerHTML=`<div class="empty" style="padding:20px 0">読み込み失敗: ${e.message}</div>`;
  }
}

// ─── 初期化 ───
chrome.storage.local.get({[GENRE_HIST_KEY]:{}}, res=>{
  _fullHist=res[GENRE_HIST_KEY]||{};
  renderGraph(filterByPeriod(_fullHist,_currentPeriod));
  renderRecommendations(_fullHist);
});
