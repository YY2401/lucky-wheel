/* 同步頻道：BroadcastChannel（同一個瀏覽器）+ MQTT（跨瀏覽器，例如 Chrome 控制台 ↔ OBS） */
(function () {
  const LW = (window.LW = window.LW || {});
  const { randId, signMessage, verifyMessage } = LuckyCore;

  // 預設的公開中繼伺服器有時候連不上（某些網路、DNS 查不到）：同時連一台備援，訊息兩邊都送，收到重複的用 mid 去掉
  const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
  const BACKUP_BROKERS = ['wss://broker.hivemq.com:8884/mqtt'];

  const Sync = {
    id: randId(10), bc: null, clients: [], room: null, secret: '', handlers: [], seen: new Set(), state: 'off', rejected: 0,
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
        // 自訂的中繼伺服器（可能是私人的）就只用它；用預設的才加備援
        const brokers = !cfg.broker || cfg.broker === DEFAULT_BROKER ? [DEFAULT_BROKER, ...BACKUP_BROKERS] : [cfg.broker];
        brokers.forEach((url, i) => {
          try {
            const c = mqtt.connect(url, { clientId: `lw_${this.id}_${i}`, reconnectPeriod: 3000, connectTimeout: 8000, clean: true });
            c.on('connect', () => { c.subscribe(this.topic()); this._update(); });
            c.on('message', (t, buf) => { try { this._recv(JSON.parse(buf.toString())); } catch { /* ignore */ } });
            c.on('offline', () => this._update());
            c.on('error', () => this._update());
            c.on('close', () => this._update());
            this.clients.push(c);
          } catch { /* 這台連不上就算了，還有別台 */ }
        });
        this.state = this.clients.length ? 'connecting' : 'offline';
      }
      this._set(this.state);
    },
    // 任何一台連上就算連線中；全部都斷才算離線
    _update() {
      if (!this.clients.length) return;
      this._set(this.clients.some((c) => c.connected) ? 'online' : 'offline');
    },
    stop() { if (this.bc) this.bc.close(); this.clients.forEach((c) => c.end(true)); this.bc = null; this.clients = []; this.state = 'off'; },
    topic() { return `luckywheel/${this.room}`; },
    async send(msg) {
      msg = { ...msg, from: this.id, mid: randId(10) };
      this.seen.add(msg.mid);
      try { if (this.secret) msg = await signMessage(this.secret, msg); } catch { /* 非安全環境沒有 WebCrypto，只能不簽 */ }
      if (this.bc) this.bc.postMessage(msg);
      const body = JSON.stringify(msg);
      this.clients.forEach((c) => { if (c.connected) c.publish(this.topic(), body); });
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
