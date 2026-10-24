/* OBS「排隊名單」畫面：只聽控制面板（twitch.html）送來的排隊狀態 */
(function () {
  const { Sync } = LW;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || '';
  const secret = params.get('key') || '';
  const warn = (text) => { $('#warn').textContent = text; $('#warn').classList.toggle('hidden', !text); };
  if (!room || !secret) { warn('網址不完整：請到忠誠點轉盤設定步驟 8 重新複製「排隊名單」網址'); return; }

  let shown = new Set(); // 已經在畫面上的名字：新加入的才播進場動畫
  function render(d) {
    $('#card').classList.remove('hidden');
    $('#title').textContent = d.title || '排隊陪玩';
    $('#total').textContent = d.total || 0;
    const row = (e, no) => `<li class="${shown.has(e.name) ? '' : 'new'}">${no != null ? `<span class="no">${no}</span>` : ''}<span class="name">${esc(e.name)}</span>${e.input ? `<span class="id">${esc(e.input)}</span>` : ''}</li>`;
    $('#playing').innerHTML = (d.playing || []).length ? d.playing.map((e) => row(e)).join('') : '<li class="empty">等待開始</li>';
    $('#waiting').innerHTML = (d.waiting || []).length ? d.waiting.map((e, i) => row(e, i + 1)).join('') : '<li class="empty">目前沒有人排隊，兌換忠誠點就能加入</li>';
    $('#more').textContent = d.more ? `還有 ${d.more} 人排隊中` : '';
    $('#more').classList.toggle('hidden', !d.more);
    shown = new Set([...(d.playing || []), ...(d.waiting || [])].map((e) => e.name));
  }

  let lastMsg = 0;
  Sync.onReject = () => warn('收到的訊息驗證不過：OBS 裡的網址可能是舊的，請重新複製「排隊名單」網址');
  Sync.on((msg) => {
    if (msg.type !== 'party') return;
    lastMsg = Date.now(); warn(''); render(msg);
  });
  Sync.start(room, { sync: params.get('sync') !== '0', broker: params.get('broker') || 'wss://broker.emqx.io:8084/mqtt', secret });
  // 向控制面板要目前的名單（OBS 比控制面板晚開也拿得到）
  const hello = () => Sync.send({ type: 'hello' });
  setTimeout(hello, 500); setTimeout(hello, 3000);
  setInterval(() => { if (!lastMsg) hello(); }, 15000);
  setTimeout(() => { if (!lastMsg) warn('還沒收到控制面板的名單：請確認忠誠點轉盤（瀏覽器或 OBS 面板）有開著'); }, 20000);
})();
