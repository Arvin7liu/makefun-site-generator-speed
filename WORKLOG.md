# WORKLOG — make.fun「Build a static site faster, 22 November 2026」參賽準備

賽事：https://make.fun/bounty/site-generator-speed-01-run-20261122
截止：2026-11-25 04:00（台北時間，UTC+8）＝ 2026-11-24T20:00Z。本機收尾目標 02:30（台北時間）。
範圍：只在本機準備，**不提交、不註冊、不登入、不建遠端、不推送**。不安裝 make.fun skill／MCP，不用推薦連結，不碰 makefunai.fun。
所有時間皆為台北時間（UTC+8）。

## 2026-11-24 18:20 開工
- 讀首輪掃描筆記 `/workspace/startup/onchain_contests_2026-11-24.md` 與公開 API 備份 `scan-2026-11-24/`。
- 公開 kit 下載（不需登入）：
  `curl -sSL -o kit.tar.gz https://make.fun/c/site-generator-speed-01-run-20261122/kit`
  sha256(kit.tar.gz) = 80ecd94c6e754842f377769e2f6c9343c46d312db99de78b09cb373101f88e1f；kit.json bundle_sha256 = 2850d1b8…a6074b 那份清單。
  解到 `kit/`（不納入 git：17 MB 的 CLI 與 harness 原始碼，可重下）。
- 規則重點（RULES.txt）：solve.js（run(input)）+ main.ts；Node 22（grader 用 22.23.4）；1 CPU、1 GB、10 s 牆鐘；每個 entry 跑兩次須位元組一致；
  比 CPU 時間（扣掉空 entry 對照，9 次 timed 取 trimmed mean）；要以 95% 信心勝過基準才有獎；repo ≤ 4 MiB；本賽 transcripts 為選填（no transcript gate）。
  評分只看 answers.json（JSON 值相等，物件 key 順序不計）。
- 工具：box 上原本是 Node 24，另下載官方 Node v22.23.4（sha256 已核）到 /workspace/tools/node22；apt 安裝 docker.io 並起 dockerd，供官方 grade-local --driver docker。

## 18:25 基準量測（本機，taskset 綁 1 核，`python3 bench/time.py <bot> 7 --pin`）
- 基準 makefun-site 1.0.0：trimmed mean ≈ 860 ms CPU（min 828）。
- 空程式（只啟動 node）≈ 52 ms；只讀 JSON 輸入 ≈ 85 ms。
- 單跑 build ≈ 410–490 ms，JSON.stringify 輸出（7.4 MB）≈ 70–110 ms。
- CPU profile（`node --cpu-prof`）：escapeHtml 183 ms（inline Markdown 逐字呼叫 regex replace）、GC 64 ms、inline 45 ms、renderMarkdown 40 ms、renderNodes 22 ms、wordsOf 19 ms。

## 設計決策（18:35）
1. 自寫一份語意相同的實作（不背練習題、不特判）：
   - escapeHtml：先掃描是否有 & < > " '，沒有就原樣回傳；有才逐段切片拼接。
   - inline Markdown：一般字元整段切片後一次 escape，而不是逐字；`**`／`]` 的尋找用 indexOf 快路徑（區間內沒有反斜線才採用，否則退回逐字掃描）。
   - 區塊 lexer：用首字元分流，只在可能命中時才跑原本的 regex（保留 `.` 不吃 U+2028/2029 等細節）。
   - 模板：解析成節點樹，渲染時對 include／for 節點做「同一次 build 內」的記憶化：以節點的自由變數（靜態分析＋include 不動點）在當下 scope 解析出的值（物件身分）為 key；只有 site／tags／recent 或迴圈元素這類跨頁共用的值才記憶，page／pager／loop 等每頁唯一的值直接不記。同一 case 內有效，case 之間不共享（符合「nothing cached from one case to the next」）。
   - slugify：ASCII 快路徑；同一 build 內記憶。
2. 以官方 generator（program/generator/subject/sites.mjs）用大量隨機 seed 產生網站，逐 case 與官方 oracle 比對（canonical JSON），外加手寫邊界案例與隨機變異模板／Markdown 的 fuzz。

## 18:37 v1 → v2（時間以 git commit 時間為準）
- v1（commit 368bdd8）：練習集 3/3 正確；`bench/time.py entry 9 --pin` trimmed mean ≈ 509 ms（基準 860 ms）。
- 差異測試：`test/fuzz-gen.mjs`（官方 generator，隨機 seed，240 seeds × 3 = 720 個網站）0 失敗；`test/fuzz-edge.mjs`（自寫對抗式網站：壞模板、怪 Markdown、Unicode、U+2028、`__proto__` 等）2 萬個網站 0 失敗。
  變異測試（故意改壞 4 處）四個都被 fuzz-edge 抓到，確認測試有鑑別力。
- v2：模板直接在「JSON 字串轉義域」渲染（文字節點預先轉義、記憶化存轉義後片段），answers.json 直接拼成純 ASCII JSON（非 ASCII 一律 \uXXXX），以 latin1 寫出；省去 JSON.stringify 7.4 MB 與 UTF-8 轉碼。run(input) 仍回傳物件（= JSON.parse(runJSON(input))）。
  量測 ≈ 474 ms（雜訊 ±20 ms）。
- V8 旗標掃描（semi-space、maglev、sparkplug、單執行緒 GC 等）：差異都在雜訊內，暫不採用。
- 關鍵發現：以 /proc/self/task 量各執行緒 CPU，主執行緒約 200 ms，另外 4 條 V8 背景執行緒合計約 150 ms，主要是 TurboFan 編譯（inline/renderMarkdown/renderNodes 各 10–15 ms、且因 deopt 重編多次）。
  判斷：1 CPU 計時下，JIT 編譯成本跟實際工作同量級，下一步要減少 deopt（越界 charCodeAt、閉包呼叫目標變動、物件形狀多型）並讓熱函式變小。

## 18:40–18:52 v3 → v6（台北時間，依 git commit 時間）
新增 `bench/ab.py`：多個版本交錯、隨機順序執行整支 `node main.ts`（綁 1 核），比 trimmed mean 與單尾 Welch t，避免機器漂移造成誤判（本機雜訊 ±20–50 ms）。

| 版本 | commit | 改動 | ab.py 結果（同輪比較） |
| --- | --- | --- | --- |
| v3 | 9b3f6e3 | 模板節點與 scope 單一形狀、link/slug 改模組層函式（呼叫目標穩定）、charCodeAt 加邊界防止越界 deopt；加 `--no-turbo-inlining` | 360 ms vs 基準 782 ms（2.17×）；同碼不加旗標 403 ms |
| v4/v5 | dc4cc29 | Markdown 直接產生 JSON 轉義字串、記憶片段先 flatten、寫入改單一 buffer | 372 vs v3 375（持平） |
| v6 | 7ba424f | 整份答案逐位元組寫進一個 Buffer（JSON 轉義、純 ASCII），完全不產生輸出字串；Markdown 就地從原文讀行、直接寫進內容 buffer；記憶化存位元組區間、命中時 memcpy | **302 ms vs v5 358 ms vs 基準 754 ms（2.5×）** |

- `--no-turbo-inlining` 的理由：1 CPU 下 V8 背景執行緒（TurboFan 編譯）的 CPU 也被計時；inlining 讓每次最佳化編譯大好幾倍，而這支程式只跑 0.3 秒，回收不了。其他旗標（maglev/sparkplug/OSR 門檻、semi-space、效率模式）A/B 都在雜訊內，不採用。
- 每版都過：練習集 3/3、fuzz-gen、fuzz-edge（v6 再跑 300 seeds × 3 + 4 萬個對抗網站，背景執行中）。
- 正確性細節（v6 串流輸出時保留參考版語意）：靜態檔 `__proto__` 不寫出也不報（參考版 `output['__proto__']=…` 是 no-op）；靜態檔名 `build-report.txt` 由報告覆蓋；與已建頁面同路徑的靜態檔報 shadowed、不覆蓋（以 written Set 判斷）。

## 18:53–19:08 v7、v8、正式 grade-local 與提交前檢查（台北時間）
- 剖析（`--cpu-prof`，steady6.mjs 熱身後每站約 36 ms）：putEsc 28%、inline 23%、wordsOf 10%。
  - v7（48e109a）：inline 改成一趟：純文字邊讀邊做 HTML+JSON 轉義直接寫進 C，不再先找區段再交給 putEsc 第二趟；wordsOf 改成少分支寫法。熱身後每站 ~36 → ~27 ms；整支 A/B：v6 340.7 → v7 329.8 ms（t=2.5）。fuzz-edge 原子加入控制字元、DEL、CR、雙反斜線；突變測試（讓 \u0001 不轉義）會被抓到。
  - 冷啟動時 inline/wordsOf 大多在 Sparkplug/Maglev 跑，TurboFan 編譯在背景執行緒也被算 CPU。調 tier-up 門檻：提早（turbofan 1000/500、maglev 100）都更慢；**延後** TurboFan（`--invocation-count-for-turbofan=24000 --invocation-count-for-osr=6000`）練習集 332 → 311 ms（t=3.9）、另一組公開產生器資料（bench/alt-input，`node bench/mkalt.mjs`）339 → 322 ms。12k 以上持平；延後後再開 inlining 反而慢 15%。→ v8（c1acad0）。
- 正確性（v7/v8 程式碼）：練習集 3/3；fuzz-gen seeds 3000..3299（900 站）0 失敗；fuzz-edge seeds 200、201 各 2 萬站 + 300（6000 站，新原子）0 失敗。v6 另有 seeds 2000..2299 + edge 100/101 各 2 萬站 0 失敗。
- **官方 grade-local（docker）**：`cd kit && node cli/makefun.mjs grade-local --kit . --bot ../entry --worktree --driver docker` → status finished，cases_passed 3/3，passed 1，L1 regrade reproduced byte for byte，eligible ranked yes / prize yes，result_sha256 cf5a3e21413d2aba0be4209a20663747de7a24832e48484fca9ab4cd696f3942（bench/grade-v8.log）。附註：本機 harness 是 node v22.23.4，伺服器 harness 是 v26.13.1，所以 result_sha256 不會等於伺服器的。
- **提交前檢查**：`node cli/makefun.mjs check --kit . --repo ../entry --worktree`（無登入、無金鑰）→ 5 pass、0 fail；加了 entry/LICENSE（MIT，含 SPDX 行）。剩下只在提交時才驗的 5 項：repo_public、repo_owner（GitHub 擁有者 = 帳號綁的 GitHub，或提交 .makefun/owner.json 寫帳號的錢包）、repo_created_after_open（2026-11-23 04:00 台北之後新建的 repo）、commit_in_repo、duplicate_snapshot（bench/check-v8.log）。
- **最終計時**（`CPU=5 python3 bench/ab.py 16 …`，交錯隨機順序、綁 1 核，bench/final-ab-practice.txt / final-ab-alt.txt）：

| 輸入 | 基準 makefun-site | 空作品（只讀 JSON） | v3 | v6 | v7 | **v8** |
| --- | --- | --- | --- | --- | --- | --- |
| 練習集 | 839.4 ms | 83.5 | 386.8 | 320.0 | 302.2 | **287.3 ms（2.92×；扣空作品 756 → 204，3.7×）** |
| alt-input | 971.7 ms | 86.3 | | | | **316.1 ms（3.07×；扣空作品 885 → 230，3.85×）** |
