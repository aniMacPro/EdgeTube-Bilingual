/* Shared pure logic; no browser or API credentials. */
(function (root) {
  "use strict";
  const DEFAULTS = Object.freeze({ enabled: false, apiKey: "", model: "deepseek-flash", target: "zh-CN", source: "auto", fontSize: 30, originalWeight: 500, translationWeight: 600, bottom: 6, opacity: 0.65, prefetch: 45, showOriginal: true });
  const LANGUAGES = Object.freeze({ "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" });
  const clean = value => String(value ?? "").replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
  function sanitize(value = {}) {
    return {
      enabled: value.enabled === true,
      apiKey: typeof value.apiKey === "string" ? value.apiKey.trim().slice(0, 512) : "",
      model: /^[a-zA-Z0-9._-]{1,80}$/.test(value.model) ? value.model : DEFAULTS.model,
      target: Object.hasOwn(LANGUAGES, value.target) ? value.target : DEFAULTS.target,
      source: ["auto", "en", "zh", "ja", "ko", "fr", "de", "es"].includes(value.source) ? value.source : "auto",
      fontSize: Math.round(clamp(value.fontSize, 16, 56, 30)),
      originalWeight: Math.round(clamp(value.originalWeight, 300, 900, 500) / 100) * 100,
      translationWeight: Math.round(clamp(value.translationWeight, 300, 900, 600) / 100) * 100,
      bottom: clamp(value.bottom, 2, 30, 6),
      opacity: clamp(value.opacity, 0, 1, 0.65),
      prefetch: clamp(value.prefetch, 15, 120, 45),
      showOriginal: value.showOriginal !== false
    };
  }
  function publicSettings(settings) { const { apiKey, ...rest } = settings; return { ...rest, hasApiKey: Boolean(apiKey) }; }
  function normalizeCues(cues) {
    return cues.map(c => ({ start: Number(c.start), end: Number(c.end), text: clean(c.text) }))
      .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.start >= 0 && c.text)
      .sort((a, b) => a.start - b.start).slice(0, 30000);
  }
  function parseJson3(data) {
    const cues = [];
    for (const e of data.events || []) {
      if (!Array.isArray(e.segs) || !Number.isFinite(e.tStartMs)) continue;
      const text = e.segs.map(s => s.utf8 || "").join("");
      if (e.aAppend && cues.length) {
        const last = cues[cues.length - 1];
        last.text += text;
        last.end = Math.max(last.end, (e.tStartMs + (e.dDurationMs || 1500)) / 1000);
      } else {
        cues.push({ start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs || 2500)) / 1000, text });
      }
    }
    // Rolling ASR windows can overlap. A new window supersedes its predecessor.
    const normalized = normalizeCues(cues);
    for (let i = 0; i < normalized.length - 1; i++) {
      if (normalized[i + 1].start > normalized[i].start) normalized[i].end = Math.min(normalized[i].end, normalized[i + 1].start);
    }
    return normalized;
  }
  function findCue(cues, time) {
    let lo = 0, hi = cues.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >>> 1; if (cues[mid].start <= time) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 && time < cues[found].end ? cues[found] : null;
  }
  function selectTrack(tracks, source) {
    const list = tracks.filter(t => t && typeof t.baseUrl === "string");
    return list.find(t => source !== "auto" && t.languageCode?.startsWith(source) && t.kind !== "asr")
      || list.find(t => source !== "auto" && t.languageCode?.startsWith(source))
      || list.find(t => source === "auto" && t.selected)
      || list.find(t => t.languageCode?.startsWith("en") && t.kind !== "asr")
      || list.find(t => t.languageCode?.startsWith("en")) || list.find(t => t.kind !== "asr") || list[0];
  }
  function decodeTranslations(payload, texts) {
    if (typeof payload !== "string") throw new Error("API 未返回翻译文本，请重试。");
    const parsed = JSON.parse(payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const items = parsed.translations;
    if (!Array.isArray(items) || items.length !== texts.length) throw new Error("翻译条目不完整，请重试。");
    const result = new Array(texts.length);
    for (const item of items) {
      if (!Number.isInteger(item.id) || item.id < 0 || item.id >= texts.length || result[item.id] !== undefined || typeof item.text !== "string" || !clean(item.text) || item.text.length > 6000) throw new Error("翻译结果格式不正确，请重试。");
      result[item.id] = clean(item.text);
    }
    if (result.some(t => !t) || result.filter(Boolean).length !== texts.length) throw new Error("翻译条目不完整，请重试。");
    return result;
  }
  function contextFor(segments, index, translations) {
    const reference = s => ({ key: s.key, text: clean(s.text).slice(0, 300), translation: clean(translations.get(s.key) || "").slice(0, 300) });
    return {
      before: segments.slice(Math.max(0, index - 3), index).map(reference),
      after: segments.slice(index + 1, index + 3).map(s => ({ key: s.key, text: clean(s.text).slice(0, 300) }))
    };
  }
  function translationPacket(value) {
    const fail = () => { throw new Error("字幕上下文格式错误，请刷新视频页面后重试。"); };
    const keyValid = key => typeof key === "string" && /^[a-zA-Z0-9:._-]{1,100}$/.test(key);
    if (!value || typeof value.videoId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.videoId) || typeof value.source !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.source) || !["timeline", "native"].includes(value.mode)) fail();
    if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 12) fail();
    const references = (refs, limit) => {
      if (!Array.isArray(refs) || refs.length > limit) fail();
      return refs.map(ref => {
        if (!ref || !keyValid(ref.key) || typeof ref.text !== "string" || !clean(ref.text) || ref.text.length > 300 || (ref.translation !== undefined && (typeof ref.translation !== "string" || ref.translation.length > 300))) fail();
        return { key: ref.key, text: clean(ref.text), translation: clean(ref.translation || "") };
      });
    };
    const items = value.items.map(item => {
      if (!item || !keyValid(item.key) || typeof item.text !== "string" || !clean(item.text) || item.text.length > 3000) fail();
      return { key: item.key, text: clean(item.text), before: references(item.before, 3), after: references(item.after, 2) };
    });
    if (new Set(items.map(s => s.key)).size !== items.length || items.reduce((n, s) => n + s.text.length, 0) > 10000) fail();
    return { videoId: value.videoId, source: value.source, mode: value.mode, items };
  }
  const api = { DEFAULTS, LANGUAGES, clean, clamp, sanitize, publicSettings, normalizeCues, parseJson3, findCue, selectTrack, decodeTranslations, contextFor, translationPacket };
  root.DualSubCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
