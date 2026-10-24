# 12｜EXPLAIN ANALYZE（EXPLAIN ANALYZE）

> `EXPLAIN` 讓資料庫印出它打算怎麼執行一條 SQL（執行計畫）；`EXPLAIN ANALYZE` 會真的執行一次，再把每一步實際花的時間和列數一起列出來。

**難度**：★★☆　**閱讀時間**：約 25 分鐘　**前置知識**：[資料庫交易](03-資料庫交易.md)、[資料庫索引](10-資料庫索引.md)、[查詢最佳化](11-查詢最佳化.md)

## 核心問題與理念

**它要解決的問題**：一條平常 50 毫秒的查詢突然變成 12 秒。資料庫執行 SQL 前，會先估每一步大概有幾列，再照估計挑一種跑法；用 `EXPLAIN` 只看得到這份估計，上面寫「只有 1 列」，看起來沒問題。實際上有 41 萬列，照「1 列」挑的跑法把另一張表查了 41 萬次（下面的情境會完整走一遍）。

**核心理念**：真的跑一次，把每一步的預估和實際並排印出來，從差最多的那一步查起。

**想通的那一步**：

- **卡住的地方**：直覺的做法是看 `EXPLAIN` 印出的 cost（資料庫估的成本）和預估列數，判斷計畫好不好。但這些數字全是資料庫照統計資訊（它對每張表「大概幾列、常見哪些值」的摘要）估出來的；摘要過期時，它會把 41 萬列估成 1 列，`EXPLAIN` 也就照樣印出一份看起來很便宜的計畫。
- **火花**：讓資料庫照計畫真的執行一次，在每一步旁邊記下實際的時間和列數。預估和實際擺在同一行，估錯的那一步一眼就看得出來。

## 閱讀前推薦具備知識

| 知識 | 要會到什麼程度 | 這篇哪裡會用到 | 不熟的話先看 |
|---|---|---|---|
| SQL 的 `SELECT`／`JOIN`／`WHERE` | **必備**：看得懂 `orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'refunding'` 回傳的每一列是什麼 | 開頭情境的那條查詢，以及「動手看看」的每個實驗 | [PostgreSQL：JOIN](https://www.postgresql.org/docs/current/tutorial-join.html) |
| [資料庫索引](10-資料庫索引.md) | **必備**：能說出「沒有索引時，要找符合條件的列只能把整張表讀一遍」 | 「它是怎麼運作的」的掃描節點（Seq Scan、Index Scan），實驗 1 加索引前後的比較 | 本系列第 10 篇 |
| [資料庫交易](03-資料庫交易.md) | **加分**：知道 `BEGIN` 之後做的改動，`ROLLBACK` 會全部復原 | 實驗 3 和地雷 1：安全地對 `DELETE` 跑 `EXPLAIN ANALYZE` | 本系列第 03 篇 |
| [查詢最佳化](11-查詢最佳化.md) | **加分**：知道 `pg_stat_statements` 是用來找出總耗時最高的查詢 | 第 9 小節〈先拿到要檢查的 SQL 和它的計畫〉 | 本系列第 11 篇 |
| Docker 基本操作 | **加分**：會用 `docker run` 起一個容器、用 `docker exec` 進到裡面 | 「動手看看」起本機 PostgreSQL | [Docker 入門](https://docs.docker.com/get-started/) |

**快速自我檢查**：`orders` 有 100 萬列，`status` 欄位沒有索引。`SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'refunding'` 回傳的每一列代表什麼？資料庫要怎麼找出 `status = 'refunding'` 的那些訂單？

<details markdown="1"><summary>看答案</summary>

每一列是一筆狀態為 `'refunding'` 的訂單，加上下這筆訂單的客戶名稱。`status` 沒有索引，資料庫只能把 `orders` 的 100 萬列從頭讀到尾，一列一列檢查 `status`。

前半句答不出來，先看 PostgreSQL 的 JOIN 教學；後半句答不出來，先讀[資料庫索引](10-資料庫索引.md)。兩個都答得出來，就可以直接往下讀。

</details>

## 為什麼要在意：一個具體的情境

假設你負責一個電商後台的「待處理退款」頁面，平常查詢大約 50 毫秒，客服每天早上 9 點上班後會一直開著它。

某天凌晨，資料團隊用一個大型匯入工作把 300 萬筆歷史訂單灌進 `orders` 表，其中約 41 萬筆的 `status` 是一個以前從沒出現過的值 `'refunding'`。匯入工作只做一件事：用 `INSERT INTO orders ... SELECT ... FROM import_orders` 把資料灌進去，灌完就結束。「待處理退款」頁面送出的查詢，是把 `orders` 和 `customers` 接起來，找出 `o.status = 'refunding'` 的訂單和客戶名稱。後來值班工程師排查時，對這條查詢只跑了 `EXPLAIN`，看到的只是預估。同一條查詢的完整寫法在「動手看看」的〈實驗 2：親手製造「統計過期」〉。

PostgreSQL 執行一條 SQL 之前，會先由規劃器（planner）挑一種跑法。它挑的依據是統計資訊，也就是「每張表大概幾列、每個欄位常見哪些值」的摘要，要靠 `ANALYZE` 指令收集。

<figure class="draw-fig">
<iframe class="draw-fig__frame" src="../figures/12-estimate-vs-actual-loops.html" title="按播放或點 T1～T6：看規劃器以為只有 1 列而選了 Nested Loop，內層 customers 卻被查了 412337 次；EXPLAIN 只印預估那一欄，要 EXPLAIN ANALYZE 才看得到實際那一欄。" loading="lazy" style="height: 720px;"></iframe>
<figcaption>按播放或點 T1～T6：看規劃器以為只有 1 列而選了 Nested Loop，內層 customers 卻被查了 412337 次；EXPLAIN 只印預估那一欄，要 EXPLAIN ANALYZE 才看得到實際那一欄。</figcaption>
</figure>

| 步驟 | 發生什麼 | 規劃器以為 `'refunding'` 有幾列 | 實際有幾列 | 「待處理退款」頁面 |
|---|---|---|---|---|
| T1（凌晨） | 匯入工作灌完 300 萬筆就結束，沒有跑 `ANALYZE`。背景的自動分析（autovacuum 的 auto-analyze）也還沒輪到這張表，統計資訊裡沒有 `'refunding'` | 1 | 約 41 萬 | 還沒人用 |
| T2（9:00） | 客服打開頁面。規劃器以為只有 1 列，選了 Nested Loop：`orders` 每找到一列，就去 `customers` 查一次那位客戶，覺得只會查一次 | 1 | 約 41 萬 | |
| T3 | 實際找到 41 萬列，`customers` 就被查了 41 萬次 | 1 | 約 41 萬 | 從 50 毫秒變成 12 秒，開始逾時；資料庫 CPU 衝到 90% |
| T4 | 值班工程師跑 `EXPLAIN`：cost 很低、預估 `rows=1`，判斷計畫沒問題，轉去懷疑網路 | 1 | 約 41 萬 | 還是 12 秒 |
| T5 | 資深同事在[讀取副本](17-讀取副本.md)（專門給讀取用的資料庫複本）上跑 `EXPLAIN (ANALYZE, BUFFERS)`，看到預估 1 列、實際 412337 列 | 1 | 412337 | 還是 12 秒 |
| T6 | 手動執行 `ANALYZE orders;`，規劃器知道這個值有 40 萬列，改選 Hash Join（把其中一邊先建成查找表，再一次比對完） | 約 40 萬 | 約 41 萬 | 回到 300 毫秒左右 |

T5 資深同事看到的輸出是這樣。每一行是計畫裡的一個步驟；前面括號是預估，`actual` 開頭的括號是實際跑出來的數字，`loops` 是這一步被執行了幾次：

```text
Nested Loop  (cost=0.86..17.02 rows=1 width=96) (actual time=0.05..11873.2 rows=412337 loops=1)
  ->  Index Scan using idx_orders_status on orders o  (... rows=1 ...) (actual ... rows=412337 loops=1)
  ->  Index Scan using customers_pkey on customers c  (... rows=1 ...) (actual ... rows=1 loops=412337)
```

規劃器以為 `status = 'refunding'` 只有 1 列，所以選了 Nested Loop（對外層每一列去內層查一次），覺得只會查一次。實際上外層吐出 41 萬列，內層就被查了 41 萬次（`loops=412337`）。

- **使用者看到的**：客服打開「待處理退款」頁面一直轉圈，最後逾時。
- **工程師看到的**：API 回應時間從 50 毫秒變成 12 秒、資料庫 CPU 90%。`EXPLAIN` 顯示 cost 很低、`rows=1`，看起來沒事；`EXPLAIN (ANALYZE, BUFFERS)` 才看到 `actual ... rows=412337` 和內層的 `loops=412337`。

**根因**：匯入那段 `INSERT ... SELECT` 後面少了 `ANALYZE orders;`，統計資訊裡沒有 `'refunding'`，規劃器把 41 萬列估成 1 列，選了 Nested Loop。排查會拖這麼久，是因為工程師跑的 `EXPLAIN` 只印預估，看不到實際的 41 萬列。

**怎麼修**：先手動執行 `ANALYZE orders;`，後續再補上合適的索引。事後檢討的改善事項有兩條：匯入工作最後一步固定加上 `ANALYZE`；排查慢查詢時，要看 `EXPLAIN ANALYZE` 的實際數字，不能只看 `EXPLAIN` 的預估。下面「它是怎麼運作的」的「7. 預估列數 vs 實際列數」會講怎麼發現估錯，「動手看看」的實驗 2 會讓你在自己的電腦上重現這個情境。

## 全貌：它在系統裡的位置

這張圖畫的是一條 SQL 從 API 送進 PostgreSQL 之後走過的路，以及 `EXPLAIN ANALYZE` 看的是哪一段，會動的箭頭是 SQL 在資料庫裡被規劃、再被執行的那一段：

```mermaid
flowchart LR
    U["使用者"] --> API["API 伺服器"]
    subgraph PG["PostgreSQL"]
        S[("統計資訊")] --> P["規劃器：挑一種跑法"]
        P e1@--> X["執行器：照計畫跑"]
        X e2@--> T[("orders、customers 表")]
    end
    e1@{ animate: true }
    e2@{ animate: true }
    API -- "送出 SQL" --> P
    DEV["工程師"] -. "EXPLAIN ANALYZE" .-> P
    X -. "回報每一步的預估與實際" .-> DEV
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class P,X hot
```

`EXPLAIN ANALYZE` 看的是 PostgreSQL 內部黃色那兩格：規劃器根據統計資訊挑了哪種跑法，執行器照著跑時每一步實際花多久、出了幾列。上一篇[查詢最佳化](11-查詢最佳化.md)教你找出該先看哪條 SQL，這篇接著看它慢在哪一步；規劃器挑的跑法有沒有走索引，則跟[資料庫索引](10-資料庫索引.md)有關。如果問題出在 API 那端送了太多次查詢（[N+1 查詢](09-N+1%20查詢.md)），單看一條計畫是看不出來的。

## 生活比喻

`EXPLAIN` 像是出門前打開導航 App：它根據手上的路況資料，規劃一條路線，告訴你「預計 25 分鐘」。你還沒出門，什麼都沒花。

`EXPLAIN ANALYZE` 則是**真的開一趟**，車上裝行車紀錄器，回來後告訴你：「第一段高速公路預估 10 分鐘，實際 9 分鐘；第二段市區預估 5 分鐘，實際塞了 40 分鐘。」你立刻知道問題在第二段，而且知道是導航手上的路況資料太舊，才會以為那段不會塞。

這個比喻在幾個地方會失準：

- **真的開一趟就是真的開了。** 導航模擬不會花油錢，但 `EXPLAIN ANALYZE` 跑 `DELETE` 是真的會把資料刪掉，這一點比喻反而太溫和。
- **資料庫不會半路改道。** 導航發現塞車會即時重新規劃；PostgreSQL 一旦選定計畫就會照著跑完，就算中途發現列數跟預估差了一萬倍也不會換。所以「規劃前的統計資訊準不準」特別重要。
- **路線不只一段一段接起來。** 執行計畫是一棵樹，兩條支線可以各自產出資料，再在某個節點合併（例如 join）。

## 它是怎麼運作的

### 1. 一條 SQL 的旅程：規劃 → 執行

同一條 SQL 可以有好幾種跑法，快慢可以差很多（後面實驗 1 加了索引，從 85 毫秒變成 0.3 毫秒），所以資料庫執行前會先挑一種。你送出一條 SQL 時，資料庫依序做這幾件事：先解析與改寫，再由規劃器參考統計資訊產生執行計畫，最後由執行器照計畫跑出結果列。

```mermaid
flowchart LR
    A["SQL 字串"] --> B["解析與改寫 (parse / rewrite)"]
    B --> C["規劃器 planner"]
    S[("統計資訊 pg_statistic")] --> C
    C --> D["執行計畫 (plan tree)"]
    D --> E["執行器 executor"]
    E --> F["結果列"]
```

`EXPLAIN` 和 `EXPLAIN ANALYZE` 在這條路上的不同位置停下來輸出，下面這張圖多畫了這兩個出口：

```mermaid
flowchart LR
    A["SQL 字串"] --> B["解析與改寫 (parse / rewrite)"]
    B --> C["規劃器 planner"]
    S[("統計資訊 pg_statistic")] --> C
    C --> D["執行計畫 (plan tree)"]
    D --> E["執行器 executor"]
    E --> F["結果列"]
    D -.->|"EXPLAIN 停在這裡，只印計畫"| X["輸出預估"]
    E -.->|"EXPLAIN ANALYZE 真的跑完，附上實測"| Y["輸出預估 + 實際"]
```

規劃器會列出好幾種可能的跑法（先掃哪張表、用不用索引、用哪種 join），用統計資訊估算每種跑法的成本，挑**估起來最便宜**的那個。注意是「估起來」：統計資訊錯了，挑出來的就可能是最貴的。

- `EXPLAIN`：規劃完就停，印出計畫和預估值。安全、快速，不碰資料。
- `EXPLAIN ANALYZE`：規劃完**真的執行**，邊跑邊記錄每個節點的實際時間和列數。結果列不會回傳給你，但該做的事都做了：`SELECT` 會真的讀資料、`UPDATE` 會真的改、觸發器（trigger）會真的觸發。

### 2. 一行節點怎麼讀

執行計畫由好幾個步驟組成，每個步驟叫一個節點（node），`EXPLAIN` 輸出的每一行就是一個節點。先看單獨一行：

```text
Seq Scan on orders  (cost=0.00..19941.00 rows=100 width=40) (actual time=0.9..85.3 rows=98 loops=1)
```

| 欄位 | 意思 |
|---|---|
| `Seq Scan on orders` | 節點類型和作用的表 |
| `cost=0.00..19941.00` | 預估成本：**啟動成本..總成本**。啟動成本是吐出第一列前要花的，總成本是全部吐完 |
| `rows=100` | 預估這個節點會輸出幾列 |
| `width=40` | 預估每列平均幾個位元組 |
| `actual time=0.9..85.3` | 實際時間（毫秒）：吐出第一列的時間..吐完最後一列的時間 |
| `rows=98` | 實際輸出列數 |
| `loops=1` | 這個節點被執行了幾次 |

讀這些數字時，有兩個地方容易算錯：

1. **`actual time` 和 `rows` 都是「每一次 loop 的平均值」。** 節點 `loops=500`、`actual time=0.010..0.020`，代表這個節點總共大約花了 0.020 × 500 = 10 毫秒，不是 0.02 毫秒；輸出列數也要乘上 loops。
2. **父節點的時間和 BUFFERS 數字包含子節點。** 父節點 `actual time=..120`、子節點 `..115`（兩者都是 `loops=1`），代表父節點自己只花了約 5 毫秒。要找最花時間的那一層，要拿自己的數字減掉子節點的數字（子節點 loops 大於 1 時，先乘回總量再減）。

這張圖把上面兩條規則各套一次數字：

```mermaid
flowchart LR
    subgraph R1["規則 1：乘上 loops"]
        direction LR
        L1["內層節點<br/>actual time=0.010..0.020<br/>loops=500"] --> L2["0.020 ms × 500 次<br/>總共約 10 ms"]
    end
    subgraph R2["規則 2：減掉子節點"]
        direction LR
        P1["父節點 actual time=..120"] --> P3["父節點自己<br/>約 120 − 115 = 5 ms"]
        P2["子節點 actual time=..115"] --> P3
    end
```

### 3. cost 是什麼單位

PostgreSQL 把表切成一頁一頁存在磁碟上（每頁預設 8KB），讀資料時一次讀一整頁，下面說的「資料頁」就是指它。循序讀是照順序一頁接一頁讀，隨機讀是跳來跳去讀，後者比較慢。

cost 是規劃器自己用的相對單位，基準由幾個設定決定（以下為預設值）：

| 設定 | 預設 | 意思 |
|---|---|---|
| `seq_page_cost` | 1.0 | 循序讀一個資料頁 |
| `random_page_cost` | 4.0 | 隨機讀一個資料頁 |
| `cpu_tuple_cost` | 0.01 | 處理一列 |
| `cpu_index_tuple_cost` | 0.005 | 處理一筆索引項目 |
| `cpu_operator_cost` | 0.0025 | 執行一次運算子或函式（例如比較 `=`） |

所以一個 Seq Scan 的總成本大約是「資料頁數 × 1.0 + 列數 × 0.01 + 列數 × 過濾條件裡的運算子與函式個數 × 0.0025」（例如 `customer_id = 42` 只有一個 `=`；`created_at >= now() - interval '7 days'` 則有 `>=`、`-`、`now()` 三個）。你不需要會算。**cost 不能換算成毫秒**，它的用途是讓規劃器比較「同一條 SQL 的不同跑法」誰比較便宜。

想看這幾項怎麼湊出一個 cost，可以拿「動手看看」實驗 1 的 Seq Scan 代入：整張 orders 表 8334 頁、100 萬列，過濾條件 `customer_id = 42` 只有一個 `=`。

```mermaid
flowchart LR
    A["8334 頁 × 1.0<br/>= 8334"] --> S["總成本 20834"]
    B["100 萬列 × 0.01<br/>= 10000"] --> S
    C["100 萬列 × 1 個運算子 × 0.0025<br/>= 2500"] --> S
    S --> U["規劃器拿它跟其他跑法比<br/>不能換算成毫秒"]
```

三項加起來，就是實驗 1 輸出裡的 `cost=0.00..20834.00`。

很多跑在 SSD 上的環境會把 `random_page_cost` 調低（常見 1.1 左右），讓規劃器更願意用索引。這是 DBA 層級的調校，新人知道有這回事就好，不要自己在正式環境改。

### 4. 讀計畫樹：由內往外

下面是一條「把 orders 和 customers 接起來，再分組彙總」的查詢的計畫，右邊的編號是資料產生的先後：

```text
HashAggregate                         ← 4. 最後做分組彙總
  ->  Hash Join                       ← 3. 把兩邊接起來
        ->  Seq Scan on orders o      ← 2. 掃 orders，逐列去 hash 表裡比對
        ->  Hash                      ← 1b. 把 customers 建成 hash 表
              ->  Seq Scan on customers c   ← 1a. 先掃 customers
```

`->` 和縮排表示父子關係。縮排最深的先產生資料，往上傳。同一層的兩個子節點，第一個叫外層（outer），第二個叫內層（inner）。

PostgreSQL 執行時，**父節點需要資料，才向子節點要下一列**（拉取式，一次一列），子節點的資料是被父節點一列一列拉上去的。所以 `LIMIT 10` 底下的節點常常只跑了一點點就停了：父節點拿到 10 列就不再要了。讀計畫時「由內往外」是理解資料流向的方法，不代表內層一定全部跑完。

這張圖是 `LIMIT 10` 底下接一個 Seq Scan 時，兩個節點之間的來回：

```mermaid
sequenceDiagram
    participant L as Limit
    participant S as Seq Scan
    loop 重複 10 次
        L->>S: 給我下一列
        S-->>L: 一列
    end
    Note over L: 拿到 10 列，不再要了
    Note over S: 表還沒讀完就停下
```

### 5. 掃描節點：資料怎麼從表裡拿出來

看表格之前，先認識三個詞：

- **回表**：索引裡只存欄位值和「這一列放在表的哪裡」，要拿整列資料，就得回到表本身（heap）去讀，這個動作叫回表。
- **可見性對照表（visibility map）**：記錄「哪些資料頁裡的列，所有交易都看得到」。Index Only Scan 靠它判斷能不能不回表，`VACUUM` 會更新它。
- **`work_mem`**：每個排序、hash 或 bitmap 動作可以用的記憶體上限，不夠用就會改用比較粗略或比較慢的做法。

這張圖是四種掃描各自怎麼拿到資料，一列是一種：

```mermaid
flowchart LR
    subgraph SEQ["Seq Scan"]
        direction LR
        s1["從頭讀表的每一頁"] --> s2["逐列套用 Filter"]
    end
    subgraph IDX["Index Scan"]
        direction LR
        i1["索引找到符合的項目"] --> i2["每一筆回表拿整列"]
    end
    subgraph IOS["Index Only Scan"]
        direction LR
        o1["索引找到符合的項目"] --> o2{"可見性對照表說<br/>這頁全部看得到?"}
        o2 -->|"是"| o3["直接用索引裡的值"]
        o2 -->|"否"| o4["回表確認，算進 Heap Fetches"]
    end
    subgraph BMP["Bitmap Index Scan + Bitmap Heap Scan"]
        direction LR
        b1["索引收集符合列所在的資料頁"] --> b2["資料頁排好順序"]
        b2 --> b3["一頁一頁讀表"]
    end
```

| 節點 | 在做什麼 | 什麼時候合理 | 什麼時候是警訊 |
|---|---|---|---|
| **Seq Scan** | 從頭到尾把整張表讀一遍，逐列套用 `Filter` | 小表；或要讀表中很大比例的列 | 大表且 `Rows Removed by Filter` 是輸出列數的幾百、幾千倍 |
| **Index Scan** | 走索引找到符合的項目，再回表（heap）拿整列 | 篩出少量列；或需要依索引順序輸出 | 回表次數很多、資料又分散時，可能比 Seq Scan 慢 |
| **Index Only Scan** | 只讀索引就拿到所有需要的欄，不回表 | 查詢用到的欄都在索引裡 | `Heap Fetches` 很大，代表可見性對照表（visibility map）不夠新，常常還是得回表，通常 `VACUUM` 之後會改善 |
| **Bitmap Index Scan + Bitmap Heap Scan** | 先用索引收集所有符合列所在的資料頁，排好順序再一次讀資料頁 | 篩出「中等數量」的列；或多個索引條件用 AND/OR 合併 | `Heap Blocks` 出現 `lossy`，代表 bitmap 太大、`work_mem` 不夠，只記得「哪幾頁」不記得「哪幾列」，只好把整頁的列都拿 `Recheck Cond` 重新檢查一遍（會看到 `Rows Removed by Index Recheck`）。注意：計畫裡出現 `Recheck Cond` 這行本身很正常，不代表真的有重新檢查 |

**Seq Scan 在很多情況下就是最快的做法。** 一張 200 列的設定表，走索引反而多一次查索引的成本；要讀表中一半的資料時，循序讀整張表也比隨機回表幾十萬次快。要不要加索引，看「過濾掉的比例」和「表的大小」來判斷。新人常見的誤判是看到 Seq Scan 就加索引。

### 6. Join 節點：兩張表怎麼接起來

下表的 hash 表是一種用鍵快速查找的對照表，像一本照編號排好的字典，給一個 `customer_id` 就能直接翻到那位客戶。

| 節點 | 做法 | 適合 | 典型地雷 |
|---|---|---|---|
| **Nested Loop** | 外層每一列，去內層找一次符合的列 | 外層很少列，而且內層有索引可以快速查 | 外層列數被嚴重低估，內層 `loops` 爆成幾十萬次（就是開頭那個情境） |
| **Hash Join** | 把內層（通常是較小的一邊）建成 hash 表，外層逐列去 hash 表比對 | 兩邊都不小、等值 join（`=`） | `Hash` 節點的 `Batches` 大於 1，代表記憶體（`work_mem`）不夠，hash 表被切塊寫到磁碟 |
| **Merge Join** | 兩邊都先依 join 鍵排序，再像拉拉鍊一樣同時往下走 | 兩邊都很大，而且本來就有排序（例如都有索引） | 為了 Merge Join 額外做了 `Sort`，而且 `Sort Method: external merge  Disk: ...` 寫到磁碟 |

開頭情境裡的 Nested Loop 是這樣跑的，看最右欄 loops 怎麼累積：

| 步驟 | 外層 orders 吐出 | 內層 customers 做什麼 | 內層 loops 累計 |
|---|---|---|---|
| 1 | 第 1 筆 `'refunding'` 訂單 | 用它的 `customer_id` 走 `customers_pkey` 查一次 | 1 |
| 2 | 第 2 筆 | 再查一次 | 2 |
| 3 | 第 3 筆 | 再查一次 | 3 |
| 4 | 一路吐到第 412337 筆 | 每一筆都查一次 | 412337 |
| 5 | 沒有下一筆了 | 結束 | 412337，就是輸出裡的 `loops=412337` |

Hash Join 的來回少很多。以「動手看看」完整解讀範例的計畫為例，customers 是被建成 hash 表的那一邊：

```mermaid
sequenceDiagram
    participant J as Hash Join
    participant C as Seq Scan customers
    participant O as Seq Scan orders
    J->>C: 把 customers 整張讀上來
    C-->>J: 10000 列
    Note over J: 建成 hash 表，放在記憶體裡
    loop 每一列訂單
        J->>O: 給我下一列
        O-->>J: 一列訂單
        Note over J: 拿 customer_id 查 hash 表
    end
```

另外幾個常見節點：`Sort`（排序，注意 `Sort Method` 是 `quicksort` 在記憶體裡還是 `external merge` 寫磁碟）、`HashAggregate`／`GroupAggregate`（`GROUP BY`）、`Limit`、`Gather`（平行查詢把多個 worker 的結果收回來）。

### 7. 預估列數 vs 實際列數：計畫好壞的關鍵

規劃器選 join 方式、選掃描方式，全靠「這一步會出來幾列」的預估。預估的依據是統計資訊（每欄的常見值、分布直方圖、相異值數量等），由 `ANALYZE` 指令收集。

```mermaid
flowchart TD
    A["看到 rows 預估 vs actual rows"] --> B{"差距超過約 10 倍?"}
    B -- "否" --> C["估計大致可信，往下找最花時間的節點"]
    B -- "是" --> D{"最近有大量寫入或匯入?"}
    D -- "是" --> E["ANALYZE 表名 後重看計畫"]
    D -- "否" --> F{"條件是多欄相關、函式包欄位、或 LIKE 之類?"}
    F -- "是" --> G["屬於估不準，交給查詢最佳化處理"]
    F -- "否" --> H["提高該欄統計目標或找 DBA 一起看"]
```

估不準的常見原因：

- **統計過期**：大量匯入、批次更新之後還沒 `ANALYZE`。自動分析會在表的變動列數超過一定門檻後觸發（預設是 50 列加上表總列數的 10%），大表要累積很多變動才會觸發，匯入完當下通常還沒跑。
- **欄位之間有相關性**：例如 `city = '台北' AND zip = '100'`，規劃器預設假設兩個條件互相獨立，會把機率直接相乘，估得太少。PostgreSQL 10 起可以用 `CREATE STATISTICS` 建立多欄的延伸統計。
- **條件裡把欄位包在函式裡**：`WHERE lower(email) = ...`、`WHERE created_at::date = ...`，規劃器對函式結果沒有統計，只能用預設比例猜。

細節留給 [查詢最佳化](11-查詢最佳化.md)，這篇只要你學會**發現**估錯。

### 8. BUFFERS：讀了多少資料頁

加上 `BUFFERS` 可以看到每個節點碰了多少資料頁、是從記憶體還是從磁碟拿的。PostgreSQL 18 起 `EXPLAIN ANALYZE` 預設就會附上 BUFFERS，舊版要自己寫 `EXPLAIN (ANALYZE, BUFFERS)`。輸出長這樣：

```text
Buffers: shared hit=2141 read=5300
```

- `shared hit`：在 PostgreSQL 的共享緩衝區（shared buffers）裡就找到的資料頁，很快。
- `shared read`：緩衝區沒有，要向作業系統要（可能在 OS 快取，也可能真的讀磁碟），慢很多。
- `dirtied`／`written`：這次查詢弄髒或寫出的資料頁，通常在寫入語句或剛大量寫入的表上會看到。
- `temp read/written`：排序、hash 用到的暫存檔，看到它代表記憶體不夠，溢出到磁碟了。

這張圖是節點每要一頁資料時，這一頁會被算進哪個數字，會動的箭頭是比較慢的那條路：

```mermaid
flowchart LR
    N["節點要讀一頁"] --> Q{"在 shared buffers 裡?"}
    Q -->|"有"| HIT["算進 shared hit"]
    Q -->|"沒有"| ASK["向作業系統要"]
    ASK e1@--> OS["OS 快取或磁碟"]
    OS e2@--> READ["算進 shared read"]
    e1@{ animate: true }
    e2@{ animate: true }
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class READ hot
```

一個資料頁預設是 8KB。`hit + read` 是這個節點碰過的資料頁總數，乘以 8KB 大概就是它讀了多少資料。這個數字比時間更穩定：時間會受快取冷熱、機器忙不忙影響，**讀了幾頁**則主要取決於計畫本身。同一條 SQL 第一次跑 read 很多、第二次全變 hit 而且變快，原因是快取熱了，計畫和碰的頁數都沒變。

### 9. 檢查一份執行計畫：照順序看，每一步為什麼

前面 8 小節把零件一個一個拆開講。真的拿到一份幾十行的計畫時，從哪一行看起、看到什麼該往哪裡查，這一小節排成固定的順序。順序有它的道理：先確認慢在資料庫裡，再找最花時間的那一層，最後才看那一層的細節，就不會花一個下午去修一個只佔 5% 時間的節點。

#### 先拿到要檢查的 SQL 和它的計畫

這張表是從「發現變慢」到「手上有一份能讀的計畫」要走的幾步：

| 步驟 | 做什麼 | 為什麼 |
|---|---|---|
| 1 | 找出是哪條 SQL：`pg_stat_statements` 依 `total_exec_time` 排序，看總耗時最高的查詢 | 憑感覺挑會挑錯。總耗時最高的那條，改快一點省下的時間最多。設定方式見[查詢最佳化](11-查詢最佳化.md)的〈一、找慢查詢〉 |
| 2 | 拿到實際送出的 SQL 和參數值：`log_min_duration_statement`（預設 `-1`，關閉）設一個門檻，超過的那一次會連同 SQL 寫進日誌 | `pg_stat_statements` 把常數換成 `$1`，看不到當時帶的值。用 ORM 的話，開 SQL 日誌看它實際送了什麼（SQLAlchemy 的 `echo=True`，見 [N+1 查詢](09-N+1%20查詢.md)） |
| 3 | 偶爾才慢的查詢，用 `auto_explain` 直接撈計畫：`auto_explain.log_min_duration` 設門檻，`auto_explain.log_analyze` 打開才有實際數字，`auto_explain.log_buffers` 要搭配它才有 BUFFERS | 事後重跑可能已經不慢了，日誌裡留下的是「慢的那一次」的計畫。官方文件提醒 `log_analyze` 會替每一條語句計時，可能嚴重拖慢效能，要跟 DBA 討論 |
| 4 | 選指令：預設用 `EXPLAIN (ANALYZE, BUFFERS)`；一跑要好幾分鐘、或在不能執行的地方，才退回只看 `EXPLAIN` 的預估 | 只看預估會被開頭情境那種 `rows=1` 騙過（地雷 2） |
| 5 | 找安全的地方跑：讀取副本或測試環境，加上 `statement_timeout`；寫入語句包在 `BEGIN … ROLLBACK` 裡（地雷 1） | `EXPLAIN ANALYZE` 會真的執行，`DELETE` 會真的刪 |

帶參數的查詢還有一個坑。應用程式用預備語句（prepared statement，先把 SQL 送給資料庫準備好，之後每次只送參數）時，PostgreSQL 預設（`plan_cache_mode = auto`）前 5 次會用帶入實際參數值算出的計畫（custom plan），之後另外做一份不看參數值的通用計畫（generic plan），如果它估起來沒有貴太多，之後就改用它。你手動把值填進 SQL 再 `EXPLAIN`，看到的是 custom plan，可能跟正式環境實際在跑的不同。想看通用計畫，PostgreSQL 16 起可以用 `EXPLAIN (GENERIC_PLAN)`（條件會寫成 `$1`，不能跟 `ANALYZE` 一起用）；也可以先 `PREPARE`，再 `SET plan_cache_mode = force_generic_plan`，然後 `EXPLAIN EXECUTE`。

#### 讀結果的順序

拿到 `EXPLAIN (ANALYZE, BUFFERS)` 的輸出後，照這個順序看。每一步都寫了看哪裡、怎麼判斷、為什麼要看：

| 步驟 | 看哪裡 | 怎麼判斷 | 為什麼 |
|---|---|---|---|
| 1 | 最底下的 `Execution Time` 和 `Planning Time` | 跟 API 變慢的時間對得上嗎？兩個哪個大？ | 先確認慢在資料庫裡。`Execution Time` 很小、API 卻很慢，問題在別處（例如 N+1，或把結果送回去的時間，它不算在 `Execution Time` 裡）。`Planning Time` 佔大部分時，要處理的是規劃本身，看節點沒有用 |
| 2 | 每個節點 `actual time` 的第二個數字和 `loops` | 第二個數字 × loops 是總時間；再減掉子節點的總時間，找出「自己」花最多的那層 | 父節點的時間包含子節點，最上面那層的數字一定最大，直接看它會以為整條都慢。要先改的是自己花最多的那層（第 2 小節） |
| 3 | 那一層的 `rows=`（預估）和 `actual ... rows=`（實際，也要乘 loops） | 差 10 倍以上就算估錯 | 掃描方式和 join 方式都是照預估列數挑的，估錯了，後面的選擇都可能跟著錯。常見原因是統計過期（先 `ANALYZE`）、欄位之間相關、欄位被包在函式裡（第 7 小節） |
| 4 | 掃描節點的類型、`Rows Removed by Filter`、`Heap Fetches` | 大表 Seq Scan 只留下少數列，`Rows Removed by Filter` 是輸出的幾十倍以上，是警訊。Index Scan 回傳表裡很大比例的列，也可能比 Seq Scan 慢。Index Only Scan 的 `Heap Fetches` 很大，代表還是常回表 | `Rows Removed by Filter` 是讀出來才丟掉的列，丟越多，白讀越多，代表索引沒用到或沒用對。要回傳很多列時，一筆一筆回表的隨機讀加起來，會比循序讀整張表還貴（第 5 小節） |
| 5 | Join 節點，和它內層的 `loops` | Nested Loop 的外層列數很大，內層 `loops` 也跟著很大 | Nested Loop 對外層每一列都去內層查一次，外層 41 萬列就查 41 萬次。外層列數被低估時最容易出事，就是開頭的情境（第 6 小節） |
| 6 | `Sort Method`、`Hash` 的 `Batches`、`temp read/written` | 出現 `external merge  Disk:`，或 `Batches` 大於 1 | 每個排序或 hash 動作能用的記憶體上限是 `work_mem`（預設 4MB；hash 動作預設可以用到它的 2 倍），放不下就寫暫存檔到磁碟。看到了先算這層自己花多少時間，再決定值不值得處理 |
| 7 | 每個節點的 `Buffers: shared hit` 和 `read` | `read` 多是冷快取；同一條查詢再跑一次，`read` 變成 `hit`、時間變短 | 時間會隨快取冷熱改變，碰的頁數主要看計畫。比較改前改後，兩次要在一樣的快取狀態下跑，並以頁數為主要依據（第 8 小節） |
| 8 | 改完之後的同一份輸出 | 同樣的資料、參數、快取狀態再跑一次，比 `Execution Time` 和 Buffers | cost 是預估，改了寫法 cost 變小，實際不一定變快。只有實測數字能證明真的變好 |

看到某個訊號之後該往哪個方向查，這張圖把上面的順序畫成判讀流程：

```mermaid
flowchart TD
    A{"Execution Time 真的慢?"} -->|"否"| Z["問題在資料庫外面<br/>例如 N+1 或網路"]
    A -->|"是"| B{"Planning Time 佔大部分?"}
    B -->|"是"| P["規劃本身太慢<br/>找 DBA 一起看"]
    B -->|"否"| C["找自己花最多時間的節點<br/>actual time × loops 再減子節點"]
    C --> D{"預估和實際列數差 10 倍以上?"}
    D -->|"是"| E["先 ANALYZE<br/>再查函式包欄位、欄位相關"]
    D -->|"否"| F{"這個節點是哪一種?"}
    F -->|"掃描, Rows Removed 很大"| G["檢查索引有沒有用上、用對"]
    F -->|"Nested Loop, 內層 loops 很大"| H["回頭看外層的列數"]
    F -->|"Sort 或 Hash 寫到磁碟"| I["少排一點資料, 或調 work_mem"]
    E --> V["同樣條件再跑一次<br/>比 Execution Time 和 Buffers"]
    G --> V
    H --> V
    I --> V
```

#### 照順序走一遍：上個月已付款訂單報表

下面用「動手看看」的同一份資料（1 萬個客戶、100 萬筆訂單，表上有主鍵和實驗 1 建的 `idx_orders_customer_id`，也一樣先關掉平行查詢）。想自己跑的話，等做完「動手看看」再回來。

財務要一份「上個月所有已付款訂單，依金額由高到低」的報表。工程師寫的條件是「訂單建立時間取到月份，等於上個月」：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, c.name, o.amount, o.created_at
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'paid'
  AND date_trunc('month', o.created_at) = date_trunc('month', now() - interval '1 month')
ORDER BY o.amount DESC;
```

PostgreSQL 17 實跑，容器剛重啟、共享緩衝區是空的（時間依機器而異，列數會因亂數資料略有不同）：

```text
Sort  (cost=33934.19..33946.05 rows=4745 width=35) (actual time=236.741..241.541 rows=78347 loops=1)
  Sort Key: o.amount DESC
  Sort Method: external merge  Disk: 3840kB
  Buffers: shared hit=5 read=8405, temp read=480 written=481
  ->  Hash Join  (cost=298.00..33644.46 rows=4745 width=35) (actual time=1.695..212.583 rows=78347 loops=1)
        Hash Cond: (o.customer_id = c.id)
        Buffers: shared hit=2 read=8405
        ->  Seq Scan on orders o  (cost=0.00..33334.00 rows=4745 width=30) (actual time=0.018..193.982 rows=78347 loops=1)
              Filter: ((status = 'paid'::text) AND (date_trunc('month'::text, created_at) = date_trunc('month'::text, (now() - '1 mon'::interval))))
              Rows Removed by Filter: 921653
              Buffers: shared read=8334
        ->  Hash  (cost=173.00..173.00 rows=10000 width=21) (actual time=1.623..1.624 rows=10000 loops=1)
              Buckets: 16384  Batches: 1  Memory Usage: 675kB
              Buffers: shared hit=2 read=71
              ->  Seq Scan on customers c  (cost=0.00..173.00 rows=10000 width=21) (actual time=0.003..0.792 rows=10000 loops=1)
                    Buffers: shared hit=2 read=71
Planning:
  Buffers: shared hit=220 read=39 dirtied=5
Planning Time: 0.639 ms
Execution Time: 244.043 ms
```

這張圖把每個節點「自己」花的時間算出來標上去（自己的時間＝自己的 actual time 減掉子節點的），黃色是最花時間的那層：

```mermaid
flowchart BT
    C["Seq Scan customers<br/>自己約 0.8 ms"] --> H["Hash<br/>自己約 0.8 ms"]
    O["Seq Scan orders<br/>自己約 194 ms<br/>丟掉 921653 列"] --> J["Hash Join<br/>自己約 17 ms"]
    H --> J
    J --> S["Sort<br/>自己約 29 ms, 寫磁碟 3840kB"]
    S --> T["Execution Time 244 ms"]
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class O hot
```

照清單一步一步看：

| 步驟 | 看哪裡 | 這份計畫裡看到 | 結論 |
|---|---|---|---|
| 1 | `Execution Time`、`Planning Time` | 244.0 ms、0.6 ms | 慢在執行，規劃不用管 |
| 2 | 各節點自己的時間 | Seq Scan on orders 約 194 ms，佔約八成；Sort 自己約 29 ms；Hash Join 自己約 17 ms | 先看 orders 的掃描 |
| 3 | orders 的預估 vs 實際 | `rows=4745` 對 `actual ... rows=78347`，差約 16 倍 | 估錯了。條件把 `created_at` 包在 `date_trunc(...)` 裡，規劃器沒有這個函式結果的統計，只能用預設比例猜 |
| 4 | 掃描方式、`Rows Removed by Filter` | Seq Scan，`Rows Removed by Filter: 921653` | 為了 7.8 萬列，逐列檢查了 100 萬列。欄位包在函式裡，就算有 `created_at` 的索引也用不上 |
| 5 | Join 與 loops | Hash Join，每個節點都是 `loops=1`，`Batches: 1` | join 沒問題，沒有 Nested Loop 內層爆量的情況 |
| 6 | Sort | `Sort Method: external merge  Disk: 3840kB`、`temp written=481` | 排序寫到磁碟了，但它自己只花約 29 ms，先不處理（實測把 `work_mem` 調到 16MB，改成 `quicksort  Memory: 7357kB`，Sort 自己的時間還是約 28 ms） |
| 7 | Buffers | `shared hit=5 read=8405`；同一條再跑一次，orders 那層還是 `read=8302` | 冷快取。大表的 Seq Scan 只借用一小塊環狀緩衝區（ring buffer，256KB），讀過的頁很快就被換掉，所以再跑一次也不會全變 `hit` |

第 2 步的 194 ms 花在哪裡，可以拿同一張表對照：在同樣剛重啟的狀態下跑 `SELECT count(*) FROM orders`，Seq Scan 讀同樣 8334 頁只花 40.7 ms。所以這 194 ms 大部分花在對 100 萬列逐列算 `date_trunc(...)`、比對條件。

根據第 3、4 步，改了兩件事：

1. **條件改成直接比 `created_at` 的範圍**：`o.created_at >= date_trunc('month', now() - interval '1 month') AND o.created_at < date_trunc('month', now())`，意思一樣是「上個月 1 號 0 點起，到這個月 1 號 0 點前」，回傳的列也一樣。欄位沒有被包起來，規劃器可以用 `created_at` 的分布統計來估，預估變成 77849 列，跟實際的 78347 列幾乎一樣。只改這一步時，計畫還是 Seq Scan，時間也沒變（實測 268 ms）。
2. **建 `(status, created_at)` 複合索引** `idx_orders_status_created_at`。做過「動手看看」〈完整解讀範例〉的話，這個索引已經在了；實測原本的寫法有這個索引也用不上，計畫一樣是 Seq Scan，要等條件改成範圍才用得上。

改完再跑一次，一樣是容器剛重啟後的第一次：

```text
Sort  (cost=21922.12..22118.15 rows=78410 width=35) (actual time=105.135..110.420 rows=78347 loops=1)
  Sort Key: o.amount DESC
  Sort Method: external merge  Disk: 3840kB
  Buffers: shared hit=5 read=8708, temp read=480 written=481
  ->  Hash Join  (cost=2510.16..13402.38 rows=78410 width=35) (actual time=6.682..79.954 rows=78347 loops=1)
        Hash Cond: (o.customer_id = c.id)
        Buffers: shared hit=2 read=8708
        ->  Bitmap Heap Scan on orders o  (cost=2212.16..12898.47 rows=78410 width=30) (actual time=4.886..62.517 rows=78347 loops=1)
              Recheck Cond: ((status = 'paid'::text) AND (created_at >= date_trunc('month'::text, (now() - '1 mon'::interval))) AND (created_at < date_trunc('month'::text, now())))
              Heap Blocks: exact=8333
              Buffers: shared read=8637
              ->  Bitmap Index Scan on idx_orders_status_created_at  (cost=0.00..2192.56 rows=78410 width=0) (actual time=4.271..4.272 rows=78347 loops=1)
                    Index Cond: ((status = 'paid'::text) AND (created_at >= date_trunc('month'::text, (now() - '1 mon'::interval))) AND (created_at < date_trunc('month'::text, now())))
                    Buffers: shared read=304
        ->  Hash  (cost=173.00..173.00 rows=10000 width=21) (actual time=1.737..1.739 rows=10000 loops=1)
              Buckets: 16384  Batches: 1  Memory Usage: 675kB
              Buffers: shared hit=2 read=71
              ->  Seq Scan on customers c  (cost=0.00..173.00 rows=10000 width=21) (actual time=0.006..0.874 rows=10000 loops=1)
                    Buffers: shared hit=2 read=71
Planning:
  Buffers: shared hit=253 read=40 dirtied=2
Planning Time: 0.677 ms
Execution Time: 112.871 ms
```

第 8 步，比較改前改後（兩次都是剛重啟後的第一次，快取狀態一樣）：

- **預估**：orders 那層從 `rows=4745` 變成 `rows=78410`，實際都是 78347，估準了。
- **時間**：`Execution Time` 從 244.0 ms 降到 112.9 ms。orders 那層從 Seq Scan 的 194 ms 變成 Bitmap Heap Scan 的 62.5 ms，條件改在索引裡比（`Index Cond`），不用再對 100 萬列逐列檢查。
- **頁數**：最上層的 Buffers 從 8410 頁變成 8713 頁，**沒有變少**。`Heap Blocks: exact=8333` 表示上個月的 78347 列散在 orders 全部 8334 頁裡的 8333 頁，因為這份資料的 `created_at` 是亂數產生的，每一頁都混著各個月份的訂單，索引幫不了忙少讀幾頁。真實系統的訂單如果是照時間先後寫進去的，同一個月的訂單會集中在比較少的頁，這個索引省下的頁數可能就多很多，要在正式資料的副本上量過才知道。
- **再跑一次**：改完的版本第二次跑變成 `shared hit=8713`、65.7 ms。這是快取熱了，不能算成改寫的功勞；改之前那版因為第 7 步說的環狀緩衝區，第二次跑還是 `read`，兩邊的第二次不能拿來比。

Sort 一直寫到磁碟，但它只佔約 29 ms，第 6 步已經判斷先不處理。要不要留下這個索引，看這份報表多常跑（見地雷 6）；條件改成範圍則沒有成本，一定要改。「動手看看」的〈完整解讀範例〉是另一種結果：索引讓碰的頁數從 8410 頁（hit 3 + read 8407）降到 1083 頁（hit 154 + read 929）。兩份對照著看，就知道為什麼第 8 步要同時比時間和頁數。

## 動手看看

### 起一個本機 PostgreSQL

```shell
# 起一個 PostgreSQL 17（本機測試用帳密，不要用在正式環境）
docker run --name pg-explain -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17

# 進到 psql
docker exec -it pg-explain psql -U postgres
```

### 準備資料：1 萬個客戶、100 萬筆訂單

```sql
CREATE TABLE customers (
  id      bigint PRIMARY KEY,
  name    text   NOT NULL,
  country text   NOT NULL
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  customer_id bigint        NOT NULL REFERENCES customers(id),
  status      text          NOT NULL,
  amount      numeric(10,2) NOT NULL,
  created_at  timestamptz   NOT NULL
);

-- 1 萬個客戶，國家輪流分配
INSERT INTO customers
SELECT g, 'customer_' || g, (ARRAY['TW','JP','US','DE'])[1 + g % 4]
FROM generate_series(1, 10000) AS g;

-- 100 萬筆訂單：95% paid、5% pending，時間分散在過去一年
INSERT INTO orders (customer_id, status, amount, created_at)
SELECT 1 + (random() * 9999)::int,
       CASE WHEN random() < 0.95 THEN 'paid' ELSE 'pending' END,
       (random() * 1000)::numeric(10,2),
       now() - random() * interval '365 days'
FROM generate_series(1, 1000000);

-- 收集統計資訊，讓規劃器知道資料長什麼樣
ANALYZE customers;
ANALYZE orders;

-- 教學用：先關掉平行查詢，計畫會比較好讀（只影響這個連線）
SET max_parallel_workers_per_gather = 0;
```

### 實驗 1：沒有索引 vs 有索引

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE customer_id = 42;
```

預期會看到類似這樣（數字每台機器不同，以下為示意）：

```text
Seq Scan on orders  (cost=0.00..20834.00 rows=100 width=35) (actual time=0.95..85.31 rows=98 loops=1)
  Filter: (customer_id = 42)
  Rows Removed by Filter: 999902
  Buffers: shared hit=3034 read=5300
Planning Time: 0.120 ms
Execution Time: 85.402 ms
```

為了找 98 列，掃了 100 萬列、丟掉 999,902 列，碰了 8 千多個資料頁（3034 + 5300 = 8334，也就是整張 orders 表的頁數；hit 和 read 怎麼分配，要看當下快取裡有什麼）。加上索引再跑一次：

```sql
CREATE INDEX idx_orders_customer_id ON orders (customer_id);

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE customer_id = 42;
```

```text
Bitmap Heap Scan on orders  (cost=5.20..380.12 rows=100 width=40) (actual time=0.052..0.301 rows=98 loops=1)
  Recheck Cond: (customer_id = 42)
  Heap Blocks: exact=97
  Buffers: shared hit=100
  ->  Bitmap Index Scan on idx_orders_customer_id  (cost=0.00..5.17 rows=100 width=0) (actual time=0.031..0.031 rows=98 loops=1)
        Index Cond: (customer_id = 42)
        Buffers: shared hit=3
Planning Time: 0.210 ms
Execution Time: 0.335 ms
```

先看內層的 Bitmap Index Scan，查索引只碰了 3 頁，找出 98 列；再看外層的 Bitmap Heap Scan，那 98 列分散在 97 個資料頁（`Heap Blocks: exact=97`），所以總共碰了 100 頁（父節點的 BUFFERS 包含子節點）。從 8 千多頁變成 100 頁，時間從 85 毫秒變 0.3 毫秒。你的機器上也可能選 Index Scan，兩種都合理。

順便試試 Index Only Scan：

```sql
-- 只查索引裡就有的欄
EXPLAIN (ANALYZE, BUFFERS)
SELECT customer_id FROM orders WHERE customer_id BETWEEN 1 AND 50;
```

剛灌完資料、還沒 VACUUM 過的表，可見性對照表幾乎是空的：你可能會看到 Index Only Scan 但 `Heap Fetches` 很大，也可能規劃器乾脆改選 Bitmap Heap Scan（它知道反正都要回表）。跑一次 `VACUUM orders;` 再看，應該會出現 Index Only Scan，而且 `Heap Fetches` 降到 0 或接近 0。（如果 autovacuum 已經先幫你跑過，一開始就會是這個結果。）

### 實驗 2：親手製造「統計過期」

```sql
-- 教學用：關掉這張表的自動 vacuum/analyze，模擬「還沒輪到」
ALTER TABLE orders SET (autovacuum_enabled = false);

-- 灌 20 萬筆從沒出現過的狀態
INSERT INTO orders (customer_id, status, amount, created_at)
SELECT 1 + (random() * 9999)::int, 'refunding', 10, now()
FROM generate_series(1, 200000);

CREATE INDEX idx_orders_status ON orders (status);

EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, c.name
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'refunding';
```

觀察 orders 那個節點：預估 `rows=` 很可能是 1 或很小的數字，`actual ... rows=200000`，差了好幾個數量級。規劃器多半會因此選 Nested Loop，內層 `loops` 變成 20 萬次（不一定每台都會這樣選，但預估和實際的落差一定很明顯）。接著：

```sql
ANALYZE orders;

EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, c.name
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'refunding';

-- 實驗完把自動 vacuum 開回來
ALTER TABLE orders RESET (autovacuum_enabled);
```

預估列數應該會接近 20 萬，join 方式通常會換成 Hash Join。

### 實驗 3：安全地 EXPLAIN ANALYZE 寫入語句

```sql
BEGIN;

EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM orders WHERE status = 'refunding';
-- ↑ 這行真的刪了 20 萬筆，只是還沒 commit

SELECT count(*) FROM orders WHERE status = 'refunding';  -- 在這個交易裡會是 0

ROLLBACK;  -- 復原

SELECT count(*) FROM orders WHERE status = 'refunding';  -- 回到 200000
```

注意 `ROLLBACK` 救得回資料，但救不回所有副作用：sequence 的 `nextval()` 不會倒退、執行期間持有的列鎖會擋住別人、觸發器裡如果透過 `dblink` 寫到別的資料庫，或用擴充套件呼叫外部服務（例如發 HTTP 請求），那些也已經發生了，不會跟著 rollback。（`NOTIFY` 倒是跟著交易走，rollback 之後就不會送出。）

### 完整解讀範例

最後來一條比較像真實需求的查詢：「最近 7 天各國的待處理訂單數和金額」。

```sql
-- 為了跟上面的實驗分開，先把實驗 2 的資料和索引清掉
-- （留著 idx_orders_status 的話，規劃器可能改用它，就看不到下面的全表掃描了）
DELETE FROM orders WHERE status = 'refunding';
DROP INDEX idx_orders_status;
VACUUM ANALYZE orders;

EXPLAIN (ANALYZE, BUFFERS)
SELECT c.country, count(*), sum(o.amount)
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'pending'
  AND o.created_at >= now() - interval '7 days'
GROUP BY c.country;
```

輸出（PostgreSQL 17 實跑、共享緩衝區剛清空時的結果；時間依機器而異，列數會因亂數資料略有不同）：

```text
GroupAggregate  (cost=28682.61..28692.35 rows=4 width=43) (actual time=43.252..43.326 rows=4 loops=1)
  Group Key: c.country
  Buffers: shared hit=3 read=8407
  ->  Sort  (cost=28682.61..28685.03 rows=969 width=9) (actual time=43.199..43.224 rows=1003 loops=1)
        Sort Key: c.country
        Sort Method: quicksort  Memory: 56kB
        Buffers: shared hit=3 read=8407
        ->  Hash Join  (cost=298.00..28634.54 rows=969 width=9) (actual time=1.637..42.974 rows=1003 loops=1)
              Hash Cond: (o.customer_id = c.id)
              Buffers: shared read=8407
              ->  Seq Scan on orders o  (cost=0.00..28334.00 rows=969 width=14) (actual time=0.036..40.944 rows=1003 loops=1)
                    Filter: ((status = 'pending'::text) AND (created_at >= (now() - '7 days'::interval)))
                    Rows Removed by Filter: 998997
                    Buffers: shared read=8334
              ->  Hash  (cost=173.00..173.00 rows=10000 width=11) (actual time=1.549..1.550 rows=10000 loops=1)
                    Buckets: 16384  Batches: 1  Memory Usage: 597kB
                    Buffers: shared read=73
                    ->  Seq Scan on customers c  (cost=0.00..173.00 rows=10000 width=11) (actual time=0.012..0.779 rows=10000 loops=1)
                          Buffers: shared read=73
Planning:
  Buffers: shared hit=218 read=42 dirtied=1
Planning Time: 1.636 ms
Execution Time: 43.397 ms
```

```mermaid
flowchart BT
    A["Seq Scan customers<br/>10000 列, 0.8 ms, 73 頁"] --> B["Hash<br/>建 hash 表 597kB, Batches 1"]
    C["Seq Scan orders<br/>掃 100 萬列只留 1003 列<br/>40.9 ms, 8334 頁"] --> D["Hash Join<br/>1003 列"]
    B --> D
    D --> S["Sort<br/>quicksort 56kB"]
    S --> E["GroupAggregate<br/>4 列, 總計 43.4 ms"]
```

逐步解讀：

1. **最內層 `Seq Scan on customers`**：讀了整張 customers（1 萬列、73 頁）。因為要 join 所有可能的客戶，又只有 73 頁，Seq Scan 很合理。
2. **`Hash`**：把 1 萬個客戶建成 hash 表，`Batches: 1` 代表整個放得進記憶體，沒有溢出到磁碟。到這裡累計約 1.5 毫秒。
3. **`Seq Scan on orders`**：瓶頸在這裡。實際時間 40.9 毫秒，佔總時間 43.4 毫秒的 94%。為了 1003 列掃了 100 萬列（`Rows Removed by Filter: 998997`），碰了 8334 頁，而且全部是 `read`，都不在共享緩衝區。
4. **預估 vs 實際**：預估 969 列、實際 1003 列，非常準。統計資訊沒問題，規劃器也沒選錯：**沒有能服務這個條件的索引**，全表掃描已經是它能選的最好做法。
5. **`Hash Join`**：自己的時間 ≈ 43.0 − 40.9 − 1.6 ≈ 0.5 毫秒，很便宜。
6. **`Sort` + `GroupAggregate`**：1003 列先依國家排序（`Sort Method: quicksort  Memory: 56kB`，在記憶體裡就排完），再分成 4 組，幾乎不花時間。這裡規劃器沒選 HashAggregate，是因為兩種做法估起來成本只差不到 1%，這種情況下它會偏好「輸出剛好有排序」的那個；換一份資料就可能換成 HashAggregate，兩種都正常。
7. 瓶頸在 orders 的全表掃描，解法是給 `status + created_at` 建索引。

```sql
-- 正式環境上大表要用 CONCURRENTLY，避免建索引期間擋住所有寫入（詳見零停機遷移那篇）
-- 注意：CONCURRENTLY 不能放在 BEGIN ... COMMIT 交易區塊裡執行
CREATE INDEX CONCURRENTLY idx_orders_status_created_at
  ON orders (status, created_at);
```

再跑一次，PostgreSQL 17 實跑會得到（時間依機器而異）：

```text
HashAggregate (actual time=7.890..7.892 rows=4 loops=1)
  Group Key: c.country
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=154 read=929
  ->  Hash Join (actual time=1.374..7.714 rows=1003 loops=1)
        Hash Cond: (o.customer_id = c.id)
        Buffers: shared hit=154 read=929
        ->  Index Scan using idx_orders_status_created_at on orders o (actual time=0.042..6.131 rows=1003 loops=1)
              Index Cond: ((status = 'pending'::text) AND (created_at >= (now() - '7 days'::interval)))
              Buffers: shared hit=81 read=929
        ->  Hash (actual time=1.280..1.281 rows=10000 loops=1)
              Buckets: 16384  Batches: 1  Memory Usage: 597kB
              Buffers: shared hit=73
              ->  Seq Scan on customers c (actual time=0.004..0.511 rows=10000 loops=1)
                    Buffers: shared hit=73
Planning:
  Buffers: shared hit=297 read=1
Planning Time: 0.477 ms
Execution Time: 7.965 ms
```

（為了好讀省略了 cost，等同加上 `COSTS OFF` 的輸出。）這次 orders 改走複合索引的 Index Scan，`status` 和 `created_at` 兩個條件都在 `Index Cond` 裡，不再有 `Filter` 和 `Rows Removed by Filter`；它碰了 1010 頁，幾乎都是那 1003 列分散所在的資料頁（每列大概落在不同頁，所以要回表一千次）。customers 這邊維持 Seq Scan + Hash，聚合則換回 HashAggregate（`Batches: 1  Memory Usage: 24kB`）。資料分布不同時，規劃器也可能改選 Bitmap Heap Scan，或改成 Nested Loop 加 `customers_pkey` 主鍵查詢（那時記得看內層的 `loops`），都合理。從 43 毫秒到 8 毫秒；碰的頁數從 8,407 頁降到 1,083 頁，更重要的是不用再逐列過濾 100 萬列。同一條查詢再跑一次，`read` 會全部變成 `hit`、時間降到 2 毫秒左右，但那只是快取熱了，不要把它算成索引的功勞（見情境演練第 4 題）。

另一種結果在「它是怎麼運作的」的〈9. 檢查一份執行計畫〉：同樣加了 `(status, created_at)` 索引，時間減半，碰的頁數卻沒有變少。那一小節也把讀計畫的順序整理成一份清單。

### 在 Python 裡看計畫

開發時想看 ORM 或自己組的 SQL 實際的計畫，可以寫個小工具函式（psycopg 3）：

```python
import psycopg

def explain_analyze(dsn: str, sql: str, params: tuple | None = None) -> None:
    """印出 EXPLAIN (ANALYZE, BUFFERS) 結果，最後一律 rollback，避免寫入語句真的生效。"""
    with psycopg.connect(dsn) as conn:
        # ClientCursor 在用戶端把參數填進 SQL，計畫會跟帶入實際值的查詢一樣
        with psycopg.ClientCursor(conn) as cur:
            # 保險：超過 30 秒就中止，免得一條爛查詢把機器跑滿
            cur.execute("SET LOCAL statement_timeout = '30s'")
            cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql, params)
            for (line,) in cur.fetchall():
                print(line)
        # psycopg 3 預設不是 autocommit，上面的動作都在同一個交易裡
        conn.rollback()

if __name__ == "__main__":
    explain_analyze(
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "SELECT * FROM orders WHERE customer_id = %s",
        (42,),
    )
```

注意：`with psycopg.connect(...)` 區塊正常結束時會 commit，所以這裡在離開前先明確 `conn.rollback()`。

### MySQL 簡短一提

> 第一次讀可以先跳過這一節，等遇到 MySQL 的執行計畫時再回來看。

MySQL 8.0.18 起也有 `EXPLAIN ANALYZE`，一樣**會真的執行**，輸出是樹狀格式：

```text
-> Filter: (orders.customer_id = 42)  (cost=101040 rows=99800) (actual time=0.45..320 rows=98 loops=1)
    -> Table scan on orders  (cost=101040 rows=998000) (actual time=0.04..280 rows=1e+6 loops=1)
```

讀法跟 PostgreSQL 很像：由內往外、`actual time` 是毫秒、有 `rows` 和 `loops`。差異在於 MySQL 的 cost 跟 PostgreSQL 的 cost 是不同的模型，兩邊的數字不能互相比較；而且 MySQL 沒有 BUFFERS 這種逐節點的資料頁統計。另外，很多 MySQL 文章用的是傳統表格式的 `EXPLAIN`，看的是 `type` 欄（`ALL` 是全表掃描、`ref`／`range` 是用索引、`const` 是主鍵或唯一索引查一列）和 `Extra` 欄（`Using filesort`、`Using temporary` 通常值得注意）。支援的語句也比 PostgreSQL 少：MySQL 8.0 的 `EXPLAIN ANALYZE` 只能用在 `SELECT`、多表的 `UPDATE`／`DELETE`，以及 8.0.19 起的 `TABLE` 語句，細節以官方文件為準。

## 常見地雷

### 地雷 1：在正式環境直接 EXPLAIN ANALYZE 寫入語句

❌ 錯誤示範

```sql
-- 想看看這個清理語句會不會很慢
EXPLAIN ANALYZE DELETE FROM sessions WHERE expired_at < now();
```

**為什麼錯**：在 autocommit 模式下（psql 和多數工具的預設），這行執行完就 commit 了，資料真的被刪掉。

✅ 正確寫法

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM sessions WHERE expired_at < now();
ROLLBACK;
```

更好的做法是在正式資料的複本或測試環境跑。在正式環境的主資料庫上跑，就算最後 rollback，執行期間仍然會鎖住那些列、產生負載和大量 WAL（寫入日誌）。（PostgreSQL 的 rollback 本身很快；MySQL InnoDB 則要靠 undo log（記錄改之前的值、用來復原的日誌）逐筆復原，大量刪除後的 rollback 可能跟刪除本身一樣久。）

### 地雷 2：只看 EXPLAIN 的預估就下結論

❌ 錯誤做法：看 `EXPLAIN` 顯示 cost 很低、`rows=1`，就斷定「SQL 沒問題，是別的地方慢」。

**為什麼錯**：EXPLAIN 印出的只是規劃器的預估。開頭那個情境裡，規劃器把 41 萬列估成 1 列，計畫的 cost 看起來很低，實際跑起來要 12 秒。

✅ 正確做法：排查慢查詢一定要拿 `EXPLAIN (ANALYZE, BUFFERS)` 的實測數字，在可以安全執行的地方跑（副本、測試環境、加上 `statement_timeout` 替查詢設執行時間上限）。真的不能執行（例如一跑要 30 分鐘），才退而用 EXPLAIN 的預估，再搭配 `auto_explain`（會把超過指定時間的查詢的計畫自動寫進日誌的模組）從日誌撈實際跑過的計畫。

### 地雷 3：在只有幾百列的開發資料庫上判斷計畫

❌ 錯誤做法：本機資料庫只有 50 筆訂單，看到 Seq Scan 很快，就說「不用索引」；或看到用了索引，就說「正式環境一定也會用」。

**為什麼錯**：規劃器會依資料量和分布選計畫。50 列的表全掃一遍比查索引還便宜，所以本機一定是 Seq Scan；正式環境 5 千萬列時，計畫完全不同。

✅ 正確做法：在跟正式環境資料量、分布相近的環境看計畫（例如定期從正式環境去識別化同步的 staging），或至少用 `generate_series` 灌出接近的資料量再測。

### 地雷 4：忘記 loops 要乘回去

❌ 錯誤做法：看到內層節點 `actual time=0.015..0.015`，覺得「才 0.015 毫秒，不是它」。

**為什麼錯**：那是每次 loop 的平均值。`loops=200000` 時，它總共花了 0.015 × 200000 = 3000 毫秒，3 秒全花在這個節點。

✅ 正確做法：每個節點都看 `loops`，`actual time 的第二個數字 × loops` 才是這個節點的總時間（含子節點）。

### 地雷 5：拿 cost 當毫秒、或拿不同查詢的 cost 互相比較

❌ 錯誤做法：「這條 cost=50000，那條 cost=200，所以前者慢 250 倍」，或「cost=1000 代表 1 秒」。

**為什麼錯**：cost 是相對單位，而且建立在預估列數上。預估錯了，cost 就跟著錯；不同查詢的 cost 也只能粗略參考。

✅ 正確做法：cost 用來理解「規劃器為什麼選這個計畫」；判斷快慢用 `actual time`、`Execution Time` 和 BUFFERS 的頁數。

### 地雷 6：看到 Seq Scan 就加索引

❌ 錯誤做法：計畫裡只要出現 Seq Scan，就開 PR 加一個索引。

**為什麼錯**：小表、或要讀大比例資料時，Seq Scan 本來就是最佳選擇。每多一個索引，每次 `INSERT`／`UPDATE` 都要多維護一份，還佔空間。加了規劃器也不會用，就是白白付出寫入成本。

✅ 正確做法：先看 `Rows Removed by Filter` 和輸出列數的比例、表有多大、這條查詢多常跑。過濾掉 99% 以上、表又大、查詢又頻繁，才值得加索引；加完要再跑一次 EXPLAIN ANALYZE 確認真的有用到、真的變快。

### 地雷 7：把正式環境的計畫貼到公開的線上視覺化工具

❌ 錯誤做法：直接把正式環境的計畫貼到公開的計畫視覺化網站，請大家幫忙看。

**為什麼錯**：計畫裡有表名、欄名、索引名，`Filter` 裡還可能直接出現查詢條件的實際值（電子郵件、身分證字號、訂單編號）。

✅ 正確做法：先把敏感值遮掉，或使用公司內部核准的工具；有疑慮就貼給內部同事看。

## 重點整理

- `EXPLAIN` 只印**預估**的執行計畫，不會執行；`EXPLAIN ANALYZE` 會**真的執行**這條 SQL。拿它跑 `UPDATE`／`DELETE`／`INSERT`，資料就真的被改了，要包在 `BEGIN; ... ROLLBACK;` 裡面。
- 讀計畫樹要**由內往外**：縮排最深的節點最先產出資料，一層層往上交給父節點，最上面那個節點就是最後結果。父節點的時間和 BUFFERS 包含子節點；`actual time` 和 `rows` 是每次 loop 的平均，要乘上 `loops`。
- 第一個要檢查的是**預估列數（`rows`）跟實際列數（`actual ... rows`）差多少**。差到十倍以上，通常是統計資訊過期或估不準，先跑 `ANALYZE 表名;`，再重看一次計畫。
- `cost` 是規劃器內部的相對單位（以「循序讀一個資料頁 = 1.0」為基準），不能換算成毫秒。要看真的花多久，看 `actual time` 和最後的 `Execution Time`。
- 加上 `BUFFERS` 可以看到每個節點碰了多少資料頁：`shared hit` 是在記憶體裡找到的，`shared read` 要向作業系統要。比較改之前和改之後，頁數比時間穩定。

## 新人必知清單

### 一定要會（基本功）

- [ ] 說得出 `EXPLAIN` 和 `EXPLAIN ANALYZE` 的差別，知道後者會真的執行。
- [ ] 對寫入語句跑 EXPLAIN ANALYZE 時，會包在 `BEGIN; ... ROLLBACK;` 裡。
- [ ] 習慣用 `EXPLAIN (ANALYZE, BUFFERS)`，看得懂 `shared hit` 和 `shared read`。
- [ ] 會由內往外讀計畫樹，知道父節點的時間和 BUFFERS 包含子節點。
- [ ] 讀得懂一行節點的 `cost`、`rows`、`actual time`、`loops`，知道 actual 數字是每次 loop 的平均。
- [ ] 認得 Seq Scan、Index Scan、Index Only Scan、Bitmap Heap Scan，說得出各自什麼時候合理。
- [ ] 認得 Nested Loop、Hash Join、Merge Join，知道 Nested Loop 的內層 loops 爆量是典型警訊。
- [ ] 會比較預估列數和實際列數，差很多時第一步先 `ANALYZE` 那張表。
- [ ] 知道在小資料量的開發資料庫上看到的計畫不代表正式環境。
- [ ] 拿到一份計畫會照順序檢查：先看 `Execution Time`，再找自己花最多時間的節點、比預估和實際列數，改完在相同條件下再跑一次，比時間也比頁數。

### 知道有這回事就好

- `FORMAT JSON`／`YAML` 輸出格式，以及把 JSON 計畫丟進視覺化工具看樹狀圖。
- `auto_explain` 模組：把超過指定時間的查詢的計畫自動寫進日誌（`auto_explain.log_min_duration`），用來抓「正式環境偶爾才慢」的查詢。開 `log_analyze` 會對所有查詢加上計時成本，要跟 DBA 討論。
- `pg_stat_statements`：統計哪些查詢最耗時，用來決定先 EXPLAIN 誰。
- `EXPLAIN ANALYZE` 本身有計時開銷，在某些機器上會讓查詢看起來比實際慢；可以用 `TIMING FALSE` 減少開銷。`Execution Time` 也不包含把結果送到用戶端的網路時間。
- 平行查詢的 `Gather`、`Workers Planned/Launched`，以及平行節點的 loops 會把 worker 一起算進去。
- PostgreSQL 18 的索引掃描節點多了一行 `Index Searches`，它是所有 loops 加總的次數，不是每次的平均，跟 `actual time`／`rows` 的算法不一樣。
- `Sort Method: external merge`、Hash 的 `Batches > 1` 都代表 `work_mem` 不夠、用到磁碟。
- 自動分析的觸發門檻（`autovacuum_analyze_threshold`、`autovacuum_analyze_scale_factor`），以及多欄延伸統計 `CREATE STATISTICS`。
- 帶參數的預備語句（prepared statement）可能用「通用計畫」（generic plan），跟你手動帶入實際值看到的計畫不同。

### 先不用管（等你遇到再學）

- 成本參數（`random_page_cost`、`effective_cache_size` 等）的調校。
- `enable_seqscan = off` 這類開關：只用來在測試時強迫規劃器試另一條路，不要在正式環境用。
- JIT 編譯在計畫裡出現的那段資訊。
- 規劃器內部的 join 搜尋演算法（例如表很多時的 GEQO）。

## Code Review 時可以問的問題

1. 這條新查詢或改過的查詢，有沒有附上在接近正式資料量的環境跑出的 `EXPLAIN (ANALYZE, BUFFERS)`？預估列數和實際列數差多少？
2. 這次新增的索引，有沒有前後兩份計畫證明規劃器真的會用、而且真的變快？會不會只是在小資料量下測出來的？
3. 計畫裡有沒有內層 `loops` 很大的 Nested Loop？外層列數會不會隨資料成長變大？
4. 如果 PR 描述說「我用 EXPLAIN ANALYZE 測過這個 UPDATE/DELETE」，是在哪裡測的？有沒有包在交易裡 rollback？
5. 這個 PR 有沒有大量匯入或批次改資料？做完之後有沒有安排 `ANALYZE`？
6. 有沒有 `Sort` 或 `Hash` 溢出到磁碟（`external merge`、`Batches` 大於 1、`temp read/written`）？資料量成長後會不會更嚴重？

## 情境演練

**1. 同事說：「我用 EXPLAIN ANALYZE 看了一下那個清除過期 token 的 DELETE，大概 2 秒。」你第一個要問他什麼？**

<details markdown="1"><summary>看答案</summary>

問他「有沒有包在交易裡 ROLLBACK？在哪個環境跑的？」因為 `EXPLAIN ANALYZE` 會真的執行語句。如果他是在正式環境、autocommit 模式下直接跑，那些 token 已經真的被刪掉了。就算有 rollback，在正式環境的主資料庫上跑也會持有列鎖、產生負載，最好在複本或測試環境跑。

</details>

**2. 你和同事一起排查一條慢查詢。計畫裡有個內層節點顯示 `(actual time=0.020..0.025 rows=3 loops=4000)`，同事說：「這個才 0.025 毫秒，跳過。」你會怎麼回？**

<details markdown="1"><summary>看答案</summary>

先別跳過。`actual time` 和 `rows` 都是每次 loop 的平均值，要乘以 loops。總時間約 0.025 × 4000 = 100 毫秒，總輸出列數約 3 × 4000 = 12,000 列。只看 0.025 毫秒，會誤以為這個節點完全不重要。

</details>

**3. 一條查詢最近突然變慢。你跑了 `EXPLAIN (ANALYZE, BUFFERS)`，看到某個 Index Scan 顯示 `rows=5`（預估），但 `actual ... rows=180000`，它是上層 Nested Loop 的外層（第一個子節點）。你會先懷疑什麼？先做什麼？**

<details markdown="1"><summary>看答案</summary>

預估和實際差了好幾個數量級，代表規劃器根據錯誤的列數選了計畫。它以為外層只有 5 列，Nested Loop 很划算；實際上內層會被查 18 萬次。最常見的原因是統計資訊過期（例如剛大量匯入），也可能是多欄條件互相相關、或欄位被包在函式裡導致估不準。

第一步是對那張表跑 `ANALYZE`，再重跑 `EXPLAIN (ANALYZE, BUFFERS)`，看預估有沒有變準、計畫有沒有換成 Hash Join。如果 ANALYZE 之後還是估不準，就要往查詢寫法或延伸統計的方向找。

</details>

**4. 你把一條查詢跑了兩次，中間什麼都沒改：第一次 `Buffers: shared hit=120 read=9800`、800 毫秒；第二次 `shared hit=9920`、90 毫秒。同事看到後，想在 PR 描述寫「最佳化後從 800 毫秒降到 90 毫秒」。你會怎麼建議？**

<details markdown="1"><summary>看答案</summary>

請他別這樣寫。兩次碰的資料頁總數一樣（都是 9920 頁），只是第二次全部已經在共享緩衝區裡（hit），不用再向作業系統讀。計畫本身沒變，變快是因為快取熱了。真正的最佳化應該讓**碰的資料頁數**變少（例如從 9920 頁變成幾十頁），而不只是時間變短。比較前後效果時，要在快取狀態相近的條件下比，並且以 BUFFERS 頁數為主要依據。

</details>

**5. 新功能上線後，「我的訂單」API 在 staging 只要 5 毫秒，正式環境卻要 3 秒。staging 的 EXPLAIN ANALYZE 顯示 Seq Scan on orders，表只有 2000 列。你接下來怎麼查？**

<details markdown="1"><summary>看答案</summary>

staging 的計畫幾乎沒有參考價值：2000 列的表 Seq Scan 本來就很快，規劃器也本來就會選它。正式環境的 orders 可能有幾千萬列，同樣的 Seq Scan 會讀非常多資料頁。

做法：

1. 拿到正式環境實際執行的 SQL 和參數值（從 `pg_stat_statements`、`auto_explain` 日誌或應用程式日誌）。
2. 在正式資料的讀取副本上跑 `EXPLAIN (ANALYZE, BUFFERS)`，加上 `statement_timeout` 保險。
3. 看最花時間的節點、`Rows Removed by Filter`、預估 vs 實際列數。如果是大表全掃又過濾掉大部分資料，就考慮加索引（正式環境用 `CREATE INDEX CONCURRENTLY`），加完再跑一次確認。
4. 長期改善：讓 staging 的資料量和分布接近正式環境，不然下次還會被騙。

</details>

**6. 一條報表查詢要 600 毫秒。計畫最上面是 `Sort (actual time=570..590 ...)`，`Sort Method: external merge  Disk: 5120kB`；它底下的 `Hash Join` 是 `actual time=..565`，兩個都是 `loops=1`。同事說：「排序寫到磁碟了，把 `work_mem` 全域調大就好。」你會怎麼回？**

<details markdown="1"><summary>看答案</summary>

先算 Sort 自己花多少：590 − 565 ≈ 25 毫秒，只佔 600 毫秒裡的一小部分。照順序看，要先往下找 Hash Join 底下哪一層自己花了最多時間，那裡才是大頭。第 9 小節的報表範例就是這樣：排序寫到磁碟，但把 `work_mem` 調到 16MB 之後，Sort 自己的時間幾乎沒變。

就算真的要調，也不要全域調大。`work_mem` 是每個排序或 hash 動作各自的上限，一條查詢可能同時有好幾個這種動作，很多連線又同時在跑，總記憶體用量會是它的好幾倍。只針對這條報表在交易裡用 `SET LOCAL work_mem` 調整比較安全。

</details>

**7. 同事加了一個索引，PR 描述寫「報表從 240 毫秒降到 65 毫秒」。你打開他附的兩份計畫：改之前 `Buffers: shared hit=5 read=8405`，改之後 `Buffers: shared hit=8713`。你會請他補什麼？**

<details markdown="1"><summary>看答案</summary>

兩份計畫的快取狀態不一樣：改之前幾乎都是 `read`（冷快取），改之後全是 `hit`（熱快取），65 毫秒裡有一部分是快取熱了的功勞。請他在相同的快取狀態下各跑一次再比，例如兩邊都用重啟後的第一次。

也請他看頁數：改之前 8410 頁，改之後 8713 頁，索引沒有讓讀的頁數變少。如果時間真的變短，要說得出原因（例如不用再逐列檢查 100 萬列），再決定這個索引值不值得它帶來的寫入成本。

</details>

## 相關主題

- [資料庫索引](10-資料庫索引.md)：EXPLAIN ANALYZE 是驗證「索引到底有沒有被用、有沒有用」的唯一可靠方法，兩篇一起看。
- [查詢最佳化](11-查詢最佳化.md)：這篇教你看出問題在哪，那篇教你怎麼改查詢、改 schema、處理估不準。
- [N+1 查詢](09-N+1%20查詢.md)：N+1 是「應用程式送了太多次查詢」，每一條單獨 EXPLAIN 都很快，要從查詢次數下手，單看一條計畫看不出問題。
- [資料庫交易](03-資料庫交易.md)：用 `BEGIN`／`ROLLBACK` 安全地測寫入語句，背後就是交易的原子性。
- [零停機遷移](16-零停機遷移.md)：在正式環境加索引要用 `CREATE INDEX CONCURRENTLY`，以及怎麼安排 schema 變更不鎖表。
- [分割](20-分割.md)：分割表的計畫裡會看到分割區剪枝（partition pruning），要用 EXPLAIN 確認沒用到的分割區真的被跳過。

## 延伸閱讀

- PostgreSQL 官方文件：Using EXPLAIN — https://www.postgresql.org/docs/current/using-explain.html
- PostgreSQL 官方文件：EXPLAIN 指令 — https://www.postgresql.org/docs/current/sql-explain.html
- PostgreSQL 官方文件：Statistics Used by the Planner — https://www.postgresql.org/docs/current/planner-stats.html
- MySQL 8.0 參考手冊：EXPLAIN Statement — https://dev.mysql.com/doc/refman/8.0/en/explain.html
