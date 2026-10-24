# 41｜Webhook 重試（Webhook Retry）

> Webhook 是別的服務在某件事發生時（例如付款成功），主動發一個 HTTP POST 到你的 API 通知你。Webhook 重試（webhook retry）是對方在時限內沒收到你回的成功狀態碼（200、201 這類 2 開頭的狀態碼，合稱 2xx），就把同一個事件再送一次。所以接收的一方會收到重複、順序錯亂的事件，程式要能承受；發送的一方則要限制重試次數，失敗了留紀錄、能重送。

**難度**：★★☆　**閱讀時間**：約 22 分鐘　**前置知識**：[唯一約束](14-唯一約束.md)、[冪等性](25-冪等性.md)、[重試機制](26-重試機制.md)、[Webhook 驗證](40-Webhook%20驗證.md)

## 核心問題與理念

**它要解決的問題**：接收付款通知的程式要等發票平台回應，拖過了金流商規定的 10 秒，金流商以為沒送到，把同一個付款通知又送了兩次，結果開出 3 張發票。其中一份晚到的舊通知，還把已經退款的訂單改回「已付款」（下面的情境會完整走一遍）。

**核心理念**：收到就先存起來、馬上回「收到了」；同一個事件 ID 只存一次，慢的工作之後再做。

**想通的那一步**：

- **卡住的地方**：直覺的做法是把事情全部做完才回 200，讓 200 代表「真的處理好了」。但發送方只等幾秒，下游一慢就逾時重送；就算回了 200，回應也可能在路上掉了，對方照樣重送。
- **火花**：把「簽收」和「處理」拆開。簽收只做一件事：用事件 ID 當主鍵（同一個值只能存一筆的欄位）把事件存進資料庫，存好就回 200，重複的存不進去也照樣回 200；處理交給背景程式在自己這邊慢慢做、失敗自己重試。這樣對方重送幾次，資料庫裡都只會留下一筆。

## 閱讀前推薦具備知識

| 知識 | 要會到什麼程度 | 這篇哪裡會用到 | 不熟的話先看 |
|---|---|---|---|
| HTTP 狀態碼 | **必備**：看到 200、400、401、409、503，能分出哪些算成功（2xx）、哪些是「請求有問題」（4xx）、哪些是「伺服器出問題」（5xx） | 「立刻回 2xx」那張狀態碼表、地雷 4、情境演練第 2 題 | [MDN：HTTP 狀態碼](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status) |
| [唯一約束](14-唯一約束.md) | **必備**：看得懂 `INSERT ... ON CONFLICT (event_id) DO NOTHING` 撞到主鍵時不報錯、寫入 0 列，也看得懂 `DO UPDATE` 裡的 `EXCLUDED` 指的是這次想寫入的那一列 | 生命週期的第二張圖、`receiver.py` 的 `store_event()`、`worker.py` 的條件式更新 | 本系列第 14 篇 |
| [冪等性](25-冪等性.md) | **必備**：能說出為什麼去重要靠資料庫的唯一約束，「先查有沒有、沒有再寫」在兩個請求同時到時擋不住 | 收件箱表的設計、地雷 3 | 本系列第 25 篇 |
| [重試機制](26-重試機制.md) | **加分**：知道重試要有次數上限，等待間隔要一次比一次長 | 「發送方：當你要提供 webhook 給別人」、`sender.py` 的 `deliver()` | 本系列第 26 篇 |
| [Webhook 驗證](40-Webhook%20驗證.md) | **加分**：知道收到 webhook 的第一步是驗簽章，驗不過就回 401、不存 | 「接收方：四個動作」的第 1 步 | 本系列第 40 篇 |
| FastAPI 的路由與 `async` | **加分**：看得懂 `@app.post("/webhooks/payments")` 把一個函式綁到一個網址，`await request.body()` 是在等請求的 body 讀進來 | 「動手看看」的 `receiver.py` | [FastAPI 教學（繁中）](https://fastapi.tiangolo.com/zh-hant/tutorial/) |

**快速自我檢查**：`webhook_inbox` 的主鍵是 `event_id`，表裡已經有 `evt_123`。handler 又收到一次 `evt_123`，執行 `INSERT INTO webhook_inbox (event_id, event_type, payload) VALUES ('evt_123', ...) ON CONFLICT (event_id) DO NOTHING`。這句會報錯嗎？`cur.rowcount` 是多少？如果 handler 接著回 `409 Conflict`，發送方會把這次投遞當成成功還是失敗？

<details markdown="1"><summary>看答案</summary>

不會報錯，`cur.rowcount` 是 0：撞到主鍵，`DO NOTHING` 就安靜地跳過。409 是 4xx，不在 2xx 裡，發送方只認 2xx 是成功，所以會當成這次沒送到，之後再送。

答不出前半，先看上表「唯一約束」那一列；答不出後半，先看「HTTP 狀態碼」那一列。

</details>

## 為什麼要在意：一個具體的情境

這是一個假設情境。你負責一個訂閱制服務的後端，串了金流商的 webhook：客人每次扣款成功，金流商就發一個 `payment.succeeded` 事件，POST 到你 API 上專門接收 webhook 的網址 `/webhooks/payments`（這種接收用的網址叫 endpoint）；客人退款時，則發一個 `payment.refunded` 事件。這家金流商規定 10 秒內要收到 2xx，沒收到就當作沒送到，5 分鐘後重送（這兩個數字是這個情境的假設，各家不同）。

處理這個網址的函式（handler）收到事件後，依序做下面四步，全部做完才回 200：

1. 照事件類型，把訂單的 status 直接改成 paid 或 refunded（`UPDATE orders SET status = %s`）。
2. 如果是扣款成功，呼叫發票平台開電子發票（`invoice_api.create(order_id)`），平常 1 秒。
3. 寄感謝信。
4. 回 200。

整個 handler 都沒有看事件 ID，同一個事件送來幾次，這四步就做幾次。

這張圖看的是一個請求在 handler 裡走過的路，上色的那一步會拖慢回應：

```mermaid
flowchart LR
    S["金流商"] -->|"POST 事件"| H["handler"]
    H --> U["改 status 誰最後到誰說了算"]
    U --> INV["呼叫發票平台 開發票"]
    INV --> M["寄感謝信"]
    M --> OK["回 200"]
    OK -.->|"回得太晚 對方已經斷線"| S
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class INV hot
```

平常整串大約 1.5 秒，沒出過問題。月初續約日早上 9 點，幾萬筆自動扣款同時成功；偏偏發票平台也被各家廠商打爆，`invoice_api.create` 要 20 秒以上才回來。下面追一筆訂單 `ord_88`，它的扣款事件 ID 是 `evt_A`，退款事件 ID 是 `evt_B`，圖和表一格一格看：

<figure class="draw-fig">
<iframe class="draw-fig__frame" src="../figures/41-webhook-retry-overwrite.html" title="按播放或拖時間軸追訂單 ord_88：handler 等發票平台超過 10 秒，金流商就把同一個 evt_A 再送一次；注意遲到的 evt_A 怎麼把退款後的 refunded 蓋回 paid，發票又怎麼從 1 張變成 3 張。" loading="lazy" style="height: 500px;"></iframe>
<figcaption>按播放或拖時間軸追訂單 ord_88：handler 等發票平台超過 10 秒，金流商就把同一個 evt_A 再送一次；注意遲到的 evt_A 怎麼把退款後的 refunded 蓋回 paid，發票又怎麼從 1 張變成 3 張。</figcaption>
</figure>

| 時間 | 金流商（發送方） | 你的 handler | `ord_88` 的 status | 已開發票 |
|---|---|---|---|---|
| T1 09:00:00 | 送出 `evt_A`（扣款成功）第 1 次 | 收到，把 status 改成 paid，開始呼叫發票平台 | paid | 0 張 |
| T2 09:00:10 | 等滿 10 秒沒收到回應，判定失敗，排 5 分鐘後重送，斷開連線 | 還在等發票平台 | paid | 0 張 |
| T3 09:00:22 | （連線已斷，什麼都沒收到） | 發票開好、感謝信寄出，回 200，但對方已經不在了 | paid | 1 張 |
| T4 09:03:00 | 客人申請退款，送出 `evt_B`（已退款） | 把 status 改成 refunded，很快就回 200 | refunded | 1 張 |
| T5 09:05:00 | 重送 `evt_A` 第 2 次 | 又把 status 改成 paid，又開始呼叫發票平台 | paid ❌ | 1 張 |
| T6 09:05:10 | 又等滿 10 秒，判定失敗，再排下一次 | 還在等發票平台 | paid | 1 張 |
| T7 09:05:21 | （連線已斷） | 開出第 2 張發票、寄出第 2 封感謝信 | paid | 2 張 |
| T8 09:10 之後 | 重送 `evt_A` 第 3 次 | T5 到 T7 再重演一次 | paid | 3 張 |

**使用者看到的**：客人收到三封一模一樣的感謝信、三張發票；已經退款的客人，訂單頁卻顯示「已付款」，訂單還被排進出貨流程。月底會計對帳時，發現上千張重複發票要作廢。

**工程師看到的**：應用程式日誌裡，同一個 `evt_A` 出現三次「開立發票」；金流商後台的投遞紀錄顯示 `evt_A` 前幾次都是逾時；發票平台的回應時間從平常 1 秒拉到 20 秒以上。

**根因**有三個，都在 handler 的那四步裡：

- `invoice_api.create(order_id)` 這一行讓回應超過 10 秒，觸發金流商重送。
- 整個 handler 沒看事件 ID，同一個 `evt_A` 送幾次，發票和信就重複幾次。
- `UPDATE orders SET status = %s` 是「誰最後到誰說了算」，T5 遲到的 `evt_A` 把 T4 的 refunded 蓋回 paid。

**怎麼修**：handler 只做「用事件 ID 把事件存進資料庫、重複就略過」，存好立刻回 200；開發票、寄信交給背景程式慢慢做；改狀態前先比較事件發生的時間，舊的事件就略過。做法在後面「接收方：四個動作」和「事件順序」兩小節。

## 全貌：它在系統裡的位置

這張圖看的是一個 webhook 事件從金流商進到你的系統，會經過哪些地方：

```mermaid
flowchart LR
    S["金流商 發送方"] e1@-->|"POST 事件 沒收到 2xx 就重送"| API["你的 API webhook handler"]
    API -. "回 2xx 等於簽收" .-> S
    API e2@-->|"存事件 重複就略過"| INBOX["PostgreSQL 收件箱表"]
    W["背景工作者"] -->|"撈出未處理的事件"| INBOX
    W -->|"開發票 寄信"| EXT["發票平台 寄信服務"]
    W -->|"更新訂單狀態"| BIZ["PostgreSQL 訂單表"]
    e1@{ animate: true }
    e2@{ animate: true }
    classDef hot fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111
    class API,INBOX hot
```

重試發生在「金流商到你的 API」這條線上，接收方要擋住重複和亂序，防線就在上色的 handler 和收件箱表。在它前面的是 [Webhook 驗證](40-Webhook%20驗證.md)（確認請求真的是金流商送的）；在它後面，把慢工作拆出去的做法見 [背景工作者](37-背景工作者.md)，「重複事件只產生一次效果」的原理見 [冪等性](25-冪等性.md)。

## 生活比喻

Webhook 就像物流公司幫你送包裹。

- **司機（發送方）**：按門鈴沒人應，就留張紙條、隔一段時間再來。第一次隔一小時，第二次隔半天，第三次隔一天。送了五次都沒人收，就把包裹退回倉庫，打電話通知你「要的話自己來領」。這就是指數退避（等待間隔一次比一次長，見 [指數退避](27-指數退避.md)）、最大次數、停用與人工重送。
- **收件人（接收方）**：聰明的做法是在門口放個收件箱，司機一來就簽收，包裹先丟進去，晚點再拆。不聰明的做法是當著司機的面拆箱、驗貨、組裝家具，司機等不下去就走了，下次又送一箱一樣的來。
- **重複簽收**：每個包裹都有追蹤編號。你看到「這編號我簽過了」，就直接說「收到了，謝謝」，不會再付一次貨到付款。

**比喻失準的地方**：

1. 真實的司機不會「明明你簽收了，卻因為回條掉在路上又送一次」，但網路會。你回了 200，回應在路上斷掉，對方照樣會重送。所以「我已經回過 2xx 就不會再收到」是錯的。
2. 包裹通常照寄出順序到；webhook 不保證。第三次重試的舊事件，完全可能比剛產生的新事件還晚到。
3. 司機不會因為你家門鈴壞了就讓整條路線的其他人都收不到件；但寫得不好的發送方，一個壞掉的 endpoint 真的可以拖垮所有客戶的投遞。

## 它是怎麼運作的

### 一次投遞的完整生命週期

Webhook 投遞會遇到網路斷線、接收方變慢這些狀況。發送方靠重送確保事件送到，接收方則要在重送、重複送達之下，讓每個事件只產生一次效果。下面用同一個事件 `evt_123`，分三張圖走一遍。

第一張只有發送方和接收方：第 1 次投遞失敗，發送方排程重試，第 2 次拿到 200 才停。

```mermaid
sequenceDiagram
    participant S as 發送方 金流商
    participant R as 接收方 你的服務

    S->>R: POST /webhooks evt_123 第 1 次
    R--xS: 逾時或回 500
    Note over S: 排程重試 例如 1 分鐘後
    S->>R: POST /webhooks evt_123 第 2 次
    R-->>S: 200 OK
    Note over S: 標記投遞成功 停止重試
```

第二張加上你的資料庫：接收方回 200 之前先把事件寫進資料庫。之後網路又重複送來同一個事件，`INSERT` 撞到主鍵、寫入 0 列，接收方照樣回 200。

```mermaid
sequenceDiagram
    participant S as 發送方 金流商
    participant R as 接收方 你的服務
    participant DB as 你的資料庫

    S->>R: POST /webhooks evt_123 第 1 次
    R--xS: 逾時或回 500
    Note over S: 排程重試 例如 1 分鐘後
    S->>R: POST /webhooks evt_123 第 2 次
    R->>DB: INSERT evt_123 ON CONFLICT DO NOTHING
    DB-->>R: 寫入成功
    R-->>S: 200 OK
    Note over S: 標記投遞成功 停止重試
    S->>R: POST /webhooks evt_123 網路重複送達
    R->>DB: INSERT evt_123 ON CONFLICT DO NOTHING
    DB-->>R: 0 rows 已存在
    R-->>S: 200 OK 重複也回成功
```

第三張再加上背景工作者：開發票、寄信這些慢工作，由它從資料庫撈出未處理的事件來做。

```mermaid
sequenceDiagram
    participant S as 發送方 金流商
    participant R as 接收方 你的服務
    participant DB as 你的資料庫
    participant W as 背景工作者

    S->>R: POST /webhooks evt_123 第 1 次
    R--xS: 逾時或回 500
    Note over S: 排程重試 例如 1 分鐘後
    S->>R: POST /webhooks evt_123 第 2 次
    R->>DB: INSERT evt_123 ON CONFLICT DO NOTHING
    DB-->>R: 寫入成功
    R-->>S: 200 OK
    Note over S: 標記投遞成功 停止重試
    S->>R: POST /webhooks evt_123 網路重複送達
    R->>DB: INSERT evt_123 ON CONFLICT DO NOTHING
    DB-->>R: 0 rows 已存在
    R-->>S: 200 OK 重複也回成功
    W->>DB: 撈出未處理的事件
    W->>W: 開發票 寄信 更新狀態
    W->>DB: 標記 processed
```

從這三張圖可以看出兩件事：

1. **「投遞成功」對發送方的定義，就是在時限內收到 2xx。** 它不知道你有沒有真的處理完，也不會去確認。你回 2xx 就等於簽收，發送方認定已送達，就不會再送（網路問題還是可能造成重送）。
2. **接收方把「簽收」和「處理」拆開。** 簽收只做一件事：把事件安全地存進資料庫。處理交給[背景工作者](37-背景工作者.md)，失敗了在自己這邊重試，不需要發送方再送一次。

發送方寧可多送，也不要漏送：只要沒收到 2xx，就當作沒送到。這種投遞方式叫「至少一次」（at-least-once）投遞，每個事件至少會送到一次，但可能送到好幾次。幾乎所有 webhook 都是這樣，所以收到重複事件是常態，接收方的程式要預先處理。

### 接收方：四個動作

接收方要應付的情況，是同一個事件會送來好幾次，順序也不保證，但開發票、寄信這類副作用只能發生一次。你收到一個 POST 時，依序做下面四件事。

下面的流程圖把四件事串起來。第一步「驗簽」是檢查請求帶的簽章，確認它真的是金流商送的；最後的「比較時間戳或版本」是因為舊事件可能晚到，背景工作者套用之前先看這個事件是不是比資料表裡目前的資料還新，舊的就略過，原因在下一小節「事件順序」。

```mermaid
flowchart TD
    A["收到 POST /webhooks"] --> B{"驗簽通過?"}
    B -- "否" --> X["回 400 或 401 不存"]
    B -- "是" --> C["INSERT 事件 ON CONFLICT (event_id) DO NOTHING"]
    C -- "資料庫掛了 寫入失敗" --> Y["回 500 讓對方重試"]
    C -- "新事件" --> D["回 200"]
    C -- "重複事件" --> D
    D --> E["背景工作者撈未處理事件"]
    E --> F{"比較時間戳或版本 比現有的新?"}
    F -- "是" --> G["套用變更"]
    F -- "否" --> H["略過 舊事件"]
    G --> I["標記 processed"]
    H --> I
```

**1. 驗簽。** 先確認這個請求真的是對方送的，細節在 [Webhook 驗證](40-Webhook%20驗證.md)。這篇只提醒一件事：像 Stripe 這種把時間戳一起簽進簽章的服務，每次重試都會帶新的時間戳、重新簽章，所以驗簽邏輯不要因為「同一個事件 ID 簽章長得不一樣」就拒絕。

**2. 用事件 ID 存進資料庫去重。** 幾乎所有正經的 webhook 都會給每個事件一個唯一 ID，例如 Stripe 事件本體裡的 `id`（`evt_` 開頭）、GitHub 的 `X-GitHub-Delivery` 標頭、遵循 Standard Webhooks 規範的服務則是 `webhook-id` 標頭。同一個事件重試時，**事件 ID 不會變**。

把事件 ID 當成主鍵寫進一張「收件箱」表，靠資料庫的[唯一約束](14-唯一約束.md)擋重複。[冪等性](25-冪等性.md)那篇講過，防線要落在資料庫，不要靠「先查再寫」。

> 注意 ID 代表的是「事件」還是「這次投遞」，各家定義不一樣，重送時會不會沿用原值也不一樣。例如你同時設了兩個 webhook 訂閱同一件事，很可能收到兩個不同 ID 的投遞；Stripe 的文件也提到，少數情況下同一件事會產生兩個不同的 Event 物件，這時要改用 `data.object` 的 ID 加上事件類型來辨認重複。動手前先讀清楚對方文件，確認「同一件事重送時哪個欄位不變」，再拿那個欄位去重。

**3. 立刻回 2xx。** 只要事件已經安全寫進資料庫，就可以回 200。發送方的時限通常很短，例如 GitHub 的文件寫明要在 10 秒內回 2xx。各家數字不同，原則都一樣，**能在幾百毫秒內回，就不要拖到幾秒**。

狀態碼怎麼回，照這張表：

| 情況 | 回什麼 | 為什麼 |
|---|---|---|
| 新事件，已存好 | 2xx | 簽收成功 |
| 重複事件，已經存過 | 2xx | 對你來說也是「已收到」，回錯誤只會讓對方一直重試 |
| 事件類型你不認得、不打算處理 | 2xx | 同上，不然它會重試到放棄，還可能害 endpoint 被停用 |
| 驗簽失敗 | 400 或 401 | 不是對方送的，或設定錯了，存下來沒意義 |
| 資料庫掛了、暫時存不進去 | 5xx | 你需要對方之後再送一次 |

**4. 背景處理，並處理順序問題。** 背景工作者從收件箱撈出未處理的事件，做真正的商業邏輯。這一步失敗了就在自己這邊重試（記錄次數，太多次就丟進[死信佇列](36-死信佇列.md)或標記失敗等人看），不需要再讓發送方重送。

### 事件順序：為什麼一定會亂，以及怎麼辦

亂序的來源很多：發送方用多個工作者並行投遞、某個事件第一次失敗進了重試排程、網路路徑不同、你自己的背景工作者也是多個並行在處理。所以 **webhook 抵達的順序，和事件發生的順序，沒有保證一致。** Stripe 的文件也明講不保證事件的投遞順序。

下面追一個訂閱 `sub_1`：10:00 它變成 active，10:05 使用者取消，變成 canceled。最右兩欄比較兩種處理方式：「照收到的順序覆蓋」，和下面解法 A 的「比事件時間，舊的略過」。

| 時間 | 發送方 | 你這邊收到 | 照收到的順序覆蓋 | 比事件時間（解法 A） |
|---|---|---|---|---|
| T1 10:00 | 產生 active 事件，第 1 次投遞失敗，排進重試 | 沒收到 | 還沒有資料 | 還沒有資料 |
| T2 10:05 | 產生 canceled 事件，第 1 次就成功 | canceled（10:05 的事件） | canceled | canceled |
| T3 10:06 | 重試 active 事件，這次成功 | active（10:00 的事件） | active ❌ | canceled，10:00 比 10:05 舊，略過 |
| T4 之後 | 沒有新事件 | 沒有 | 停在 active，使用者明明取消了 | canceled ✅ |

三種解法，由簡單到穩健：

**解法 A：比時間戳或版本號，只接受比較新的。** 事件裡通常有「事件產生時間」，或者物件本身帶版本號、`updated_at`。你在資料表裡記下「目前這筆資料是根據哪個時間點的事件更新的」，新來的事件比較舊就略過。

用 SQL 寫成一個條件式更新：`INSERT ... ON CONFLICT (id) DO UPDATE` 後面加上 `WHERE subscriptions.source_updated_at < EXCLUDED.source_updated_at`。`EXCLUDED` 代表這次想寫進去的那一列，所以這個條件的意思是「資料表裡記的時間比新事件舊，才覆蓋」；不符合就什麼都不改。完整程式在「動手看看」的〈3. 背景工作者 `worker.py`〉。

要小心時間戳的精度：如果對方只給到「秒」，同一秒內發生的兩個事件你就分不出先後。Stripe 就是這樣：事件的 `created` 只到秒，Stripe 文件明講不要拿它判斷事件順序。這時候要找更可靠的排序依據（例如物件本身的版本號），或改用解法 B。下面的範例用時間戳，只是為了好示範。

**解法 B：把 webhook 當「通知」，收到後回頭打 API 拿最新狀態。** 不管事件內容是什麼，只把它當作「`sub_1` 有變動了」，接著呼叫對方的 API 查 `sub_1` 現在是什麼狀態，以 API 回傳的為準。這樣順序就不重要了，因為你永遠拿到的是最新的。代價是多一次 API 呼叫，大量事件時要注意對方的[速率限制](30-速率限制.md)。有些廠商乾脆設計「瘦事件」（thin event），payload 只給 ID，接收方只能用這種方式。

這張圖看的是解法 B 的來回：事件只負責通知，狀態以回頭查到的為準。

```mermaid
sequenceDiagram
    participant S as 金流商 發送方
    participant R as 你的服務
    participant API as 金流商 API
    S->>R: 事件 sub_1 有變動
    R-->>S: 200 OK
    R->>API: 查 sub_1 現在的狀態
    API-->>R: canceled
    R->>R: 以 API 回傳的狀態寫進資料表
```

就算晚到的是 10:00 的舊事件，回頭查到的也是現在的 canceled。

**解法 C：狀態機防呆。** 有些狀態轉換本來就不合法，例如「已退款」不該回到「已付款」。在套用事件前檢查狀態轉換是否合法，可以擋掉一部分亂序造成的錯誤。這通常和 A 或 B 搭配使用，不單獨用。

### 發送方：當你要提供 webhook 給別人

> 第一次讀可以先跳過這一節，等你要讓自己的系統發 webhook 給別人時再回來看。

角色反過來，當你的系統要通知客戶時，你就是發送方。客戶的 endpoint 隨時可能變慢、掛掉或下線，發送方要讓事件最後送得到，又不能讓一個壞掉的 endpoint 拖垮其他客戶。一個合格的發送方要有下面這些部分。

圖裡有三個詞先說明：outbox 是一張「待發送事件」表，和訂單寫在同一個交易裡（下面第一點會講）；delivery 是「把某個事件送給某個客戶 endpoint」的一筆投遞工作；不跟隨轉址是對方回 3xx（301、302 這類轉址狀態碼）要你改送到別的網址時，不跟過去，直接算這次失敗。

```mermaid
flowchart LR
    A["業務交易 寫入訂單"] --> B["同一個交易寫 outbox"]
    B --> C["投遞排程 撈到期的 delivery"]
    C e1@--> D["HTTP POST 設逾時 不跟隨轉址"]
    D -- "2xx" --> E["標記成功"]
    D -- "非 2xx 或逾時" --> F{"還沒到最大次數?"}
    F -- "是" --> G["指數退避加抖動 排下一次"]
    G e2@--> C
    F -- "否" --> H["標記失敗 等人工重送"]
    H --> I{"這個 endpoint 連續失敗太久?"}
    I -- "是" --> J["停用 endpoint 寄信通知客戶"]
    D --> K["寫投遞紀錄 狀態碼 耗時 回應片段"]
    e1@{ animate: true }
    e2@{ animate: true }
```

逐一說明：

- **可靠地產生事件**：「訂單成立」和「要發 webhook」必須一起成功或一起失敗。標準做法是[信箱模式](44-信箱模式.md)：在同一個[資料庫交易](03-資料庫交易.md)裡寫入業務資料和一筆待投遞事件，再由背景程式送出。不要在交易還沒 commit 前就直接打 HTTP。
- **逾時**：連線逾時和讀取逾時都要設，而且要短（幾秒到十幾秒）。沒設逾時的話，一個卡住不回應的 endpoint 會把你的投遞工作者一個一個佔住，最後沒有工作者可以送別的事件。
- **重試排程**：用[指數退避](27-指數退避.md)加[抖動](28-抖動.md)，間隔從幾秒、幾分鐘一路拉長到幾小時，總共持續數小時到數天。例如 Stripe 在正式環境會用指數退避重試最多 3 天。不要固定每 10 秒重打，對方掛掉時你等於在 DDoS 它（用大量請求把對方打到起不來）。
- **對方回 429 或 503 且帶 `Retry-After`**：尊重它，下次至少等這麼久。
- **最大次數**：重試要有終點，到了就標記為失敗，留給人工處理。
- **停用一直失敗的 endpoint**：某個客戶的 endpoint 連續好幾天都失敗，多半是對方已經下線或設定壞了。停用它並寄信通知，否則你的重試佇列會被這些已經沒人在收的 endpoint 塞滿。Standard Webhooks 規範也建議：對方明確回 `410 Gone` 時，就直接停用這個 endpoint。
- **隔離**：每個 endpoint 要有自己的並行上限或獨立的佇列，一個慢的客戶不能拖累其他客戶。這也是一種[背壓](47-背壓.md)的應用。
- **投遞紀錄與重送介面**：每一次嘗試都記下時間、狀態碼、耗時、回應內容的前幾百字。客戶來問「為什麼沒收到」時，你和客戶都能自己查。再給一個「重送這個事件」的按鈕或 API，客戶修好 endpoint 後可以自己補。GitHub 就提供手動重送，而且明講不會自動重送失敗的投遞，這種設計一樣要在文件裡講清楚。
- **重送用同一個事件 ID**：不管是自動重試還是人工重送，事件 ID 都要維持不變，接收方的去重才有用。

## 動手看看

這個範例在本機起一個 PostgreSQL，寫一個接收端和一個模擬發送端，讓你親眼看到三件事：發送方重試、接收方去重、亂序事件不會蓋掉新狀態。

### 1. 起資料庫、建表

```powershell
docker run --rm -d --name pg-webhook -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
```

```sql
-- 用 docker exec -it pg-webhook psql -U postgres 進去執行
-- 收件箱：event_id 當主鍵，重複的事件自然擋掉
CREATE TABLE webhook_inbox (
    event_id     text PRIMARY KEY,
    event_type   text        NOT NULL,
    payload      jsonb       NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,             -- NULL 代表還沒處理
    attempts     int         NOT NULL DEFAULT 0,
    last_error   text
);

-- 業務資料：記住這筆資料是根據哪個時間點的事件更新的
CREATE TABLE subscriptions (
    id                text PRIMARY KEY,
    status            text        NOT NULL,
    source_updated_at timestamptz NOT NULL
);
```

### 2. 接收端 `receiver.py`

```python
# receiver.py：只做「存起來、回 200」，不做任何慢工作
import json
import os
from collections import defaultdict

import psycopg
from psycopg.types.json import Jsonb
from fastapi import FastAPI, Request, Response
from starlette.concurrency import run_in_threadpool

DSN = os.getenv("DSN", "postgresql://postgres:postgres@127.0.0.1:5432/postgres")
# 模擬故障：每個事件的前 N 次請求都回 503，用來觀察發送方重試
FAIL_FIRST_N = int(os.getenv("FAIL_FIRST_N", "0"))
_hits: dict[str, int] = defaultdict(int)  # 只給故障模擬用，正式環境不要靠記憶體

app = FastAPI()

def store_event(event: dict) -> bool:
    """存進收件箱。回傳 True 代表新事件，False 代表重複。"""
    with psycopg.connect(DSN) as conn:  # 正常離開 with 時自動 commit
        cur = conn.execute(
            """
            INSERT INTO webhook_inbox (event_id, event_type, payload)
            VALUES (%s, %s, %s)
            ON CONFLICT (event_id) DO NOTHING
            """,
            (event["id"], event["type"], Jsonb(event)),
        )
        return cur.rowcount == 1  # 撞到主鍵時 rowcount 是 0

@app.post("/webhooks/payments")
async def receive(request: Request) -> Response:
    body = await request.body()
    # 正式環境：這裡要先驗簽，失敗回 400/401（見第 40 篇），範例省略
    event = json.loads(body)

    _hits[event["id"]] += 1
    if _hits[event["id"]] <= FAIL_FIRST_N:
        print(f"[receiver] {event['id']} 模擬故障，回 503")
        return Response(status_code=503)

    # 寫入失敗（例如資料庫掛了）會丟例外，FastAPI 回 500，發送方就會重試
    # 用同步連線丟到執行緒池跑，不卡住事件迴圈。不用 psycopg 的 async 模式，
    # 是因為它在 Windows 上和 uvicorn 預設的 ProactorEventLoop 不相容
    is_new = await run_in_threadpool(store_event, event)

    print(f"[receiver] {event['id']} {'新事件，已存入' if is_new else '重複，略過'}")
    return Response(status_code=200)  # 新的、重複的，一律回 200
```

### 3. 背景工作者 `worker.py`

這支程式不斷從收件箱撈一筆還沒處理的事件來做。程式裡有兩個新寫法先說明：

- `FOR UPDATE SKIP LOCKED`：`FOR UPDATE` 會把撈到的這一列鎖住，表示「這筆我在處理」（見 [悲觀鎖定](07-悲觀鎖定.md)）；`SKIP LOCKED` 讓別的 worker 碰到已經被鎖住的列時直接跳過，去拿下一筆。所以開好幾個 worker 也不會處理到同一筆。
- 外層 `conn.transaction()` 裡面又包一層 `conn.transaction()`：裡面那層是存檔點（savepoint），處理失敗時只撤銷裡面那一段，外層還能把「失敗次數 +1」寫進去。

```python
# worker.py：從收件箱撈事件出來處理，失敗就記次數，不影響發送方
import time

import psycopg

DSN = "postgresql://postgres:postgres@127.0.0.1:5432/postgres"
MAX_ATTEMPTS = 5

def apply_event(conn: psycopg.Connection, event: dict) -> None:
    obj = event["data"]["object"]
    # ✅ 只有事件比目前資料還新才覆蓋；舊事件晚到就什麼都不做
    conn.execute(
        """
        INSERT INTO subscriptions (id, status, source_updated_at)
        VALUES (%(id)s, %(status)s, %(ts)s)
        ON CONFLICT (id) DO UPDATE
            SET status = EXCLUDED.status,
                source_updated_at = EXCLUDED.source_updated_at
            WHERE subscriptions.source_updated_at < EXCLUDED.source_updated_at
        """,
        {"id": obj["id"], "status": obj["status"], "ts": event["created"]},
    )

def process_one(conn: psycopg.Connection) -> bool:
    with conn.transaction():
        # SKIP LOCKED：多個 worker 並行時不會搶同一筆
        row = conn.execute(
            """
            SELECT event_id, payload FROM webhook_inbox
            WHERE processed_at IS NULL AND attempts < %s
            ORDER BY received_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            """,
            (MAX_ATTEMPTS,),
        ).fetchone()
        if row is None:
            return False
        event_id, payload = row
        try:
            with conn.transaction():  # 巢狀 transaction = savepoint，失敗只回滾這段
                apply_event(conn, payload)
                conn.execute(
                    "UPDATE webhook_inbox SET processed_at = now() WHERE event_id = %s",
                    (event_id,),
                )
            print(f"[worker] {event_id} 處理完成")
        except Exception as e:  # 失敗：記錄次數與原因，下一輪再試
            conn.execute(
                "UPDATE webhook_inbox SET attempts = attempts + 1, last_error = %s "
                "WHERE event_id = %s",
                (repr(e), event_id),
            )
            print(f"[worker] {event_id} 處理失敗：{e!r}")
    return True

if __name__ == "__main__":
    with psycopg.connect(DSN, autocommit=True) as conn:
        while True:
            if not process_one(conn):
                time.sleep(1)  # 沒事做就休息一下
```

### 4. 模擬發送端 `sender.py`

重試的等待時間用「full jitter」：先算出這次的等待上限（1 秒、2 秒、4 秒……一次翻倍，最多 30 秒），再在 0 到上限之間隨機挑一個秒數，細節見 [抖動](28-抖動.md)。

```python
# sender.py：模擬發送方，故意送出亂序和重複的事件
import json
import random
import time

import httpx

URL = "http://127.0.0.1:8000/webhooks/payments"
MAX_ATTEMPTS = 5
BASE, CAP = 1.0, 30.0  # 示範用 1 秒起跳；正式環境是分鐘到小時等級

def post_once(event: dict) -> int:
    try:
        r = httpx.post(
            URL,
            content=json.dumps(event),
            headers={"Content-Type": "application/json"},
            timeout=httpx.Timeout(5.0, connect=2.0),  # 一定要設逾時
            follow_redirects=False,                   # 不跟隨轉址，3xx 當失敗
        )
        return r.status_code
    except httpx.TransportError:  # 連不上、逾時都算失敗
        return 0

def deliver(event: dict) -> bool:
    # 示範用 sleep；正式環境是把 next_attempt_at 寫進資料表，由排程撈出來送
    for attempt in range(1, MAX_ATTEMPTS + 1):
        code = post_once(event)
        print(f"[sender] {event['id']} 第 {attempt} 次 → {code or '連線失敗或逾時'}")
        if 200 <= code < 300:
            return True
        if attempt < MAX_ATTEMPTS:
            # 指數退避 + full jitter
            time.sleep(random.uniform(0, min(CAP, BASE * 2 ** (attempt - 1))))
    print(f"[sender] {event['id']} 放棄，寫進投遞紀錄等人工重送")
    return False

def make(event_id: str, created: str, status: str) -> dict:
    return {
        "id": event_id,
        "type": "subscription.updated",
        "created": created,
        "data": {"object": {"id": "sub_1", "status": status}},
    }

if __name__ == "__main__":
    newer = make("evt_002", "2026-10-24T10:05:00Z", "canceled")
    older = make("evt_001", "2026-10-24T10:00:00Z", "active")
    deliver(newer)  # 新事件先到
    deliver(older)  # 舊事件因為重試晚到
    deliver(newer)  # 網路造成的重複送達
```

### 5. 跑起來

開三個終端機：

```powershell
# 終端機 1：接收端，每個事件前兩次故意回 503
$env:FAIL_FIRST_N = "2"
uv run --with fastapi --with uvicorn --with "psycopg[binary]" uvicorn receiver:app --port 8000

# 終端機 2：背景工作者
uv run --with "psycopg[binary]" python worker.py

# 終端機 3：發送端
uv run --with httpx python sender.py
```

**預期會看到：**

- 發送端每個事件前兩次拿到 `503`，第三次拿到 `200`。每次重試前的等待時間是隨機的（full jitter），但隨機範圍的上限會越來越大，所以偶爾會看到第二次等得比第一次還短，這是正常的。
- 第三個 `deliver(newer)` 在接收端印出「重複，略過」，而且直接拿到 `200`（因為 `_hits` 已經超過 2）。
- 回 psql 查：

```sql
SELECT event_id, processed_at IS NOT NULL AS done FROM webhook_inbox;  -- 只有 2 列
SELECT * FROM subscriptions;  -- sub_1 的 status 是 canceled，source_updated_at 是 10:05
```

**做個對照實驗**：把 `worker.py` 裡 `ON CONFLICT ... DO UPDATE` 那段的 `WHERE` 拿掉，`TRUNCATE webhook_inbox, subscriptions;` 之後重跑。你會看到 `sub_1` 最後變成 `active`，也就是「事件順序」那張 `sub_1` 時間表裡「取消了卻又變回 active」的狀況。

玩完記得收拾：`docker stop pg-webhook`（`--rm` 會順便刪掉容器）。

## 常見地雷

### 地雷 1：在 handler 裡同步做完所有工作

- ❌ **錯誤做法**：收到 webhook 後，在同一個請求裡更新資料庫、開發票、寄信，全部做完才回 200。
- **為什麼錯**：任何一個下游變慢，整個回應就超過發送方的時限，觸發重試。更糟的是，第一次其實已經做完了，重試會讓副作用再發生一次。
- ✅ **正確做法**：handler 只做驗簽和把事件存進資料庫，回 200；慢工作丟給背景工作者，並且讓背景處理本身也是冪等的。

### 地雷 2：先回 200，再把事件丟到記憶體或另一條執行緒

- ❌ **錯誤做法**：收到後馬上回 200，然後把事件丟進程式內的 queue 或開個 thread 處理。
- **為什麼錯**：回了 200，發送方就不會再送了。這時候如果你的 process 被重啟、部署、OOM（記憶體用完被系統強制結束），記憶體裡的事件就永遠消失，而且沒有任何人會發現。
- ✅ **正確做法**：**先寫進持久化的地方**（資料庫、或可靠的[訊息佇列](35-訊息佇列.md)），寫成功才回 200。寫失敗就回 5xx，讓對方重送。部署時也要做好[優雅關閉](48-優雅關閉.md)，讓處理中的請求有機會完成。

### 地雷 3：用「先查再寫」去重

- ❌ **錯誤做法**：

```python
# ❌ 錯誤示範：兩個重複請求同時到，兩邊都查不到，兩邊都會處理
if not db.exists("SELECT 1 FROM webhook_inbox WHERE event_id = %s", event_id):
    db.insert(...)
    handle(event)
```

- **為什麼錯**：重試和網路重複送達常常幾乎同時抵達，這就是典型的[競爭條件](01-競爭條件.md)。
- ✅ **正確做法**：

```python
# ✅ 正確寫法：讓唯一約束替你擋，看 rowcount 決定是不是新事件
cur = conn.execute(
    "INSERT INTO webhook_inbox (event_id, event_type, payload) "
    "VALUES (%s, %s, %s) ON CONFLICT (event_id) DO NOTHING",
    (event_id, event_type, Jsonb(event)),
)
is_new = cur.rowcount == 1
```

### 地雷 4：重複事件或不認得的事件回錯誤碼

- ❌ **錯誤做法**：發現事件重複就回 `409 Conflict`；收到沒處理的事件類型就回 `400`。
- **為什麼錯**：大部分發送方對任何非 2xx 都會重試。你等於叫它一直送、一直送，最後它判定你的 endpoint 一直失敗，可能把整個 endpoint 停用，連你需要的事件也收不到了。
- ✅ **正確做法**：重複、不認得、不需要處理的事件，都回 2xx。只有「我需要你再送一次」的情況才回非 2xx。另外，到後台只訂閱你真的需要的事件類型。

### 地雷 5：假設事件照順序到，用「最後收到」覆蓋狀態

- ❌ **錯誤做法**：`UPDATE subscriptions SET status = :status WHERE id = :id`，誰最後到誰說了算。
- **為什麼錯**：重試會讓舊事件晚到，舊狀態蓋掉新狀態，而且完全沒有錯誤訊息。
- ✅ **正確做法**：帶上「事件時間或版本」做條件式更新，舊的就略過；或者收到通知後回頭打 API 拿最新狀態。

### 地雷 6（發送方）：沒設逾時、固定間隔、無限重試

- ❌ **錯誤做法**：`requests.post(url, json=payload)` 不設 timeout；失敗就 `sleep(10)` 再送，直到成功為止。
- **為什麼錯**：Python 的 `requests` 預設沒有逾時，一個不回應的 endpoint 可以讓工作者一直卡住。固定間隔加無限重試，等於對已經掛掉的客戶不停送請求，自己的佇列也越堆越長。
- ✅ **正確做法**：連線和讀取逾時都要設；指數退避加抖動；設定最大次數與總時長；連續失敗太久就停用 endpoint 並通知客戶；每個 endpoint 限制並行數，避免互相拖累。

### 地雷 7（發送方）：重試或重送時換了新的事件 ID

- ❌ **錯誤做法**：每次投遞都重新產生 payload，順便產生新的 `id`。
- **為什麼錯**：接收方唯一能用來去重的東西就是 ID。ID 一換，接收方會把重試當成全新事件，重複處理。
- ✅ **正確做法**：事件 ID 在事件產生時就固定下來（寫在 outbox 裡），之後所有自動重試和人工重送都沿用同一個 ID。可以另外給每次「投遞嘗試」一個 attempt ID 方便除錯，但不要拿它取代事件 ID。

## 重點整理

- **Webhook 幾乎都是「至少一次」（at-least-once）投遞。** 發送方沒在時限內收到 2xx 就重送，所以同一個事件收到兩次、三次是常態。回過 200 也可能再收到，因為回應可能在路上斷掉。
- **接收方做四個動作：先驗簽，再用事件 ID 當主鍵把事件存進收件箱表（重複就略過），接著立刻回 2xx，最後交給背景工作者處理。** 開發票、寄信這些慢工作不放在 handler 裡同步做，背景處理本身也要冪等。
- **事件不保證照順序到。** 用事件的時間戳或版本號做條件式更新，只接受比較新的事件；或者把 webhook 當通知，回頭打對方 API 拿最新狀態。
- **狀態碼照「需不需要對方重送」來回。** 新的、重複的、不認得的事件都回 2xx；只有真的沒存下來（例如資料庫寫不進去）才回 5xx。回錯狀態碼，要嘛事件掉了，要嘛被一直重送到 endpoint 被停用。
- **當發送方時：** 設逾時，重試用指數退避加抖動並設上限，一直失敗的 endpoint 停用並通知客戶，每次投遞留紀錄、提供重送介面，而且重送時事件 ID 不變。

## 新人必知清單

### 一定要會（基本功）

- [ ] 說得出 webhook 是「至少一次」投遞，重複和亂序都是正常現象。
- [ ] 寫得出接收方的流程：先驗簽，再用 `INSERT ... ON CONFLICT DO NOTHING` 存事件，接著回 2xx，最後交給背景處理。
- [ ] 知道什麼情況回 2xx（新的、重複的、不認得的）、什麼情況回非 2xx（真的需要對方重送）。
- [ ] 能用時間戳或版本號寫出條件式更新，讓舊事件不會蓋掉新狀態；也知道「回頭查 API」這個替代方案。
- [ ] 知道背景處理本身也要冪等：開發票、寄信這種副作用，要有自己的去重機制。
- [ ] 當發送方時，HTTP 請求一定設逾時，重試一定有上限且用指數退避加抖動。

### 知道有這回事就好

- 各家廠商的重試策略不一樣（重試多久、幾次、會不會自動重送、多久會停用 endpoint），串接前要讀對方文件，不要憑感覺。
- Standard Webhooks 是一份社群規範，定義了 `webhook-id`、`webhook-timestamp`、`webhook-signature` 這幾個標頭，有些服務照它實作。
- 「瘦事件」設計：payload 只給 ID，強迫接收方回頭查 API，從根本上避開順序問題。
- 發送方要提供投遞紀錄、重送 API、endpoint 停用通知，這些是 webhook 產品的基本配備。
- 發送方要防 SSRF：客戶填的 URL 可能指向你的內網（例如 `http://169.254.169.254/` 或 `localhost`），送出前要擋掉內部位址。
- 收件箱表會無限長大，要定期清掉處理完而且超過保留期的資料（或用[分割](20-分割.md)）。

### 先不用管（等你遇到再學）

- 自建大規模 webhook 投遞平台的細節：每個 endpoint 獨立佇列、公平排程、跨區域投遞。真的要做時可以先評估現成的託管服務。
- 用事件序號做嚴格有序處理（per-key 排序、分區佇列），這屬於[事件驅動架構](39-事件驅動架構.md)和[事件來源](46-事件來源.md)的範疇。
- 「恰好一次」（exactly-once）語意的理論討論。實務上就是「至少一次投遞 + 冪等處理」。

## Code Review 時可以問的問題

1. **這個 webhook handler 在回 2xx 之前，事件已經寫進持久化儲存了嗎？** 如果 process 在回應之後馬上掛掉，事件會不會不見？
2. **去重是靠資料庫的唯一約束，還是「先查再寫」？** 用的是對方文件指定的事件 ID 嗎？
3. **handler 裡有沒有呼叫外部 API、寄信或其他慢工作？** 最壞情況下回應時間會不會超過對方的時限？
4. **事件晚到或亂序時，會不會用舊資料蓋掉新資料？** 有沒有比時間戳、版本號，或回頭查 API？
5. **每一種情況回的狀態碼合理嗎？** 重複事件、不認得的事件是不是回 2xx？暫時性失敗是不是回 5xx？
6. **（發送方）HTTP 請求有設逾時嗎？重試有上限、有退避和抖動嗎？重送時事件 ID 有沒有維持不變？有留投遞紀錄嗎？**

## 情境演練

**1. 你在日誌裡看到同一個 `evt_123` 送進來兩次，兩次 handler 都正常回了 200。同事懷疑是金流商的 bug，想去開工單。你會怎麼判斷？接收方這邊該做什麼？**

<details markdown="1"><summary>看答案</summary>

這是 webhook 的正常現象，不用急著開工單。你回了 200，對方不一定收到 200：回應在網路上可能斷掉，或者你回應時已經超過對方的時限、對方已經斷線。發送方只能根據「有沒有在時限內收到 2xx」判斷，沒收到就重試。發送方自己的系統也可能因為故障而重複送出。webhook 本來就是 at-least-once 投遞，接收方要用事件 ID 去重，讓同一個事件第二次進來時直接略過、回 2xx。

</details>

**2. 你在幫 webhook handler 決定每種情況回什麼狀態碼。上線後可能遇到這四種請求，各回 2xx 還是非 2xx？(a) 事件已經處理過 (b) 事件類型是你沒用到的 `customer.updated` (c) 資料庫連線池滿了，存不進去 (d) 簽章驗證失敗**

<details markdown="1"><summary>看答案</summary>

- (a) 2xx。對你來說已經收到了，回錯誤只會讓對方一直重試。
- (b) 2xx。不然對方會一直重試這個你根本不在乎的事件，還可能因為失敗率太高而停用你的 endpoint。更好的做法是在對方後台取消訂閱這個事件類型。
- (c) 5xx。你確實沒存下來，需要對方之後再送一次。
- (d) 400 或 401。這不是合法的請求，存下來沒有意義。如果是因為你自己的金鑰設定錯了，對方會重試，修好之後還有機會補收；這也是為什麼要監控驗簽失敗率。

</details>

**3. 同事說：「我們的 webhook handler 收到就先回 200，然後用 `asyncio.create_task()` 在背景處理，這樣就不會逾時了。」這有什麼問題？怎麼改？**

<details markdown="1"><summary>看答案</summary>

回 200 的那一刻，發送方就認定投遞成功、不會再送了。但背景 task 只存在於記憶體裡，如果剛好遇到部署重啟、process 崩潰或被 OOM kill，事件就永久遺失，而且沒有任何紀錄。

改法：回 200 之前，先把事件寫進資料庫的收件箱表（或可靠的訊息佇列），寫成功才回 200。背景工作者從收件箱撈事件處理，處理失敗也能從資料表裡重試。這樣「簽收」和「處理」雖然拆開了，但中間有持久化的交接點。

</details>

**4. 你們串了某金流商的訂閱事件。客服回報：有位使用者明明在 10:05 取消訂閱，系統卻顯示「訂閱中」。查日誌發現 10:05 的 `subscription.canceled` 在 10:05 抵達並處理成功，而 10:00 的 `subscription.updated`（狀態 active）在 10:07 才抵達。發生了什麼事？你會用哪兩種方式修？**

<details markdown="1"><summary>看答案</summary>

10:00 的事件第一次投遞失敗（可能你當時回了 5xx 或逾時），進了發送方的重試排程，10:07 才重送成功。你的處理邏輯是「收到什麼就把狀態改成什麼」，所以遲到的舊事件把 canceled 蓋回 active。

修法一：在資料表記錄 `source_updated_at`，用事件的產生時間做條件式更新，只有比較新的事件才覆蓋（`ON CONFLICT ... DO UPDATE ... WHERE subscriptions.source_updated_at < EXCLUDED.source_updated_at`）。要確認時間戳精度夠，必要時改用版本號。

修法二：把 webhook 當通知，收到任何訂閱事件後，回頭呼叫金流商的 API 查這個訂閱目前的狀態，以 API 結果為準。這樣不管事件順序怎麼亂，拿到的都是最新狀態，代價是多一次 API 呼叫，要注意速率限制。

另外可以順便查：10:00 那次為什麼失敗？如果是 handler 太慢導致逾時，那才是要優先修的根因。

</details>

**5. 你負責設計公司對外提供的 webhook。有個大客戶的 endpoint 從昨天開始一律逾時，你發現所有客戶的 webhook 都延遲了好幾個小時。問題可能出在哪？要怎麼設計才能避免？**

<details markdown="1"><summary>看答案</summary>

可能的原因：所有 endpoint 共用同一批投遞工作者和同一條佇列，而且逾時設得太長（或沒設）。大客戶的事件量大、每次都卡到逾時才放棄，再加上不斷重試，投遞工作者大部分時間都在等這個壞掉的 endpoint，其他客戶的事件只能在後面排隊。

設計上要做到：

- 逾時設短（幾秒），不要讓一個請求佔住工作者太久。
- 每個 endpoint 限制並行數或使用獨立佇列，壞掉的 endpoint 只會拖慢自己。
- 重試用指數退避加抖動，失敗越多次間隔越長，不要一直塞回佇列前面。
- 連續失敗超過一定時間就自動停用 endpoint，寄信通知客戶，並提供投遞紀錄和重送介面讓他修好後自己補送。
- 監控每個 endpoint 的失敗率和佇列延遲，有異常時告警。

</details>

## 相關主題

- [冪等性](25-冪等性.md)：接收方用事件 ID 去重，就是冪等性在 webhook 場景的具體應用。
- [重試機制](26-重試機制.md)、[指數退避](27-指數退避.md)、[抖動](28-抖動.md)：發送方的重試排程怎麼設計，原理都在這三篇。
- [Webhook 驗證](40-Webhook%20驗證.md)：接收流程的第一步，重試時的時間戳和簽章處理也要搭配看。
- [背景工作者](37-背景工作者.md)：把「簽收」和「處理」拆開後，處理的那一半怎麼寫。
- [死信佇列](36-死信佇列.md)：背景處理一直失敗的事件該去哪裡、怎麼人工介入。
- [信箱模式](44-信箱模式.md)：發送方如何保證「業務資料寫入」和「要發 webhook」不會只成功一半。

## 延伸閱讀

- Stripe 文件：Receive Stripe events in your webhook endpoint（重試、重複事件、事件順序的說明）— https://docs.stripe.com/webhooks
- GitHub 文件：Best practices for using webhooks — https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- Standard Webhooks 規範（標頭命名、重試與簽章的共通做法）— https://www.standardwebhooks.com/
- PostgreSQL 官方文件：INSERT（`ON CONFLICT` 子句）— https://www.postgresql.org/docs/current/sql-insert.html
