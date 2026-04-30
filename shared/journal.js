/* JOURNAL_CONFIG must be set by the page before this script loads:
   {
     countLabel:        string   — e.g. '次騎乘'
     routeColLabel:     string   — e.g. '路線'
     defaultAreaLabel:  string   — fallback area name
     errorCmd:          string   — shown in error message
     kmStep:            (km) => number
     nameFor:           (item, detectArea) => string
   }
*/

/* ── Area detection ── */
const AREA_LABELS = {
  jinshan: '金山', tamsui: '淡水', luzhou: '蘆洲',
  wulai: '烏來', yangming: '陽明山', jilong: '基隆',
};
function detectArea(file) {
  for (const [key, label] of Object.entries(AREA_LABELS)) {
    if (file.startsWith(key)) return { key, label };
  }
  return { key: 'other', label: JOURNAL_CONFIG.defaultAreaLabel };
}

/* ── Formatters ── */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtDur(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}<span class="unit">h</span> ${String(m).padStart(2,'0')}<span class="unit">m</span>`;
  return `${m}<span class="unit">m</span>`;
}

/* ── Map helpers ── */
const rideMaps = {};
const loadedData = {};

function eleColor(ele, lo, hi) {
  const t = Math.max(0, Math.min(1, (ele - lo) / (hi - lo)));
  return `hsl(${Math.round(120 - t * 120)},100%,48%)`;
}
function dotIcon(color, size) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>`,
    iconSize: [size, size], iconAnchor: [size/2, size/2],
  });
}
function downsample(pts, max) {
  const step = Math.max(1, Math.floor(pts.length / max));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

function initMap(idx, points, stats) {
  if (rideMaps[idx]) { rideMaps[idx].invalidateSize(); return; }

  const loEle = Math.max(0, stats.max_elevation_m - stats.total_ascent_m - 20);
  const hiEle = stats.max_elevation_m;
  const pts   = downsample(points, 600);

  const map = L.map(`ride-map-${idx}`, { zoomControl: true, scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 17,
  }).addTo(map);
  rideMaps[idx] = map;

  const lg = L.layerGroup().addTo(map);
  const bounds = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i+1];
    const seg = [[p1.lat, p1.lon], [p2.lat, p2.lon]];
    L.polyline(seg, { color: '#1a1a1a', weight: 7, opacity: 0.65, lineJoin:'round', lineCap:'round' }).addTo(lg);
    L.polyline(seg, { color: eleColor((p1.ele+p2.ele)/2, loEle, hiEle), weight: 4, opacity: 1, lineJoin:'round', lineCap:'round' }).addTo(lg);
    bounds.push([p1.lat, p1.lon]);
  }
  bounds.push([pts[pts.length-1].lat, pts[pts.length-1].lon]);

  L.marker([pts[0].lat, pts[0].lon], { icon: dotIcon('#22c55e', 14) }).addTo(lg).bindTooltip('出發');
  L.marker([pts[pts.length-1].lat, pts[pts.length-1].lon], { icon: dotIcon('#ef4444', 14) }).addTo(lg).bindTooltip('終點');

  const lBounds = L.latLngBounds(bounds);
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(lBounds, { padding: [28, 28] });
    drawChart(idx, points, hiEle);
  });
}

/* ── Elevation chart ── */
function buildProfile(points) {
  const sampled = downsample(points, 300);
  let dist = 0;
  return sampled.map((pt, i) => {
    if (i > 0) {
      const prev = sampled[i-1];
      const dlat = (pt.lat - prev.lat) * 111000;
      const dlon = (pt.lon - prev.lon) * 111000 * Math.cos(pt.lat * Math.PI / 180);
      dist += Math.sqrt(dlat*dlat + dlon*dlon);
    }
    return [dist, pt.ele];
  });
}

function drawChart(idx, points, maxEleParam) {
  const canvas  = document.getElementById(`ele-chart-${idx}`);
  const profile = buildProfile(points);
  const dpr  = window.devicePixelRatio || 1;
  const W = (canvas.parentElement.clientWidth || canvas.parentElement.offsetWidth) - 48, H = 110;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const totalDist = profile[profile.length-1][0];
  const chartMax  = Math.ceil((maxEleParam || 300) / 100) * 100 + 20;
  const pL=36, pR=8, pT=10, pB=22;
  const cW = W-pL-pR, cH = H-pT-pB;
  const toX = d => pL + (d / totalDist) * cW;
  const toY = e => pT + cH - (Math.max(0,e) / chartMax) * cH;

  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 0.5;
  ctx.fillStyle = '#666'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
  [0, 100, 200, chartMax].forEach(e => {
    const y = toY(e);
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W-pR, y); ctx.stroke();
    ctx.fillText(e, pL-4, y+3);
  });
  const kmStep = JOURNAL_CONFIG.kmStep(totalDist / 1000);
  ctx.textAlign = 'center';
  for (let km = 0; km <= Math.ceil(totalDist/1000); km += kmStep) {
    const xd = toX(km * 1000);
    ctx.beginPath(); ctx.strokeStyle='#222'; ctx.lineWidth=0.5;
    ctx.moveTo(xd, pT); ctx.lineTo(xd, pT+cH); ctx.stroke();
    ctx.fillStyle='#666';
    ctx.fillText(km===0?'0':km+'km', xd, H-4);
  }

  const grad = ctx.createLinearGradient(0, pT, 0, pT+cH);
  grad.addColorStop(0, 'rgba(201,169,110,0.65)');
  grad.addColorStop(1, 'rgba(201,169,110,0.08)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(toX(profile[0][0]), toY(profile[0][1]));
  profile.forEach(([d,e]) => ctx.lineTo(toX(d), toY(e)));
  ctx.lineTo(toX(profile[profile.length-1][0]), toY(0));
  ctx.lineTo(toX(profile[0][0]), toY(0));
  ctx.closePath(); ctx.fill();

  ctx.strokeStyle = 'rgba(201,169,110,0.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(toX(profile[0][0]), toY(profile[0][1]));
  profile.forEach(([d,e]) => ctx.lineTo(toX(d), toY(e)));
  ctx.stroke();
}

/* ── Row open / close ── */
function closeRow(idx) {
  const detail = document.getElementById(`detail-${idx}`);
  const row    = document.getElementById(`row-${idx}`);
  if (detail) detail.classList.remove('open');
  if (row)    row.classList.remove('active');
}

function rowMouseLeave(idx, e) {
  const detail = document.getElementById(`detail-${idx}`);
  if (!detail || !detail.classList.contains('open')) return;
  const to = e.relatedTarget;
  if (to && (detail === to || detail.contains(to))) return;
  closeRow(idx);
}

function detailMouseLeave(idx, e) {
  const row = document.getElementById(`row-${idx}`);
  const to  = e.relatedTarget;
  if (to && row && (row === to || row.contains(to))) return;
  closeRow(idx);
}

async function toggleRow(idx, file, row) {
  const detail = document.getElementById(`detail-${idx}`);
  if (detail.classList.contains('open')) return;

  document.querySelectorAll('.ride-detail-row').forEach(r => r.classList.remove('open'));
  document.querySelectorAll('.ride-row').forEach(r => r.classList.remove('active'));

  detail.classList.add('open');
  row.classList.add('active');

  if (!loadedData[idx]) {
    const res  = await fetch(`data/${file}`);
    loadedData[idx] = await res.json();
  }
  setTimeout(() => {
    const { points, stats } = loadedData[idx];
    initMap(idx, points, stats);
  }, 660);
}

/* ── Filter ── */
function filterRides(area, btn) {
  document.querySelectorAll('.ride-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.ride-detail-row').forEach(r => r.classList.remove('open'));
  document.querySelectorAll('.ride-row').forEach(r => {
    r.classList.remove('active');
    const match = area === 'all' || r.dataset.area === area;
    r.classList.toggle('hidden', !match);
    const next = r.nextElementSibling;
    if (next?.classList.contains('ride-detail-row')) next.classList.toggle('hidden', !match);
  });
}

/* ── Embed mode ── */
if (new URLSearchParams(location.search).has('embed')) {
  document.getElementById('page-header').style.display = 'none';
}

/* ── Boot ── */
(async () => {
  const content = document.getElementById('content');
  try {
    const index = await fetch('data/index.json').then(r => r.json());

    const totalDist = index.reduce((s, i) => s + i.total_distance_km, 0);
    const totalAsc  = index.reduce((s, i) => s + i.total_ascent_m,  0);
    const totalCal  = index.reduce((s, i) => s + (i.calories || 0), 0);

    const areaSeen = new Map();
    index.forEach(i => {
      const k = i.area || 'other', l = i.area_label || '其他';
      if (k !== 'other' && !areaSeen.has(k)) areaSeen.set(k, l);
    });
    let filterHTML = `<button class="ride-filter-btn active" onclick="filterRides('all',this)">全部</button>`;
    areaSeen.forEach((label, key) => {
      filterHTML += `<button class="ride-filter-btn" onclick="filterRides('${key}',this)">${label}</button>`;
    });

    let rowsHTML = '';
    index.forEach((item, idx) => {
      const areaKey = item.area || 'other';
      const w = item.weather;
      const weatherCell = w
        ? `<td class="ride-weather"><span title="${w.desc||''}">${w.icon}</span> ${w.temp}°C</td>`
        : `<td class="ride-weather">—</td>`;
      const calCell = item.calories != null
        ? `<td>${item.calories.toLocaleString()}<span class="unit">kcal</span></td>`
        : `<td>—</td>`;
      const itemName = JOURNAL_CONFIG.nameFor(item, detectArea);
      rowsHTML += `
        <tr class="ride-row" id="row-${idx}" data-area="${areaKey}"
            onclick="toggleRow(${idx},'${item.file}',this)"
            onmouseleave="rowMouseLeave(${idx},event)">
          <td title="${itemName}">${itemName} <span class="ride-row-arrow">›</span></td>
          <td>${fmtDate(item.start_time)}</td>
          <td>${item.total_distance_km.toFixed(2)}<span class="unit">km</span></td>
          <td>↑${Math.round(item.total_ascent_m)}<span class="unit">m</span></td>
          <td>↓${Math.round(item.total_descent_m || 0)}<span class="unit">m</span></td>
          <td>${fmtDur(item.duration_sec)}</td>
          ${weatherCell}
          ${calCell}
        </tr>
        <tr class="ride-detail-row" id="detail-${idx}" onmouseleave="detailMouseLeave(${idx},event)">
          <td colspan="8">
            <div class="ride-detail-inner">
              <div id="ride-map-${idx}" class="ride-map"></div>
              <div class="ride-chart-wrap">
                <div class="ride-chart-label">海拔剖面</div>
                <canvas id="ele-chart-${idx}" class="ele-chart"></canvas>
              </div>
            </div>
          </td>
        </tr>`;
    });

    content.innerHTML = `
      <div class="ride-summary">
        <div class="ride-summary-stat">
          <span class="ride-summary-value">${index.length}</span>
          <span class="ride-summary-label">${JOURNAL_CONFIG.countLabel}</span>
        </div>
        <div class="ride-summary-divider"></div>
        <div class="ride-summary-stat">
          <span class="ride-summary-value">${totalDist.toFixed(2)}</span>
          <span class="ride-summary-label">KM 總里程</span>
        </div>
        <div class="ride-summary-divider"></div>
        <div class="ride-summary-stat">
          <span class="ride-summary-value">${Math.round(totalAsc).toLocaleString()}</span>
          <span class="ride-summary-label">M 總爬升</span>
        </div>
        ${totalCal > 0 ? `
        <div class="ride-summary-divider"></div>
        <div class="ride-summary-stat">
          <span class="ride-summary-value">${totalCal.toLocaleString()}</span>
          <span class="ride-summary-label">Kcal 總消耗</span>
        </div>` : ''}
      </div>
      <div class="ride-filter">${filterHTML}</div>
      <table class="ride-table">
        <thead>
          <tr>
            <th style="width:21%">${JOURNAL_CONFIG.routeColLabel}</th>
            <th style="width:12%">日期</th>
            <th style="width:10%">里程</th>
            <th style="width:10%">爬升</th>
            <th style="width:10%">下降</th>
            <th style="width:12%">時間</th>
            <th style="width:12%">天氣</th>
            <th style="width:13%">卡路里</th>
          </tr>
        </thead>
        <tbody>${rowsHTML}</tbody>
      </table>`;

  } catch(e) {
    content.innerHTML = `<div id="loading-msg">找不到 data/index.json<br>請先執行：${JOURNAL_CONFIG.errorCmd}</div>`;
  }
})();
