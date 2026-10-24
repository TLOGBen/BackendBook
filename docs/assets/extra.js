// 網站上的兩個小功能，搭配 extra.css：
//
// 1. 表格標記
//    - data-stacked：每一格記下自己的欄名（data-label），手機寬度時表格改成
//      「一列一張卡片」，每格前面顯示欄名，不用在表格裡橫向捲動。
//    - data-timeline：第一欄是「時間」或「步驟」的表格。
//
// 2. 時間軸逐步播放
//    每張時間軸表格上方加一排按鈕。按「逐步看」後一次只亮一列：
//    已經發生的照常顯示，現在這一列標成琥珀色，還沒發生的變淡。
//    沒有 JavaScript 時表格照常全部顯示。
(function () {
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function markTables(root) {
    root.querySelectorAll(".md-typeset table").forEach(function (table) {
      if (table.hasAttribute("data-stacked")) return;
      var heads = Array.prototype.map.call(table.querySelectorAll("thead th"), function (th) {
        return th.textContent.trim();
      });
      if (!heads.length) return;
      table.querySelectorAll("tbody tr").forEach(function (tr) {
        Array.prototype.forEach.call(tr.children, function (td, i) {
          if (heads[i]) td.setAttribute("data-label", heads[i]);
        });
      });
      table.setAttribute("data-stacked", "");
      if (/^(時間|步驟)/.test(heads[0])) {
        table.setAttribute("data-timeline", "");
        addPlayer(table);
      }
    });
  }

  function addPlayer(table) {
    var rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"));
    if (rows.length < 2) return;

    var bar = document.createElement("div");
    bar.className = "tl-player";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "時間軸逐步播放");
    bar.innerHTML =
      '<button type="button" data-act="play">▶ 逐步看</button>' +
      '<button type="button" data-act="prev" aria-label="上一步">上一步</button>' +
      '<button type="button" data-act="next" aria-label="下一步">下一步</button>' +
      '<button type="button" data-act="auto">自動播放</button>' +
      '<button type="button" data-act="all">全部顯示</button>' +
      '<span class="tl-status" aria-live="polite"></span>';

    // Material 會把表格包在 .md-typeset__scrollwrap 裡，按鈕放在包裝外面
    var anchor = table.closest(".md-typeset__scrollwrap") || table;
    anchor.parentNode.insertBefore(bar, anchor);

    var status = bar.querySelector(".tl-status");
    var autoBtn = bar.querySelector('[data-act="auto"]');
    var step = -1; // -1 代表全部顯示
    var timer = null;

    function label(i) {
      var first = rows[i].children[0];
      return first ? first.textContent.trim() : String(i + 1);
    }

    function render() {
      if (step < 0) {
        table.removeAttribute("data-stepping");
        rows.forEach(function (r) { r.classList.remove("tl-now", "tl-future"); });
        status.textContent = "";
        return;
      }
      table.setAttribute("data-stepping", "");
      rows.forEach(function (r, i) {
        r.classList.toggle("tl-now", i === step);
        r.classList.toggle("tl-future", i > step);
      });
      status.textContent = "第 " + (step + 1) + " / " + rows.length + " 步：" + label(step);
    }

    function stopAuto() {
      if (timer) { clearInterval(timer); timer = null; }
      autoBtn.textContent = "自動播放";
    }

    function go(i) {
      step = Math.max(0, Math.min(rows.length - 1, i));
      render();
    }

    bar.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act !== "auto") stopAuto();
      if (act === "play") go(0);
      else if (act === "next") go(step < 0 ? 0 : step + 1);
      else if (act === "prev") go(step < 0 ? 0 : step - 1);
      else if (act === "all") { step = -1; render(); }
      else if (act === "auto") {
        if (timer) { stopAuto(); return; }
        if (step < 0 || step >= rows.length - 1) go(0);
        autoBtn.textContent = "暫停";
        timer = setInterval(function () {
          if (step >= rows.length - 1) { stopAuto(); return; }
          go(step + 1);
        }, reduceMotion ? 2600 : 1800);
      }
    });
  }

  // 3. /draw 出的主圖（iframe）
  //    - 把網站目前的深淺色設到圖的根元素 data-theme，切換配色時跟著換
  //    - 依圖的實際內容調整 iframe 高度
  function siteTheme() {
    var scheme = document.body.getAttribute("data-md-color-scheme");
    return scheme === "slate" ? "dark" : "light";
  }

  function syncFigure(frame) {
    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.documentElement) return;
    doc.documentElement.setAttribute("data-theme", siteTheme());
    // 只量 body 自己的內容高度。documentElement.scrollHeight 至少等於 iframe 目前的高度，
    // 用它的話 iframe 只會變高、縮不回來（例如視窗從窄拉回寬）。
    var body = doc.body;
    if (!body) return;
    var cs = doc.defaultView ? doc.defaultView.getComputedStyle(body) : null;
    var margin = cs ? (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) : 0;
    var h = Math.ceil(body.scrollHeight + margin);
    if (h > 0) frame.style.height = h + "px";
  }

  function wireFigures(root) {
    root.querySelectorAll("iframe.draw-fig__frame").forEach(function (frame) {
      if (frame.hasAttribute("data-wired")) return;
      frame.setAttribute("data-wired", "");
      frame.addEventListener("load", function () {
        syncFigure(frame);
        try {
          var win = frame.contentWindow;
          if (win && win.ResizeObserver) {
            new win.ResizeObserver(function () { syncFigure(frame); }).observe(frame.contentDocument.body);
          }
        } catch (e) { /* 跨網域時略過，維持預設高度 */ }
      });
      if (frame.contentDocument && frame.contentDocument.readyState === "complete") syncFigure(frame);
    });
  }

  new MutationObserver(function () {
    document.querySelectorAll("iframe.draw-fig__frame").forEach(syncFigure);
  }).observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });

  function init() { markTables(document); wireFigures(document); }

  // Material 開了 instant navigation 時用 document$；沒開時就在載入後跑一次
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(init);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
