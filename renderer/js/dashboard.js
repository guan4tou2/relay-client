'use strict';
// 儀表板與電源狀態機（連線／中斷，接真實 route IPC）。
// renderer 的各檔都是一般 <script>（不是 module），最外層的宣告在各檔之間共用；載入順序見 index.html。

// =====================================================================================
// 儀表板（建一次；動態值以 updateDashboard 套用，電源 SVG 常駐）
// =====================================================================================
function buildDashboard() {
  $('view-dash').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div id="dashStatus" style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:0 2px;flex-wrap:wrap"></div>
      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:13px 20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:20px">
          <button id="powerBtn" title="啟動路由（空白鍵）" style="width:84px;height:84px;flex-shrink:0;position:relative;border:none;background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center">
            <span id="pwRipple" style="position:absolute;inset:-6px;border-radius:50%;border:1px solid var(--good);opacity:0"></span>
            <span id="pwHalo" style="position:absolute;inset:0;border-radius:50%;background:transparent"></span>
            <svg width="84" height="84" viewBox="0 0 256 256" style="position:absolute;inset:0;overflow:visible">
              <defs>
                <linearGradient id="v2tail" x1="0" y1="0" x2="1" y2="1"><stop id="tailStop0" offset="0" stop-color="var(--accent)" stop-opacity="0"></stop><stop id="tailStop1" offset="1" stop-color="var(--accent)" stop-opacity="1"></stop></linearGradient>
                <linearGradient id="v2sweep" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0"></stop><stop offset=".55" stop-color="var(--accent)" stop-opacity=".55"></stop><stop offset="1" stop-color="var(--accent)" stop-opacity="1"></stop></linearGradient>
              </defs>
              <circle cx="128" cy="128" r="90" fill="none" stroke="var(--fill2)" stroke-width="13"></circle>
              <g id="pwArcGroup" style="transform-origin:128px 128px">
                <g style="transform-origin:128px 128px;transform:rotate(-90deg)"><circle id="pwTop" cx="128" cy="128" r="90" fill="none" stroke="var(--accent)" stroke-width="13" stroke-linecap="round" stroke-dasharray="283 283" stroke-dashoffset="283" style="opacity:0"></circle></g>
                <g style="transform-origin:128px 128px;transform:rotate(90deg)"><circle id="pwBot" cx="128" cy="128" r="90" fill="none" stroke="var(--good)" stroke-width="13" stroke-linecap="round" stroke-dasharray="283 283" stroke-dashoffset="283" style="opacity:0"></circle></g>
              </g>
              <g id="pwSweep" style="transform-origin:128px 128px;opacity:0"><path d="M60 173 A90 90 0 0 1 218 128" fill="none" stroke="url(#v2sweep)" stroke-width="13" stroke-linecap="round"></path></g>
              <g id="pwSpin" style="transform-origin:128px 128px;opacity:0"><path d="M128 38 A90 90 0 0 1 218 128" fill="none" stroke="url(#v2tail)" stroke-width="13" stroke-linecap="round"></path><circle id="pwSpinDot" cx="218" cy="128" r="8.5" fill="var(--accent)"></circle></g>
              <circle id="pwNode" cx="128" cy="128" r="26" fill="var(--text3)" style="transition:fill .35s,r 1.2s cubic-bezier(.32,.72,0,1);transform-origin:128px 128px"></circle>
              <circle id="pwHole" cx="128" cy="128" r="9" fill="var(--card)" style="transition:r 1.2s cubic-bezier(.32,.72,0,1)"></circle>
            </svg>
          </button>
          <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
            <span id="pwTitle" style="font-size:20px;font-weight:700;letter-spacing:-.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">未執行</span>
            <span id="pwSub" style="font-size:13px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">尚未選擇路由</span>
            <span id="pwMeta" style="font-size:11.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>
          </div>
          <div style="width:1px;align-self:stretch;background:var(--sep)"></div>
          <div style="flex:0 1 144px;min-width:124px;display:flex;flex-direction:column;gap:9px">
            <span id="sysLabel" style="font-size:12.5px;font-weight:600;display:flex;align-items:center">系統代理${tipIcon('所有系統流量改走此端口')}</span>
            <button id="sysToggle" role="switch" aria-checked="false" aria-label="系統代理" title="切換系統代理" style="width:50px;height:30px;border-radius:15px;border:none;padding:0;cursor:pointer;position:relative;background:var(--fill);transition:background .22s">
              <span id="sysKnob" style="position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .22s cubic-bezier(.32,.72,0,1)"></span>
            </button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding-top:11px;border-top:1px solid var(--sep);flex-wrap:wrap;row-gap:9px">
          <button id="copyAddr" class="hvFill2" title="複製本地代理位址" style="display:flex;align-items:center;gap:7px;height:28px;padding:0 10px;border:1px solid var(--sep);border-radius:9px;background:transparent;color:var(--text);cursor:pointer;font-size:11.5px;white-space:nowrap;flex-shrink:0">
            <span id="curKind" style="color:var(--text3);font-weight:600"></span>
            <span id="curAddr" style="font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace"></span>
            <span id="copyIcon" style="width:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text3)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg></span>
            <span id="copyChk" style="width:16px;margin-left:-16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--accent);opacity:0;background:var(--card)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6.5"></polyline></svg></span>
          </button>
          <button id="editCurrent" class="hvAccDim" style="margin-left:auto;height:28px;padding:0 12px;border:1px solid var(--sep);border-radius:9px;background:transparent;color:var(--accent);font-size:12px;font-weight:500;cursor:pointer;flex-shrink:0;white-space:nowrap">編輯路由</button>
        </div>
      </div>

      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:13px 18px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:13.5px;font-weight:600;white-space:nowrap">連線鏈路</span>
          <span id="chainSummary" style="font-size:11.5px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        </div>
        <div id="chainRow" style="display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding-bottom:2px"></div>
      </div>

      <div style="background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:12px 18px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:14px">
          <span style="font-size:13.5px;font-weight:600;white-space:nowrap">即時速率</span>
          <div style="display:flex;align-items:center;gap:14px;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;font-size:12px">
            <span style="display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:2px;background:var(--good)"></span>↓ <span id="downRate">0 B/s</span></span>
            <span style="display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:2px;background:var(--purple)"></span>↑ <span id="upRate">0 B/s</span></span>
          </div>
          <div id="rangeSeg" style="margin-left:auto;display:flex;gap:2px;padding:2px;background:var(--fill2);border-radius:8px"></div>
        </div>
        <div style="position:relative">
        <span id="chartScale" style="position:absolute;left:0;top:14px;padding:0 5px 0 0;background:var(--card);font-size:10px;line-height:16px;color:var(--text3);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;pointer-events:none"></span>
        <svg viewBox="0 0 560 88" preserveAspectRatio="none" style="width:100%;height:88px;display:block">
          <line x1="0" y1="22" x2="560" y2="22" stroke="var(--sep)" stroke-width="1"></line>
          <line x1="0" y1="55" x2="560" y2="55" stroke="var(--sep)" stroke-width="1"></line>
          <polygon id="areaDown" points="" fill="var(--good-dim)"></polygon>
          <polyline id="lineDown" points="" fill="none" stroke="var(--good)" stroke-width="2" stroke-linejoin="round"></polyline>
          <polyline id="lineUp" points="" fill="none" stroke="var(--purple)" stroke-width="1.6" stroke-linejoin="round" stroke-dasharray="3 3"></polyline>
        </svg>
        </div>
        <div style="display:flex;gap:22px;padding-top:9px;border-top:1px solid var(--sep)">
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">連線數</span><span id="statConns" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">0</span></div>
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">上傳總量</span><span id="statUp" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">0 B</span></div>
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">下載總量</span><span id="statDown" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">0 B</span></div>
          <div style="display:flex;flex-direction:column;gap:3px"><span style="font-size:10.5px;color:var(--text3);font-weight:600;letter-spacing:.3px;white-space:nowrap">已執行</span><span id="statUptime" style="font-size:16px;font-weight:600;font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace">00:00</span></div>
        </div>
      </div>
      <div id="dashInstances" style="display:none"></div>
    </div>`;

  $('powerBtn').onclick = () => togglePower();
  $('sysToggle').onclick = () => toggleSys();
  $('copyAddr').onclick = () => copyAddr();
  $('editCurrent').onclick = () => openRoute(state.sel);
  renderRange();
}

function renderRange() {
  $('rangeSeg').innerHTML = ['60 秒', '5 分鐘'].map(r =>
    `<button data-r="${r}" style="border:none;cursor:pointer;height:27px;padding:0 11px;border-radius:6px;font-size:12px;white-space:nowrap;flex-shrink:0;${segCss(state.range === r)}">${r}</button>`
  ).join('');
  $('rangeSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.range = b.dataset.r; renderRange(); updateTraffic(); });
}

// 電源按鈕：讀 selected route 的 session，套用到常駐 SVG（保留元素才能觸發 stroke-dashoffset / r 過場）
function updatePower() {
  if (!$('pwTop')) return;
  const S = ses(state.sel);
  const running = S.status === 'running', connecting = S.status === 'connecting', closing = S.status === 'closing', failing = S.status === 'failing';
  const prog = S.prog || 0, settle = !!S.settle, shaking = !!S.shaking;
  const topOff = 283 - 141.4 * Math.min(1, prog / 0.55) - 0.1;
  const botOff = 283 - 141.4 * Math.max(0, (prog - 0.55) / 0.45) - 0.1;
  const arcOpacity = prog > 0.001 ? '1' : '0';
  const tailColor = failing ? 'var(--red)' : 'var(--accent)';
  const transTop = closing ? 'stroke-dashoffset .55s cubic-bezier(.4,0,.6,1) .3s,opacity .3s' : failing ? 'stroke-dashoffset .3s ease-out,opacity .2s' : 'stroke-dashoffset 1.9s cubic-bezier(.25,.5,.3,1),opacity .3s';
  const transBot = closing ? 'stroke-dashoffset .5s cubic-bezier(.4,0,.6,1),opacity .3s' : 'stroke-dashoffset 1.5s cubic-bezier(.3,.4,.2,1) 1.9s,opacity .3s';

  const top = $('pwTop'), bot = $('pwBot'), spin = $('pwSpin'), node = $('pwNode'), hole = $('pwHole');
  $('pwArcGroup').style.animation = settle ? 'arcSettle 1.5s 1 both' : 'none';
  top.style.transition = transTop; top.style.opacity = arcOpacity; top.style.stroke = failing ? 'var(--red)' : 'var(--accent)'; top.setAttribute('stroke-dashoffset', String(topOff));
  bot.style.transition = transBot; bot.style.opacity = arcOpacity; bot.style.stroke = failing ? 'var(--red)' : 'var(--good)'; bot.setAttribute('stroke-dashoffset', String(botOff));
  spin.style.animation = connecting ? 'spinArc 1.15s cubic-bezier(.6,.05,.4,.95) infinite' : closing ? 'spinArc .8s linear infinite reverse' : 'none';
  spin.style.opacity = failing ? '0' : connecting ? '1' : closing ? '.6' : '0';
  $('tailStop0').setAttribute('stop-color', tailColor); $('tailStop1').setAttribute('stop-color', tailColor); $('pwSpinDot').setAttribute('fill', tailColor);
  $('powerBtn').style.animation = shaking ? 'shake .5s cubic-bezier(.36,.07,.19,.97) 1' : 'none';
  node.style.fill = failing ? 'var(--red)' : running ? 'var(--good)' : (connecting || closing) ? 'var(--accent)' : 'var(--text3)';
  node.setAttribute('r', (connecting || closing) ? String(15 + 11 * prog) : '26');
  node.style.animation = running ? 'nodeBeat .55s cubic-bezier(.32,.72,0,1) 1' : 'none';
  hole.setAttribute('r', running ? '11' : (connecting || closing) ? String(9 * prog) : '9');
  $('pwRipple').style.opacity = running ? '1' : '0'; $('pwRipple').style.animation = running ? 'ripple 2.6s ease-out infinite' : 'none';
  $('pwHalo').style.background = running ? 'var(--good-dim)' : 'transparent';

  const cur = curRoute();
  $('powerBtn').title = failing ? '重新啟動這條路由（空白鍵）' : running ? '停止路由（空白鍵）' : '啟動路由（空白鍵）';
  $('pwTitle').textContent = failing ? '啟動失敗' : running ? '執行中' : connecting ? (S.stage || '正在啟動…') : closing ? '正在停止…' : '未執行';
  // 位址已經在下方的複製鈕上，這行改顯示路由名稱（原本兩處都寫 SOCKS5 127.0.0.1:…）
  $('pwSub').textContent = cur ? (cur.label || '未命名路由') : '尚未選擇路由';
  $('pwMeta').textContent = failing ? (S.failReason || '') : cur ? (cur.hops.length ? cur.hops.length + ' 跳 · 出口 ' + srvName(cur.hops[cur.hops.length - 1]) : '尚未設定跳點') : '';
}

function updateChain() {
  const cur = curRoute();
  if (!cur) { $('chainSummary').textContent = ''; $('chainRow').innerHTML = ''; return; }
  const S = ses(state.sel);
  const running = S.status === 'running', connecting = S.status === 'connecting';
  $('chainSummary').textContent = cur.hops.length > 1 ? cur.hops.length + ' 跳串鏈 · 每跳握手都跑在前一跳的通道內，流量自最後一跳出網'
    : cur.hops.length === 1 ? '單跳 · 流量自此節點出網' : '尚未設定跳點';
  const hops = cur.hops.map(id => state.servers.find(x => x.id === id)).filter(Boolean);
  const doneHops = running ? hops.length + 1 : (S.hopDone || 0);
  const nodes = [{ name: '本地監聽', sub: '127.0.0.1:' + cur.localPort, badge: cur.kind === 'http' ? 'HTTP' : 'SOCKS5', icon: iconSvg(ICONS.local), stage: 0 }]
    .concat(hops.map((hp, i) => ({ name: hp.name, sub: hp.host + ':' + hp.port, badge: PROTO[sProto(hp)].label + (i === hops.length - 1 ? ' · 出口' : ''), icon: iconSvg(i === hops.length - 1 ? ICONS.target : ICONS.hop), stage: i + 1 })));
  $('chainRow').innerHTML = nodes.map((c, i, arr) => {
    const lit = running || c.stage <= doneHops;
    const hasNext = i < arr.length - 1;
    const linkColor = running ? 'var(--good)' : c.stage < doneHops ? 'var(--accent)' : 'var(--sep)';
    const dash = (running || connecting) ? '4 4' : '0';
    const flowAnim = (running || connecting) ? 'hopFlow .6s linear infinite' : 'none';
    return `<div style="display:flex;align-items:flex-start;flex-shrink:0">
      <div style="width:118px;display:flex;flex-direction:column;align-items:center;gap:5px">
        <div style="width:34px;height:34px;border-radius:10px;background:${lit ? 'var(--accent-dim)' : 'var(--fill2)'};border:1px solid ${lit ? 'var(--accent)' : 'var(--sep)'};display:flex;align-items:center;justify-content:center;color:${lit ? 'var(--accent)' : 'var(--text3)'}">${c.icon}</div>
        <span style="font-size:12px;font-weight:600;text-align:center;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>
        <span style="font-size:10.5px;color:var(--text2);font-family:'JetBrains Mono','Cascadia Mono',Consolas,monospace;text-align:center;white-space:nowrap;max-width:112px;overflow:hidden;text-overflow:ellipsis">${esc(c.sub)}</span>
        <span style="font-size:9.5px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;background:var(--fill2);color:var(--text2);white-space:nowrap">${esc(c.badge)}</span>
      </div>
      ${hasNext ? `<svg width="46" height="38" viewBox="0 0 46 38" style="flex-shrink:0">
        <line x1="2" y1="19" x2="40" y2="19" stroke="${linkColor}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${dash}" style="animation:${flowAnim}"></line>
        <polyline points="34 13 40 19 34 25" fill="none" stroke="${linkColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
      </svg>` : ''}
    </div>`;
  }).join('');
}

// 速率圖取樣：TICK_MS 一點，所以 60 秒 = 200 點、5 分鐘 = 1000 點
const TICK_MS = 300;
const RANGE_SEC = { '60 秒': 60, '5 分鐘': 300 };
const SERIES_MAX = Math.round(300 * 1000 / TICK_MS); // 緩衝一律留滿 5 分鐘，切區間才不用等資料重長
const DRAW_MAX = 280;                                // 圖寬 560，最密兩點一像素

function updateTraffic() {
  if (!$('lineDown')) return;
  const S = ses(state.sel);
  const cap = Math.round((RANGE_SEC[state.range] || 60) * 1000 / TICK_MS);
  const raw = (S.series || []).slice(-cap);
  // 下限原本是 3 MB/s：一般瀏覽（幾十到幾百 KB/s）整條線貼在底部看不出起伏。
  // 改成 64 KB/s 下限，並在上方格線標出刻度，免得小流量被放大成像滿載。
  const max = Math.max(64 * 1024, ...raw.map(p => Math.max(p.down, p.up)));
  $('chartScale').textContent = fmtBytes(max * 66 / 78) + '/s';
  // x 軸釘右緣、依時間往左長；不再把手上的點硬撐滿整條寬度，否則資料不滿一格時兩個區間會畫出一模一樣的圖
  const x0 = raw.length ? 560 * (cap - raw.length) / (cap - 1) : 560;
  const pts = thinSeries(raw, DRAW_MAX);
  const step = pts.length > 1 ? (560 - x0) / (pts.length - 1) : 0;
  const xy = key => pts.map((p, i) => `${(x0 + i * step).toFixed(1)},${(88 - (p[key] / max) * 78).toFixed(1)}`).join(' ');
  const ld = xy('down'), lu = xy('up');
  $('lineDown').setAttribute('points', ld);
  $('lineUp').setAttribute('points', lu);
  $('areaDown').setAttribute('points', ld ? `${x0.toFixed(1)},88 ${ld} 560,88` : '');
  $('downRate').textContent = fmtBytes(S.down || 0) + '/s';
  $('upRate').textContent = fmtBytes(S.up || 0) + '/s';
  $('statConns').textContent = String(Math.max(0, S.conns || 0)); // 夾住下界，永不顯示負值
  $('statUp').textContent = fmtBytes(S.upT || 0);
  $('statDown').textContent = fmtBytes(S.downT || 0);
  const upt = S.uptime || 0;
  $('statUptime').textContent = `${String(Math.floor(upt / 60)).padStart(2, '0')}:${String(upt % 60).padStart(2, '0')}`;
}

function updateDashboard() {
  updatePower();
  updateChain();
  updateTraffic();
  const cur = curRoute();
  const runIds = runningRouteIds();
  $('sysToggle').style.background = state.sys ? 'var(--accent)' : 'var(--fill)';
  $('sysToggle').setAttribute('aria-checked', state.sys ? 'true' : 'false');
  $('sysKnob').style.left = state.sys ? '23px' : '3px';
  const sysTip = $('sysLabel').querySelector('[data-tip]');
  if (sysTip) sysTip.dataset.tip = runIds.length > 1 ? '系統代理指向目前選取的路由端口' : '所有系統流量改走此端口';
  $('copyIcon').style.color = state.copied ? 'transparent' : 'var(--text3)';
  $('copyChk').style.opacity = state.copied ? '1' : '0';
  $('curKind').textContent = cur ? (cur.kind === 'http' ? 'HTTP' : 'SOCKS5') : '';
  $('curAddr').textContent = cur ? '127.0.0.1:' + cur.localPort : '';
  // 路由 id 只有對照 config.json 時才用得到，收進位址鈕的懸浮提示
  $('copyAddr').title = cur ? `複製本地代理位址（路由 id：${cur.id}）` : '複製本地代理位址';
}
// =====================================================================================
// 電源狀態機（連線 / 中斷）—— 綁到真實 route IPC
// =====================================================================================
async function togglePower(id) {
  const rid = id || state.sel;
  if (!rid) { flash('請先選擇一條路由'); return; }
  const route = state.routes.find(r => r.id === rid);
  if (!route) return;
  const S = ses(rid);
  if (S.status === 'connecting' || S.status === 'closing') return;

  // 停止
  if (S.status === 'running') {
    clearSTimers(rid);
    setSes(rid, { status: 'closing', prog: 0, settle: false });
    afterStatusChange();
    window.api.routeStop(rid).catch(() => {});
    sTimeout(rid, () => { dropSes(rid); afterStatusChange(); }, 900);
    flash('已停止 ' + (route.label || '路由'));
    if (!state.routes.some(r => r.id !== rid && ses(r.id).status === 'running') && state.sys) {
      state.sys = false;
      window.api.toggleSystemProxy(false, route.localPort).catch(() => {});
    }
    return;
  }

  // 啟動：跑連線動畫時間軸；用真實 routeStart 結果決定 settle
  const hops = route.hops.map(hid => state.servers.find(x => x.id === hid)).filter(Boolean);
  clearSTimers(rid);
  setSes(rid, { status: 'connecting', prog: 0, stage: '綁定 127.0.0.1:' + route.localPort + '…', failReason: '', settle: false, shaking: false,
    series: [], up: 0, down: 0, upT: 0, downT: 0, uptime: 0, conns: 0, hopDone: 0, startTs: 0, _pu: 0, _pd: 0 });
  afterStatusChange();
  requestAnimationFrame(() => { setSes(rid, { prog: 1 }); if (state.sel === rid && state.tab === 'dashboard') updatePower(); });
  const t0 = performance.now();
  const per = 2600 / Math.max(1, hops.length);
  hops.forEach((hp, i) => sTimeout(rid, () => { setSes(rid, { stage: '第 ' + (i + 1) + ' 跳握手 · ' + hp.name + '…', hopDone: i }); if (state.sel === rid && state.tab === 'dashboard') { updatePower(); updateChain(); } }, 700 + per * i));
  sTimeout(rid, () => { if (ses(rid).status === 'connecting') { setSes(rid, { stage: '開啟本地監聽…', hopDone: hops.length }); if (state.sel === rid && state.tab === 'dashboard') { updatePower(); updateChain(); } } }, 3000);

  let result;
  try { result = await window.api.routeStart(rid); }
  catch (e) { result = { ok: false, error: e.message }; }

  const settle = () => {
    if (ses(rid).status !== 'connecting') return;
    if (result && result.ok) {
      const hint = !state.sysHintSeen && !state.sys;
      setSes(rid, { status: 'running', prog: 1, stage: '', settle: true, startTs: Date.now() });
      state.sysHintSeen = true; state.banner = hint ? '路由已啟動。開啟「系統代理」即可讓所有系統流量改走此端口。' : '';
      showBanner();
      sTimeout(rid, () => { setSes(rid, { settle: false }); if (state.sel === rid && state.tab === 'dashboard') updatePower(); }, 1560);
      afterStatusChange();
      flash('已連線 · ' + (route.label || '路由'));
    } else if (result && result.conflict) {
      clearSTimers(rid); dropSes(rid);
      state.alert = result.conflict; renderAlert(); afterStatusChange();
    } else {
      const reason = (result && result.error) || '連線失敗';
      setSes(rid, { status: 'failing', shaking: true, failReason: reason, stage: '', prog: 0.5 });
      afterStatusChange();
      sTimeout(rid, () => { setSes(rid, { shaking: false }); if (state.sel === rid && state.tab === 'dashboard') updatePower(); }, 520);
      flash((route.label || '路由') + ' 連線失敗');
    }
  };
  const target = (result && result.ok) ? 3450 : (result && result.conflict) ? 0 : 1750;
  const wait = Math.max(0, target - (performance.now() - t0));
  setTimeout(settle, wait);
  flash('正在啟動 ' + (route.label || '路由'));
}

async function toggleSys() {
  const runIds = runningRouteIds();
  if (!runIds.length) { flash('請先啟動路由', 'var(--amber)'); return; }
  const cur = curRoute();
  const next = !state.sys;
  // 失敗時維持原狀並講出原因：以前 catch 裡直接 state.sys = next，開關顯示「開」但系統根本沒設
  try {
    const r = await window.api.toggleSystemProxy(next, cur && runIds.includes(cur.id) ? cur.localPort : undefined);
    state.sys = r ? !!r.systemProxyEnabled : state.sys;
    if (r && r.error) flash('系統代理：' + r.error, 'var(--red)');
  } catch (e) { flash('切換系統代理失敗：' + (e && e.message || e), 'var(--red)'); }
  if (state.tab === 'dashboard') updateDashboard();
}

// 剪貼簿寫入可能被拒（視窗沒焦點、權限），成功才顯示「已複製」
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); if (okMsg) flash(okMsg); return true; }
  catch (e) { flash('無法寫入剪貼簿', 'var(--red)'); return false; }
}

async function copyAddr() {
  const cur = curRoute();
  if (!cur) return;
  if (!(await copyText('127.0.0.1:' + cur.localPort))) return;
  state.copied = true; if (state.tab === 'dashboard') updateDashboard();
  setTimeout(() => { state.copied = false; if (state.tab === 'dashboard') updateDashboard(); }, 1200);
}
