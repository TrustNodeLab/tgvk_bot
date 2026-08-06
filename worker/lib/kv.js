// Слой доступа к Cloudflare KV: state, очереди (candidates/stock), история,
// черновики, отслеживание диспатчей. Все значения — JSON.
// В тестах env.BOT_KV подменяется in-memory стабом с тем же интерфейсом.

import { MAX_SEEN_GUIDS, MAX_HISTORY, MAX_CANDIDATES_QUEUE } from "./limits.js";

async function kvGet(env, key, fallback = null) {
  try {
    const raw = await env.BOT_KV.get(key, "json");
    return raw === null || raw === undefined ? fallback : raw;
  } catch (e) {
    return fallback;
  }
}

async function kvSet(env, key, value) {
  try {
    await env.BOT_KV.put(key, JSON.stringify(value));
  } catch (e) {
    /* ignore: storage errors не должны ронять крон */
  }
}

async function kvDel(env, key) {
  try {
    await env.BOT_KV.delete(key);
  } catch (e) {
    /* ignore */
  }
}

// ---------- state ----------

export async function loadState(env) {
  const s = (await kvGet(env, "state", {})) || {};
  s.seen_guids = Array.isArray(s.seen_guids) ? s.seen_guids : [];
  if (!s.counters) s.counters = {};
  if (!s.meta) s.meta = {};
  if (!s.blacklist) s.blacklist = { sources: [], keywords: [], guids: [] };
  if (!s.extra_keywords) s.extra_keywords = [];
  if (!s.removed_keywords) s.removed_keywords = [];
  return s;
}

export async function saveState(env, state) {
  await kvSet(env, "state", state);
}

export async function rememberGuid(env, state, guid) {
  if (!guid || state.seen_guids.includes(guid)) return;
  state.seen_guids.push(guid);
  if (state.seen_guids.length > MAX_SEEN_GUIDS) {
    state.seen_guids = state.seen_guids.slice(-MAX_SEEN_GUIDS);
  }
  await saveState(env, state);
}

// ---------- candidates (очередь на подготовку) ----------

export async function getCandidates(env) {
  return (await kvGet(env, "candidates", [])) || [];
}

export async function setCandidates(env, list) {
  await kvSet(env, "candidates", list);
}

export async function addCandidate(env, cand) {
  const list = await getCandidates(env);
  if (list.some((c) => c.guid === cand.guid)) return;
  list.push(cand);
  if (list.length > MAX_CANDIDATES_QUEUE) list.splice(0, list.length - MAX_CANDIDATES_QUEUE);
  await setCandidates(env, list);
}

export async function takeCandidates(env, count) {
  const list = await getCandidates(env);
  const taken = list.splice(0, count);
  await setCandidates(env, list);
  return taken;
}

// ---------- stock (готовые пакеты на публикацию) ----------

export async function getStock(env) {
  return (await kvGet(env, "stock", [])) || [];
}

export async function setStock(env, list) {
  await kvSet(env, "stock", list);
}

export async function addStock(env, pkg) {
  const list = await getStock(env);
  if (list.some((p) => p.id === pkg.id)) return;
  list.push(pkg);
  list.sort((a, b) => (a.scheduled_for || 0) - (b.scheduled_for || 0));
  await setStock(env, list);
}

export async function removeStock(env, id) {
  const list = await getStock(env);
  const next = list.filter((p) => p.id !== id);
  await setStock(env, next);
  return next.length !== list.length;
}

// ---------- publish_log (история) ----------

export async function getLog(env) {
  return (await kvGet(env, "publish_log", [])) || [];
}

export async function addLog(env, entry) {
  const list = await getLog(env);
  list.unshift(entry);
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
  await kvSet(env, "publish_log", list);
}

// ---------- drafts ----------

export async function loadDraft(env, id) {
  return kvGet(env, `draft:${id}`, null);
}

export async function saveDraft(env, draft) {
  await kvSet(env, `draft:${draft.id}`, draft);
  const idx = (await kvGet(env, "draft_index", [])) || [];
  if (!idx.includes(draft.id)) {
    idx.push(draft.id);
    await kvSet(env, "draft_index", idx);
  }
}

export async function deleteDraft(env, id) {
  await kvDel(env, `draft:${id}`);
  const idx = (await kvGet(env, "draft_index", [])) || [];
  const next = idx.filter((x) => x !== id);
  await kvSet(env, "draft_index", next);
}

export async function listDrafts(env) {
  const idx = (await kvGet(env, "draft_index", [])) || [];
  const drafts = [];
  for (const id of idx) {
    const d = await loadDraft(env, id);
    if (d) drafts.push(d);
  }
  return drafts;
}

// ---------- dispatch tracking (для фолбэка при аутэдже GitHub) ----------

export async function markDispatch(env, guid, info) {
  await kvSet(env, `dispatch:${guid}`, info);
}

export async function getDispatch(env, guid) {
  return kvGet(env, `dispatch:${guid}`, null);
}

export async function clearDispatch(env, guid) {
  await kvDel(env, `dispatch:${guid}`);
}

export async function listDispatches(env) {
  // Полный листинг по префиксу — только для диагностики/тестов.
  const items = [];
  if (env.BOT_KV && typeof env.BOT_KV.list === "function") {
    try {
      const res = await env.BOT_KV.list({ prefix: "dispatch:" });
      for (const k of res.keys || []) {
        const v = await env.BOT_KV.get(k.name, "json");
        if (v) items.push({ guid: k.name.slice(9), ...v });
      }
    } catch (e) {
      /* ignore */
    }
  }
  return items;
}
