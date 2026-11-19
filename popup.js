"use strict";
const C = DualSubCore;
const $ = id => document.getElementById(id);
let loaded = false;
let saving = false;
let lastConfig = C.DEFAULTS;
const ask = async message => { const r = await chrome.runtime.sendMessage(message); if (!r?.ok) throw new Error(r?.error || "插件连接失败，请重新打开设置。"); return r; };
function notice(text, good = false) { $("notice").textContent = text; $("notice").className = good ? "success" : "error"; }
function values() { return C.sanitize({ enabled: $("enabled").checked, apiKey: $("api-key").value, target: $("target").value, source: $("source").value, model: $("model").value.trim(), fontSize: $("font-size").value, originalWeight: $("original-weight").value, translationWeight: $("translation-weight").value, bottom: $("bottom").value, opacity: Number($("opacity").value) / 100, prefetch: $("prefetch").value, showOriginal: $("show-original").checked }); }
function preview() {
  const v = values();
  $("font-size-value").textContent = v.fontSize;
  const weights = { 300: "细", 400: "正常", 500: "中等", 600: "半粗", 700: "粗", 800: "特粗", 900: "最粗" };
  $("original-weight-value").textContent = `${v.originalWeight} · ${weights[v.originalWeight]}`;
  $("translation-weight-value").textContent = `${v.translationWeight} · ${weights[v.translationWeight]}`;
  $("preview-original").style.fontWeight = String(v.originalWeight);
  $("preview-translation").style.fontWeight = String(v.translationWeight);
  $("bottom-value").textContent = `${v.bottom}%`;
  $("opacity-value").textContent = `${Math.round(v.opacity * 100)}%`;
  const p = $("preview-subtitles");
  p.style.fontSize = `${v.fontSize * (window.innerWidth >= 600 ? 0.63 : 0.43)}px`;
  p.style.bottom = `${v.bottom}%`;
  p.style.backgroundColor = `rgba(0,0,0,${v.opacity})`;
  $("preview-original").hidden = !v.showOriginal;
  const samples = { "zh-CN": "带着好奇心，去更远的地方。", "zh-TW": "帶著好奇心，去更遠的地方。", en: "Curiosity will take you further.", ja: "好奇心が、あなたを遠くへ連れていく。", ko: "호기심과 함께 더 멀리 나아가세요.", fr: "La curiosité vous emmène plus loin.", de: "Neugier bringt dich weiter.", es: "La curiosidad te lleva más lejos." };
  $("preview-translation").textContent = samples[v.target];
}
async function save() {
  if (!loaded || saving) return false;
  const next = values();
  if (next.enabled && !next.apiKey) { notice("请先填写 API Key，再开启双语字幕。"); $("enabled").checked = false; return false; }
  if (!$("settings-form").reportValidity()) return false;
  saving = true; $("save").disabled = true;
  try {
    await ask({ type: "SAVE_SETTINGS", settings: next });
    lastConfig = next;
    notice(next.enabled ? "已保存，YouTube 页面将自动应用设置。" : "已保存。开启双语字幕后开始翻译。", true);
    await refreshStatus(); return true;
  } catch (e) { notice(e.message); $("enabled").checked = lastConfig.enabled; return false; }
  finally { saving = false; $("save").disabled = false; }
}
async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
async function refreshStatus() {
  try {
    const tab = await activeTab();
    if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) {
      $("video-status").textContent = "打开 YouTube 视频后即可使用"; $("status-dot").className = "dot"; return;
    }
    const status = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
    $("video-status").textContent = status.error || `${status.mode}${status.translated ? ` · 已译 ${status.translated} 条` : ""}`;
    $("status-dot").className = `dot${status.error ? " error" : status.enabled ? " active" : ""}`;
  } catch { $("video-status").textContent = "请刷新 YouTube 页面以载入插件"; $("status-dot").className = "dot"; }
}
$("settings-form").addEventListener("submit", event => { event.preventDefault(); void save(); });
$("enabled").addEventListener("change", () => void save());
$("settings-form").addEventListener("input", preview);
$("show-key").addEventListener("click", () => { const show = $("api-key").type === "password"; $("api-key").type = show ? "text" : "password"; $("show-key").textContent = show ? "隐藏" : "显示"; });
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("test").addEventListener("click", async () => {
  if (!await save()) return;
  $("test").disabled = true; notice("正在测试翻译连接（会产生一次少量 API 用量）…", true);
  try { const r = await ask({ type: "TEST_API" }); notice(`连接成功：${r.sample}`, true); }
  catch (e) { notice(e.message); }
  finally { $("test").disabled = false; }
});
$("clear-cache").addEventListener("click", async () => {
  try { await ask({ type: "CLEAR_CACHE" }); notice("已清除本地持久缓存。当前视频的内存译文会保留到重新读取。", true); }
  catch (e) { notice(e.message); }
});
$("retry").addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("请先打开 YouTube 视频。");
    await chrome.tabs.sendMessage(tab.id, { type: "RETRY_CAPTIONS" }); await refreshStatus();
  } catch { notice("请切换到 YouTube 视频，刷新页面后重试。"); }
});
(async () => {
  try {
    await ask({ type: "GET_SETTINGS" });
    const v = C.sanitize((await chrome.storage.local.get("settings")).settings || C.DEFAULTS);
    lastConfig = v;
    for (const [name, key] of [["api-key", "apiKey"], ["target", "target"], ["source", "source"], ["model", "model"], ["font-size", "fontSize"], ["original-weight", "originalWeight"], ["translation-weight", "translationWeight"], ["bottom", "bottom"], ["prefetch", "prefetch"]]) $(name).value = v[key];
    $("opacity").value = Math.round(v.opacity * 100); $("show-original").checked = v.showOriginal; $("enabled").checked = v.enabled;
    loaded = true; preview(); await refreshStatus();
  } catch (e) { notice(e.message); }
})();
window.addEventListener("resize", preview);
setInterval(() => void refreshStatus(), 2000);
