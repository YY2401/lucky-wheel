/* 進入點：載入儲存層後，依網址決定啟動控制台或 OBS 覆蓋層 */
(async () => {
  const { Store, KEYS, ui } = window.LW;
  Store.onError = (e) => ui.toast(`儲存失敗：${e.message}`, 6000);
  await Store.init([KEYS.config, KEYS.records, KEYS.stockLog, KEYS.overlayConfig, KEYS.skipAnim, KEYS.prizeList, KEYS.meta]);

  const params = new URLSearchParams(location.search);
  if (params.get('overlay') === '1') LW.startOverlay(params);
  else LW.startControl();
})();
