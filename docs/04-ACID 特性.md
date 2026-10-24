# 04｜ACID 特性（ACID）

> ACID 是資料庫對[交易](03-資料庫交易.md)（用 `BEGIN` 到 `COMMIT` 綁成一包的一組 SQL）的四個承諾：一包裡的修改要嘛全做、要嘛全不做；不會寫進違反規則的資料；同時進行的交易不互相干擾；確認成功之後，就不會因為當機而消失。

**難度**：★★☆　**閱讀時間**：約 20 分鐘　**前置知識**：[資料庫交易](03-資料庫交易.md)；讀過[競爭條件](01-競爭條件.md)更好

## 核心問題與理念

**它要解決的問題**：兌換優惠券要扣點數、發券、記點數紀錄三件事，程式卻讓每一句 SQL 送出就各自生效。部署新版時程式被砍在中間，37 位會員的點數扣了，券或點數紀錄卻缺一樣，資料庫這邊每一句都顯示成功（下面的情境會完整走一遍）。

**核心理念**：該一起成功的寫入要放進同一筆交易，資料庫才會替它們守住這四個承諾。

**想通的那一步**：

- **卡住的地方**：要做到「說成功了就不會丟」，直覺的做法是每次 commit（確認交易生效）都把改到的資料頁寫回磁碟（資料頁是資料在磁碟上存放的單位）。可是資料頁散在磁碟各處，到處跳著寫很慢，而且一頁寫到一半斷電，那一頁就毀了。
- **火花**：先把「改了什麼」依序接在一本日誌（WAL）的尾巴，日誌確定寫進磁碟就回報成功，資料頁之後再慢慢寫回；當機重啟時，照日誌把修改重做一遍。只往尾巴接著寫很快，安全和速度就同時顧到了。

| 字母 | 解決什麼 | 核心想法 |
|---|---|---|
| A 原子性 | 做到一半被砍，資料停在一半 | 沒 commit 的修改，就當作沒發生 |
| C 一致性 | 寫進違反規則的資料，例如餘額變負數 | 規則寫進 schema（建表時宣告的欄位和約束），資料庫每次寫入都幫你擋 |
| I 隔離性 | 同時跑的交易互相看到、互相蓋掉 | 每筆交易讀自己的快照（某個時間點的資料內容），改同一列要排隊 |
| D 持久性 | 回報成功之後當機，資料不見 | 先把修改記進磁碟上的日誌，再回報成功 |

## 閱讀前推薦具備知識

| 知識 | 要會到什麼程度 | 這篇哪裡會用到 | 不熟的話先看 |
|---|---|---|---|
| [資料庫交易](03-資料庫交易.md) | **必備**：能說出 autocommit 下每句 SQL 自己就是一個交易，要用 `BEGIN`…`COMMIT`（Python 裡是 `with conn.transaction():`）才能把幾句綁成一包 | 情境裡三句各自 commit、〈A 原子性〉、地雷 1 | 本系列第 03 篇〈自動提交（autocommit）〉 |
| SQL 建表與約束 | **加分**：看得懂 `balance int NOT NULL CHECK (balance >= 0)` 在限制什麼 | 〈C 一致性〉，以及「動手看看」第 1、3 步 | [PostgreSQL 官方教學](https://www.postgresql.org/docs/current/tutorial.html) 第 2 章；各種約束本篇〈C 一致性〉有一張表 |
| 記憶體和磁碟的差別 | **加分**：能說出放在記憶體裡的資料，程序被砍或斷電就沒了，寫進磁碟的才留得住 | 〈D 持久性：WAL 和 fsync〉、「動手看看」第 5 步 | 本篇〈D 持久性〉會順帶解釋 |
| [競爭條件](01-競爭條件.md) | **加分**：知道兩個請求可以同時通過 Python 裡的 `if balance >= amount` 檢查 | 〈C 一致性〉最後一段、地雷 2 | 本系列第 01 篇 |
| Docker 基本指令 | **加分**：會用 `docker run`、`docker exec`，知道 `docker kill` 會直接砍掉容器裡的程序 | 「動手看看」第 5 步模擬當機、第 6 步跑 pgbench | [Docker 入門](https://docs.docker.com/get-started/) |

**快速自我檢查**：在 psql 裡下 `BEGIN;`，接著 `UPDATE members SET points = points - 500 WHERE id = 7;`，沒下 `COMMIT` 就把視窗關掉。重新連進來查，會員 7 的點數少了 500 嗎？如果一開始沒有下 `BEGIN` 呢？

<details markdown="1"><summary>看答案</summary>

有 `BEGIN` 的那次不會少：交易沒 `COMMIT` 就斷線，資料庫會把它回滾。沒下 `BEGIN` 的那次會少：psql 預設 autocommit，這句執行完就提交了，關視窗也不會退回。這篇的 ACID 都建立在「哪幾句在同一筆交易裡」這件事上。答不出來也沒關係，先看 03〈自動提交（autocommit）〉那一節。

</details>

## 為什麼要在意：一個具體的情境

這是一個假設情境。你負責電商的「點數兌換優惠券」功能，後端用 Python + psycopg 3，資料庫是 PostgreSQL。會員按下「用 500 點換一張券」，後端要做三件事：扣點數、發一張券、記一筆點數紀錄。

專案的資料庫連線設定是 `autocommit=True`，因為之前有人嫌「忘記 commit 結果查不到資料」很煩，就整個專案打開了。autocommit 的意思是：沒有明確開交易的話，每一句 SQL 送出去就自己 commit。兌換的函式 `redeem_coupon()` 裡依序寫了三行 `conn.execute(...)`，外面沒有包 `with conn.transaction():`：

1. `UPDATE members` 扣 500 點，送出後馬上 commit。
2. `INSERT INTO coupons` 發一張券，送出後馬上 commit。
3. `INSERT INTO point_logs` 記一筆 -500 的點數紀錄，送出後馬上 commit。

同樣的錯誤寫法，在「動手看看」的〈7. Python：把多個動作包進同一筆交易〉有完整程式（`transfer_wrong()`）。

平常完全沒事，測試也都會過。某天週年慶、兌換量很大的時候，團隊部署新版本。部署時舊版程式會先收到「請結束」的通知（SIGTERM），超過寬限時間（grace period）還沒結束，就被強制砍掉（SIGKILL），程式跑到哪一行就停在哪一行。這支程式沒有做[優雅關閉](48-優雅關閉.md)，也就是收到通知後沒有先把手上的請求做完，所以正在處理的兌換請求被攔腰砍斷。看其中兩個會員：

| 時間 | 會員 7 的兌換請求 | 會員 8 的兌換請求 | 資料庫裡的會員 7 | 資料庫裡的會員 8 |
|---|---|---|---|---|
| T1 | 第 1 句扣 500 點，馬上 commit | | 點數 1200 → 700 | |
| T2 | | 第 1 句扣 500 點，馬上 commit | 點數 700 | 點數少 500 |
| T3 | | 第 2 句發券，馬上 commit | 點數 700 | 點數少 500，多一張券 |
| T4 | 第 2 句還沒送出，被 SIGKILL 砍掉 | 第 3 句還沒送出，被 SIGKILL 砍掉 | 點數 700，沒有券 | 點數少 500，有券 |
| T5 | 新版程式啟動，沒人重做 | 新版程式啟動，沒人重做 | 點數少 500，沒有券，沒有點數紀錄 | 有券，但沒有點數紀錄 |

**使用者看到的**：會員 7 看到點數被扣了，優惠券卻沒拿到；會員 8 拿到券了，點數紀錄裡卻查不到這次兌換。兩個人都去找客服。

**工程師看到的**：資料庫這邊沒有任何一句 SQL 失敗，每一句都成功 commit 了。拿客服回報去對資料，「點數有扣、券或紀錄缺一樣」的總共 37 筆，時間全部集中在部署那 6 分鐘。

**根因**：連線是 `autocommit=True`，`redeem_coupon` 裡的三行 `conn.execute(...)` 是三筆獨立的交易。程式在第 1 句和第 2 句之間（或第 2 句和第 3 句之間）被砍掉時，前面的句子早就 commit 了，資料庫沒有任何理由退回它。程式碼從頭到尾沒有告訴 PostgreSQL「這三件事要一起成功」。這張圖看會員 8 那筆請求，每一句各自 commit 之後被砍斷的樣子：

<figure class="draw-fig">
<iframe class="draw-fig__frame" src="../figures/04-autocommit-sigkill.html" title="按播放或拖時間軸，看會員 8 的三句 SQL 怎麼各自 commit、在第 3 句前被 SIGKILL 砍斷；再切到「with conn.transaction():」，看同樣被砍時資料庫怎麼整筆當作沒發生。" loading="lazy" style="height: 560px;"></iframe>
<figcaption>按播放或拖時間軸，看會員 8 的三句 SQL 怎麼各自 commit、在第 3 句前被 SIGKILL 砍斷；再切到「with conn.transaction():」，看同樣被砍時資料庫怎麼整筆當作沒發生。</figcaption>
</figure>

**怎麼修**：把三句包進同一個 `with conn.transaction():` 區塊，寫法跟「動手看看」第 7 步的 `transfer()` 一樣，再補上優雅關閉。包起來之後，程式在中途被砍，這筆交易還沒 commit，PostgreSQL 會把它整筆當作沒發生（「它是怎麼運作的」的「A 原子性」講為什麼做得到）。已經壞掉的那 37 筆只能寫腳本對帳，人工補券或退點，這種事後清理的成本遠高於一開始寫對。

ACID 是資料庫提供的能力，你得用對方式去要：多個寫入要一起成功，就得由你把它們包進同一筆交易。

## 全貌：它在系統裡的位置

這張圖看一個寫入請求從使用者到資料存進磁碟，經過哪些元件，ACID 管的是哪一段。

```mermaid
flowchart LR
    U["使用者"] --> API["API 伺服器"]
    API e1@-->|"BEGIN、SQL、COMMIT"| PG["PostgreSQL"]
    PG e2@-->|"回報 COMMIT 成功前，先寫進磁碟"| Disk["磁碟"]
    e1@{ animate: true }
    e2@{ animate: true }
    API -- "ACID 管不到" --> Ext["外部服務：金流、寄信、訊息佇列"]
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class PG,Disk hot
```

ACID 的四個承諾都在 PostgreSQL 裡面兌現：A、C、I 由資料庫處理交易時負責，D 要等修改確實寫進磁碟才算數。API 伺服器呼叫的外部服務在資料庫外面，交易回滾時撤不回來（「常見地雷」第 4 點）。交易怎麼開、怎麼結束，在 [資料庫交易](03-資料庫交易.md)；I 的不同強度，在 [隔離等級](05-隔離等級.md)；跨好幾個資料庫或服務的情況，在 [分散式交易](43-分散式交易.md)。

## 生活比喻

想像去銀行臨櫃辦「從我的帳戶轉 1 萬元到我媽的帳戶」：

- **A**：行員不會只把你的帳戶扣款、然後跑去吃午餐。要嘛兩邊都改好，要嘛整張單作廢。
- **C**：銀行規定帳戶不能變負數。你戶頭只有 5 千，行員會直接退件，不會讓帳面出現 -5000。
- **I**：同時有另一個櫃台在處理你的房貸扣款，兩個行員不會同時拿著「餘額 5 萬」的舊紙條各自算，最後互相蓋掉對方的結果。
- **D**：你拿到蓋好章的收據，就算銀行下一秒停電，這筆轉帳也已經記在總帳上了。

**比喻失準的地方**：

1. 真實的銀行轉帳常常跨行，是兩家銀行、兩套系統，根本不在同一個資料庫交易裡，靠的是對帳和補償，這是 [分散式交易](43-分散式交易.md) 的範圍，不是單一資料庫的 ACID。
2. 比喻裡的銀行「懂」業務規則；資料庫不懂業務，只會檢查你寫進 schema 的約束。你沒寫 `CHECK (balance >= 0)`，它就很樂意讓餘額變負的。
3. 隔離在真實資料庫裡有等級之分，預設並不是「兩個行員完全不會撞在一起」。

## 它是怎麼運作的

ACID 的四個字母各自對應資料庫裡一組具體的機制。下面這張圖先列出對照，括號裡的英文是機制的名字，現在不用記，後面每個字母的小節會一個一個講。

```mermaid
flowchart LR
    A["A 原子性"] --> A1["PostgreSQL：改資料時留著舊版本，失敗就當新版本不存在 (MVCC)"]
    A --> A2["MySQL InnoDB：先記下舊值，失敗時改回去 (undo log)"]
    C["C 一致性"] --> C1["約束: PK / FK / UNIQUE / CHECK / NOT NULL"]
    C --> C2["應用程式邏輯 (資料庫管不到)"]
    I["I 隔離性"] --> I1["每筆交易讀自己的快照，改同一列要排隊 (MVCC 快照 + 列鎖)"]
    I --> I2["隔離等級決定強度"]
    D["D 持久性"] --> D1["先把修改紀錄寫進日誌 (WAL)"]
    D --> D2["確認日誌真的寫到磁碟 (fsync)"]
```

### A 原子性：失敗的交易「好像從沒發生過」

原子性要處理的問題，是交易做到一半失敗時，已經改掉的資料怎麼還原。PostgreSQL 的做法是**不原地改資料**。你送出 `UPDATE` 改一列時，PostgreSQL 把舊版本標記為過期，再寫一個新版本。這套機制叫 MVCC（Multi-Version Concurrency Control，多版本並行控制）。

每個列版本身上都帶著兩個系統欄位：

- `xmin`：建立這個版本的交易編號
- `xmax`：刪除（或更新掉）這個版本的交易編號

讀取時，資料庫會查「`xmin` 那筆交易到底 commit 了沒」，這個狀態記在 `pg_xact`（舊版叫 `pg_clog`）。交易回滾時，PostgreSQL 不需要把資料一筆筆改回去，只要把這筆交易標成「已中止」，它寫的所有新版本就自動變成沒人看得見。

這些沒人看得見的版本，加上被已 commit 的 `UPDATE`／`DELETE` 取代掉的舊版本，統稱 dead tuple，之後由 VACUUM（PostgreSQL 定期在背景跑的清理程序）清掉。

下面這張表用一個帳戶 alice（餘額 1000）當例子，看它被一筆交易改掉、又回滾的過程。交易編號 100、200 是假設的數字。

| 步驟 | 發生什麼 | 版本 1（餘額 1000） | 版本 2（餘額 700） |
|---|---|---|---|
| 1 | 交易 100 寫入 alice，已 commit | `xmin` = 100，大家看得見 | 還不存在 |
| 2 | 交易 200 `UPDATE` 扣 300 | `xmax` 標成 200 | `xmin` = 200 |
| 3 | 交易 200 回滾，`pg_xact` 把它標成已中止 | 照樣看得見 | 沒人看得見，成為 dead tuple |
| 4 | VACUUM 跑過 | 照樣看得見 | 被清掉 |

回滾時，PostgreSQL 沒有把資料改回去，變的只有交易 200 的狀態。

MySQL InnoDB 則是原地修改，並把舊值寫進 undo log，回滾時照 undo log 把資料改回去。這張圖看兩邊回滾時各自做了什麼：

```mermaid
flowchart LR
    R["交易要回滾"] --> P1["PostgreSQL：在 pg_xact 把交易標成已中止"]
    P1 --> P2["新版本自動沒人看得見，之後由 VACUUM 清掉"]
    R --> M1["MySQL InnoDB：照 undo log 把舊值寫回去"]
    M1 --> M2["交易越大，回滾可能跑越久"]
```

兩種做法都能達成原子性，只是成本落在不同地方：PostgreSQL 回滾很便宜，但要靠 VACUUM 收垃圾；InnoDB 回滾大交易可能要跑很久。

另一個 PostgreSQL 特有的行為：**交易裡只要有一句出錯，整筆交易就進入中止狀態（aborted）**，之後任何指令都會被拒絕，錯誤訊息是：

```
ERROR:  current transaction is aborted, commands ignored until end of transaction block
```

（SQLSTATE `25P02`）這時你只能 `ROLLBACK`；就算你下 `COMMIT`，PostgreSQL 也會把它當成 `ROLLBACK` 處理。MySQL InnoDB 在這點不同：一般的語句錯誤（例如重複鍵）通常只回滾**那一句**，交易本身還活著，要不要整筆回滾由應用程式決定；例外是**死鎖**，InnoDB 會直接回滾整筆交易（見 [死鎖](02-死鎖.md)）。從 MySQL 轉過來的人很容易在這裡被嚇到。

### C 一致性：資料庫只守你寫下來的規則

一致性要防的，是交易 commit 出違反規則的資料。ACID 的 C 要求**交易開始前資料符合所有規則，交易結束後也要符合**，不能帶著違規的狀態 commit。（理論上的定義允許交易中間暫時不符合，但實際上資料庫預設每一句就檢查，見下文的 `DEFERRABLE`。）

「規則」對資料庫來說就是這些：

| 約束 | 擋下什麼 | 違反時的 SQLSTATE |
|---|---|---|
| `NOT NULL` | 必填欄位是空的 | `23502` |
| `FOREIGN KEY` | 指向不存在的資料 | `23503` |
| `UNIQUE` / `PRIMARY KEY` | 重複值 | `23505` |
| `CHECK` | 自訂條件，例如 `balance >= 0` | `23514` |

細節分別在 [外鍵約束](13-外鍵約束.md)、[唯一約束](14-唯一約束.md) 兩篇。

約束預設是**每一句執行完就檢查**。如果你需要「交易中間暫時違反、commit 前修好」，PostgreSQL 支援把 `UNIQUE`、`PRIMARY KEY`、`FOREIGN KEY` 宣告成 `DEFERRABLE INITIALLY DEFERRED`，延到 commit 時才檢查；`CHECK` 和 `NOT NULL` 則不能延後。

這張圖看一句寫入碰到約束時，資料庫怎麼處理：

```mermaid
flowchart TD
    W["一句 INSERT 或 UPDATE"] --> Q{"違反 schema 上宣告的約束嗎？"}
    Q -->|"沒有"| OK["寫入"]
    Q -->|"違反"| D{"這條約束宣告成 DEFERRABLE INITIALLY DEFERRED 嗎？"}
    D -->|"沒有（預設）"| E["這句立刻報錯，SQLSTATE 見上表"]
    D -->|"有"| L["先放行，COMMIT 時再檢查"]
    P["只寫在 Python 裡的規則"] -.->|"資料庫不知道"| OK
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class P hot
```

資料庫提供工具（約束）與保證（不會帶著違規 commit），**規則要你自己寫進 schema**。只寫在 Python 裡的檢查，碰到 [競爭條件](01-競爭條件.md) 或有人直接連資料庫改資料時，就擋不住了。

### I 隔離性：這裡只點到為止

同時有很多交易在跑時，PostgreSQL 用 MVCC 讓每筆交易讀到一份「快照」，寫入時再搭配列鎖避免兩筆交易同時改同一列。快照取的時機、能擋住哪些異常（髒讀、不可重複讀、幻讀、遺失更新，這幾種異常在 [隔離等級](05-隔離等級.md) 逐一舉例），由隔離等級決定：

- PostgreSQL 預設：**Read Committed**
- MySQL InnoDB 預設：**Repeatable Read**

這張圖看在 PostgreSQL 預設的 Read Committed 下，兩筆交易碰到同一列：讀的時候讀快照，寫的時候排隊等列鎖。alice 原本有 1000。

```mermaid
sequenceDiagram
    participant A as 交易 A
    participant PG as PostgreSQL
    participant B as 交易 B
    A->>PG: BEGIN，alice 扣 300
    Note over PG: A 拿到 alice 那列的列鎖
    B->>PG: 讀 alice
    PG-->>B: 1000（A 還沒 commit，讀到的是已 commit 的版本）
    B->>PG: alice 扣 100
    Note over B,PG: 等 A 的列鎖
    A->>PG: COMMIT
    PG-->>B: 拿到鎖，從 700 扣 100，變成 600
```

**預設的隔離等級不是「完全隔離」**。「先讀餘額、在程式裡算、再寫回去」這種寫法，在預設等級下依然可能出事。怎麼選等級、怎麼處理，請看 [隔離等級](05-隔離等級.md)、[樂觀鎖定](06-樂觀鎖定.md)、[悲觀鎖定](07-悲觀鎖定.md)。

### D 持久性：WAL 和 fsync

最直覺的持久化方式是「每次 commit 就把改到的資料頁寫回磁碟」。但資料頁散落在磁碟各處，隨機寫入很慢，而且一頁寫到一半斷電，整頁就毀了。

PostgreSQL 的做法是 **WAL（Write-Ahead Logging，預寫式日誌）**：

1. 你送出 `UPDATE` 時，PostgreSQL 先在記憶體裡改資料頁（shared buffers），同時產生一筆描述「改了什麼」的 WAL 紀錄。
2. 你送出 `COMMIT` 時，PostgreSQL 把這筆交易的 WAL 紀錄**依序附加**寫到 WAL 檔（`pg_wal/` 目錄，PostgreSQL 10 以前叫 `pg_xlog/`），然後呼叫 `fsync` 這類系統呼叫，確認作業系統真的把它寫進磁碟（只放在 OS 的快取裡不算）。
3. 確認寫入完成後，才回傳 `COMMIT` 成功給用戶端。
4. 真正的資料頁晚點再由背景程序和 **checkpoint** 慢慢寫回磁碟。checkpoint 是資料庫定期做的一次「把記憶體裡改過的資料頁全部寫回磁碟」，做完之後，這個時間點以前的修改就不用再靠 WAL 補。

當機重啟時，PostgreSQL 從最後一個 checkpoint 開始重播（redo）WAL，把那些「已 commit 但資料頁還沒寫回」的修改補回來。這叫 crash recovery。

第一張圖只畫 commit 這條路，`COMMIT` 要等 WAL 寫進磁碟才回傳成功。

```mermaid
sequenceDiagram
    participant App as 應用程式
    participant PG as PostgreSQL 後端程序
    participant Buf as shared buffers（記憶體）
    participant WAL as WAL 檔（pg_wal）
    App->>PG: BEGIN 與 UPDATE
    PG->>Buf: 修改資料頁並產生 WAL 紀錄
    App->>PG: COMMIT
    PG->>WAL: 寫入 WAL 紀錄並 fsync
    WAL-->>PG: 已確實寫進磁碟
    PG-->>App: COMMIT 成功
```

第二張圖多了資料檔。`COMMIT` 不用等資料頁寫回，資料頁晚點才由 checkpoint 或背景程序寫回資料檔；當機時靠 WAL 把還沒寫回的部分補回來。

```mermaid
sequenceDiagram
    participant App as 應用程式
    participant PG as PostgreSQL 後端程序
    participant Buf as shared buffers（記憶體）
    participant WAL as WAL 檔（pg_wal）
    participant Data as 資料檔
    App->>PG: BEGIN 與 UPDATE
    PG->>Buf: 修改資料頁並產生 WAL 紀錄
    App->>PG: COMMIT
    PG->>WAL: 寫入 WAL 紀錄並 fsync
    WAL-->>PG: 已確實寫進磁碟
    PG-->>App: COMMIT 成功
    Note over Buf,Data: 之後由 checkpoint 或背景寫入程序寫回資料檔
    Note over WAL,Data: 當機時從最後的 checkpoint 重播 WAL 補回資料
```

把當機前後拉成時間軸，看一筆已 commit 的交易 X 怎麼被救回來：

| 時間 | 發生什麼 | 記憶體裡的資料頁 | WAL 檔（磁碟） | 資料檔（磁碟） |
|---|---|---|---|---|
| T1 | 做完一次 checkpoint | 和資料檔一樣 | 從這裡往後記 | 到這裡為止都是最新的 |
| T2 | 交易 X 送出 `UPDATE` | 改了 | | 舊的 |
| T3 | 交易 X 送出 `COMMIT`，回傳成功 | 改了，還沒寫回 | X 的紀錄已寫進磁碟 | 舊的 |
| T4 | 當機 | 全部消失 | X 的紀錄還在 | 舊的 |
| T5 | 重啟，從 T1 的 checkpoint 重播 WAL | 重新套用 X 的修改 | X 的紀錄還在 | 之後寫回，X 的修改回來了 |

依序附加寫入比隨機寫入快得多，所以 WAL 同時兼顧了「安全」和「效能」。WAL 也是 [讀取副本](17-讀取副本.md) 的基礎：串流複寫就是把 WAL 傳給副本重播。

### 會削弱 Durability 的設定

這幾個設定新人一定要認得，看到有人在正式環境改它們要提高警覺：

- **`fsync`**（預設 `on`）：關掉後 PostgreSQL 不再確認資料寫到磁碟。速度會變快，但作業系統當機或斷電時，**可能造成無法修復的資料損毀**，不只是丟資料。官方文件明確說只有在「整個資料庫可以輕鬆從外部資料重建」的情境（例如從備份檔初次載入一個新叢集、跑完就丟掉的批次處理叢集）才考慮關，而且「硬體品質好」不構成關掉的理由。
- **`synchronous_commit`**（預設 `on`）：設成 `off` 時，`COMMIT` 不等 WAL 寫進磁碟就回傳成功。代價是當機時**可能遺失最近一小段時間已回報成功的交易**（官方文件說最長延遲是 `wal_writer_delay` 的三倍，`wal_writer_delay` 預設 200ms），但**不會造成資料損毀或不一致**，資料庫重啟後會是某個一致的較早狀態。它可以針對單一交易設定（`SET LOCAL synchronous_commit = off`），適合「掉幾筆也沒關係」的資料，例如操作日誌。
- `synchronous_commit` 還有 `local`、`remote_write`、`remote_apply` 等值，跟同步複寫有關；如果沒有設定 `synchronous_standby_names`，這幾個值的效果和 `on` 一樣。
- **`full_page_writes`**（預設 `on`）：防止「一頁寫一半」造成的損壞，不要關。

這張圖看 `synchronous_commit` 和 `fsync` 改掉之後，當機時的後果差在哪：

```mermaid
flowchart LR
    C["COMMIT"] --> S{"synchronous_commit"}
    S -->|"on（預設）"| W["等 WAL 寫進磁碟才回傳成功"]
    W --> OK["fsync 保持 on 時，當機後重播 WAL，已回報成功的交易都在"]
    S -->|"off"| N["不等 WAL 寫進磁碟就回傳成功"]
    N --> L["當機可能遺失最近一小段交易，不會損毀"]
    F["fsync = off"] --> X["不再確認寫進磁碟"]
    X --> Y["作業系統當機或斷電：可能損毀到無法修復"]
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class Y hot
```

MySQL InnoDB 的對應設定是 `innodb_flush_log_at_trx_commit` 與 binlog 的 `sync_binlog`。`innodb_flush_log_at_trx_commit` 預設 `1`，每次 commit 都寫入並 flush redo log。設成 `0` 時，連 mysqld 程序當掉都可能遺失大約最後一秒的交易；設成 `2` 時，mysqld 當掉不會丟，但作業系統當機或斷電可能遺失大約最後一秒的交易。

最後，持久性有它的邊界：

- 它防的是**當機**。磁碟壞掉或機房燒掉，要靠副本與備份。
- 硬體回報的狀態不一定可靠：有些磁碟或 RAID 卡的寫入快取在沒有斷電保護的情況下會先回報「寫好了」。官方文件的 WAL 可靠性章節專門討論這件事，正式環境的硬體選型要注意。
- 雲端託管資料庫（RDS、Cloud SQL 等）通常已經處理好這層，但參數群組裡的 `synchronous_commit` 還是可能被人改掉，值得檢查。

## 動手看看

用 Docker 起一個 PostgreSQL（密碼只用在本機練習）：

```shell
# 起一個 PostgreSQL 17 容器
docker run --name acid-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17

# 進入 psql
docker exec -it acid-pg psql -U postgres
```

### 1. 準備資料

```sql
-- 帳戶表：用 CHECK 約束把「餘額不能為負」寫進資料庫
CREATE TABLE accounts (
    id      int PRIMARY KEY,
    owner   text NOT NULL,
    balance int  NOT NULL CHECK (balance >= 0)
);
INSERT INTO accounts VALUES (1, 'alice', 1000), (2, 'bob', 0);
```

### 2. 原子性：中途出錯，整筆作廢

```sql
BEGIN;
UPDATE accounts SET balance = balance - 300 WHERE id = 1;  -- 成功
UPDATE accounts SET balance = balance + 'abc' WHERE id = 2; -- 故意出錯
SELECT * FROM accounts;   -- 會被拒絕：current transaction is aborted ...
COMMIT;                   -- 會顯示 ROLLBACK，不是 COMMIT
SELECT * FROM accounts;   -- alice 仍然是 1000
```

**預期**：第二句報錯後，連 `SELECT` 都不能執行；`COMMIT` 的回應是 `ROLLBACK`；alice 的錢沒有被扣。

### 3. 一致性：約束擋下違規資料

```sql
UPDATE accounts SET balance = balance - 5000 WHERE id = 1;
-- ERROR:  new row for relation "accounts" violates check constraint "accounts_balance_check"
```

**預期**：直接被擋。資料庫只守你寫下來的規則，如果建表時沒寫 `CHECK`，這句會成功，alice 的餘額變成 -4000。

### 4. 看 MVCC 的列版本

```sql
SELECT xmin, xmax, * FROM accounts;
UPDATE accounts SET balance = balance + 1 WHERE id = 2;
SELECT xmin, xmax, * FROM accounts;   -- bob 那列的 xmin 變成新的交易編號
```

**預期**：bob 的 `xmin` 改變了，代表 `UPDATE` 寫了一個新版本，沒有原地修改。

### 5. 持久性與原子性：直接把資料庫砍掉

開兩個終端機。第一個終端機在 psql 裡：

```sql
INSERT INTO accounts VALUES (3, 'carol', 100);  -- autocommit，立刻 commit

BEGIN;
INSERT INTO accounts VALUES (4, 'dave', 100);   -- 還沒 commit
-- 先停在這裡，不要 COMMIT
```

第二個終端機模擬當機（`docker kill` 預設送 SIGKILL，資料庫沒機會正常關機）：

```shell
docker kill acid-pg
docker start acid-pg
docker logs --tail 15 acid-pg      # 應該看到 "not properly shut down; automatic recovery in progress"、"redo starts at" 之類的訊息
docker exec -it acid-pg psql -U postgres -c "SELECT * FROM accounts ORDER BY id;"
```

**預期**：carol（已 commit）還在，這是持久性；dave（未 commit）不見了，這是原子性。日誌裡可以看到 PostgreSQL 在重啟時重播 WAL。

**這個實驗的極限**：`docker kill` 只是砍掉資料庫**程序**，主機的作業系統還活著，已經交給 OS 的寫入仍留在 OS 快取裡、之後照樣會寫進磁碟。所以就算你把 `fsync` 關掉，這個實驗多半也一樣會過。`fsync` 真正防的是**作業系統當機或斷電**，這在本機很難安全重現，知道有這個差別就好。

### 6. 感受 synchronous_commit 的效能差異

`pgbench` 是 PostgreSQL 內建的壓測工具，會一直送出小交易，最後印出 tps（每秒完成幾筆交易）。下面先用預設設定跑一次，再把 `synchronous_commit` 關掉跑一次，比較兩次的 tps。

```shell
# 建立 pgbench 的測試資料
docker exec acid-pg pgbench -U postgres -i postgres

# 預設設定：每次 commit 都等 WAL 寫進磁碟
docker exec acid-pg pgbench -U postgres -c 8 -T 15 postgres

# 關掉 synchronous_commit 再跑一次
docker exec -e PGOPTIONS='-c synchronous_commit=off' acid-pg pgbench -U postgres -c 8 -T 15 postgres
```

**預期**：第二次的 tps 通常會明顯高一些，差多少依你的磁碟和 Docker 環境而異。有人想關掉它，就是為了這個差距；關掉的代價見上面「會削弱 Durability 的設定」。

### 7. Python：把多個動作包進同一筆交易

用 psycopg 3（`pip install "psycopg[binary]"`）：

```python
import psycopg

DSN = "postgresql://postgres:postgres@localhost:5432/postgres"

def transfer(conn: psycopg.Connection, src: int, dst: int, amount: int) -> None:
    # ✅ 正確寫法：with conn.transaction() 區塊內的語句屬於同一筆交易
    # 區塊正常結束就 COMMIT；中途拋出例外就 ROLLBACK
    with conn.transaction():
        cur = conn.execute(
            "UPDATE accounts SET balance = balance - %s WHERE id = %s",
            (amount, src),
        )
        if cur.rowcount != 1:
            raise ValueError(f"找不到轉出帳戶 {src}")  # 拋例外 → 整筆回滾
        cur = conn.execute(
            "UPDATE accounts SET balance = balance + %s WHERE id = %s",
            (amount, dst),
        )
        if cur.rowcount != 1:
            raise ValueError(f"找不到轉入帳戶 {dst}")  # 前一句的扣款也會被撤銷

# autocommit=True 時，只有 conn.transaction() 區塊內才是交易，邊界最清楚
with psycopg.connect(DSN, autocommit=True) as conn:
    try:
        transfer(conn, 1, 999, 100)   # 999 不存在
    except ValueError as e:
        print("轉帳失敗，已回滾：", e)
    print(conn.execute("SELECT id, balance FROM accounts ORDER BY id").fetchall())
    # alice 的餘額不會少 100
```

```python
# ❌ 錯誤示範：autocommit 模式下逐句執行，每句都是獨立交易
def transfer_wrong(conn, src, dst, amount):
    conn.execute("UPDATE accounts SET balance = balance - %s WHERE id = %s", (amount, src))
    # 程序如果在這裡被砍、或下一句出錯，上面的扣款已經 commit，錢就憑空消失
    conn.execute("UPDATE accounts SET balance = balance + %s WHERE id = %s", (amount, dst))
```

練習完記得收掉容器：`docker rm -f acid-pg`。

## 常見地雷

### 1. 以為「用了 PostgreSQL 就有 ACID」，但沒開交易

❌ 錯誤做法：連線開 autocommit，多個相關的寫入一句一句送；或用 ORM 時每個 `save()` 都自動 commit。

為什麼錯：每一句都是自己的交易。資料庫對每一句都有完整的 ACID，但對「這三句要一起成功」一無所知。

✅ 正確做法：凡是「必須一起成功」的多個寫入，明確用一個交易包起來（`with conn.transaction():`、Django 的 `transaction.atomic()`、SQLAlchemy 的 `with session.begin():`）。Code review 時看到多個寫入就問一句：它們在同一筆交易裡嗎？

### 2. 把 C 當成「資料一定是對的」

❌ 錯誤做法：「資料庫有 ACID，所以不會有負的餘額、不會有孤兒資料。」但 schema 上什麼約束都沒寫，檢查全在 Python 裡。

為什麼錯：資料庫只檢查宣告過的約束。應用程式裡的 `if balance >= amount` 擋不住兩個請求同時通過檢查（見 [競爭條件](01-競爭條件.md)），也擋不住有人直接下 SQL 修資料。

✅ 正確做法：重要的不變條件盡量寫成約束：`NOT NULL`、`CHECK`、`UNIQUE`、`FOREIGN KEY`。應用程式的檢查負責給使用者看得懂的錯誤訊息；資料庫的約束負責最後把關，兩個請求同時通過應用程式檢查時也擋得住。

### 3. 例外被吞掉後繼續用同一個連線（PostgreSQL 專屬）

❌ 錯誤做法：

```python
# ❌ 錯誤示範：在同一筆交易裡吞掉例外，然後繼續執行
# （psycopg 3 預設 autocommit=False，第一句執行時就已經自動開了一筆交易）
try:
    cur.execute("INSERT INTO users (email) VALUES (%s)", (email,))
except psycopg.errors.UniqueViolation:
    pass  # 以為「重複就算了」
cur.execute("INSERT INTO audit_log (action) VALUES (%s)", ("signup",))
# ↑ 這句會丟出 psycopg.errors.InFailedSqlTransaction（SQLSTATE 25P02，current transaction is aborted）
```

為什麼錯：PostgreSQL 交易中任何一句失敗，整筆交易就進入中止狀態，後面全部被拒絕。

✅ 正確做法：要嘛讓例外往外拋、整筆回滾重來；要嘛用 savepoint 只回滾那一句。psycopg 3 裡可以巢狀使用 `with conn.transaction():`，內層會自動變成 savepoint：

```python
# ✅ 正確寫法：內層 transaction() 是 savepoint，失敗只回滾這一段
with conn.transaction():
    try:
        with conn.transaction():
            conn.execute("INSERT INTO users (email) VALUES (%s)", (email,))
    except psycopg.errors.UniqueViolation:
        pass  # 只撤銷 INSERT users，外層交易仍然可用
    conn.execute("INSERT INTO audit_log (action) VALUES (%s)", ("signup",))
```

（「重複就算了」這個需求更好的寫法通常是 `INSERT ... ON CONFLICT DO NOTHING`，詳見 [唯一約束](14-唯一約束.md)。）

### 4. 以為交易回滾會撤銷外部副作用

❌ 錯誤做法：在交易裡呼叫金流 API、寄確認信、丟訊息到 Kafka（一種訊息佇列），後面某句 SQL 失敗回滾了。

為什麼錯：ACID 只管資料庫內部。信已經寄出去、錢已經扣了、訊息已經被別人消費了，資料庫回滾不會把它們收回來。反過來，先送訊息再 commit，commit 失敗時就送出了一則「不存在的事件」。

✅ 正確做法：交易內只做資料庫的事。需要「資料寫入」和「發出事件」一起成功，用 [信箱模式](44-信箱模式.md)：在同一筆交易裡把要送的訊息寫進 outbox 表，commit 後再由背景程序送出。

### 5. 為了效能關掉 fsync

❌ 錯誤做法：「壓測時把 `fsync = off` 快了好幾倍，正式環境也這樣設吧。」

為什麼錯：`fsync = off` 時，作業系統當機或斷電可能讓資料庫**損毀到無法啟動**，不只是丟掉最後幾筆。

✅ 正確做法：正式環境 `fsync` 永遠保持 `on`。真的需要用持久性換速度，改用 `synchronous_commit = off`，而且最好只針對特定交易（`SET LOCAL synchronous_commit = off`），並且讓團隊明確知道「這類資料當機時可能遺失最後一小段」。

### 6. 把交易開很久

❌ 錯誤做法：`BEGIN` 之後去呼叫一個要 10 秒的外部服務，或在交易裡等使用者操作；或 Python 程式忘了 commit，連線停在 `idle in transaction` 好幾個小時。

為什麼錯：交易持有的列鎖會一直卡著別人；PostgreSQL 的 VACUUM 也不能清掉這筆交易還可能看得到的舊版本，表會越來越大。連線也一直被占著，拖垮 [連線池](08-連線池.md)。

✅ 正確做法：交易越短越好，外部呼叫放到交易外面。可以設定 `idle_in_transaction_session_timeout` 讓卡住的交易自動被中斷，並監控 `pg_stat_activity` 裡 `state = 'idle in transaction'` 的連線。

### 7. 以為 MySQL 一定有交易

❌ 錯誤做法：接手舊系統，看到 `START TRANSACTION` 就以為有原子性。

為什麼錯：MySQL 底層可以換不同的「儲存引擎」來存資料，現在預設是 InnoDB；舊的 MyISAM 儲存引擎不支援交易，`ROLLBACK` 對它沒有作用。另外 MySQL 的 DDL（`ALTER TABLE` 等）會觸發隱含 commit，不能跟資料修改一起回滾；PostgreSQL 大部分 DDL 則可以放在交易裡。

✅ 正確做法：確認表的引擎是 InnoDB（`SHOW TABLE STATUS` 或查 `information_schema.TABLES` 的 `ENGINE` 欄）。做 [資料庫遷移](15-資料庫遷移.md) 時，要知道你用的資料庫 DDL 能不能回滾。

## 重點整理

- **A 原子性**：包在同一筆交易裡的修改，最後只有「全部生效」或「全部沒發生」兩種結果。前提是你真的把它們包進同一筆交易；autocommit 下一句一句送，每句都是獨立的交易，中途被砍掉，前面的句子已經 commit 了。
- **C 一致性**：資料庫只守你寫進 schema 的約束（`NOT NULL`、`FOREIGN KEY`、`UNIQUE`、`CHECK`），不會帶著違反約束的資料 commit。只寫在 Python 裡的業務規則，資料庫不知道，兩個請求同時通過檢查時擋不住。
- **I 隔離性**：好幾筆交易同時跑時，彼此看到什麼、會不會互相覆蓋，由隔離等級決定。PostgreSQL 預設是 Read Committed，不是完全隔離。
- **D 持久性**：`COMMIT` 回傳成功時，WAL 已經寫進磁碟，之後就算當機，重啟時也會重播 WAL 把資料補回來。`fsync = off` 時，作業系統當機或斷電可能讓資料庫損毀；`synchronous_commit = off` 可能遺失最近一小段交易，但不會損毀。
- ACID 只管資料庫內部。交易裡呼叫的外部 API、寄出的信、送出的訊息，交易回滾時不會跟著撤銷。

## 新人必知清單

### 一定要會（基本功）

- [ ] 能用白話講出 A、C、I、D 各自保證什麼、**不**保證什麼
- [ ] 知道 autocommit 下每句 SQL 都是獨立交易，會用你們專案的框架把多個寫入包成一筆交易
- [ ] 知道 C 只涵蓋宣告過的約束，會在 schema 上加 `NOT NULL`、`CHECK`、`UNIQUE`、`FOREIGN KEY`
- [ ] 知道 PostgreSQL 交易中出錯後要整筆 `ROLLBACK`（或用 savepoint），認得 `current transaction is aborted` 這個錯誤
- [ ] 知道交易回滾不會撤銷外部副作用（API 呼叫、寄信、送訊息）
- [ ] 知道 `COMMIT` 成功才代表持久化，沒 commit 的東西當機後就沒了
- [ ] 知道 PostgreSQL 預設隔離等級是 Read Committed，不是完全隔離

### 知道有這回事就好

- WAL 的運作方式：先寫日誌、`fsync` 寫進磁碟、再回 commit 成功；當機後從 checkpoint 重播 WAL
- `fsync`、`synchronous_commit`、`full_page_writes` 的意義與關掉的代價
- PostgreSQL 的 MVCC：`UPDATE` 是寫新版本、`xmin`／`xmax`、回滾時只是標記交易中止，dead tuple 要靠 VACUUM 清
- MySQL InnoDB 用 undo log 回滾、`innodb_flush_log_at_trx_commit` 控制 redo log 何時寫進磁碟
- `DEFERRABLE` 約束可以延到 commit 時才檢查
- `COMMIT` 送出後連線斷掉，用戶端會不知道到底成功了沒，所以重試要配合 [冪等性](25-冪等性.md)
- Durability 防當機不防磁碟壞掉，那是副本與備份的工作

### 先不用管（等你遇到再學）

- WAL 檔的內部格式、`pg_waldump` 的使用
- checkpoint 相關參數調校（`checkpoint_timeout`、`max_wal_size`）
- 同步複寫的 `synchronous_standby_names` 設定細節
- 交易編號回捲（transaction ID wraparound）與 freeze
- 兩階段提交（`PREPARE TRANSACTION`）

## Code Review 時可以問的問題

1. 這幾個寫入是不是「必須一起成功」？它們真的在同一筆交易裡嗎？還是 autocommit 一句一句送？
2. 這段程式裡的業務規則（不能負數、不能重複、必須存在），有沒有對應的資料庫約束？只靠應用程式檢查的話，兩個請求同時進來會怎樣？
3. 交易裡有沒有呼叫外部服務、寄信、送訊息？交易回滾或 commit 失敗時，這些副作用怎麼處理？
4. 這裡的 `try/except` 有沒有吞掉資料庫錯誤後繼續使用同一筆交易？
5. 這筆交易會持續多久？裡面有沒有慢的操作讓鎖一直卡著？
6. 有沒有人改了 `synchronous_commit`、`fsync` 或 ORM 的 autocommit 設定？影響範圍和代價有寫清楚嗎？

## 情境演練

**Q1.** 架構討論時，有同事說：「我們用的是有 ACID 的 PostgreSQL，所以主庫和副本之間的資料一定一致。」你會怎麼回應？

<details markdown="1"><summary>看答案</summary>

這句話把兩種「一致」混在一起了。ACID 的 C 指交易前後資料都符合宣告過的約束，是單一資料庫內部的概念。主庫和副本看到的資料一不一樣，是 CAP 定理的 C 在講的事：分散式系統的多個節點在同一時間看到一樣的資料（接近線性一致性），講的是副本之間的狀態。兩個字母撞名，意思完全不同。最終一致性的「一致」也是在講副本，屬於 CAP 那一邊，見 [最終一致性](42-最終一致性.md)。

</details>

**Q2.** 你寫的註冊流程在一筆 PostgreSQL 交易裡依序執行好幾句 SQL，其中一句因為違反唯一約束失敗了。程式抓到例外後沒有處理，接著直接下 `COMMIT`。前面成功的語句會被保存嗎？

<details markdown="1"><summary>看答案</summary>

不會。PostgreSQL 交易中任何一句失敗，整筆交易就進入中止狀態，之後的指令都會被拒絕，`COMMIT` 也會被當成 `ROLLBACK` 處理，前面成功的語句全部作廢。這是原子性的直接表現。如果只想撤銷失敗的那一句，要在那一句之前建 savepoint，失敗時 `ROLLBACK TO SAVEPOINT`。注意 MySQL InnoDB 的行為不同，一般語句錯誤通常只回滾那一句。

</details>

**Q3.** 同事說：「我們把 `synchronous_commit` 設成 `off`，所以資料庫當機後可能會壞掉。」你會怎麼跟他說明實際的風險？

<details markdown="1"><summary>看答案</summary>

`synchronous_commit = off` 的代價是**可能遺失最近一小段已回報成功的交易**（最長約 `wal_writer_delay` 的三倍），但資料庫不會損毀，重啟後會處於某個一致的較早狀態。會讓資料庫可能損毀的是 `fsync = off`。這兩個設定的風險等級差很多：前者可以針對不重要的資料謹慎使用，後者在正式環境不應該關。

</details>

**Q4.** 同事提議：「每次 commit 都直接把修改過的資料頁寫回磁碟就好，比先寫 WAL 單純。」你會怎麼回應？

<details markdown="1"><summary>看答案</summary>

PostgreSQL 先寫 WAL，有兩個原因。第一是效能：資料頁散落在磁碟各處，每次 commit 都隨機寫入很慢；WAL 是依序附加寫入，速度快很多，資料頁可以之後由 checkpoint 批次寫回。第二是安全：資料頁寫到一半斷電會留下損壞的頁面，而有了 WAL，當機後可以從最後一個 checkpoint 重播日誌，把資料補回正確狀態。只要 WAL 確實寫進磁碟（`fsync`），已 commit 的交易就能在 crash recovery 時恢復。

</details>

**Q5.** 你負責的訂單服務在一筆交易裡做了這些事：①寫入 `orders` ②呼叫金流 API 扣款 ③寫入 `payments` ④送一則「訂單成立」訊息到訊息佇列 ⑤`COMMIT`。某天第 ③ 步因為欄位長度超過限制而失敗。使用者會遇到什麼事？你會怎麼改？

<details markdown="1"><summary>看答案</summary>

交易回滾，`orders` 沒有寫入。但第 ② 步的扣款已經在金流那邊發生，使用者被扣了錢卻沒有訂單；如果第 ④ 步跑到了（例如順序不同），下游服務還會收到一則根本不存在的訂單訊息。原因是 ACID 只保證資料庫內部的修改，管不到外部系統。

改法的方向：

- 交易內只做資料庫的事。先在交易裡建立狀態為「待付款」的訂單並 commit，再呼叫金流；金流結果回來後再開一筆交易更新訂單狀態。
- 金流呼叫要帶冪等鍵（見 [冪等性](25-冪等性.md)），失敗重試才不會重複扣款，並準備好對帳或退款的補償流程。
- 「訂單成立」訊息用 [信箱模式](44-信箱模式.md)：在更新訂單的同一筆交易裡寫入 outbox 表，commit 後由背景程序送出，確保「資料有改」與「訊息有送」一致。
- 欄位長度這種錯誤，應該在應用程式層先驗證，給使用者清楚的錯誤訊息。

</details>

## 相關主題

- [資料庫交易](03-資料庫交易.md)：ACID 是交易提供的保證，先懂怎麼開、怎麼結束交易。
- [隔離等級](05-隔離等級.md)：ACID 的 I 有不同強度，這篇講各等級擋得住哪些異常。
- [競爭條件](01-競爭條件.md)：只靠應用程式檢查、沒有約束或適當隔離時，最常出現的問題。
- [唯一約束](14-唯一約束.md)：把「不能重複」交給資料庫守，是 C 最實用的工具之一。
- [信箱模式](44-信箱模式.md)：交易管不到外部系統時，怎麼讓「寫資料」和「發事件」一致。
- [分散式交易](43-分散式交易.md)：跨多個資料庫或服務時，單一資料庫的 ACID 就不夠用了。

## 延伸閱讀

- PostgreSQL 官方文件：Write-Ahead Logging (WAL)，https://www.postgresql.org/docs/current/wal-intro.html
- PostgreSQL 官方文件：Reliability（磁碟快取、fsync 與硬體可靠性），https://www.postgresql.org/docs/current/wal-reliability.html
- PostgreSQL 官方文件：Asynchronous Commit（`synchronous_commit = off` 的取捨），https://www.postgresql.org/docs/current/wal-async-commit.html
- Martin Kleppmann，《Designing Data-Intensive Applications》第 7 章〈Transactions〉，對 ACID 各字母的意義與常見誤解有很清楚的討論。
