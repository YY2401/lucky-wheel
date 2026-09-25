/* Excel：用 File System Access API 綁定一個 .xlsx，每次抽獎把完整紀錄重寫進「抽獎紀錄」與「庫存異動」工作表（其他工作表保留） */
(function () {
  const LW = (window.LW = window.LW || {});
  const { formatTime, stockNum, stockDelta } = LuckyCore;
  const SHEET = '抽獎紀錄';
  const HEADERS = ['時間', '批次ID', '抽獎類型', '第幾抽', '抽獎者/備註', '獎項', '獎項ID', '剩餘數量', '當時機率(%)', '保底', '狀態', '備註'];
  const COL_WIDTHS = [20, 22, 10, 8, 20, 24, 14, 10, 12, 8, 8, 18];
  // 抽獎以外的庫存變化另開一張工作表，對帳時才看得出「少掉的庫存是抽走的還是被改掉的」
  const STOCK_SHEET = '庫存異動';
  const STOCK_HEADERS = ['時間', '獎項', '獎項ID', '原因', '數量（改前）', '數量（改後）', '剩餘（改前）', '剩餘（改後）', '增減'];
  const STOCK_WIDTHS = [20, 24, 14, 14, 14, 14, 14, 14, 8];

  const Excel = {
    handle: null,
    lastWrite: null,
    supported: typeof window.showSaveFilePicker === 'function',
    types: [{ description: 'Excel 活頁簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
    getRecords: () => [],
    getStockLog: () => [],
    onChange: null, // 綁定 / 寫入後通知頁面更新顯示

    async init({ getRecords, getStockLog, onChange }) {
      this.getRecords = getRecords; if (getStockLog) this.getStockLog = getStockLog; this.onChange = onChange;
      try { this.handle = (await LW.idb.get(LW.KEYS.excelHandle)) || null; } catch { this.handle = null; }
      this._changed();
    },
    async create() {
      this.handle = await window.showSaveFilePicker({ suggestedName: '抽獎紀錄.xlsx', types: this.types });
      await LW.idb.set(LW.KEYS.excelHandle, this.handle); this._changed();
      return this.writeAll();
    },
    async open() {
      [this.handle] = await window.showOpenFilePicker({ types: this.types, multiple: false });
      await LW.idb.set(LW.KEYS.excelHandle, this.handle); this._changed();
      return this.writeAll();
    },
    async forget() { this.handle = null; await LW.idb.del(LW.KEYS.excelHandle); this._changed(); },
    // 重新整理後權限會被收回，需在使用者點擊後立即詢問
    async ensurePermission() {
      if (!this.handle) return false;
      let p = await this.handle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted') p = await this.handle.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    },
    rows() { return this.getRecords().map((r) => [r.time, r.batchId, r.type, r.index, r.player, r.prize, r.prizeId, r.remaining === -1 ? '無限' : r.remaining, r.probability, r.pity ? '是' : '', r.void ? '作廢' : '正常', r.note || '']); },
    stockRows() { return this.getStockLog().map((e) => [e.time, e.prize, e.prizeId, e.reason, stockNum(e.qtyFrom), stockNum(e.qtyTo), stockNum(e.remFrom), stockNum(e.remTo), stockDelta(e)]); },
    buildWorkbook(existing) {
      let wb = null;
      if (existing) { try { wb = XLSX.read(existing, { type: 'array' }); } catch { wb = null; } }
      if (!wb) wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...this.rows()]);
      ws['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));
      if (wb.SheetNames.includes(SHEET)) wb.Sheets[SHEET] = ws; else XLSX.utils.book_append_sheet(wb, ws, SHEET);
      const log = this.stockRows();
      if (log.length || wb.SheetNames.includes(STOCK_SHEET)) {
        const ws2 = XLSX.utils.aoa_to_sheet([STOCK_HEADERS, ...log]);
        ws2['!cols'] = STOCK_WIDTHS.map((wch) => ({ wch }));
        if (wb.SheetNames.includes(STOCK_SHEET)) wb.Sheets[STOCK_SHEET] = ws2; else XLSX.utils.book_append_sheet(wb, ws2, STOCK_SHEET);
      }
      return wb;
    },
    async writeAll() {
      if (!this.handle) return { ok: false, skipped: true };
      if (!(await this.ensurePermission())) return { ok: false, error: '未取得寫入權限' };
      let existing = null;
      try { const f = await this.handle.getFile(); if (f.size > 0) existing = await f.arrayBuffer(); } catch { existing = null; }
      const out = XLSX.write(this.buildWorkbook(existing), { type: 'array', bookType: 'xlsx' });
      const w = await this.handle.createWritable();
      await w.write(out); await w.close();
      this.lastWrite = new Date(); this._changed();
      return { ok: true, name: this.handle.name };
    },
    download() { XLSX.writeFile(this.buildWorkbook(), `抽獎紀錄_${formatTime(new Date()).replace(/[-: ]/g, '')}.xlsx`); },
    statusText() {
      if (!this.supported) return '此瀏覽器不支援直接寫入檔案（請用 Chrome / Edge）；仍可用「下載 Excel」取得紀錄。';
      return this.handle
        ? `已綁定：${this.handle.name}${this.lastWrite ? `（最後寫入 ${formatTime(this.lastWrite)}）` : ''}`
        : '尚未綁定 Excel 檔案。按「建立新的 Excel」選擇存放位置，之後每次抽獎會自動寫入。';
    },
    _changed() { if (this.onChange) this.onChange(this); },
  };

  LW.Excel = Excel;
})();
