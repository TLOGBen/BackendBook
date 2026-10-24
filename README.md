# 後端基本功

給新進後端工程師的 50 個基本功主題：並行與交易、資料庫效能、schema 演進、資料庫擴展、快取、重試與容錯、流量與擴展、非同步處理、分散式一致性、上線維運。

文章原稿在 [`docs/`](docs/)，用 [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) 建成網站，push 到 `main` 後由 GitLab CI 發布到 GitLab Pages。

## 在本機預覽

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/mkdocs serve
```

Windows 上把 `.venv/bin/` 換成 `.venv\Scripts\`。打開 <http://127.0.0.1:8000> 就能看到網站，改了 `docs/` 裡的檔案會自動重新整理。

## 部署到 GitLab Pages

- 每次 push 到 `main`，`.gitlab-ci.yml` 的 `pages` job 會用 `mkdocs build --strict` 建置，並把結果發布到 GitLab Pages。連結壞掉時建置會失敗，不會發布出壞掉的網站。
- push 到其他分支時只跑 `check` job，確認建置會過，不會發布。
- 網站網址在專案的 **Deploy → Pages** 頁面。如果看不到這個選項，代表這台 GitLab 沒有開 Pages 功能，要請管理員開啟。

## 改文章時

- 文章之間用相對連結，例如 `[死鎖](02-死鎖.md)`。檔名有空白時寫成 `%20`，例如 `[N+1 查詢](09-N+1%20查詢.md)`。
- 摺疊的答案寫成 `<details markdown="1"><summary>看答案</summary> … </details>`。`markdown="1"` 不能拿掉，少了它，答案裡的 Markdown 不會被轉換。
- 圖用 Mermaid。節點文字含中文、括號、冒號時用雙引號包起來。
- 新增文章要同時加進 `mkdocs.yml` 的 `nav`。
