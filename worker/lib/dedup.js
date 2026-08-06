// Дедупликация новостей: одинаковые заголовки из разных источников сворачиваем
// в один кандидат, выбирая источник с наиболее полным текстом.

// Нормализация заголовка: регистр, пунктуация, суффиксы «— Издание», теги.
export function normalizeTitle(title) {
  let t = (title || "").toLowerCase();
  // срезаем хвост вида " — Издание", " / Издание", " | Издание"
  t = t.replace(/\s+[—–-]\s+[^\s]+(?:\s+[^\s]+){0,3}\s*$/, "");
  t = t.replace(/\s+[\/|]\s+[^\s]+(?:\s+[^\s]+){0,3}\s*$/, "");
  t = t.replace(/[^а-яёa-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return t;
}

export function tokenize(text) {
  const t = normalizeTitle(text);
  return t ? t.split(" ") : [];
}

// Jaccard-сходство двух строк по множеству токенов.
export function jaccard(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const DUP_THRESHOLD = 0.62;

// Сворачивает список кандидатов в кластеры одинаковых новостей.
// Возвращает массив групп: {items: [cand...], best: cand, cluster_id}.
export function clusterDuplicates(cands) {
  const groups = [];
  for (const c of cands) {
    const nt = normalizeTitle(c.title);
    let placed = false;
    for (const g of groups) {
      if (jaccard(g.norm, nt) >= DUP_THRESHOLD) {
        g.items.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ norm: nt, items: [c] });
  }
  return groups.map((g, i) => {
    // «лучший» источник — самый подробный (наибольший текст/описание).
    const best = g.items.reduce((a, b) =>
      (b.description || "").length > (a.description || "").length ? b : a
    );
    return { cluster_id: `c${i}`, items: g.items, best };
  });
}

// Собирает текст для LLM из кластера: основной текст + связанные ссылки, чтобы
// LLM суммаризировала несколько источников одной новости.
export function buildClusterText(cluster, excerpt) {
  const seen = new Set();
  const links = [];
  for (const it of cluster.items) {
    if (seen.has(it.link)) continue;
    seen.add(it.link);
    links.push(it.link);
  }
  const primary = excerpt || cluster.best.description || "";
  const extra = links
    .slice(1)
    .map((l) => `- ${l}`)
    .join("\n");
  let text = `${cluster.best.title}\n\n${primary}\n\nИсточник: ${links[0]}`;
  if (extra) text += `\n\nСвязанные источники этой же новости:\n${extra}`;
  return text;
}
