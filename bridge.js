/* Runs in the page world. Only reads captions/player state; never sees API keys. */
(() => {
  "use strict";
  const C = DualSubCore;
  const REQUEST = "EDGETUBE_CAPTION_REQUEST_V1";
  const RESPONSE = "EDGETUBE_CAPTION_RESPONSE_V1";
  const captured = new Map();
  const nativeFetch = window.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const xhrUrls = new WeakMap();
  let fetching = false;
  function player() { return document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') || document.querySelector("#movie_player") || document.querySelector(".html5-video-player"); }
  function videoId() { return new URL(location.href).searchParams.get("v") || location.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] || ""; }
  function captionURL(value) { try { const u = new URL(value, location.href); return u.protocol === "https:" && ["www.youtube.com", "m.youtube.com"].includes(u.hostname) && u.pathname === "/api/timedtext" ? u : null; } catch { return null; } }
  function parse(text) {
    if (!text || text.length > 6000000) return [];
    try { return C.parseJson3(JSON.parse(text)); } catch { /* YouTube may return XML instead. */ }
    try {
      const doc = new DOMParser().parseFromString(text, "text/xml");
      if (doc.querySelector("parsererror")) return [];
      const rows = [...doc.querySelectorAll("text, p[t]")].map(e => {
        const factor = e.hasAttribute("t") ? 1000 : 1;
        const start = Number(e.getAttribute("t") ?? e.getAttribute("start")) / factor;
        const duration = Number(e.getAttribute("d") ?? e.getAttribute("dur") ?? 2.5 * factor) / factor;
        return { start, end: start + duration, text: e.textContent };
      });
      return C.normalizeCues(rows);
    } catch { return []; }
  }
  function remember(url, body) {
    const u = captionURL(url);
    if (!u || u.searchParams.has("tlang") || u.searchParams.get("v") !== videoId()) return;
    const cues = parse(body);
    if (!cues.length) return;
    const key = `${u.searchParams.get("v")}:${u.searchParams.get("lang")}:${u.searchParams.get("kind") || ""}`;
    captured.set(key, { videoId: u.searchParams.get("v"), languageCode: u.searchParams.get("lang"), kind: u.searchParams.get("kind") || "", cues });
    while (captured.size > 6) captured.delete(captured.keys().next().value);
  }
  // Observe only caption responses the player already requests. Preserve every original response.
  window.fetch = function (...args) {
    const promise = Reflect.apply(nativeFetch, this, args);
    const url = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
    if (captionURL(url)) promise.then(r => { if (r.ok) r.clone().text().then(body => remember(url, body)).catch(() => {}); }).catch(() => {});
    return promise;
  };
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    xhrUrls.set(this, String(url));
    return Reflect.apply(nativeOpen, this, [method, url, ...args]);
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (captionURL(xhrUrls.get(this))) this.addEventListener("load", () => {
      try {
        if (this.status === 200) remember(xhrUrls.get(this), this.responseType === "json" ? JSON.stringify(this.response) : this.responseText);
      } catch { /* Do not interfere with the player. */ }
    }, { once: true });
    return Reflect.apply(nativeSend, this, args);
  };
  function info() {
    const p = player();
    let response;
    try { response = p?.getPlayerResponse?.(); } catch { /* Not ready yet. */ }
    if (!response || response.videoDetails?.videoId !== videoId()) {
      response = window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId() ? window.ytInitialPlayerResponse : null;
    }
    let current;
    try { current = p?.getOption?.("captions", "track"); } catch { /* Captions module unloaded. */ }
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      videoId: videoId(), title: response?.videoDetails?.title || "", isLive: response?.videoDetails?.isLiveContent === true,
      tracks: tracks.slice(0, 100).map(t => ({ ...t, selected: Boolean(current?.vssId && current.vssId === t.vssId) })),
      nativeLanguage: current?.languageCode || ""
    };
  }
  async function getCaptions(source) {
    const state = info();
    if (!state.videoId) return { ...state, cues: [] };
    // Live caption timestamps are not reliably relative to HTMLMediaElement.currentTime.
    if (state.isLive) return { ...state, tracks: undefined, cues: [] };
    const track = C.selectTrack(state.tracks, source);
    const stored = [...captured.values()].find(t => t.videoId === state.videoId && (track ? t.languageCode === track.languageCode && t.kind === (track.kind || "") : source === "auto" || t.languageCode?.startsWith(source)));
    if (stored) return { ...state, tracks: undefined, languageCode: stored.languageCode, cues: stored.cues, captured: true };
    if (!track || fetching) return { ...state, tracks: undefined, cues: [] };
    const url = captionURL(track.baseUrl);
    if (!url || url.searchParams.get("v") !== state.videoId) return { ...state, tracks: undefined, cues: [] };
    fetching = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      url.searchParams.set("fmt", "json3");
      url.searchParams.delete("tlang");
      const response = await Reflect.apply(nativeFetch, window, [url.href, { credentials: "include", signal: abort.signal }]);
      const body = response.ok ? await response.text() : "";
      remember(url.href, body);
      return { ...state, tracks: undefined, languageCode: track.languageCode, cues: parse(body) };
    } catch { return { ...state, tracks: undefined, cues: [] }; }
    finally { clearTimeout(timeout); fetching = false; }
  }
  window.addEventListener("message", async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== REQUEST) return;
    const { id, type, source } = event.data;
    if (typeof id !== "string" || id.length > 80) return;
    let data;
    try {
      if (type === "CAPTIONS") data = await getCaptions(["auto", "en", "zh", "ja", "ko", "fr", "de", "es"].includes(source) ? source : "auto");
      else if (type === "INFO") { data = info(); data.tracks = data.tracks.map(({ baseUrl, ...track }) => track); }
      else return;
      window.postMessage({ channel: RESPONSE, id, data }, location.origin);
    } catch { window.postMessage({ channel: RESPONSE, id, data: { videoId: videoId(), cues: [] } }, location.origin); }
  });
})();
