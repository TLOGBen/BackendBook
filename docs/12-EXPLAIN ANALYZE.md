# 12｜EXPLAIN ANALYZE（EXPLAIN ANALYZE）

> `EXPLAIN` 讓資料庫印出它打算怎麼執行一條 SQL（執行計畫）；`EXPLAIN ANALYZE` 會真的執行一次，再把每一步實際花的時間和列數一起列出來。

**難度**：★★☆　**閱讀時間**：約 25 分鐘　**前置知識**：[資料庫索引](10-資料庫索引.md)、[資料庫交易](03-資料庫交易.md)

## 為什麼要在意：一個具體的情境

假設你負責一個電商後台的「待處理退款」頁面，平常查詢大約 50 毫秒，客服每天早上 9 點上班後會一直開著它。

某天凌晨，資料團隊用一個大型匯入工作把 300 萬筆歷史訂單灌進 `orders` 表，其中約 41 萬筆的 `status` 是一個以前從沒出現過的值 `'refunding'`。「待處理退款」頁面送出的，就是下面那條找 `'refunding'` 訂單的 `SELECT`：

```sql
-- ❌ 出事的寫法
-- 凌晨的匯入工作：把 300 萬筆歷史訂單灌進 orders，灌完就結束
INSERT INTO orders (customer_id, status, amount, created_at)
SELECT customer_id, status, amount, created_at FROM import_orders;

-- 值班工程師排查時只跑了 EXPLAIN，看到的只是預估
EXPLAIN
SELECT o.id, c.name
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'refunding';
```

PostgreSQL 執行一條 SQL 之前，會先由規劃器（planner）挑一種跑法。它挑的依據是統計資訊，也就是「每張表大概幾列、每個欄位常見哪些值」的摘要，要靠 `ANALYZE` 指令收集。

| 步驟 | 發生什麼 | 規劃器以為 `'refunding'` 有幾列 | 實際有幾列 | 「待處理退款」頁面 |
|---|---|---|---|---|
| T1（凌晨） | 匯入工作灌完 300 萬筆就結束，沒有跑 `ANALYZE`。PostgreSQL 在背景定期自動跑的分析（autovacuum 的 auto-analyze）也還沒輪到這張表，統計資訊裡根本沒有 `'refunding'` | 1 | 約 41 萬 | 還沒人用 |
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

這張圖畫的是一條 SQL 從 API 送進 PostgreSQL 之後走過的路，以及 `EXPLAIN ANALYZE` 看的是哪一段：

```mermaid
flowchart LR
    U["使用者"] --> API["API 伺服器"]
    subgraph PG["PostgreSQL"]
        S[("統計資訊")] --> P["規劃器：挑一種跑法"]
        P --> X["執行器：照計畫跑"]
        X --> T[("orders、customers 表")]
    end
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

很多跑在 SSD 上的環境會把 `random_page_cost` 調低（常見 1.1 左右），讓規劃器更願意用索引。這是 DBA 層級的調校，新人知道有這回事就好，不要自己在正式環境改。

### 4. 讀計畫樹：由內往外

```text
HashAggregate                         ← 4. 最後做分組彙總
  ->  Hash Join                       ← 3. 把兩邊接起來
        ->  Seq Scan on orders o      ← 2. 掃 orders，逐列去 hash 表裡比對
        ->  Hash                      ← 1b. 把 customers 建成 hash 表
              ->  Seq Scan on customers c   ← 1a. 先掃 customers
```

`->` 和縮排表示父子關係。縮排最深的先產生資料，往上傳。同一層的兩個子節點，第一個叫外層（outer），第二個叫內層（inner）。

PostgreSQL 執行時，**父節點需要資料，才向子節點要下一列**（拉取式，一次一列），子節點的資料是被父節點一列一列拉上去的。所以 `LIMIT 10` 底下的節點常常只跑了一點點就停了：父節點拿到 10 列就不再要了。讀計畫時「由內往外」是理解資料流向的方法，不代表內層一定全部跑完。

### 5. 掃描節點：資料怎麼從表裡拿出來

看表格之前，先認識三個詞：

- **回表**：索引裡只存欄位值和「這一列放在表的哪裡」，要拿整列資料，就得回到表本身（heap）去讀，這個動作叫回表。
- **可見性對照表（visibility map）**：記錄「哪些資料頁裡的列，所有交易都看得到」。Index Only Scan 靠它判斷能不能不回表，`VACUUM` 會更新它。
- **`work_mem`**：每個排序、hash 或 bitmap 動作可以用的記憶體上限，不夠用就會改用比較粗略或比較慢的做法。

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

一個資料頁預設是 8KB。`hit + read` 是這個節點碰過的資料頁總數，乘以 8KB 大概就是它讀了多少資料。這個數字比時間更穩定：時間會受快取冷熱、機器忙不忙影響，**讀了幾頁**則主要取決於計畫本身。同一條 SQL 第一次跑 read 很多、第二次全變 hit 而且變快，原因是快取熱了，計畫和碰的頁數都沒變。

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
