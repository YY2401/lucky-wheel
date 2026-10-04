'use strict';
/* 忠誠點轉盤 e2e 與說明書截圖共用的模擬：Twitch API / EventSub / Apps Script */
// 在頁面任何程式執行前裝上模擬：fetch（Twitch、Apps Script）與 WebSocket（EventSub）
function installMocks() {
  const M = (window.__tw = {
    sockets: [], sheetCalls: [], validateStatus: Number(localStorage.getItem('mock.validate')) || 200, subscribeStatus: 202, failSheet: 0, rowErrors: {},
    rewards: [{ id: 'rw1', title: '忠誠點轉盤', cost: 500, is_enabled: true, background_color: '#00C7AC' }, { id: 'rw2', title: '喝水', cost: 100, is_enabled: true }],
    redeem(ev) {
      const ws = M.sockets[M.sockets.length - 1];
      ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'notification' }, payload: { subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { redeemed_at: new Date().toISOString(), ...ev } } }) });
    },
  });
  class FakeWS {
    constructor(url) {
      this.url = url; M.sockets.push(this);
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: `S${M.sockets.length}`, keepalive_timeout_seconds: 600 } } }) }), 30);
    }
    close() { this.closed = true; if (this.onclose) setTimeout(() => this.onclose(), 0); }
  }
  window.WebSocket = FakeWS;
  const real = window.fetch.bind(window);
  const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://id.twitch.tv/oauth2/validate')) return M.validateStatus === 200 ? json({ login: 'streamer', user_id: '123', client_id: 'cid', expires_in: 9999 }) : json({ status: 401 }, 401);
    if (url.startsWith('https://api.twitch.tv/helix/users')) return json({ data: [{ display_name: '實況主' }] });
    if (url.startsWith('https://api.twitch.tv/helix/channel_points/custom_rewards')) return json({ data: M.rewards });
    if (url.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions')) { M.subscribed = JSON.parse(opts.body); return json({}, M.subscribeStatus); }
    if (url.startsWith('https://script.google.com/')) {
      const req = JSON.parse(opts.body);
      M.sheetCalls.push(req);
      if (M.failSheet > 0) { M.failSheet--; return Promise.reject(new TypeError('Failed to fetch')); }
      if (req.action === 'ping') return json({ ok: true, title: '轉盤紀錄', viewers: 216, sheet: '10月', columns: { '1點': 'AA', '3點': 'AB', '5點': 'AC' }, problems: [] });
      return json({ ok: true, results: req.records.map((r, i) => (M.rowErrors[r.login] ? { id: r.id, ok: false, error: M.rowErrors[r.login] } : { id: r.id, ok: true, cell: `${Number(r.date.slice(5, 7))}月!AB${3 + i}`, name: `${r.display}(${r.login})`, isNew: r.login === 'newbie' })) });
    }
    return real(url, opts);
  };
}

module.exports = { installMocks };
