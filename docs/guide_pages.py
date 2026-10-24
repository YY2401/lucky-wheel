"""找出說明書每個設定步驟在第幾頁，寫成 docs/guide-pages.json，給網頁的「看圖解」連結用。
由 docs/build-guide.js 產生 PDF 後自動執行；說明書改版頁碼變了也會跟著更新。"""
import json, os, re, sys
import pypdfium2 as pdfium

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, '忠誠點轉盤使用說明.pdf')
# 章節標題開頭 → 網頁上的步驟
WANT = {'step1': '設定步驟 1', 'step2': '設定步驟 2', 'step3': '設定步驟 3', 'step4': '設定步驟 4', 'step5': '設定步驟 5', 'step6': '設定步驟 6', 'step7': '設定步驟 7', 'step8': '設定步驟 8', 'step9': '設定步驟 9', 'faq': '出問題怎麼辦'}

doc = pdfium.PdfDocument(PDF)
found = {}
for i in range(len(doc)):
    text = doc[i].get_textpage().get_text_range()
    head = re.sub(r'\s+', ' ', text[:200])  # 章節標題在頁首
    for key, title in WANT.items():
        if key not in found and title in head and i > 2:  # 跳過封面與目錄
            found[key] = i + 1
missing = [k for k in WANT if k not in found]
if missing:
    sys.exit(f'找不到這些章節的頁碼：{missing}')
with open(os.path.join(HERE, 'guide-pages.json'), 'w', encoding='utf-8') as f:
    json.dump(found, f, ensure_ascii=False)
print('guide-pages.json', found)
