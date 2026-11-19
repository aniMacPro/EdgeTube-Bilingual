(() => {
  "use strict";
  const C = DualSubCore;
  let config = null;
  let id = "";
  let epoch = 0;
  let cues = [];
  let translations = new Map();
  let pending = new Set();
  let retryAt = new Map();
  let busy = false;
  let error = "";
  let mode = "等待视频";
  let video = null;
  let player = null;
  let host = null;
  let originalNode, translatedNode, box, shadow;
  let observer;
  let resizer;
  let lastNative = "";
  let stableAt = 0;
  let nativeActive = "";
  let nativeCurrent = null;
  let nativeSegments = [];
  let nativeSequence = 0;
  let nativeTime = null;
  let nativeClock = 0;
  let captionSource = "auto";
  let transcriptAt = 0;
  let transcriptBusy = false;
  let enabledCC = null;
  let ccAttempted = false;
  let lastPaint = "";
  let lastPump = 0;
  let nextRequestAt = 0;
  let adActive = false;
  let seq = 0;
  const rpc = new Map();
  const send = message => chrome.runtime.sendMessage(message).then(r => { if (!r?.ok) throw new Error(r?.error || "插件连接已断开，请刷新视频页面。"); return r; });
  function getId() { return new URL(location.href).searchParams.get("v") || location.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] || ""; }
  function bridge(type) {
    return new Promise(resolve => {
      const key = `${Date.now()}-${++seq}`;
      const timer = setTimeout(() => { rpc.delete(key); resolve(null); }, 10000);
      rpc.set(key, data => { clearTimeout(timer); resolve(data); });
      window.postMessage({ channel: "EDGETUBE_CAPTION_REQUEST_V1", id: key, type, source: config?.source || "auto" }, location.origin);
    });
  }
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === "EDGETUBE_CAPTION_RESPONSE_V1") {
      const done = rpc.get(event.data.id);
      if (done) { rpc.delete(event.data.id); done(event.data.data); }
    }
  });
  function restoreCC() {
    if (enabledCC?.isConnected && enabledCC.getAttribute("aria-pressed") === "true") enabledCC.click();
    enabledCC = null;
  }
  function reset() {
    epoch++; cues = []; translations = new Map(); pending = new Set(); retryAt = new Map(); busy = false;
    error = ""; lastNative = ""; nativeActive = ""; transcriptAt = 0; transcriptBusy = false; ccAttempted = false;
    nativeCurrent = null; nativeSegments = []; nativeSequence = 0; nativeTime = null; nativeClock = 0; captionSource = config?.source || "auto";
    nextRequestAt = 0; mode = "正在读取字幕"; lastPaint = "";
    render("", "");
  }
  function mount(p) {
    player?.classList.remove("edgetube-rendering");
    observer?.disconnect();
    resizer?.disconnect();
    host?.remove();
    player = p;
    host = document.createElement("div"); host.id = "edgetube-subtitle-host";
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host{all:initial;position:absolute;inset:0;pointer-events:none;font-family:Arial,"Microsoft YaHei",sans-serif;color:white}
      .wrap{position:absolute;left:4%;right:4%;bottom:var(--bottom,6%);text-align:center;display:flex;justify-content:center}
      .box{box-sizing:border-box;max-width:100%;padding:.3em .65em .38em;border-radius:5px;background:rgba(0,0,0,var(--opacity,.65));font-size:var(--size,30px);line-height:1.42;text-shadow:0 1px 3px #000;white-space:normal;overflow-wrap:anywhere}
      .line{margin:0;max-height:4.3em;overflow:hidden;font-weight:var(--original-weight,500);letter-spacing:0;color:#fff}
      .translation{font-weight:var(--translation-weight,600)}.line+.line{margin-top:.12em}[hidden]{display:none!important}
    `;
    const wrap = document.createElement("div"); wrap.className = "wrap";
    box = document.createElement("div"); box.className = "box"; box.hidden = true;
    originalNode = document.createElement("div"); originalNode.className = "line original"; originalNode.dir = "auto";
    translatedNode = document.createElement("div"); translatedNode.className = "line translation"; translatedNode.dir = "auto";
    box.append(originalNode, translatedNode); wrap.append(box); shadow.append(style, wrap);
    player.append(host);
    observer = new MutationObserver(readNative);
    observer.observe(player, { subtree: true, childList: true, characterData: true });
    resizer = new ResizeObserver(applyStyle);
    resizer.observe(player);
    lastPaint = ""; applyStyle();
  }
  function applyStyle() {
    if (!host || !config) return;
    // 30 px at 1280-wide player; scale naturally in theater/fullscreen/mobile layouts.
    const scale = Math.min(1.65, Math.max(0.65, player.clientWidth / 1280));
    host.style.setProperty("--size", `${Math.round(config.fontSize * scale)}px`);
    host.style.setProperty("--original-weight", String(config.originalWeight ?? 500));
    host.style.setProperty("--translation-weight", String(config.translationWeight ?? 600));
    host.style.setProperty("--bottom", `${config.bottom}%`);
    host.style.setProperty("--opacity", String(config.opacity));
  }
  function render(original, translated) {
    if (!box) return;
    const visible = Boolean(config?.enabled && config.hasApiKey && !adActive && (original || translated));
    const paint = JSON.stringify([visible, config?.showOriginal, original, translated]);
    if (paint === lastPaint) return;
    lastPaint = paint;
    originalNode.textContent = original;
    translatedNode.textContent = translated;
    originalNode.hidden = !config?.showOriginal || !original;
    translatedNode.hidden = !translated;
    box.hidden = !visible || (!translated && !config?.showOriginal);
    player?.classList.toggle("edgetube-rendering", !box.hidden);
  }
  function readNative() {
    if (!player || !config?.enabled || cues.length) return;
    const windows = player.querySelectorAll(".caption-window");
    const text = C.clean([...windows].map(w => [...w.querySelectorAll(".ytp-caption-segment")].map(n => n.textContent).join(" ")).join(" "));
    if (text !== lastNative) {
      // Rolling captions often revise one utterance; do not turn each prefix into history.
      if (nativeCurrent && text && (text.startsWith(nativeCurrent.text) || nativeCurrent.text.startsWith(text)) && nativeSegments.at(-1) === nativeCurrent) nativeSegments.pop();
      lastNative = text; nativeActive = text; nativeCurrent = null; stableAt = Date.now();
    }
  }
  function currentNativeSegment() {
    if (!nativeActive || Date.now() - stableAt <= 450) return null;
    if (!nativeCurrent) {
      nativeCurrent = { key: `native:${Math.round((video?.currentTime || 0) * 1000)}:${++nativeSequence}`, text: nativeActive };
      nativeSegments.push(nativeCurrent);
      if (nativeSegments.length > 40) nativeSegments.shift();
    }
    return nativeCurrent;
  }
  function checkNativeSeek() {
    const time = video.currentTime, clock = Date.now();
    const expected = (clock - nativeClock) / 1000 * Math.abs(video.playbackRate || 1);
    if (nativeTime !== null && (time < nativeTime - 0.5 || Math.abs(time - nativeTime) > Math.max(3, expected + 2))) {
      // An unrelated playback position must not inherit the most recently watched dialogue.
      epoch++; busy = false; pending = new Set(); retryAt = new Map(); transcriptBusy = false;
      nativeSegments = []; nativeCurrent = null; lastNative = ""; nativeActive = "";
    }
    nativeTime = time; nativeClock = clock;
  }
  async function loadTranscript() {
    if (!config?.enabled || !config.hasApiKey || !id || transcriptBusy || cues.length || Date.now() - transcriptAt < 18000 || adActive) return;
    const generation = epoch; transcriptAt = Date.now(); transcriptBusy = true;
    try {
      const data = await bridge("CAPTIONS");
      if (generation !== epoch || !config?.enabled || data?.videoId !== id) return;
      captionSource = data.languageCode || data.nativeLanguage || config.source || "auto";
      if (Array.isArray(data.cues) && data.cues.length) {
        cues = C.normalizeCues(data.cues.slice(0, 30000)).map((cue, index) => ({ ...cue, key: `cue:${index}:${Math.round(cue.start * 1000)}:${Math.round(cue.end * 1000)}` }));
        if (cues.length) { mode = `提前翻译 · ${data.languageCode || "原文"}`; error = ""; nativeActive = ""; }
      } else {
        mode = "逐句翻译 · 使用 YouTube 字幕";
        ensureCC();
      }
    } finally { if (generation === epoch) transcriptBusy = false; }
  }
  function ensureCC() {
    const button = player?.querySelector(".ytp-subtitles-button");
    if (!button || ccAttempted || getComputedStyle(button).display === "none") return;
    ccAttempted = true;
    if (button.getAttribute("aria-pressed") === "false") { button.click(); enabledCC = button; }
  }
  function segmentsAhead() {
    const now = video?.currentTime || 0;
    if (cues.length) {
      const current = C.findCue(cues, now);
      const list = current ? [current] : [];
      for (const cue of cues) {
        if (cue.start >= now && cue.start <= now + config.prefetch && !list.includes(cue)) list.push(cue);
        if (cue.start > now + config.prefetch || list.length >= 12) break;
      }
      return list;
    }
    const current = currentNativeSegment();
    return current ? [current] : [];
  }
  async function pump() {
    if (!config?.enabled || !config.hasApiKey || busy || !video || video.ended || adActive || Date.now() < nextRequestAt) return;
    // Paused videos only translate the visible subtitle; do not run through a whole lookahead.
    const now = Date.now();
    const candidates = segmentsAhead();
    const selected = (video.paused ? candidates.slice(0, 1) : candidates).filter(s => !translations.has(s.key) && !pending.has(s.key) && (retryAt.get(s.key) || 0) <= now);
    const items = [];
    let length = 0;
    const timeline = cues.length ? cues : nativeSegments;
    for (const segment of selected) {
      if (segment.text.length > 3000) continue;
      if (length + segment.text.length > 9500) break;
      items.push({ key: segment.key, text: segment.text, ...C.contextFor(timeline, timeline.indexOf(segment), translations) }); length += segment.text.length;
    }
    if (!items.length) return;
    const generation = epoch; const pendingSet = pending; busy = true;
    items.forEach(s => pendingSet.add(s.key));
    try {
      const response = await send({ type: "TRANSLATE", videoId: id, source: captionSource, mode: cues.length ? "timeline" : "native", items, config: { model: config.model, target: config.target } });
      if (generation !== epoch) return;
      items.forEach((s, i) => { if (response.translations[i]) translations.set(s.key, response.translations[i]); });
      while (translations.size > 4000) translations.delete(translations.keys().next().value);
      error = "";
    } catch (e) {
      if (generation !== epoch) return;
      error = e.message;
      nextRequestAt = Date.now() + 12000;
      items.forEach(s => retryAt.set(s.key, nextRequestAt));
    } finally {
      items.forEach(s => pendingSet.delete(s.key));
      if (generation === epoch) busy = false;
    }
  }
  function updateConfig(next, forceReset = false) {
    const change = forceReset || !config || ["model", "target", "source", "enabled", "hasApiKey"].some(k => next[k] !== config[k]);
    if (config?.enabled && !next.enabled) restoreCC();
    config = next;
    if (change) reset();
    applyStyle();
    tick();
  }
  function tick() {
    const nextId = getId();
    if (id !== nextId) { restoreCC(); id = nextId; reset(); }
    const p = document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') || document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
    if (p && (p !== player || !host?.isConnected)) { restoreCC(); reset(); mount(p); }
    if (!p || !p.isConnected || !id) { render("", ""); mode = "请打开一个 YouTube 视频"; return; }
    video = p.querySelector("video");
    const isAd = p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting");
    if (isAd !== adActive) { adActive = isAd; lastNative = ""; nativeActive = ""; nativeCurrent = null; nativeSegments = []; nativeTime = null; }
    if (!config?.enabled || !config.hasApiKey || !video || adActive) { render("", ""); return; }
    const current = cues.length ? C.findCue(cues, video.currentTime) : null;
    if (!cues.length) { checkNativeSeek(); readNative(); }
    const segment = current || (!cues.length ? currentNativeSegment() : null);
    const original = current?.text || (!cues.length ? nativeActive : "");
    render(original, segment ? translations.get(segment.key) || "" : "");
    if (Date.now() - lastPump > 300) { lastPump = Date.now(); void pump(); }
    void loadTranscript();
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "SETTINGS_CHANGED") { updateConfig(message.settings, message.reset); respond({ ok: true }); }
    if (message?.type === "GET_STATUS") respond({ ok: true, enabled: config?.enabled, mode: !config?.enabled ? "双语字幕已关闭" : mode, error, cueCount: cues.length, translated: translations.size, busy, hasText: Boolean(cues.length || nativeActive), videoId: id });
    if (message?.type === "RETRY_CAPTIONS") { reset(); tick(); respond({ ok: true }); }
  });
  document.addEventListener("yt-navigate-finish", tick);
  window.addEventListener("resize", applyStyle);
  document.addEventListener("fullscreenchange", applyStyle);
  send({ type: "GET_SETTINGS" }).then(r => updateConfig(r.settings)).catch(e => { error = e.message; });
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); restoreCC(); player?.classList.remove("edgetube-rendering"); host?.remove(); observer?.disconnect(); resizer?.disconnect(); return; }
    tick();
  }, 120);
})();
