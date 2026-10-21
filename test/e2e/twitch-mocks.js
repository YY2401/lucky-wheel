'use strict';
/* 忠誠點轉盤 e2e 與說明書截圖共用的模擬：Twitch API / EventSub / Apps Script */
// 在頁面任何程式執行前裝上模擬：fetch（Twitch、Apps Script）與 WebSocket（EventSub）
// 跨重新整理要保留的模擬狀態放 localStorage：mock.validate（401＝過期）、mock.scopes（read＝舊版授權）、mock.unfulfilled（Twitch 上未完成的兌換）
function installMocks() {
  const ls = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
  const M = (window.__tw = {
    sockets: [], sheetCalls: [], patches: [], created: [], validateStatus: Number(localStorage.getItem('mock.validate')) || 200, subscribeStatus: 202, failSheet: 0, rowErrors: {},
    scopes: localStorage.getItem('mock.scopes') === 'read' ? ['channel:read:redemptions'] : ['channel:manage:redemptions', 'channel:read:redemptions'],
    rewards: [
      { id: 'rw1', title: '忠誠點轉盤', cost: 500, is_enabled: true, background_color: '#00C7AC', managed: true },
      { id: 'rw2', title: '喝水', cost: 100, is_enabled: true, background_color: '#9146FF' },
    ],
    unfulfilled: ls('mock.unfulfilled', []), // Twitch 上狀態還是「未完成」的兌換
    redeem(ev) {
      const full = { redeemed_at: new Date().toISOString(), ...ev };
      if (M.rewards.some((r) => r.managed && r.id === ev.reward.id)) M.unfulfilled.push({ ...full, status: 'UNFULFILLED' });
      const ws = M.sockets[M.sockets.length - 1];
      ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'notification' }, payload: { subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: full } }) });
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
  const pub = (r) => { const { managed, ...rest } = r; void managed; return { ...rest, should_redemptions_skip_request_queue: false }; };
  window.fetch = (url, opts = {}) => {
    url = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const q = url.includes('?') ? new URLSearchParams(url.split('?')[1]) : new URLSearchParams();
    if (url.startsWith('https://id.twitch.tv/oauth2/validate')) return M.validateStatus === 200 ? json({ login: 'streamer', user_id: '123', client_id: 'cid', scopes: M.scopes, expires_in: 9999 }) : json({ status: 401 }, 401);
    if (url.startsWith('https://api.twitch.tv/helix/users?login=')) { const l = q.get('login'); return json({ data: l === 'nobody' ? [] : [{ login: l, display_name: l.toUpperCase(), id: `9${l.length}` }] }); }
    if (url.startsWith('https://api.twitch.tv/helix/users')) return json({ data: [{ display_name: '實況主' }] });
    if (url.startsWith('https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions')) {
      if (method === 'GET') return json({ data: M.unfulfilled.filter((x) => x.reward.id === q.get('reward_id')), pagination: {} });
      const ids = q.getAll('id'); const status = JSON.parse(opts.body).status;
      M.patches.push({ rewardId: q.get('reward_id'), ids, status });
      if (!M.rewards.some((r) => r.managed && r.id === q.get('reward_id'))) return json({ message: 'not created by this client' }, 403);
      const hit = M.unfulfilled.filter((x) => ids.includes(x.id));
      M.unfulfilled = M.unfulfilled.filter((x) => !ids.includes(x.id));
      return hit.length ? json({ data: hit.map((x) => ({ ...x, status })) }) : json({ message: 'not found' }, 404);
    }
    if (url.startsWith('https://api.twitch.tv/helix/channel_points/custom_rewards')) {
      if (method === 'POST') {
        const b = JSON.parse(opts.body);
        if (M.rewards.some((r) => r.title === b.title)) return json({ message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD' }, 400);
        const r = { id: `new${M.rewards.length}`, input: !!b.is_user_input_required, title: b.title, cost: b.cost, is_enabled: true, background_color: '#FFCF33', managed: true };
        M.rewards.push(r); M.created.push(b);
        return json({ data: [pub(r)] });
      }
      const list = q.get('only_manageable_rewards') === 'true' ? M.rewards.filter((r) => r.managed) : M.rewards;
      return json({ data: list.map(pub) });
    }
    if (url.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions')) { M.subscribed = JSON.parse(opts.body); return json({}, M.subscribeStatus); }
    if (url.startsWith('https://script.google.com/')) {
      const req = JSON.parse(opts.body);
      M.sheetCalls.push(req);
      if (M.failSheet > 0) { M.failSheet--; return Promise.reject(new TypeError('Failed to fetch')); }
      if (req.action === 'ping') return json({ ok: true, title: '轉盤紀錄', viewers: 216, sheet: '10月', columns: { '1點': 'AA', '3點': 'AB', '5點': 'AC' }, heads: ['1點', '3點', '5點', 'Q版塗鴉', '新欄位'], noLogin: ['幽璃ゆうり'], problems: [] });
      if (req.action === 'move') return json({ ok: true, results: req.records.map((r) => ({ id: r.id, ok: true, cell: `10月!AB${50}`, name: `${r.to.display}(${r.to.login})` })) });
      return json({ ok: true, results: req.records.map((r, i) => (M.rowErrors[r.login] ? { id: r.id, ok: false, error: M.rowErrors[r.login] } : { id: r.id, ok: true, cell: `${Number(r.date.slice(5, 7))}月!AB${3 + i}`, name: `${r.display}(${r.login})`, isNew: r.login === 'newbie' })) });
    }
    return real(url, opts);
  };
}

module.exports = { installMocks };
