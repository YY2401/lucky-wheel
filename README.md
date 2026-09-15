# 🎡 Lucky Wheel — 直播用網頁幸運轉盤

動態機率 × 獎項庫存 × 連抽 × OBS 透明覆蓋層 × 自動寫入 Excel。

## 功能

- **動態機率**：每個獎項設定「權重」，機率 = 權重 ÷ 所有還有庫存獎項的權重總和。抽完的獎項自動退出抽獎池，其餘獎項機率即時重新分配。
- **獎項數量**：可設定限量（抽完為止）或無限；剩餘數量可手動調整、一鍵重置庫存。
- **圖片**：每個獎項可上傳圖片（自動縮圖）或填圖片網址，顯示在轉盤扇區與結果卡上。
- **互動動畫**：Canvas 轉盤、LED 跑燈、指針彈跳、滴答音效、中獎音效、彩帶。
- **連抽**：單抽 / 三連抽 / 五連抽 / 十連抽 / 自訂連抽（最多 100）。可選「快速模式」只轉一次直接顯示全部結果，也可中途「跳過動畫」。
- **OBS 覆蓋層**：透明背景頁面，透過 SSE 與控制台即時同步；在控制台按抽獎，OBS 畫面同步轉動並顯示結果卡。
- **Excel 紀錄**：每次抽獎即時附加到指定的 `.xlsx`（路徑可自訂，可放桌面或任何位置），同時保留 `records.json` 備份，可隨時重建 Excel。
- **外部觸發**：`GET /api/spin?count=1&player=名字`，可接 Stream Deck、聊天機器人等。

## 安裝與啟動

需要 Node.js 18+。

```bash
npm install
npm start
```

- 控制台：<http://localhost:3000/>
- OBS 覆蓋層：<http://localhost:3000/overlay.html>

改連接埠：`PORT=8080 npm start`

## 使用方式

1. 開啟控制台 → 「獎項設定」：編輯名稱、權重、數量、顏色、圖片，按「儲存設定」。
2. 「設定 / OBS」：調整轉動時間、圈數、扇區顯示方式、Excel 路徑、音效。
3. 輸入抽獎者名稱（選填，會寫進 Excel），按「單抽」或連抽按鈕。空白鍵也可單抽。
4. 「抽獎紀錄」可查看所有紀錄、依紀錄重建 Excel、清除紀錄。

## OBS 設定

1. OBS → 來源 → ＋ → **瀏覽器**
2. 網址：`http://localhost:3000/overlay.html`
3. 寬 / 高建議 1280 × 720 以上，背景已是透明。
4. 在控制台抽獎，OBS 畫面會同步。

覆蓋層網址參數：

| 參數 | 說明 | 範例 |
| --- | --- | --- |
| `size` | 轉盤像素大小（預設 520） | `?size=600` |
| `mode=spin` | 平常隱藏轉盤，只在抽獎時淡入 | `?mode=spin` |
| `hide` | 結果卡顯示秒數（預設用控制台設定） | `?hide=10` |
| `sound=0` | 關閉覆蓋層音效 | `?sound=0` |

組合範例：`http://localhost:3000/overlay.html?size=600&mode=spin&hide=10`

## Excel

- 預設寫到 `data/records.xlsx`，可在「設定」改為絕對路徑，例如 `/Users/你的名字/Desktop/抽獎紀錄.xlsx`。
- 工作表名稱 `抽獎紀錄`，欄位：時間、批次ID、抽獎類型、第幾抽、抽獎者/備註、獎項、獎項ID、剩餘數量、當時機率(%)。
- 若 Excel 檔正被 Excel 程式開啟（Windows 會鎖檔）導致寫入失敗，紀錄仍會保存在 `data/records.json`，關閉檔案後到「抽獎紀錄」按「依紀錄重建 Excel」即可補回。

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/config` | 取得設定 |
| PUT | `/api/config` | 更新設定（JSON） |
| POST / GET | `/api/spin` | 抽獎，參數 `count`（1–100）、`player` |
| POST | `/api/reset-stock` | 重置所有獎項庫存 |
| GET | `/api/records?limit=200` | 抽獎紀錄 |
| DELETE | `/api/records` | 清除紀錄 |
| POST | `/api/export` | 依紀錄重建 Excel |
| POST | `/api/upload` | 上傳圖片（data URL） |
| GET | `/api/events` | SSE 事件流（`hello` / `config` / `spin`） |
| GET | `/api/status` | 狀態與目前機率 |

## 專案結構

```
server.js            後端：抽獎邏輯、庫存、Excel、SSE
public/
  index.html, app.js 控制台
  overlay.html, overlay.js  OBS 覆蓋層
  wheel.js           共用轉盤引擎（繪製、動畫、音效、彩帶）
  style.css
  uploads/           上傳的獎項圖片
data/
  config.json        設定（自動產生）
  records.json       紀錄備份（自動產生）
  records.xlsx       預設 Excel 輸出
```
