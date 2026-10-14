// ==UserScript==
// @name         YouTube 观看记录 · 一键移除按钮
// @namespace    https://github.com/jerryshell/yt-del-btn
// @version      2.1.3
// @description  在 YouTube 观看记录页为每条记录直接显示「从观看记录中移除」按钮，一次点击即删除，省掉二级菜单
// @author       jerry
// @license      MIT
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 做法只有一条：点 YouTube 自己的菜单项。
 * ------------------------------------------------
 * 点一下条目上的「更多操作」，再点「从观看记录中移除」——和手动操作两次一样，
 * 请求组装、埋点、提示条、列表更新、撤销入口全部由 YouTube 处理。
 *
 * 需要识别的两个元素按数据模型认，不写死文案：
 *   · 菜单按钮：yt-button-view-model 的 data 里带 showSheetCommand 的那一个
 *   · 删除行  ：yt-list-item-view-model 的 data 里 feedbackToken 属于当前视频的那一个
 *     （YouTube 会复用菜单节点，用 token 比对才不会认错；页面残留的其它面板也不会被点到）
 * 取不到 data 的旧 DOM 才退回「可见 + 文案匹配」，文案同样从页面数据里读。
 *
 * token 与文案来自页面数据：window.ytInitialData 与 /youtubei/v1/browse 的响应。
 */

(() => {
  "use strict";

  /* ============================ 配置 ============================ */

  const DEBUG = false; // true → 控制台打印 [ytdb] 详细日志
  const HOVER_ONLY = false; // true → 静止时不显示按钮，鼠标移到该条记录上才出现（页面更干净）
  const PATH = "/feed/history"; // 只在观看记录页生效
  const CARD_SEL =
    "yt-lockup-view-model, ytd-video-renderer, ytd-playlist-video-renderer, " +
    "ytd-grid-video-renderer, ytd-compact-video-renderer";
  const SCAN_DELAY = 250; // 页面变动后延迟多少毫秒扫描一次（节流，不重置）

  /* ============================ 状态 ============================ */

  const tokens = new Map(); // videoId -> [feedbackToken, ...]（同一视频在记录里可能有多条）
  const hints = new Map(); // videoId -> { menuLabel, removeLabel, tracking }（UI 文案，取自页面数据）
  let initialScanned = false; // window.ytInitialData 是否已扫描
  let timer = 0; // scan 节流定时器
  let lastReport = ""; // 上次打印过的扫描摘要（避免刷屏）
  let warned = false; // 是否已提示过注入失败
  let zIndex = "5"; // 按钮层级（被遮住时自动提高）
  let checked = false; // 是否已确认按钮在最上层

  /* ============================ 日志 ============================ */

  // 分两档：
  //   key  —— 关键路径，始终打印（info），事后把控制台这几行发出来即可定位问题
  //   log  —— 细节，仅详细模式打印（debug），日常使用不受打扰
  // 详细模式打开方式（二选一）：
  //   1. 把上面的 DEBUG 改成 true
  //   2. 控制台执行 localStorage.ytdb = "debug" 后刷新页面（__ytdb.debug(true) 可临时打开）
  const T = "ytdb";
  const VERSION = "2.1.3";
  let verbose = DEBUG;
  try {
    verbose = DEBUG || localStorage.getItem("ytdb") === "debug";
  } catch {}

  const stamp = () => new Date().toTimeString().slice(0, 8);
  const key = (...a) => console.info("[" + T + " " + stamp() + "]", ...a);
  const keyWarn = (...a) => console.warn("[" + T + " " + stamp() + "]", ...a);
  const log = (...a) => {
    if (verbose) console.debug("[" + T + " " + stamp() + "]", ...a);
  };
  const err = (...a) => console.error("[" + T + " " + stamp() + "]", ...a);
  const onHistory = () => location.pathname === PATH;
  const ready = (fn) =>
    document.documentElement
      ? fn()
      : document.addEventListener("DOMContentLoaded", fn, { once: true });

  /* ========================== 数据：token ========================== */

  // 这个 feedbackEndpoint 是不是「从观看记录中移除」：必须带 ..._REMOVE 的 localWatchHistoryCommand
  const historyRemoveCommand = (fe) => {
    const cmd = (fe?.actions || []).find(
      (a) => a?.localWatchHistoryCommand,
    )?.localWatchHistoryCommand;
    return cmd && /REMOVE/.test(String(cmd.localWatchHistoryCommandType)) ? cmd : null;
  };

  function remember(vid, patch) {
    if (!vid) return;
    const h = hints.get(vid) || {};
    for (const k of Object.keys(patch)) if (patch[k]) h[k] = patch[k];
    hints.set(vid, h);
  }

  // 从任意 innertube JSON 里收集「从观看记录中移除」的 feedbackToken
  function collect(node, ctxVid) {
    if (!node || typeof node !== "object") return 0;
    if (Array.isArray(node)) {
      let n = 0;
      for (const v of node) n += collect(v, ctxVid);
      return n;
    }

    let n = 0;

    // 记录当前所在的视频条目（仅认已知 renderer / viewModel 的形状，避免张冠李戴）
    const lv = node.lockupViewModel,
      vr = node.videoRenderer;
    const pv = node.playlistVideoRenderer,
      gv = node.gridVideoRenderer;
    const own =
      (lv && lv.contentId) || (vr && vr.videoId) || (pv && pv.videoId) || (gv && gv.videoId);
    if (own) ctxVid = own;

    const fe = node.feedbackEndpoint;
    if (fe && fe.feedbackToken) {
      const rc = historyRemoveCommand(fe);
      const vid = rc && (rc.videoId || fe.contentId || ctxVid);
      if (vid) {
        const arr = tokens.get(vid) || [];
        if (!arr.includes(fe.feedbackToken)) {
          arr.push(fe.feedbackToken);
          tokens.set(vid, arr);
          n++;
        }
      }
    }

    // 顺手记下 UI 线索，供「点 YouTube 自己的菜单项」使用。
    // 两段文案都来自页面数据本身（本机语言），所以不写死「更多操作 / 从观看记录中移除」。
    const li = node.listItemViewModel;
    const tap = li?.rendererContext?.commandContext?.onTap?.innertubeCommand;
    if (tap && historyRemoveCommand(tap.feedbackEndpoint)) {
      remember(ctxVid, { removeLabel: li.title?.content });
    }
    const mb = node.menuButton && node.menuButton.buttonViewModel;
    if (mb && mb.accessibilityText) remember(ctxVid, { menuLabel: mb.accessibilityText });

    for (const k in node) n += collect(node[k], ctxVid);
    return n;
  }

  /* ========================== 页面：按钮 ========================== */

  // 注意：页面开启了 Trusted Types（CSP 禁止 innerHTML），图标必须用 DOM API 构建
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_PATH = "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z";

  function makeIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATH);
    svg.appendChild(path);
    return svg;
  }

  // 位置 / 尺寸 / 底色等关键样式直接写内联（见 inject），
  // 这里放内联做不到的效果。取值有据：
  //   · 焦点环 —— 白环 + 黑描边，与 YouTube 自己的覆盖层按钮同一思路，
  //     因为 YouTube 的 CSS 里有大量 outline:none，默认焦点环并不可靠；
  //     黑描边比白环宽 2px，白色缩略图上也能看清环的外沿；
  //   · 命中区 —— 视觉仍是 30px，用 ::after 撑到 40×40（桌面目标 ≥40px）；
  //   · 按下反馈 —— scale(.96)，仅在允许动效时启用。
  const CSS =
    ".ytdb-del{transition:opacity .15s cubic-bezier(.2,0,0,1),background-color .15s cubic-bezier(.2,0,0,1),transform .1s cubic-bezier(.2,0,0,1)}" +
    // 指向卡片时先把按钮提亮，便于发现；指到按钮本身则完全实心
    "yt-lockup-view-model:hover .ytdb-del,ytd-video-renderer:hover .ytdb-del{opacity:.85!important}" +
    ".ytdb-del:hover{opacity:1!important;background-color:#c00!important}" +
    ".ytdb-del:disabled{opacity:.3;cursor:progress}" +
    ".ytdb-del::after{content:'';position:absolute;inset:-5px;border-radius:50%}" +
    ".ytdb-del:focus-visible{outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 6px rgba(0,0,0,.6)}" +
    "@media (prefers-reduced-motion: no-preference){.ytdb-del:active{transform:scale(.96)}}" +
    "html.ytdb-busy yt-sheet-view-model,html.ytdb-busy tp-yt-iron-overlay-backdrop," +
    "html.ytdb-busy ytd-popup-container{visibility:hidden!important}";

  function installStyle() {
    if (document.getElementById("ytdb-style")) return;
    const el = document.createElement("style");
    el.id = "ytdb-style";
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  // 卡片 → videoId（新老 UI 都是靠 /watch?v= / /shorts/ 链接）
  function cardVid(card) {
    const links = card.querySelectorAll(
      'a[href*="/watch?"], a[href*="/shorts/"], a[href*="/live/"]',
    );
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m =
        href.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ||
        href.match(/\/(?:shorts|live)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    }
    return null;
  }

  const stopEvent = (e) => e.stopPropagation();

  // 自检：按钮真的在最上层吗？被遮住就提高层级，仍被遮住就把遮挡者报出来。
  // 纯诊断，任何异常都不影响注入与删除。
  function checkPlacement() {
    if (checked) return;
    const btn = document.querySelector(".ytdb-del");
    if (!btn) return;
    let top = null;
    try {
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) {
        top = document.elementFromPoint(x, y);
      }
    } catch {
      return; // 判不了，下次扫描再说
    }
    if (!top) return;
    if (top === btn || btn.contains(top)) {
      checked = true;
      return;
    }
    const who =
      top.tagName.toLowerCase() +
      (typeof top.className === "string" && top.className.trim()
        ? "." + top.className.trim().split(/\s+/)[0]
        : "");
    if (zIndex === "5") {
      zIndex = "2147483000";
      document.querySelectorAll(".ytdb-del").forEach((b) => (b.style.zIndex = zIndex));
      keyWarn("按钮被 " + who + " 遮住，已提高层级");
    } else {
      checked = true;
      keyWarn("按钮仍被 " + who + " 遮住，请把这一行发我");
    }
  }

  function inject(card, vid) {
    let btn = card.querySelector(":scope > .ytdb-del");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ytdb-del";
      btn.title = "从观看记录中移除";
      btn.setAttribute("aria-label", "从观看记录中移除");
      btn.appendChild(makeIcon());
      // 关键样式写在元素上：即使 <style> 被 CSP 拦下，按钮也看得见。
      // 固定右下角：列表条目是「左封面 + 右信息」，压左侧封面上既看不清也会盖住画面。
      btn.style.cssText =
        "position:absolute;inset-inline-end:8px;bottom:8px;box-sizing:border-box;" +
        "width:30px;height:30px;padding:0;display:flex;align-items:center;justify-content:center;" +
        "border:0;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;cursor:pointer;" +
        (HOVER_ONLY ? "opacity:0" : "opacity:.6");
      btn.addEventListener("mousedown", stopEvent, true);
      btn.addEventListener("click", onClick, true); // 捕获阶段：先于 YouTube 的处理器，且不再冒泡
      if (getComputedStyle(card).position === "static") card.style.position = "relative";
      card.appendChild(btn);
      log("注入按钮：", vid);
    }
    btn.dataset.vid = vid;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 只影响观感：把弹出的面板藏起来，避免二级菜单在眼前闪一下。失败不影响删除。
  function setBusy(on) {
    try {
      document.documentElement.classList.toggle("ytdb-busy", on);
    } catch {}
  }

  // 二级菜单里的行（新旧 DOM 都盖）
  const MENU_ROW_SEL =
    'yt-list-item-view-model, ytd-menu-service-item-renderer, tp-yt-paper-item, [role="menuitem"]';

  // YouTube 的 view-model 元素（yt-*-view-model）把渲染用的数据挂在 data 属性上，
  // 拿到它就能按 token 认出「这一行属于哪个视频」，不必依赖文案或节点新旧。
  function modelOf(el) {
    try {
      const d = el && el.data;
      return (typeof d === "function" ? d.call(el) : d) || null;
    } catch {
      return null;
    }
  }

  const isVisible = (el) => {
    try {
      return el.getClientRects().length > 0;
    } catch {
      return true;
    }
  };

  const textMatches = (el, label) => {
    const want = (label || "").trim();
    if (!want) return false;
    const t = (el.textContent || "").trim();
    return t === want || (t.length < want.length + 40 && t.includes(want));
  };

  // 行模型里是否含该视频的 feedbackToken（模型结构变了也不怕）
  function rowHasToken(row, list, model) {
    if (!list.length) return false;
    const m = model === undefined ? modelOf(row) : model;
    if (!m) return false;
    try {
      const s = JSON.stringify(m);
      return list.some((t) => s.includes(t));
    } catch {
      return false;
    }
  }

  // 能弹出菜单的按钮：buttonViewModel.onTap.innertubeCommand.showSheetCommand
  const hasShowSheet = (model) => !!model?.onTap?.innertubeCommand?.showSheetCommand;

  // 包装元素 → 真正接收点击的元素
  const btnTarget = (el) =>
    el && el.tagName === "BUTTON"
      ? el
      : (el && el.querySelector && el.querySelector("button")) || el;

  const rowTarget = (el) =>
    el?.closest?.("yt-list-item-view-model, ytd-menu-service-item-renderer, tp-yt-paper-item") ||
    el;

  // 卡片上的「更多操作」按钮：先用数据模型认，再用文案，最后退回卡片里最后一个按钮
  // （要排掉自己注入的那个按钮，否则可能点到自己）。stats 用于日志。
  function findMenuButton(card, label, stats) {
    const nodes = [...card.querySelectorAll("button, yt-button-view-model")].filter(
      (n) => !n.classList.contains("ytdb-del"),
    );
    if (stats) stats.candidates = nodes.length;
    for (const n of nodes) {
      if (hasShowSheet(modelOf(n))) {
        if (stats) stats.by = "数据模型(showSheetCommand)";
        return btnTarget(n);
      }
    }
    if (label) {
      const hit = nodes.find(
        (n) => (n.getAttribute("aria-label") || n.title || "").trim() === label,
      );
      if (hit) {
        if (stats) stats.by = "文案(" + label + ")";
        return btnTarget(hit);
      }
    }
    if (stats) stats.by = nodes.length ? "退而取最后一个按钮" : "无候选";
    return nodes.length ? btnTarget(nodes[nodes.length - 1]) : null;
  }

  // 选菜单行：先按 token 精确对应，再退回「可见 + 文案匹配」。stats 用于日志。
  function pickRow(vid, label, stats) {
    const mine = tokens.get(vid) || [];
    let fallback = null;
    const rows = document.querySelectorAll(MENU_ROW_SEL);
    if (stats) {
      stats.rows = rows.length;
      stats.withModel = 0;
      stats.otherModel = 0;
    }
    for (const row of rows) {
      const model = modelOf(row);
      if (model) {
        if (stats) stats.withModel++;
        // 有模型就能判断归属：token 对得上才点，对不上绝不点（可能是别的视频残留的面板）
        if (rowHasToken(row, mine, model)) {
          if (stats) stats.by = "feedbackToken";
          return rowTarget(row);
        }
        if (stats) stats.otherModel++;
        continue;
      }
      // 旧 DOM（没有 view-model 数据）只能退回「可见 + 文案」
      if (!fallback && isVisible(row) && textMatches(row, label)) {
        if (stats) stats.by = "可见文案(" + label + ")";
        fallback = rowTarget(row);
      }
    }
    return fallback;
  }

  // 关掉可能还开着的面板
  function closePopups() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
    );
  }

  // 点开二级菜单 → 点「从观看记录中移除」。之后的请求、toast、列表更新、撤销提示全由 YouTube 处理。
  async function clickNativeRemove(card, vid) {
    const info = hints.get(vid) || {};
    const menuStats = {};
    const menu = findMenuButton(card, info.menuLabel, menuStats);
    log("菜单按钮：", menuStats.by || "无", "（候选 " + menuStats.candidates + " 个）");
    if (!menu) throw new Error("找不到条目上的菜单按钮（候选 " + menuStats.candidates + " 个）");

    const rowStats = {};
    const t0 = Date.now();
    setBusy(true);
    try {
      menu.click();
      for (let i = 0; i < 12; i++) {
        const row = pickRow(vid, info.removeLabel, rowStats);
        if (row) {
          log(
            "菜单行命中：" + rowStats.by,
            "(行 " +
              rowStats.rows +
              " 个，带模型 " +
              rowStats.withModel +
              " 个，第 " +
              (i + 1) +
              " 次轮询，" +
              (Date.now() - t0) +
              "ms)",
          );
          row.click();
          return true;
        }
        await sleep(60);
      }
      log("未命中菜单行：", JSON.stringify(rowStats));
      closePopups();
      throw new Error(
        "没等到「" +
          (info.removeLabel || "从观看记录中移除") +
          "」菜单项（行 " +
          rowStats.rows +
          " 个，带模型 " +
          rowStats.withModel +
          " 个）",
      );
    } finally {
      setTimeout(() => setBusy(false), 300);
    }
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const btn = e.currentTarget;
    if (btn.disabled) return;
    const card = btn.parentElement;
    const vid = btn.dataset.vid;
    if (!vid || !card) return;

    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    const t0 = Date.now();
    key("点击删除 " + vid + "（token " + (tokens.get(vid) || []).length + " 个）");
    try {
      await clickNativeRemove(card, vid);
      key("已删除 " + vid + "：用时 " + (Date.now() - t0) + "ms");
    } catch (e) {
      keyWarn("删除失败 " + vid + "：" + (e && e.message) + "（再点一次重试）");
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }

  /* ========================== 扫描与接管 ========================== */

  // 列表里的条目：排除嵌套的卡片（外层处理即可）
  const findCards = () =>
    [...document.querySelectorAll(CARD_SEL)].filter(
      (c) => !(c.parentElement && c.parentElement.matches(CARD_SEL)),
    );

  function scan() {
    if (!onHistory()) return;

    if (!initialScanned && window.ytInitialData) {
      initialScanned = true;
      log("ytInitialData 里的 token：" + collect(window.ytInitialData));
    }

    const cards = findCards();
    let injected = 0,
      noVid = 0,
      noToken = 0;

    for (const card of cards) {
      const vid = cardVid(card);
      if (!vid) {
        noVid++;
        continue;
      }
      if (!tokens.has(vid)) {
        noToken++;
        continue; // 不是观看记录条目 / token 还没到
      }
      try {
        inject(card, vid);
        injected++;
      } catch (e) {
        if (!warned) {
          warned = true;
          err("添加按钮失败：", e);
        }
      }
    }

    const report = cards.length + "/" + injected + "/" + noVid + "/" + noToken + "/" + tokens.size;
    if (report !== lastReport) {
      lastReport = report;
      const line =
        "卡片 " +
        cards.length +
        "，已加按钮 " +
        injected +
        "，无法识别视频 " +
        noVid +
        "，缺 token " +
        noToken +
        "，token 覆盖 " +
        tokens.size +
        " 个视频";
      key("扫描：" + line);
      if (!injected) keyWarn("按钮数为 0：把上面这一行发我即可定位");
    }
    try {
      checkPlacement();
    } catch (e) {
      log("置顶自检跳过：", e); // 自检只是诊断，出错不影响注入与删除
    }
  }

  function schedule() {
    if (timer) return; // 节流：一批变动只扫一次
    timer = setTimeout(() => {
      timer = 0;
      scan();
    }, SCAN_DELAY);
  }

  /* ============ token 来源 2：拦截 /youtubei/v1/browse 响应 ============ */

  const isBrowse = (u) => typeof u === "string" && u.indexOf("/youtubei/v1/browse") >= 0;
  const inspect = (json) => {
    if (json && collect(json)) schedule();
  };

  // 翻页 / 站内跳转时，从 browse 响应里继续收集 token
  try {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url;
      if (onHistory() && isBrowse(url)) {
        p.then((r) => {
          try {
            r.clone()
              .json()
              .then(inspect)
              .catch(() => {});
          } catch {}
        }).catch(() => {});
      }
      return p;
    };
  } catch (e) {
    keyWarn("fetch 拦截失败（翻页记录的 token 可能取不到）：", e);
  }

  try {
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ytdbUrl = url;
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (onHistory() && isBrowse(this.__ytdbUrl)) {
        this.addEventListener("load", () => {
          try {
            inspect(
              this.responseType === "json"
                ? this.response
                : JSON.parse(this.responseText || "null"),
            );
          } catch {}
        });
      }
      return xhrSend.apply(this, arguments);
    };
  } catch (e) {
    keyWarn("XHR 拦截失败（翻页记录的 token 可能取不到）：", e);
  }

  /* ========================== 启动 ========================== */

  function boot() {
    try {
      installStyle();
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      window.addEventListener("yt-navigate-finish", () => {
        initialScanned = false;
        setTimeout(scan, 300);
      });

      scan();
      setTimeout(() => {
        if (onHistory() && !tokens.size) {
          keyWarn(
            "没取到任何 token：可能未登录，或页面数据结构已变。" +
              "请在控制台执行 __ytdb.dump() 看识别情况。",
          );
        }
      }, 6000);

      key(
        "脚本已运行（v" +
          VERSION +
          "）：" +
          location.pathname +
          " | 详细日志 " +
          (verbose ? "开" : '关（localStorage.ytdb = "debug" 后刷新可开）'),
      );
      log("环境：", { ytInitialData: typeof window.ytInitialData === "object" });
    } catch (e) {
      err("启动失败：", e);
    }
  }

  // 调试用句柄：控制台可用 __ytdb.tokens.size / __ytdb.scan() 查看状态
  try {
    window.__ytdb = {
      tokens,
      hints,
      scan,
      collect,
      version: VERSION,
      // 临时打开详细日志：__ytdb.debug(true)
      debug(on = true) {
        verbose = !!on;
        key("详细日志已" + (verbose ? "打开" : "关闭"));
        return verbose;
      },
      // 看看当前页面的识别情况：__ytdb.hints / __ytdb.tokens
      dump() {
        return {
          version: VERSION,
          tokens: tokens.size,
          videos: [...tokens.keys()].slice(0, 50),
          hints: Object.fromEntries(hints),
        };
      },
    };
  } catch {}

  ready(boot);
})();
