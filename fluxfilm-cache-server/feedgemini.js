/**
 * FluxFilm - optional Google Gemini adapter for the 🍿 feed ✨ AI fill (feedai.js). Same answer shape as Olivia's DeepSeek
 * adapter (oliviawords.callModel): { json, tokens, grounded } or null.
 *
 * - Key: admin → 🍿 What's new → ⚙️ Settings → "Gemini key" (Google AI Studio). Stored server-side in feed_settings,
 *   never sent to the admin page or the storefront. Model: GEMINI_MODEL env or gemini-2.5-flash.
 * - opts.search = true → Google Search grounding (for very new titles the movie database barely knows). Gemini can't
 *   combine search with JSON mode, so the JSON is then read out of the text answer.
 * - "Thinking" is switched off (cheaper, faster, and the whole token budget goes to the answer).
 * - opts.fetch replaces global fetch in tests. Nothing is logged except the HTTP status / timeout.
 */
const s = (v) => String(v == null ? '' : v).trim();
const MODEL = () => s(process.env.GEMINI_MODEL) || 'gemini-2.5-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** '```json {..} ```' / text with one JSON object inside → the object, else null. */
function parseJsonText(text) {
  const t = s(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

/** OpenAI-style messages ([system, user, assistant, user…]) → Gemini systemInstruction + contents. */
function toGemini(messages) {
  const sys = []; const contents = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !s(m.content)) continue;
    if (m.role === 'system') sys.push(s(m.content));
    else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] });
  }
  return { systemInstruction: sys.length ? { parts: [{ text: sys.join('\n\n') }] } : undefined, contents };
}

async function callGemini(messages, opts) {
  const o = opts || {};
  const key = s(o.key);
  if (!key) return null;
  const doFetch = o.fetch || fetch;
  const g = toGemini(messages);
  const body = {
    contents: g.contents,
    generationConfig: { temperature: o.temperature != null ? o.temperature : 0.8, maxOutputTokens: o.maxTokens || 600, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (g.systemInstruction) body.systemInstruction = g.systemInstruction;
  if (o.search) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 20000);
  try {
    const r = await doFetch(BASE + encodeURIComponent(o.model || MODEL()) + ':generateContent', {
      method: 'POST', signal: ctrl.signal,
      // Key in a header, never in the URL (URLs end up in logs).
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.log('[feed ai] Gemini HTTP', r.status); return null; }
    const j = await r.json();
    const cand = (j && j.candidates && j.candidates[0]) || {};
    const text = ((cand.content && cand.content.parts) || []).map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    const json = parseJsonText(text);
    if (!json || typeof json !== 'object') return null;
    const grounded = !!(cand.groundingMetadata && ((cand.groundingMetadata.groundingChunks || []).length || (cand.groundingMetadata.webSearchQueries || []).length));
    return { json, tokens: Number(j.usageMetadata && j.usageMetadata.totalTokenCount) || 0, grounded };
  } catch (e) {
    console.log('[feed ai] Gemini call failed:', e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 80));
    return null;
  } finally { clearTimeout(timer); }
}

module.exports = { callGemini, parseJsonText, toGemini, MODEL };
