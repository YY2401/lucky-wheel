/* OBS「點歌播放器」：照控制面板（twitch.html）送來的順序播放 YouTube，播完、出錯都回報給控制面板 */
/* global YT */
(function () {
  const { Sync } = LW;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || '';
  const secret = params.get('key') || '';
  const warn = (text) => { $('#warn').textContent = text; $('#warn').classList.toggle('hidden', !text); };
  if (!room || !secret) { warn('網址不完整：請到忠誠點轉盤設定步驟 9 重新複製「點歌播放器」網址'); return; }
  if (params.get('video') === '0') $('#video').classList.add('off'); // 只要聲音、不顯示影片

  let player = null; let ready = false;
  let state = null; // 最新收到的名單
  let playingId = ''; // 目前載入的點歌編號
  let cutTimer = null;
  const report = (event, extra = {}) => Sync.send({ type: 'songEvent', id: playingId, event, ...extra });

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      width: '100%', height: '100%',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: () => { ready = true; if (state) apply(state); },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            const d = player.getVideoData();
            if (d && d.title) report('title', { title: d.title });
          } else if (e.data === YT.PlayerState.ENDED && playingId) { report('ended'); }
        },
        onError: (e) => { if (playingId) report('error', { code: e.data }); },
      },
    });
  };

  function apply(d) {
    state = d;
    $('#card').classList.remove('hidden');
    $('#total').textContent = (d.next || []).length + (d.more || 0);
    $('#song').textContent = d.now ? d.now.title : '目前沒有歌，送小奇點貼 YouTube 連結就能點歌';
    $('#who').innerHTML = d.now ? `點歌：${esc(d.now.who)}${d.paused ? '　<span class="paused">暫停中</span>' : ''}` : '';
    $('#next').innerHTML = (d.next || []).map((s, i) => `<li><span class="no">${i + 1}</span><span class="name">${esc(s.title)}</span><span class="by">${esc(s.who)}</span></li>`).join('');
    $('#nextBox').classList.toggle('hidden', !(d.next || []).length);
    $('#more').textContent = d.more ? `還有 ${d.more} 首` : ''; $('#more').classList.toggle('hidden', !d.more);
    $('#video').classList.toggle('hidden', !d.now && params.get('video') !== '0');
    if (!ready) return;
    player.setVolume(d.volume == null ? 60 : d.volume);
    const id = d.now ? d.now.id : '';
    if (id !== playingId) {
      playingId = id; clearInterval(cutTimer);
      if (d.now) {
        player.loadVideoById(d.now.videoId);
        // 超過時間上限：播到上限就算播完
        if (d.maxSec > 0) cutTimer = setInterval(() => { if (playingId === id && player.getCurrentTime() >= d.maxSec) { clearInterval(cutTimer); report('ended', { cut: true }); } }, 1000);
      } else player.stopVideo();
    }
    if (d.now) { if (d.paused) player.pauseVideo(); else if (player.getPlayerState() === YT.PlayerState.PAUSED) player.playVideo(); }
  }

  let lastMsg = 0;
  Sync.onReject = () => warn('收到的訊息驗證不過：OBS 裡的網址可能是舊的，請重新複製「點歌播放器」網址');
  Sync.on((msg) => { if (msg.type === 'songs') { lastMsg = Date.now(); warn(''); apply(msg); } });
  Sync.start(room, { sync: params.get('sync') !== '0', broker: params.get('broker') || 'wss://broker.emqx.io:8084/mqtt', secret });
  const hello = () => Sync.send({ type: 'hello' });
  setTimeout(hello, 500); setTimeout(hello, 3000);
  setInterval(() => { if (!lastMsg) hello(); }, 15000);
  setTimeout(() => { if (!lastMsg) warn('還沒收到控制面板的點歌名單：請確認忠誠點轉盤（瀏覽器或 OBS 面板）有開著，而且步驟 9 有打開點歌'); }, 20000);
})();
