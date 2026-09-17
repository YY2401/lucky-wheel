/* 同步頻道：BroadcastChannel（同一個瀏覽器）+ MQTT（跨瀏覽器，例如 Chrome 控制台 ↔ OBS） */
(function () {
  const LW = (window.LW = window.LW || {});
  const { randId, signMessage, verifyMessage } = LuckyCore;

  const Sync = {
    id: randId(10), bc: null, client: null, room: null, secret: '', handlers: [], seen: new Set(), state: 'off', rejected: 0,
    onStatus: null, // (state, room) => void，由頁面決定怎麼顯示
    onReject: null, // 收到簽章不符的訊息時通知（可能有人亂發、或 OBS 網址是舊的）
    start(room, cfg) {
      this.stop();
      this.room = room;
      this.secret = cfg.secret || '';
      this.bc = new BroadcastChannel(`lucky-wheel:${room}`);
      this.bc.onmessage = (e) => this._recv(e.data);
      this.state = 'local';
      if (cfg.sync && window.mqtt) {
        try {
          this.client = mqtt.connect(cfg.broker, { clientId: `lw_${this.id}`, reconnectPeriod: 3000, connectTimeout: 8000, clean: true });
          this.client.on('connect', () => { this._set('online'); this.client.subscribe(this.topic()); });
          this.client.on('message', (t, buf) => { try { this._recv(JSON.parse(buf.toString())); } catch { /* ignore */ } });
          this.client.on('offline', () => this._set('offline'));
          this.client.on('error', () => this._set('offline'));
          this.state = 'connecting';
        } catch { this.state = 'offline'; }
      }
      this._set(this.state);
    },
    stop() { if (this.bc) this.bc.close(); if (this.client) this.client.end(true); this.bc = this.client = null; this.state = 'off'; },
    topic() { return `luckywheel/${this.room}`; },
    async send(msg) {
      msg = { ...msg, from: this.id, mid: randId(10) };
      this.seen.add(msg.mid);
      try { if (this.secret) msg = await signMessage(this.secret, msg); } catch { /* 非安全環境沒有 WebCrypto，只能不簽 */ }
      if (this.bc) this.bc.postMessage(msg);
      if (this.client && this.client.connected) this.client.publish(this.topic(), JSON.stringify(msg));
    },
    on(fn) { this.handlers.push(fn); },
    _set(state) { this.state = state; if (this.onStatus) this.onStatus(state, this.room); },
    async _recv(msg) {
      // 同一則訊息可能同時從 BroadcastChannel 和 MQTT 收到，用 mid 去重
      if (!msg || msg.from === this.id || this.seen.has(msg.mid)) return;
      if (this.secret) {
        let ok = false;
        try { ok = await verifyMessage(this.secret, msg); } catch { ok = false; }
        if (!ok) { this.rejected++; if (this.onReject) this.onReject(msg); return; }
      }
      if (this.seen.has(msg.mid)) return;
      this.seen.add(msg.mid); if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
      this.handlers.forEach((h) => h(msg));
    },
  };

  LW.Sync = Sync;
})();
