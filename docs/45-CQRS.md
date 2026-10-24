# 45｜CQRS（Command Query Responsibility Segregation）

> CQRS（命令查詢職責分離）把「改資料」和「查資料」交給兩套不同的資料表和程式處理：改資料的那套負責把規則守好，查資料的那套把資料整理成畫面好查、查得快的樣子。

**難度**：★★★　**閱讀時間**：約 25 分鐘　**前置知識**：[資料庫交易](03-資料庫交易.md)、[冪等性](25-冪等性.md)、[最終一致性](42-最終一致性.md)、[信箱模式](44-信箱模式.md)

## 核心問題與理念

**它要解決的問題**：電商客服後台的訂單列表要依很多條件篩選，背後是一條把 6 張表接起來查（join）的重查詢。它跟下單的寫入擠在同一個資料庫上，週年慶時查詢一多，資料庫忙不過來，連結帳都跟著逾時（下面的情境會完整走一遍）。

**核心理念**：畫面要什麼樣子，就事先替它存一份那個樣子；規則照舊只在原本那份資料上檢查。

**想通的那一步**：

- **卡住的地方**：直覺的做法是讓同一份資料表又守規則、又好查。為了列表查得快加一堆重複的欄位，每次寫入都得一起維護；為了寫入正確讓每筆資料只存一處，列表頁就得每次把 6 張表接起來查，兩邊互相拉扯。
- **火花**：讀和寫要的形狀本來就不一樣，乾脆存兩份：寫入那份照規則改，再由背景程式把每次變化整理進另一份畫面專用的表。查詢那份壞了或要改版，都能從寫入那份重新產生，所以它可以怎麼好查就怎麼存。

## 閱讀前推薦具備知識

| 知識 | 要會到什麼程度 | 這篇哪裡會用到 | 不熟的話先看 |
|---|---|---|---|
| SQL 的 `JOIN` 和 `UPDATE ... WHERE` | **必備**：看得懂一條用 `JOIN` 把 `orders` 和 `customers` 接起來的查詢，也看得懂 `UPDATE ... WHERE` 改了哪幾列 | 情境裡 6 張表 join 的訂單列表、「為什麼要分開模型」的正規化對照、「動手看看」的 `schema.sql` 和投影用的 SQL | [PostgreSQL：JOIN](https://www.postgresql.org/docs/current/tutorial-join.html) |
| [資料庫交易](03-資料庫交易.md) | **必備**：知道 `with conn.transaction():` 區塊裡的幾筆寫入會一起 commit 或一起作廢，區塊外面的程式不在交易裡 | 第二次出事的根因（commit 之後才寫 Elasticsearch）、`place_order` 把訂單和事件寫在同一個交易 | 本系列第 03 篇 |
| [最終一致性](42-最終一致性.md) | **加分**：知道「寫入成功之後，別的地方要過一小段時間才看得到」是正常狀態，系統會自己追上 | 「讀模型最終一致，那剛寫完馬上讀怎麼辦」 | 本系列第 42 篇 |
| [信箱模式](44-信箱模式.md) | **加分**：能說出為什麼「commit 之後再呼叫另一個系統」會漏資料，以及把事件寫進同一個交易的信箱表怎麼補上這個縫 | 第二次出事的修法、Level 3 的第 1 個設計、「常見地雷」第 2 點 | 本系列第 44 篇 |
| [冪等性](25-冪等性.md) | **加分**：知道同一筆事件處理兩次，結果要跟處理一次一樣；「設定成某個值」比「累加」安全 | 投影程式的版本守門、「常見地雷」第 3 點 | 本系列第 25 篇 |
| Python 的函式、`for` 迴圈、`with` | **加分**：看得懂 `for sku, qty, price in items:` 一次拿出 tuple 裡的 3 個值 | 「動手看看」的 `cqrs_demo.py` | [Python 官方教學（中文）](https://docs.python.org/zh-tw/3/tutorial/index.html) 第 4、5 章 |

**快速自我檢查**：下面這段下單程式裡，最後一行 `es.index(...)` 逾時、拋出例外。這時 PostgreSQL 裡還有這張訂單嗎？

```python
with conn.transaction():
    order_id = insert_order(conn, data)
es.index(index="orders", id=order_id, document=to_doc(data))  # 這行逾時，拋出例外
```

<details markdown="1"><summary>看答案</summary>

還有。`with` 區塊結束時交易就已經 commit 了，`es.index` 寫在區塊外面，不在任何交易裡，它失敗也不會讓訂單回滾。這就是情境裡「PostgreSQL 有、Elasticsearch 永遠沒有」的原因。答不出來的話，先看第 03 篇〈資料庫交易〉，弄清楚交易從哪裡開始、到哪裡結束。

</details>

## 為什麼要在意：一個具體的情境

這是一個假設情境。假設你負責一家電商的訂單系統，所有資料都放在同一台 PostgreSQL。訂單相關的資料分散在 `orders`、`order_items`、`customers`、`payments`、`shipments`、`coupons` 6 張表。客服後台的「訂單列表」要能依客戶等級、付款狀態、出貨狀態、金額區間篩選，還要依建立時間排序、分頁，所以這個頁面背後是一條 6 張表 join 的 SQL，外加 2 個子查詢算件數和金額。

### 第一次出事：查詢把下單拖垮

週年慶那天，依序發生這些事：

| 步驟 | 發生什麼 | 數字變化 |
|---|---|---|
| 1 | 客服和營運同時開著訂單列表頁一直重新整理 | 每次重新整理都跑一次 6 張表 join |
| 2 | 報表系統每 5 分鐘也打同一支列表 API 匯出 | 同一條重查詢又多一批 |
| 3 | 這些查詢和下單的 `INSERT` 都打在同一台 PostgreSQL | 資料庫 CPU 衝到 95% |
| 4 | 下單 API 要等資料庫，回應變慢 | p99 從 80ms 拉到 4 秒（p99：100 個請求裡最慢的那 1 個花多久） |
| 5 | 結帳等太久 | 結帳開始逾時 |

客人看到的是結帳轉圈圈、最後失敗。工程師在監控上看到的是資料庫 CPU 95%、下單 API 的 p99 4 秒。問題出在「查資料」和「改資料」擠在同一份資料上，查詢一多就把寫入拖垮了。

### 第二次出事：搬到 Elasticsearch 之後，訂單會漏

團隊決定把訂單列表搬到 Elasticsearch（一種專門做搜尋和篩選的資料庫），客服後台改查 Elasticsearch，PostgreSQL 只負責下單。工程師在下單的程式碼裡，先在 `with conn.transaction():` 區塊裡寫入訂單，區塊結束、訂單 commit 之後，再呼叫 `es.index(...)` 寫一份到 Elasticsearch；寫失敗就用 `logger.warning(...)` 記一行，照樣回 201 給客人。類似的錯誤寫法在「常見地雷」的〈2. 雙寫：commit 之後再直接寫讀庫〉。

下面這張圖看的是這支下單 API 的兩次寫入：兩次寫入各自獨立，黃色那一步失敗時，前一步已經收不回來。

```mermaid
flowchart LR
    API["下單 API"] --> PG[("PostgreSQL：commit 訂單")]
    PG --> ES["寫入 Elasticsearch"]
    ES -->|"成功"| OK["回 201"]
    ES -->|"逾時或失敗"| WARN["記一行 warning"]
    WARN --> OK
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class ES,WARN hot
```

上線後頭兩週沒有異狀。之後某一筆訂單 1001 是這樣走的：

| 時間 | 下單 API | PostgreSQL 裡的 1001 | Elasticsearch 裡的 1001 | 客服後台搜尋 1001 |
|---|---|---|---|---|
| T1 | 開交易，`insert_order` 寫入訂單 1001 | 交易還沒 commit，別人看不到 | 沒有 | |
| T2 | 交易 commit 成功 | 有 | 沒有 | |
| T3 | 呼叫 `es.index`，Elasticsearch 正忙，一直等到逾時 | 有 | 沒有 | |
| T4 | 抓到例外，記一行 warning，照樣回 201 給客人 | 有 | 沒有 | |
| T5 | 客人拿到訂單編號 1001，也收到確認信 | 有 | 沒有 | |
| T6（隔天） | | 有 | 沒有 | 查無資料 |
| T7 之後 | 沒有任何程式會回頭補寫 1001 | 有 | 永遠沒有 | 永遠查不到 |

客人看到的是下單成功、手上有確認信；客服看到的是「後台搜不到這筆訂單」。工程師翻日誌，只找得到一行 `寫入 ES 失敗，order_id=1001` 的 warning，沒有 error，所以告警從來沒響過。

根因在先後順序：訂單的交易在 `with` 區塊結束時就 commit 了，之後的 `es.index` 不在任何交易裡；它失敗時，程式只記一行 warning 就繼續往下走。這種「改資料庫之後，再另外寫第二個系統」的做法叫**雙寫**（dual write），兩邊沒有共同的交易，中間任何一步失敗，兩邊就永久對不上。再加上 Elasticsearch 裡的資料只在下單當下寫一次，就算發現漏了，也沒有可靠的來源可以重新產生一份。

修法是在下單的同一個交易裡，多寫一筆「訂單成立了」的事件到信箱表（見[信箱模式](44-信箱模式.md)），再由另一支背景程式讀事件、更新 Elasticsearch，失敗就重試，必要時能從頭重建整份資料。下面「它是怎麼運作的」的 Level 3、「動手看看」和「常見地雷」第 2 點會講這套做法。

## 全貌：它在系統裡的位置

下面這張圖畫的是做了 CQRS 之後，一筆訂單從使用者送出、到出現在列表頁的路線：

```mermaid
flowchart LR
    U["使用者 / 客服"] --> CMD["Command API（改資料）"]
    CMD e1@--> W[("寫入 DB：orders、domain_events")]
    W -. "背景讀新事件" .-> P["投影程式"]
    P e2@--> R[("讀取 DB：order_list_view")]
    U --> QRY["Query API（查資料）"]
    QRY --> R
    e1@{ animate: true }
    e2@{ animate: true }
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class P,R,QRY hot
```

從 Command API 到寫入 DB 那條路叫**寫入模型**（write model），負責檢查規則、把資料改對。從 Query API 到讀取 DB 那條路叫**讀模型**（read model），裡面的資料是替某個畫面整理好的樣子。黃色是 CQRS 多出來的部分，中間的**投影程式**（projector）在背景把寫入端的新事件整理進讀取 DB，這個動作叫**投影**（projection）。投影程式跑完之前，讀取 DB 裡還沒有新訂單，這就是[最終一致性](42-最終一致性.md)；寫入 DB 裡那張 `domain_events` 是[信箱模式](44-信箱模式.md)的信箱表；讀取端如果只是主庫的複本、表的形狀一模一樣，就屬於[讀取副本](17-讀取副本.md)的範圍。

## 生活比喻

想像一間餐廳。

- **廚房**是寫入模型。點單進來，廚師要照規矩做：檢查食材夠不夠、這道菜能不能改辣度、出餐順序對不對。廚房的流程只為了把菜做對而設計，客人不會進來看。
- **外場的菜單看板和叫號螢幕**是讀模型。客人想知道「今天有什麼、多少錢、我的號碼到了沒」，不需要走進廚房翻點單夾。看板是另外整理好、專門給人看的。
- 廚房出完一道菜，有人去更新叫號螢幕，這中間會有幾秒延遲；螢幕也可能壞掉，重開之後照點單紀錄重新顯示一次就好。

**比喻失準的地方**：

1. 餐廳的看板通常只有一塊，系統裡的讀模型可以有很多份：訂單列表一份、搜尋索引一份、營收報表一份，每份格式都不同，都從同一份寫入資料衍生出來。
2. 叫號螢幕慢幾秒客人能接受，但系統裡「剛付款，訂單頁顯示未付款」會讓使用者重複付款。最終一致的延遲對程式邏輯的影響，比看板大得多，要刻意設計。
3. 廚房絕對不會照著外場看板來決定要不要做菜，但新人很常在程式裡**用讀模型的資料去做寫入判斷**（例如看讀模型判斷庫存夠不夠），這是 CQRS 最常見的誤用之一，後面地雷會講。

## 它是怎麼運作的

開頭的第一次事故裡，同一份資料既要顧下單規則，又要撐客服列表的多條件篩選，查詢量一大就拖垮了寫入。CQRS 把這兩件事交給寫入模型和讀模型兩個模型處理。下面先分清楚兩種操作，再看模型為什麼要分、可以分到什麼程度。

### 先分清楚：command 和 query

- **命令（command）**：意圖改變狀態，例如「下單」「取消訂單」「變更收件地址」。命令可能被拒絕（庫存不足、狀態不允許），它的回傳值通常很少：成功或失敗、新資源的 id、新的版本號。
- **查詢（query）**：只讀，不改任何狀態，例如「列出我最近 20 筆訂單」。查詢可以隨便重試、隨便快取。

下面這張圖看的是一個請求進來時，怎麼分辨它是命令還是查詢：

```mermaid
flowchart LR
    REQ["一個請求"] --> ASK{"會改變狀態嗎"}
    ASK -->|"會"| C["命令：下單、取消訂單"]
    ASK -->|"不會"| Q["查詢：列出最近 20 筆訂單"]
    C --> CR["可能被拒絕，回傳很少：成功或失敗、id、版本號"]
    Q --> QR["可以重試、可以快取"]
```

這個概念源自 Bertrand Meyer 提出的 CQS（Command Query Separation）原則：一個方法要嘛改狀態、要嘛回傳資料，不要兩個都做。Greg Young 把這個想法放大到架構層級，就是 CQRS：不只方法分開，連**模型**都分開。

### 為什麼要分開模型

寫和讀的需求天生衝突。寫入模型要守住**不變條件**（invariant，任何時候都必須成立的規則，例如「庫存不能是負的」）；讀模型只要讓畫面查得快。兩邊的差別整理如下：

| | 寫入模型 | 讀模型 |
|---|---|---|
| 目標 | 保證商業規則正確 | 讓某個畫面查得快、查得簡單 |
| 形狀 | 正規化，避免重複資料 | 反正規化，一列就是畫面上的一列 |
| 約束 | 外鍵、唯一約束、交易、鎖 | 幾乎沒有，能被砍掉重建 |
| 數量 | 通常一份 | 可以很多份（列表、搜尋、報表） |
| 擴展 | 主庫垂直擴展、分片 | 副本、快取、搜尋引擎，水平擴展 |

硬要一個模型同時滿足兩邊，要嘛為了列表頁加一堆冗餘欄位，寫入時還得同步維護它們；要嘛為了寫入正確保持正規化，讀取時就得 6 張表 join。

下面這張圖看的是同一份訂單資料的兩種形狀，以及客服列表頁從哪裡拿資料：

```mermaid
flowchart LR
    subgraph WM["寫入模型：正規化"]
        O["orders"]
        OI["order_items"]
        CU["customers"]
        PA["payments"]
        SH["shipments"]
        CO["coupons"]
    end
    subgraph RM["讀模型：反正規化"]
        V["order_list_view：一列就是列表頁的一列"]
    end
    WM -->|"投影時先整理好"| V
    WM -.->|"沒有讀模型時，每次查詢都 6 張表 join"| PAGE["客服訂單列表頁"]
    V -->|"直接查一張表"| PAGE
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class V hot
```

### CQRS 是一個光譜，不是開關

讀寫要分開到什麼程度，可以分成 3 個等級。這張圖由左到右排出來，越往右分得越開，下面逐一說明：

```mermaid
flowchart LR
    L1["Level 1<br/>同一資料庫<br/>同一組表<br/>程式分成 Command 與 Query 服務"]
    L2["Level 2<br/>同一資料庫<br/>另建讀取專用的表或 materialized view"]
    L3["Level 3<br/>獨立讀取資料庫<br/>事件驅動更新投影"]
    L1 --> L2 --> L3
```

**Level 1：只在程式裡分開。** 寫入走 `OrderCommandService`，用 ORM（把資料表對應成 Python 物件的工具，例如 SQLAlchemy）載入完整的領域物件（代表一張訂單、自帶規則檢查的物件）、檢查規則、存回去；讀取走 `OrderQueryService`，直接寫一條手調過的 SQL，回傳 DTO（data transfer object，只裝資料、沒有邏輯的簡單物件），不經過領域物件。資料是同一份，所以**沒有一致性問題**。很多團隊做到這裡就夠了，成本幾乎是零，好處是讀取路徑不再經過 ORM，不會因為 lazy loading（用到關聯資料時才自動多查一次）觸發 [N+1 查詢](09-N+1%20查詢.md)。

**Level 2：同一資料庫、另建讀取表。** 開一張反正規化的 `order_list_view` 表（或 PostgreSQL 的 materialized view：把一條查詢的結果存成一張實體表，要下指令才會刷新），專門給列表頁用。更新方式可以是同一交易內順手更新（強一致但寫入變慢）、定期 `REFRESH MATERIALIZED VIEW`（簡單但有固定延遲），或是用信箱表 + 投影程式非同步更新（最終一致）。

**Level 3：獨立的讀取資料庫。** 寫入端是 PostgreSQL，讀取端可能是另一台 PostgreSQL、Elasticsearch、Redis 或資料倉儲。中間靠事件串起來。下面用 3 張圖，走一遍你送出 `POST /orders` 之後依序發生的事。

第 1 步只有寫入端。Command API 在同一個交易裡寫訂單和事件，commit 之後就回應使用者：

```mermaid
sequenceDiagram
    participant U as 使用者
    participant C as Command API
    participant W as 寫入 DB
    U->>C: POST /orders
    C->>W: BEGIN 寫 orders 與 domain_events COMMIT
    C-->>U: 201 order_id=42 version=1
```

第 2 步多了投影程式和讀取 DB。投影程式在背景撈出還沒處理的事件，更新讀模型；在它跑完之前，讀模型裡還沒有這張訂單：

```mermaid
sequenceDiagram
    participant U as 使用者
    participant C as Command API
    participant W as 寫入 DB
    participant P as 投影程式
    participant R as 讀取 DB
    U->>C: POST /orders
    C->>W: BEGIN 寫 orders 與 domain_events COMMIT
    C-->>U: 201 order_id=42 version=1
    Note over W,R: 這段時間讀模型還沒有 42 號訂單
    P->>W: 撈未處理事件
    P->>R: 冪等更新 order_list_view
```

第 3 步多了 Query API。查詢只讀讀取 DB，投影跑完之後才查得到 42 號：

```mermaid
sequenceDiagram
    participant U as 使用者
    participant C as Command API
    participant W as 寫入 DB
    participant P as 投影程式
    participant R as 讀取 DB
    participant Q as Query API
    U->>C: POST /orders
    C->>W: BEGIN 寫 orders 與 domain_events COMMIT
    C-->>U: 201 order_id=42 version=1
    Note over W,R: 這段時間讀模型還沒有 42 號訂單
    P->>W: 撈未處理事件
    P->>R: 冪等更新 order_list_view
    U->>Q: GET /orders
    Q->>R: SELECT 反正規化的列
    Q-->>U: 訂單列表含 42 號
```

這條流程能可靠運作，靠的是 3 個設計：

1. **命令和事件寫在同一個交易**（信箱模式），所以「訂單成立了但事件沒送出」這種事不會發生。
2. **投影程式（projector）**是讀模型的唯一寫入者。它至少會收到一次事件，可能收到兩次，所以處理邏輯必須冪等：同一筆事件處理兩次，結果要跟處理一次一樣（見[冪等性](25-冪等性.md)）。
3. **讀模型可以重建**：把讀取表清空，從第一筆事件（或直接從寫入表）重新跑一次投影，就能得到一份正確的讀模型。這也是你敢放心改讀模型結構的原因。

### 讀模型最終一致，那「剛寫完馬上讀」怎麼辦

CQRS 上線時最常被問到這個問題。用上面的 42 號訂單來看，下單後馬上查列表，會依序發生這些事：

<figure class="draw-fig">
<iframe class="draw-fig__frame" src="../figures/45-cqrs-read-lag.html" title="按播放或點 T1～T5，看 42 號訂單先進寫入 DB、讀模型晚一步才有；注意黃色的空窗：T3 那一刻訂單已經成立，列表卻看不到。" loading="lazy" style="height: 840px;"></iframe>
<figcaption>按播放或點 T1～T5，看 42 號訂單先進寫入 DB、讀模型晚一步才有；注意黃色的空窗：T3 那一刻訂單已經成立，列表卻看不到。</figcaption>
</figure>

| 時間 | 發生什麼 | 寫入 DB 的 42 號 | 讀模型的 42 號 | 列表頁看到 42 號嗎 |
|---|---|---|---|---|
| T1 | 使用者送出 `POST /orders`，交易 commit | 有，version=1 | 沒有 | |
| T2 | 使用者拿到 201 和 order_id=42 | 有，version=1 | 沒有 | |
| T3 | 前端馬上打 `GET /orders` | 有，version=1 | 沒有 | 看不到 |
| T4 | 投影程式處理 `OrderPlaced` | 有，version=1 | 有，version=1 | |
| T5 | 前端再打一次 `GET /orders` | 有，version=1 | 有，version=1 | 看得到 |

T3 那一刻，訂單其實已經成立，只是讀模型還沒追上。常見解法由簡單到複雜排列：

- **命令直接回傳需要的資料**：下單 API 回傳完整的訂單內容，前端直接顯示，不要下單完立刻打列表 API。
- **前端樂觀更新（optimistic UI）**：先把新訂單插進畫面，等之後的查詢自然追上。
- **帶版本號查詢**：命令回傳 `version=3`，查詢時帶上，Query API 發現讀模型版本還小於 3，就短暫等待或改從寫入端讀這一筆。
- **關鍵畫面直接讀寫入模型**：例如「付款結果頁」就是不能錯，直接查寫入庫，不經過讀模型。CQRS 沒規定所有讀取都只能走讀模型。

下面這張圖看的是「帶版本號查詢」在讀模型還沒追上時怎麼處理，這裡畫的是改從寫入端讀的那一種：

```mermaid
sequenceDiagram
    participant U as 前端
    participant Q as Query API
    participant R as 讀取 DB
    participant W as 寫入 DB
    U->>Q: 查詢 42 號訂單 帶 version=3
    Q->>R: 查 42 號的讀模型
    R-->>Q: version=2
    Note over Q: 讀模型版本小於 3
    Q->>W: 改從寫入端讀這一筆
    W-->>Q: version=3 的訂單
    Q-->>U: 回傳 version=3 的資料
```

這跟[讀取副本](17-讀取副本.md)遇到的[複寫延遲](18-複寫延遲.md)是同一類問題，解法也很像。讀取副本是**同一個模型的複本**；CQRS 的讀模型則是另一個形狀的模型。

### CQRS 和事件來源的關係

很多文章把 CQRS 和[事件來源（event sourcing）](46-事件來源.md)綁在一起講，因為事件來源的寫入端只存事件，幾乎一定要搭配 CQRS 才查得動。反過來就不成立了：**CQRS 的寫入端可以是很普通的關聯式資料表**，就像本篇的範例一樣，用信箱表送出事件就夠了。不要因為想做 CQRS 就順便導入事件來源，那是另一筆大成本。

下面這張圖看的是寫入端的兩種做法，都能把事件交給投影程式、餵出同樣的讀模型：

```mermaid
flowchart LR
    subgraph A["做法一：一般資料表（本篇）"]
        T[("orders 等資料表 + domain_events 信箱表")]
    end
    subgraph B["做法二：事件來源"]
        EV[("只存事件的事件儲存庫")]
    end
    T e1@--> P["投影程式"]
    EV --> P
    P --> R[("讀模型")]
    e1@{ animate: true }
```

本篇走的是做法一，動態箭頭標的就是這條路。

## 動手看看

我們用一台 PostgreSQL 做 Level 2：寫入表、事件表、讀取表都在同一個資料庫，但讀取表只由投影程式非同步更新。這樣就能親眼看到最終一致、冪等與重建。

### 1. 起一台 PostgreSQL

```bash
docker run --rm -d --name cqrs-pg -e POSTGRES_PASSWORD=secret -p 5432:5432 postgres:16
```

### 2. 建立 schema（存成 `schema.sql`）

```sql
-- ===== 寫入模型：正規化，有約束 =====
CREATE TABLE customers (
    id   bigint PRIMARY KEY,
    name text   NOT NULL,
    tier text   NOT NULL            -- 客戶等級：gold / normal
);

CREATE TABLE orders (
    id          bigserial   PRIMARY KEY,
    customer_id bigint      NOT NULL REFERENCES customers(id),
    status      text        NOT NULL DEFAULT 'placed',
    version     int         NOT NULL DEFAULT 1,     -- 每次狀態變更 +1
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    order_id   bigint        NOT NULL REFERENCES orders(id),
    sku        text          NOT NULL,
    qty        int           NOT NULL CHECK (qty > 0),
    unit_price numeric(12,2) NOT NULL,
    PRIMARY KEY (order_id, sku)
);

-- ===== 信箱表：和寫入同一個交易寫入 =====
CREATE TABLE domain_events (
    id           bigserial   PRIMARY KEY,
    aggregate_id bigint      NOT NULL,   -- 這裡就是 order id
    version      int         NOT NULL,   -- 對應 orders.version
    type         text        NOT NULL,
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz             -- NULL 代表投影程式還沒處理
);
-- 只索引還沒處理的事件，投影程式撈資料很快
CREATE INDEX domain_events_pending_idx ON domain_events (id) WHERE processed_at IS NULL;

-- ===== 讀取模型：反正規化，一列就是列表頁的一列 =====
CREATE TABLE order_list_view (
    order_id      bigint        PRIMARY KEY,
    customer_name text          NOT NULL,
    customer_tier text          NOT NULL,
    status        text          NOT NULL,
    item_count    int           NOT NULL,
    total         numeric(12,2) NOT NULL,
    created_at    timestamptz   NOT NULL,
    version       int           NOT NULL   -- 用來擋重複或過期的事件
);
CREATE INDEX order_list_view_status_idx ON order_list_view (status, created_at DESC);

INSERT INTO customers VALUES (1, '王小明', 'gold'), (2, '陳大華', 'normal');
```

容器剛起來時資料庫還在初始化，等個幾秒再匯入 schema（看到 `the database system is starting up` 或連不上 socket 的錯誤，就再等一下重試；也可以先跑 `docker exec cqrs-pg pg_isready -U postgres`，回 `accepting connections` 再繼續）：

```bash
# bash / zsh
docker exec -i cqrs-pg psql -U postgres < schema.sql
```

```powershell
# pwsh 沒有 < 重新導向，改用管線
Get-Content schema.sql -Raw | docker exec -i cqrs-pg psql -U postgres
```

### 3. 命令端、投影程式、查詢端（存成 `cqrs_demo.py`）

這支程式分成三段，對應全貌圖的三個部分：

- **命令端**：`place_order`、`cancel_order`，只動寫入表，並在同一個交易裡寫一筆事件到 `domain_events`。
- **投影程式**：`apply_event`、`run_projector_once`，把還沒處理的事件寫進 `order_list_view`。裡面的 `ON CONFLICT ... DO UPDATE ... WHERE` 意思是「這個 `order_id` 已經有一列的話，改成更新它，而且只有事件的版本比較新才更新」，這就是讓重送無害的版本守門。`FOR UPDATE SKIP LOCKED` 是給多個投影程式同時跑時用的，本篇只跑一個，可以先不管。
- **查詢端**：`list_orders`，只讀 `order_list_view`。

最下面的 `__main__` 依序做 ① 到 ⑧，每一步印一行結果，第 4 小節會逐一對照。

```python
"""CQRS Level 2 範例：同一個 PostgreSQL，寫入表 + 信箱表 + 讀取表。

執行：uv run --with "psycopg[binary]" python cqrs_demo.py
"""
import json
from decimal import Decimal

import psycopg

DSN = "postgresql://postgres:secret@localhost:5432/postgres"

# ---------- 命令端：只管規則正確，順手寫一筆事件 ----------

def place_order(conn, customer_id, items):
    """items: [(sku, qty, unit_price), ...]，回傳 (order_id, version)。"""
    with conn.transaction():  # 訂單、明細、事件在同一個交易，要嘛全成功要嘛全失敗
        cust = conn.execute(
            "SELECT name, tier FROM customers WHERE id = %s", (customer_id,)
        ).fetchone()
        if cust is None:
            raise ValueError("客戶不存在")

        order_id, created_at = conn.execute(
            "INSERT INTO orders (customer_id) VALUES (%s) RETURNING id, created_at",
            (customer_id,),
        ).fetchone()
        for sku, qty, price in items:
            conn.execute(
                "INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES (%s, %s, %s, %s)",
                (order_id, sku, qty, price),
            )

        # 事件帶上讀模型需要的資料，投影程式就不用回頭查寫入表
        payload = {
            "customer_name": cust[0],
            "customer_tier": cust[1],
            "status": "placed",
            "item_count": sum(q for _, q, _ in items),
            "total": str(sum(q * p for _, q, p in items)),  # Decimal 轉字串，避免浮點誤差
            "created_at": created_at.isoformat(),
        }
        conn.execute(
            "INSERT INTO domain_events (aggregate_id, version, type, payload) "
            "VALUES (%s, 1, 'OrderPlaced', %s)",
            (order_id, json.dumps(payload, ensure_ascii=False)),
        )
    return order_id, 1

def cancel_order(conn, order_id):
    """取消訂單。規則檢查一律看寫入模型，不看讀模型。"""
    with conn.transaction():
        row = conn.execute(
            "SELECT status, version FROM orders WHERE id = %s FOR UPDATE", (order_id,)
        ).fetchone()
        if row is None:
            raise ValueError("訂單不存在")
        status, version = row
        if status == "cancelled":
            return version  # 已經取消過，直接回傳（冪等）
        if status != "placed":
            raise ValueError(f"狀態 {status} 不能取消")

        new_version = version + 1
        conn.execute(
            "UPDATE orders SET status = 'cancelled', version = %s WHERE id = %s",
            (new_version, order_id),
        )
        conn.execute(
            "INSERT INTO domain_events (aggregate_id, version, type, payload) "
            "VALUES (%s, %s, 'OrderCancelled', %s)",
            (order_id, new_version, json.dumps({"status": "cancelled"})),
        )
    return new_version

# ---------- 投影程式：讀模型的唯一寫入者，必須冪等 ----------

def apply_event(conn, order_id, version, typ, p):
    if typ == "OrderPlaced":
        # ON CONFLICT ... WHERE：只有新版本才覆蓋，同一事件重送也不會出錯
        conn.execute(
            """
            INSERT INTO order_list_view
                (order_id, customer_name, customer_tier, status, item_count, total, created_at, version)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (order_id) DO UPDATE SET
                customer_name = EXCLUDED.customer_name,
                customer_tier = EXCLUDED.customer_tier,
                status        = EXCLUDED.status,
                item_count    = EXCLUDED.item_count,
                total         = EXCLUDED.total,
                created_at    = EXCLUDED.created_at,
                version       = EXCLUDED.version
            WHERE order_list_view.version < EXCLUDED.version
            """,
            (order_id, p["customer_name"], p["customer_tier"], p["status"],
             p["item_count"], Decimal(p["total"]), p["created_at"], version),
        )
    elif typ == "OrderCancelled":
        # ✅ 直接「設定」成事件裡的值，不要用 +1 / -1 之類的累加
        conn.execute(
            "UPDATE order_list_view SET status = %s, version = %s "
            "WHERE order_id = %s AND version < %s",
            (p["status"], version, order_id, version),
        )
    else:
        raise ValueError(f"不認得的事件類型：{typ}")  # 讓它失敗，別默默吞掉

def run_projector_once(conn, batch_size=100):
    """處理一批事件，回傳處理了幾筆。

    注意：這個範例假設同一時間只跑「一個」投影程式實例。
    SKIP LOCKED 讓多個實例不會互相卡住，但也會讓同一張訂單的事件被不同實例
    亂序處理（例如 OrderCancelled 比 OrderPlaced 先套用，UPDATE 找不到列，
    之後 OrderPlaced 又把狀態寫回 placed）。要多實例平行，得依 aggregate_id 分區。
    """
    with conn.transaction():
        events = conn.execute(
            """
            SELECT id, aggregate_id, version, type, payload
            FROM domain_events
            WHERE processed_at IS NULL
            ORDER BY id
            LIMIT %s
            FOR UPDATE SKIP LOCKED
            """,
            (batch_size,),
        ).fetchall()
        for ev_id, order_id, version, typ, payload in events:
            apply_event(conn, order_id, version, typ, payload)  # psycopg 3 會把 jsonb 轉成 dict
            conn.execute("UPDATE domain_events SET processed_at = now() WHERE id = %s", (ev_id,))
    return len(events)

# ---------- 查詢端：只讀讀模型，不碰領域規則 ----------

def list_orders(conn, status=None):
    sql = "SELECT order_id, customer_name, status, item_count, total, version FROM order_list_view"
    params = []
    if status:
        sql += " WHERE status = %s"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT 20"
    return conn.execute(sql, params).fetchall()

if __name__ == "__main__":
    with psycopg.connect(DSN, autocommit=True) as conn:
        oid, v = place_order(conn, 1, [("BOOK-1", 2, Decimal("350.00")), ("PEN-9", 1, Decimal("45.50"))])
        print(f"下單成功 order_id={oid} version={v}")

        print("① 投影前查讀模型：", list_orders(conn))          # 看不到剛下的單：最終一致
        print("② 投影處理事件數：", run_projector_once(conn))
        print("③ 投影後查讀模型：", list_orders(conn))

        cancel_order(conn, oid)
        print("④ 取消後、投影前：", list_orders(conn))          # 還是 placed
        run_projector_once(conn)
        print("⑤ 取消後、投影後：", list_orders(conn))          # 變成 cancelled

        # 模擬「事件被重送」：把事件標回未處理再跑一次，讀模型不該被弄壞
        conn.execute("UPDATE domain_events SET processed_at = NULL")
        print("⑥ 重播事件數：", run_projector_once(conn))
        print("⑦ 重播後讀模型：", list_orders(conn))            # 仍然是 cancelled，version 不變

        # 模擬「讀模型改版、整份重建」
        conn.execute("TRUNCATE order_list_view")
        conn.execute("UPDATE domain_events SET processed_at = NULL")
        while run_projector_once(conn):
            pass
        print("⑧ 重建後讀模型：", list_orders(conn))
```

### 4. 預期會看到什麼

- ① 是空的（或沒有這張新訂單）：命令已經 commit，但讀模型還沒追上。這就是最終一致，在正式環境裡這段延遲通常是毫秒到秒級。
- ② 處理了 1 筆事件（`OrderPlaced`）。
- ③ 出現一列，印出來長得像 `(1, '王小明', 'placed', 3, Decimal('745.50'), 1)`，也就是 `status='placed'`、`item_count=3`、`total=745.50`、`version=1`（`numeric` 欄位在 Python 裡會是 `Decimal`）。
- ④ 仍然是 `placed`，⑤ 才變成 `cancelled`、`version=2`。
- ⑥ 會處理 2 筆事件（這是在全新資料庫上第一次執行的數字；重跑腳本時，之前訂單的事件也會一起被標回未處理，數字會更大），但 ⑦ 的結果和 ⑤ 一模一樣：版本守門讓重送無害。
- ⑧ 讀取表清空後重新投影，結果和 ⑤ 相同。因為隨時能這樣重建，讀模型才可以放心丟掉重來。

另外可以自己試：把 `OrderCancelled` 的處理改成 `UPDATE order_list_view SET status = %s, item_count = item_count - 1 WHERE order_id = %s` 這種累加、而且不帶版本守門的寫法，再跑一次重播，就會看到 `item_count` 從 3 被扣到 1，扣了兩次。（如果保留 `AND version < %s` 和 `version = %s`，重播會被版本守門擋下，只扣一次。）

收拾：

```bash
docker stop cqrs-pg   # 有加 --rm，停掉就會自動刪除容器
```

> **MySQL 的差異**：MySQL 沒有原生的 materialized view，Level 2 只能用一般表 + 投影程式或觸發器維護；`FOR UPDATE SKIP LOCKED` 在 MySQL 8.0 起才支援。`ON CONFLICT ... DO UPDATE ... WHERE` 是 PostgreSQL 語法，MySQL 要改寫成 `INSERT ... ON DUPLICATE KEY UPDATE`，每個欄位都用 `col = IF(version < 新版本, 新值, col)` 判斷版本。MySQL 會**由左到右**套用這些指派，所以 `version` 那一欄一定要放在最後，否則後面欄位的 `IF()` 看到的已經是更新後的版本號，結果全部不更新。另外引用新值的 `VALUES(col)` 寫法從 8.0.20 起被標為棄用，新版改用 `INSERT ... AS new ON DUPLICATE KEY UPDATE col = new.col` 的別名寫法（8.0.19 起支援）。

> **補充：用 materialized view 做最簡單的 Level 2**。如果讀模型可以接受「每隔幾分鐘才更新」，PostgreSQL 的 `CREATE MATERIALIZED VIEW` 加上定期 `REFRESH MATERIALIZED VIEW CONCURRENTLY` 就能撐很久，不用寫投影程式。注意兩件事：`CONCURRENTLY` 要求這個 materialized view 上至少有一個 UNIQUE 索引，而且這個索引只能用欄位名稱（不能是運算式）、不能帶 `WHERE`（不能是部分索引）；不加 `CONCURRENTLY` 的話，刷新期間會擋住其他人讀這個 view。不管加不加，每次刷新都是把整個查詢重跑一次，資料量大時會很重。

## 常見地雷

### 1. 簡單 CRUD 也套上完整 CQRS

❌ 錯誤做法：一個內部用的「供應商資料維護」頁面，欄位怎麼存就怎麼顯示，卻拆成 Command API、Query API、事件表、投影程式、獨立讀庫。

為什麼錯：多了一整條非同步管線要維運、要監控、要處理最終一致，換到的好處是零。讀寫模型長得一樣的時候，分開它們只是在製造複製貼上。

✅ 正確做法：先問「讀和寫的形狀真的不一樣嗎？讀取量真的大到影響寫入嗎？」答案是否定的話，就用一般 CRUD。需要的話也從 Level 1 開始，只在真正痛的那個模組升級，不要整個系統一起套。

### 2. 雙寫：commit 之後再直接寫讀庫

❌ 錯誤示範：

```python
# ❌ 錯誤示範：DB commit 和寫讀庫是兩件事，中間掛掉就永久不一致
with conn.transaction():
    order_id = insert_order(conn, data)
es.index(index="orders", id=order_id, document=to_doc(data))  # 逾時、程式被砍，這筆就漏了
```

為什麼錯：兩個系統沒有共同的交易。DB 成功、ES 失敗，讀模型永遠少一筆；反過來先寫 ES 再寫 DB，DB 失敗時讀模型多出一筆不存在的訂單。

✅ 正確寫法：

```python
# ✅ 正確寫法：同一個交易寫訂單和事件（信箱模式），由投影程式負責送到讀庫
with conn.transaction():
    order_id = insert_order(conn, data)
    insert_event(conn, order_id, "OrderPlaced", payload)
# 投影程式非同步讀 domain_events，冪等地寫入 ES，失敗就重試
```

細節見[信箱模式](44-信箱模式.md)。另一種做法是 CDC（change data capture，直接讀資料庫內部的變更紀錄，把每一筆變更送給讀取端），「知道有這回事就好」那一節有補充。

### 3. 投影程式不冪等，事件重送就壞

❌ 錯誤做法：收到 `ItemAdded` 就 `UPDATE order_list_view SET item_count = item_count + 1`。

為什麼錯：訊息系統幾乎都是「至少一次」交付（at-least-once）。投影程式更新完讀庫、還沒來得及標記已處理就被重啟，同一筆事件會再處理一次，數字就多加了。讀庫和事件表不在同一個資料庫時（例如讀庫是 Elasticsearch），「更新讀庫」和「標記已處理」沒辦法放進同一個交易，這種情況遲早會發生。

✅ 正確做法：事件帶版本號，讀模型記錄目前版本，`WHERE version < 新版本` 才更新；能「設定成某個值」就不要「累加」；或者記下已處理的事件 id，做成去重表。原則見[冪等性](25-冪等性.md)。

### 4. 用讀模型做寫入判斷

❌ 錯誤做法：下單前先查讀模型的 `product_stock_view` 看庫存夠不夠，夠才下單。

為什麼錯：讀模型是過去某個時間點的資料。兩個人同時看到「剩 1 件」，兩邊都下單成功，就超賣了。這其實是[競爭條件](01-競爭條件.md)，只是延遲被放大到秒級。

✅ 正確做法：不變條件只在寫入模型檢查，靠交易、`SELECT ... FOR UPDATE`、[樂觀鎖定](06-樂觀鎖定.md)或[唯一約束](14-唯一約束.md)來保證。讀模型只拿來「顯示」，例如商品頁顯示「庫存約 3 件」。

### 5. 下單後馬上查列表，以為下單失敗

❌ 錯誤做法：前端呼叫 `POST /orders` 成功後，立刻 `GET /orders` 重刷列表，拿不到新訂單就顯示「訂單建立中，請稍後」，使用者再按一次「下單」。

為什麼錯：讀模型還沒追上。使用者重按，系統就多一筆重複訂單。

✅ 正確做法：命令 API 直接回傳新訂單的內容與版本，前端先用它更新畫面；關鍵頁面直接讀寫入模型；下單 API 本身支援冪等鍵（`Idempotency-Key` 之類的請求標頭，名稱依團隊慣例），重按也不會產生第二筆。

### 6. 投影沒有監控、不能重建

❌ 錯誤做法：投影程式跑在某台機器上的 cron，掛了 3 天沒人知道；讀取表結構改了，只能手動寫 SQL 一筆一筆補。

為什麼錯：讀模型停止更新，使用者看到的全是舊資料，但每個 API 都回 200，誰也不會發現。

✅ 正確做法：

- 監控「最舊未處理事件的年齡」（例如 `SELECT now() - min(created_at) FROM domain_events WHERE processed_at IS NULL`），超過門檻就告警。
- 投影程式交給可監控的[背景工作者](37-背景工作者.md)，要能[優雅關閉](48-優雅關閉.md)。
- 讀模型要能整份重建：保留足夠的事件，或能從寫入表直接重新產生。改讀模型結構時，建新表、重新投影、切換讀取來源、再刪舊表。

### 7. 以為 CQRS 一定要搭配事件來源

❌ 錯誤做法：「我們要做 CQRS，所以寫入端也改成只存事件。」

為什麼錯：事件來源會改變整個寫入端的資料存放方式、schema 演進方式和除錯方式，成本遠高於 CQRS 本身。兩者常一起出現，但沒有綁定。

✅ 正確做法：寫入端維持一般的關聯式資料表，用信箱表發事件就夠了。真的需要完整的狀態變更歷史、要能回到任意時間點，再評估[事件來源](46-事件來源.md)。

## 重點整理

- CQRS 讓**寫入（command）和讀取（query）用不同的模型**。它是一個光譜：Level 1 只在程式裡分開命令服務和查詢服務，Level 2 在同一個資料庫另建讀取表，Level 3 才是獨立的讀取資料庫加上投影程式。
- 寫入模型負責商業規則和不變條件，要正規化、有約束、有交易；讀模型是替某個畫面量身訂做的反正規化資料，可以有很多份、可以砍掉重建。寫入判斷只看寫入模型，讀模型只拿來顯示。
- 讀模型只要是非同步更新的，就是**最終一致**：剛下完單，列表頁可能還看不到。「剛寫完馬上讀」的畫面要事先設計，例如命令直接回傳新資料、關鍵畫面直接讀寫入模型。
- 把變更從寫入端送到讀取端時**不要雙寫**，要用[信箱模式](44-信箱模式.md)或 CDC；投影程式要冪等（版本守門、用設定值取代累加）、能整份重建、有延遲監控。
- **適合**：讀寫比例懸殊、讀取需求複雜（多表 join、全文搜尋、彙總報表）。**不適合**：一般 CRUD 後台、表單式系統。CQRS 常和[事件來源](46-事件來源.md)一起出現，但大多數 CQRS 不需要事件來源。

## 新人必知清單

### 一定要會（基本功）

- [ ] 說得出 command 和 query 的差別：command 改狀態、可能被拒絕、回傳很少；query 只讀、可重試、可快取。
- [ ] 知道 CQRS 是光譜：Level 1（程式分開）、Level 2（同庫另建讀取表）、Level 3（獨立讀庫加事件投影），而且大多數情況停在 Level 1 或 2 就好。
- [ ] 知道只要讀模型是非同步更新，就是最終一致，並能說出至少兩種處理「剛寫完馬上讀」的方法。
- [ ] 知道寫入端到讀取端不能雙寫，要用信箱模式或 CDC。
- [ ] 會寫冪等的投影：用版本號守門、用設定值取代累加。
- [ ] 知道商業規則和不變條件只能在寫入模型檢查，讀模型只用來顯示。
- [ ] 能判斷一個需求適不適合 CQRS：讀寫比例懸殊、讀取形狀和寫入形狀差很多才考慮。

### 知道有這回事就好

- CQS（Command Query Separation）是方法層級的原則，CQRS 是把它放大到模型與架構層級。
- 讀模型可以是 Elasticsearch、Redis、資料倉儲，不一定是關聯式資料庫；一份寫入資料可以餵出很多份讀模型。
- CDC（change data capture，例如 Debezium 透過邏輯解碼讀 PostgreSQL 的 WAL；WAL 是 PostgreSQL 記錄每一筆變更的日誌檔）可以取代輪詢信箱表，延遲更低、也不用一直對主庫下查詢。代價是要維運 replication slot（主庫替某個讀取端記住「讀到哪裡」的記號）：消費端停太久，主庫會一直保留 WAL，磁碟可能被塞滿。
- 用 `bigserial` 的 id 當「讀到哪裡」的游標有陷阱：序號是在 `INSERT` 時取的，不是在 commit 時，id 較小的交易可能比較晚 commit，只記「最後處理到 id N」的投影會漏掉它。本篇範例改用 `processed_at` 標記就是為了避開這個問題。
- 讀取端和寫入端可以獨立擴展、獨立部署，甚至由不同團隊負責。
- 帶版本號查詢、「讀自己寫的」（read-your-writes）保證，是處理最終一致的進階手法。

### 先不用管（等你遇到再學）

- 事件 schema 演進與 upcasting（舊格式事件升級成新格式）。
- 投影的分區與平行化：依 aggregate id 分區，保證同一筆資料的事件依序處理（本篇範例只跑單一投影實例，所以先不用處理）。
- Saga／流程管理器（process manager）搭配 CQRS 的長流程協調，見[分散式交易](43-分散式交易.md)。
- 事件來源加快照（snapshot）、時間旅行查詢。
- 領域驅動設計（DDD）裡 aggregate 邊界的劃分。

## Code Review 時可以問的問題

1. 這個模組的讀和寫真的長得不一樣嗎？讀取量真的大到需要分開嗎？如果只是 CRUD，為什麼不用一般寫法？
2. 寫入和「通知讀取端」是同一個交易嗎？有沒有出現 commit 之後再寫另一個系統的雙寫？
3. 投影程式收到同一個事件兩次、或晚到的舊事件，結果會不會錯？有沒有版本守門或去重？
4. 命令端的檢查邏輯有沒有偷讀讀模型？不變條件是靠交易、鎖或約束保證的嗎？
5. 使用者寫完馬上讀的那個畫面，會不會因為讀模型延遲而顯示錯誤？前端或 API 怎麼處理？
6. 讀模型延遲有監控和告警嗎？讀取表要改結構時，怎麼重建？

## 情境演練

**1. 訂單列表頁的 6 張表 join 越來越慢。主管在會議上說：「那就做 CQRS 吧，開一台讀取副本，把列表頁的查詢導過去。」你會怎麼回應？**

<details markdown="1"><summary>看答案</summary>

先釐清主管要的是哪一個。讀取副本是**同一個模型**的複本，表結構和主庫一模一樣，只是分擔讀取流量；查詢導過去之後，還是同一條 6 張表 join 的 SQL，只是換一台機器跑。CQRS 是讀取用**不同形狀的模型**，例如把 6 張表 join 的結果預先攤平成一張表，或丟進搜尋引擎。副本解決「讀太多」，CQRS 解決「讀和寫要的形狀不一樣」。

所以要看慢的原因：如果主庫只是被讀取流量壓垮，副本就有幫助；如果是 join 本身太重，就要攤平成讀模型。兩者也可以一起用（讀模型放在副本上），而且都會遇到最終一致的問題。

</details>

**2. PM 聽說你們要「導入 CQRS」，擔心客服在後台改完客戶資料後，畫面會顯示舊值。團隊的計畫只是把程式拆成 `OrderCommandService` 和 `OrderQueryService`，資料表不動。你會怎麼回答 PM？**

<details markdown="1"><summary>看答案</summary>

這個計畫不會產生延遲。CQRS 是光譜，這是 Level 1：程式分成命令服務和查詢服務，讀寫的是同一份資料，沒有任何同步延遲。Level 2 如果在同一個交易裡更新讀取表，也是強一致的。只有當讀模型是**非同步**更新（投影程式、定期刷新的 materialized view、獨立讀庫）時，才會變成最終一致。之後如果要往那個方向走，再一起討論「剛寫完馬上讀」的畫面怎麼處理。

</details>

**3. 你在 review 同事寫的投影程式，處理 `OrderPlaced` 的部分寫成這樣。你會留什麼意見？**

```sql
INSERT INTO order_list_view (...) VALUES (...);
UPDATE customer_stats SET order_count = order_count + 1 WHERE customer_id = $1;
```

<details markdown="1"><summary>看答案</summary>

有兩個問題。第一，`INSERT` 沒有 `ON CONFLICT`，事件重送時會撞主鍵而失敗，投影卡住、後面的事件全部堵住。第二，`order_count + 1` 是累加，事件重送就會多算一次。投影要冪等：`INSERT ... ON CONFLICT DO UPDATE ... WHERE version < EXCLUDED.version`；統計數字改成記錄「已計入的訂單 id」去重，或定期從寫入資料重算 `count(*)` 再「設定」回去。

</details>

**4. 你們的商品頁讀的是讀模型 `product_view`，投影延遲平常不到 1 秒。某天行銷改了價格，1 分鐘後客服反映「商品頁還是舊價格，但結帳金額是新價格」。你會怎麼查、怎麼改？**

<details markdown="1"><summary>看答案</summary>

先查投影延遲：看最舊未處理事件的年齡、投影程式的日誌和錯誤，多半是投影程式卡在某一筆壞掉的事件（例如不認得的事件類型或資料格式錯誤）一直重試，後面全部堵住；也可能是投影程式掛了沒人知道。

修正分兩層：

- **短期**：修好或跳過那筆壞事件（移到類似[死信佇列](36-死信佇列.md)的地方人工處理），讓投影恢復；必要時重建讀模型。
- **長期**：加上延遲告警；結帳金額本來就應該以寫入模型為準（這點系統做對了），但商品頁可以在顯示價格時帶上「價格版本」，結帳時若版本不同就明確提示「價格已更新」，使用者不必到最後一步才發現。這次結帳金額沒有算錯，正是因為它沒有依賴讀模型；不變條件和最終金額都要照這個原則處理。

</details>

**5. 團隊想把一個每天幾百筆寫入、讀取也只有內部幾十個人用的工單系統改成「CQRS + 事件來源 + Kafka + 獨立讀庫」，理由是「之後可能會變大」。你會怎麼回應？**

<details markdown="1"><summary>看答案</summary>

這是典型的過度設計。讀寫量都小，讀寫形狀也差不多，CQRS 的好處（讀寫各自擴展、讀取形狀最佳化）一個都用不到，卻要付出最終一致、投影維運、事件 schema 演進、除錯困難的成本；事件來源更會讓整個寫入端的資料模型變複雜。

建議：用一般 CRUD；如果列表或報表查詢真的開始變慢，先在程式裡把查詢服務獨立出來（Level 1），再考慮建讀取專用的表或 materialized view（Level 2）。這些步驟都能漸進升級，不需要現在就為「可能會變大」付全額。

</details>

## 相關主題

- [最終一致性](42-最終一致性.md)：非同步更新的讀模型就是最終一致，這篇講怎麼和它相處。
- [信箱模式](44-信箱模式.md)：把寫入和事件放在同一個交易，是 CQRS 讀寫同步最可靠的做法。
- [事件來源](46-事件來源.md)：常和 CQRS 一起出現，但不必綁定；寫入端只存事件時才一定需要 CQRS。
- [冪等性](25-冪等性.md)：投影程式和命令 API 都要冪等，才能放心重試與重播。
- [讀取副本](17-讀取副本.md)：同一模型的複本，常和 CQRS 混淆，也常一起使用。
- [事件驅動架構](39-事件驅動架構.md)：Level 3 的 CQRS 本身就是事件驅動，訊息交付與順序的議題都在那邊。

## 延伸閱讀

- Martin Fowler, “CQRS”：https://martinfowler.com/bliki/CQRS.html （短文，提醒大多數系統不需要 CQRS）
- Microsoft Azure Architecture Center, “CQRS pattern”：https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs
- PostgreSQL 官方文件：REFRESH MATERIALIZED VIEW：https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html
- PostgreSQL 官方文件：INSERT（含 `ON CONFLICT`）：https://www.postgresql.org/docs/current/sql-insert.html
