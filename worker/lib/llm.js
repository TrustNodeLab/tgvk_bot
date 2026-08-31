// Генерация текста поста прямо в Worker: без GitHub.
// Провайдеры выбираются ротацией по времени суток ЕКБ:
//   утро (06-12) — GigaChat, день (12-17) — совместный пост (оба LLM),
//   вечер (17-22) — Gemini, ночь (22-06) — любой доступный.
// Если LLM_PROXY_URL не задан — детерминированный генератор по правилам.
// Возвращает { headline, headline_lines, caption, cards, tier, source }.

import { ekbNow } from "./config.js";
import { markdownToHtml, stripMarkdown, fitCaption } from "./text.js";
import { analyzePost, buildCards, buildAdvice, sanitizeLink, punchFact, stripCliche, clichePenalty } from "./nlp.js";
import { detectScheme, pickByHash } from "./schemes.js";

const RUSTORE = "https://www.rustore.ru/catalog/app/com.frauddetector.app";
const SITE = "https://trustnodelab.github.io";

// Жанры поста — ротация «как в живой редакции», чтобы соседние посты не
// выглядели одинаково (шаблон-«бот» = убийца охватов). Жанр выбирается
// детерминированно от guid/текста: стабилен для той же новости, но разный
// между соседними постами. Инструкция дописывается в системный промпт LLM.
const POST_STYLES = [
  {
    id: "razbor",
    name: "Разбор схемы",
    instruction:
      "Формат поста — «Разбор схемы»: сначала коротко о чём новость, затем " +
      "по шагам — как именно работает схема обмана (что говорит мошенник, как " +
      "давит на страхи, где точка отказа), и в конце — конкретная защита. " +
      "Пиши как аналитик безопасности, объясняющий механику, а не как новостная лента.",
  },
  {
    id: "warning",
    name: "Предупреждение",
    instruction:
      "Формат поста — «Предупреждение»: поставь читателя в ситуацию («вы " +
      "можете столкнуться с этим сегодня»), объясни риск человеческим языком, " +
      "дай 2—3 действия, которые прямо сейчас снижают угрозу. Тон — заботливый, " +
      "без паники и кликбейта.",
  },
  {
    id: "fact",
    name: "Факт-карточка",
    instruction:
      "Формат поста — «Факт-карточка»: сухо и по делу. Собери главные факты " +
      "новости короткими абзацами, цифры — точно из источника, вывод — одним " +
      "предложением. Без лишних слов и общих советов; стиль — информационный.",
  },
  {
    id: "myth",
    name: "Разбор заблуждения",
    instruction:
      "Формат поста — «Разбор заблуждения»: найди распространённый миф или " +
      "наивную ошибку, связанную с новостью («я думал, меня это не касается»), " +
      "разбери, почему она работает на людях, и покажи, как правильно поступать. " +
      "Пиши спокойно, с примерами «хорошо/плохо».",
  },
  {
    id: "case",
    name: "Кейс-история",
    instruction:
      "Формат поста — «Кейс-история»: перескажи ситуацию из новости как " +
      "историю конкретного человека ( кто, где, что случилось, что потерял ), " +
      "выдели момент, где его можно было остановить, и сделай вывод-совет. " +
      "Рассказывай живо и по-человечески, без канцелярита.",
  },
];

function pickPostStyle(meta = {}, weights = null) {
  const seed = String(meta.guid || meta.link || meta.title || meta.text || "").trim();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  // Ротация с учётом вовлечённости: если есть веса (из статов аудитории), сдвигаем
  // выбор в сторону жанров с лучшей статистикой. h остаётся детерминированным
  // от поста, веса лишь переставляют порядок кандидатов.
  if (weights && Object.keys(weights).length) {
    const ranked = [...POST_STYLES].sort(
      (a, b) => (weights[b.id] || 0) - (weights[a.id] || 0)
    );
    return ranked[h % ranked.length];
  }
  return POST_STYLES[h % POST_STYLES.length];
}

export const FOOTER_HTML =
  `🛡️ <b>TrustNode</b>\n` +
  `📱 Приложение: <a href="${RUSTORE}">RuStore</a>\n` +
  `🌐 Сайт: <a href="${SITE}">trustnodelab.github.io</a>`;

// ---------- санитайзинг HTML (оставляем только свои теги) ----------

export function sanitizeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- утилиты ----------

// Финальный caption: markdown -> HTML, лимит TG 1024, футер всегда целиком.
function finalizeCaption(body) {
  const b = markdownToHtml(String(body || "")).trim();
  if (!b) return FOOTER_HTML;
  const budget = 1024 - FOOTER_HTML.length - 2;
  const bodyFit = b.length <= budget ? b : truncateAt(b, budget);
  return bodyFit + "\n\n" + FOOTER_HTML;
}

function truncateAt(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "") + "…";
}

function stripLink(s) {
  return s.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

// Срезает хвосты «— Источник: https://…» / «Источник: URL», которые LLM иногда
// копирует из сырого текста новости в bullets. Сама ссылка добавляется отдельно.
export function stripSourceTail(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/\s*[—–-]\s*источник\s*:\s*(?:https?:\/\/)?\S+\s*$/i, "")
    // хвост «Источник: …» с чем угодно после двоеточия (URL, CDATA-обломки,
    // «ссылка») — ссылка на источник добавляется отдельно, хвост всегда мусор
    .replace(/\s*[—–-]\s*источник\s*:.*$/i, "")
    .replace(/\s*источник\s*:\s*(?:https?:\/\/)?\S+\s*$/i, "")
    .replace(/\s*источник\s*:.*$/i, "")
    .trim();
}

// ---------- генератор по правилам ----------

// «Редакционная» обвязка по жанрам: хук-зачин и авторское мнение-вывод.
const STYLE_EDIT = {
  razbor: {
    hook: "Разбираем, как работает схема — по шагам.",
    section: "Как это работает",
    opinion: [
      "Схема старая, но работает: мошенники ставят на страх и спешку.",
      "Меняется только легенда — механика всегда одна.",
      "Разбор этой схемы стоит сохранить и переслать родным.",
    ],
  },
  warning: {
    hook: "С этим можно столкнуться уже сегодня.",
    section: "На что обратить внимание",
    opinion: [
      "Это не «где-то там» — с таким звонком может столкнуться любой.",
      "Одна ошибка — и деньги уходят за минуты. Будьте на шаг впереди.",
    ],
  },
  fact: {
    hook: "Коротко о главном.",
    section: "Суть",
    opinion: [
      "Цифры говорят сами за себя.",
      "За сухими цифрами — реальные люди и их деньги.",
    ],
  },
  myth: {
    hook: "Что на самом деле происходит — и где подвох.",
    section: "Где подвох",
    opinion: [
      "«Это не про меня» — самая опасная мысль. Как раз про вас.",
      "Мошенники рассчитывают на уверенность «я бы не повёлся».",
    ],
  },
  case: {
    hook: "Случай из новости — как это выглядело на деле.",
    section: "Как это было",
    opinion: [
      "История типовая — и именно поэтому поучительная.",
      "Итог можно было бы изменить одной проверкой.",
    ],
  },
};

// Подставляет {subject}/{stat} в шаблон, срезает пустые плейсхолдеры.
function fillTemplate(tpl, subject, stat) {  let s = String(tpl || "").replace(/\{subject\}/gi, cap(subject || "мошенники"));
  s = s.replace(/\{stat\}/gi, stat || "").replace(/\s+/g, " ").trim();
  s = s.replace(/:\s*$/, "").replace(/[.,;:]+$/, "");
  return s;
}

function cap(s) {
  const t = String(s || "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// Скор заголовка: выбираем лучший из готовых вариантов по редакционным правилам
// (цифра впереди, вопрос к читателю, «касается вас», компактность). Это заменяет
// старый «первый подходящий» — соседние посты перестают открываться одинаково.
function headlineScore(h) {
  const t = String(h || "").trim();
  if (t.length < 10 || t.length > 90) return -Infinity;
  let s = 0;
  // цифра в первых символах — конкретика и интрига
  if (/^\d/.test(t)) s += 3;
  else if (/\d/.test(t)) s += 1;
  // вопрос — прямая вовлечённость читателя
  if (/\?\s*$/.test(t)) s += 2;
  // «касается вас»: вы/вас/ваш — персональная привязка
  if (/\b(вас|вы|ваш|ваши|ваша|ваше)\b/i.test(t)) s += 2;
  // компактность: 25-60 символов — золотая середина
  if (t.length >= 25 && t.length <= 60) s += 1;
  // кавычки вокруг схемы («безопасный счёт») — живая подача
  if (/(«[^»]{2,30}»)/.test(t)) s += 1;
  // клише-открывалки штрафуем: «важно/срочно/эксперты сообщили» — признак
  // шаблонного «бота», вариант с клише должен проигрывать живому.
  s -= clichePenalty(t) * 4;
  return s;
}

// Заголовок: явный title > первая строка > лучший из вариантов схемы > шаблон
// темы > лид. Среди шаблонов схемы выбираем вариант с максимальным скором, а не
// первый подходящий — чтобы соседние посты не открывались одинаковой фразой.
function ruleHeadline(analysis, scheme, meta) {
  const explicit = stripCliche(analysis.headline);
  const title = String(meta.title || "").replace(/https?:\/\/\S+/gi, "").trim();
  const firstLine = analysis.firstLine;
  const hasExplicit =
    !!title || (firstLine && firstLine.length >= 10 && firstLine.length <= 110 &&
      !/^(москва|риа|tass|интерфакс)/i.test(firstLine));
  if (hasExplicit) return explicit;

  const subject = analysis.subject || "мошенники";
  const stat = analysis.stats && analysis.stats[0] ? analysis.stats[0].value : "";
  const best = (list) => {
    let bestH = null;
    let bestS = -Infinity;
    for (const tpl of list || []) {
      const h = fillTemplate(tpl, subject, stat);
      const s = headlineScore(h);
      if (s > bestS) {
        bestS = s;
        bestH = h;
      }
    }
    return bestH;
  };
  if (scheme && scheme.headline && scheme.headline.length) {
    const h = best(scheme.headline);
    if (h) return h;
  }
  if (analysis.topic && analysis.topic.template) {
    const h = stripCliche(fillTemplate(analysis.topic.template, subject, stat));
    if (h.length >= 10) return h;
  }
  return explicit;
}

// Лид: шаблон схемы (живая подача) > срезанное первое предложение > ничего.
function ruleLead(analysis, scheme) {
  const subject = analysis.subject || "мошенники";
  const stat = analysis.stats && analysis.stats[0] ? analysis.stats[0].value : "";
  if (scheme && scheme.lead && scheme.lead.length) {
    const tpl = pickByHash(scheme.lead, analysis.headline || "", "lead");
    if (tpl) return fillTemplate(tpl, subject, stat);
  }
  if (analysis.lead && analysis.lead.length >= 15) return stripCliche(analysis.lead);
  return "";
}

// Факты: пунш-обработка, максимум 4, без дублей заголовка и лида.
function ruleFacts(analysis) {
  const headNorm = String(analysis.headline || "").toLowerCase().replace(/[.,!?…]+$/g, "").trim();
  const leadNorm = String(analysis.lead || "").toLowerCase().slice(0, 40);
  const seen = new Set();
  const out = [];
  for (const f of analysis.facts || []) {
    const pf = punchFact(f, 135);
    if (!pf) continue;
    const k = pf.toLowerCase().slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    if (pf.toLowerCase().startsWith(headNorm.slice(0, 30))) continue;
    // факт не должен пересказывать лид — иначе в посте одна мысль дважды
    if (leadNorm && pf.toLowerCase().startsWith(leadNorm.slice(0, 30))) continue;
    out.push(pf);
    if (out.length >= 4) break;
  }
  return out;
}

// Советы: схема > тема > дефолт, без дублей, максимум 3.
function ruleAdvice(analysis, scheme) {
  const seen = new Set();
  const out = [];
  const add = (t) => {
    const s = String(t || "").trim();
    if (!s || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    out.push(s.slice(0, 120));
  };
  if (scheme && scheme.advice) for (const t of scheme.advice) add(t);
  if (analysis.topic && analysis.topic.tips) for (const t of analysis.topic.tips) add(t);
  add("При малейшем сомнении перезвоните сами — по официальному номеру с карты или сайта");
  add("Расскажите о схеме близким: мошенники давят на доверие и страх");
  return out.slice(0, 3);
}

// Строка-мост «касается вас»: когда ни текст, ни лид, ни советы не содержат
// персонального обращения, добавляем короткую фразу, которая переводит новость
// из «где-то там» в «это может быть про вас». Без неё (кириллица не найдена)
// не добавляем — чтобы не вставлять пустую обвязку в уже живой текст.
function relevanceBridge(analysis, scheme, styleId) {
  const haystack = [
    analysis.lead,
    (scheme && scheme.advice) || [],
    (analysis.topic && analysis.topic.tips) || [],
  ].flat().join(" ").toLowerCase();
  if (/\b(вас|вы|ваш|ваши|ваша|ваше|сво[а-яёей]?|у\s+меня)\b/.test(haystack)) return "";
  const perStyle = {
    warning: "Это не «где-то там» — с такой схемой можно столкнуться уже сегодня.",
    myth: "«Я бы не повёлся» — именно на эту уверенность и рассчитывают мошенники.",
    case: "Такая история может произойти с кем угодно — в том числе с близкими.",
    razbor: "Знать эту схему стоит каждому: деньги теряют не «кто-то», а ваши знакомые.",
    fact: "За этими цифрами — реальные люди, которые уже потеряли деньги.",
  };
  return perStyle[styleId] || perStyle.warning;
}

export function generateByRules(text, meta = {}) {
  const src = String(meta.text || text || "");
  const analysis = analyzePost(src, meta);
  const scheme = detectScheme(src) || null;
  const style = pickPostStyle(meta);
  const edit = STYLE_EDIT[style.id] || STYLE_EDIT.fact;
  const subject = analysis.subject || "мошенники";

  const headline = ruleHeadline(analysis, scheme, meta);
  const lead = ruleLead(analysis, scheme);
  const facts = ruleFacts(analysis);
  const cards = buildCards(analysis, meta, scheme);

  const hint = scheme ? scheme.hint : (analysis.topic ? analysis.topic.hint : "Суть");

  const captionLines = [];
  captionLines.push(`${sanitizeHtml(edit.hook)}\n`);
  captionLines.push(`<b>${sanitizeHtml(headline)}</b>`);
  if (lead) captionLines.push(`\n${sanitizeHtml(lead)}`);

  // Мост «касается вас»: если подача пока безличная, добавляем персональную
  // привязку («это может быть про вас»), чтобы новость цепляла лично.
  const bridge = relevanceBridge(analysis, scheme, style.id);
  if (bridge) captionLines.push(`\n${sanitizeHtml(bridge)}`);

  // Шаги схемы — для разбора/предупреждения, если схема распознана и есть шаги.
  const steps = scheme && scheme.steps && scheme.steps.length ? scheme.steps.slice(0, 3) : [];
  if (steps.length && (style.id === "razbor" || style.id === "warning" || style.id === "myth")) {
    captionLines.push("");
    captionLines.push(`🔍 ${hint}`);
    for (let i = 0; i < steps.length; i++) {
      captionLines.push(`${i + 1}. ${sanitizeHtml(steps[i])}`);
    }
  } else if (facts.length) {
    captionLines.push("");
    captionLines.push(`🔍 ${hint}`);
    for (const f of facts) captionLines.push("• " + sanitizeHtml(f));
  }

  // Сигналы распознавания — предупреждение/разбор.
  const signals = scheme && scheme.signals && scheme.signals.length ? scheme.signals.slice(0, 3) : [];
  if (signals.length && (style.id === "warning" || style.id === "razbor")) {
    captionLines.push("");
    captionLines.push("🚩 Как распознать");
    for (const s of signals) captionLines.push("• " + sanitizeHtml(s));
  }

  // Механика «почему это работает» — для разбора/предупреждения/мифа: объясняем
  // психологический рычаг, а не только перечисляем шаги.
  const why = scheme && scheme.why && scheme.why.length ? scheme.why.slice(0, 2) : [];
  let whyUsed = false;
  if (why.length && (style.id === "razbor" || style.id === "warning" || style.id === "myth")) {
    whyUsed = true;
    captionLines.push("");
    captionLines.push("🧠 Почему это работает");
    for (const w of why) captionLines.push("• " + sanitizeHtml(w));
  }

  const advice = ruleAdvice(analysis, scheme);
  if (advice.length) {
    captionLines.push("");
    captionLines.push("🛡️ Что делать");
    for (const a of advice) captionLines.push("• " + sanitizeHtml(a));
  }

  // Авторское мнение-вывод: живое от LLM (meta.opinion) > жанровое/схемное.
  const opinion =
    (meta.opinion && String(meta.opinion).trim().slice(0, 220)) ||
    pickByHash(scheme && scheme.opinion && scheme.opinion.length ? scheme.opinion : edit.opinion, src, "opinion");
  if (opinion) captionLines.push(`\n${sanitizeHtml(opinion)}`);

  if (meta.link) captionLines.push("", `Источник: <a href="${sanitizeLink(meta.link)}">ссылка</a>`);
  captionLines.push("", FOOTER_HTML);

  // Бюджет caption (1024). Если всё вместе не влезает, жертвуем по возрастанию
  // ценности: сначала шаблонное мнение студии, затем блок «почему», затем мост —
  // источник, советы и футер режутся fitCaption в последнюю очередь.
  let joined = captionLines.join("\n");
  if (joined.length > 1024) {
    // 1) Мнение студии — оно шаблонное и дублируется в opinion-промпте.
    if (opinion) {
      const idx = joined.indexOf(`\n${sanitizeHtml(opinion)}`);
      if (idx >= 0) {
        joined = joined.slice(0, idx) + joined.slice(idx + 1 + sanitizeHtml(opinion).length);
      }
    }
    // 2) Блок «почему» целиком (заголовок + буллеты).
    if (joined.length > 1024 && whyUsed) {
      const head = joined.indexOf("\n\n🧠 Почему это работает");
      if (head >= 0) {
        const tail = joined.indexOf("\n\n", head + 3);
        joined = joined.slice(0, head) + (tail >= 0 ? joined.slice(tail) : "");
        whyUsed = false;
      }
    }
    // 3) Мост «касается вас».
    if (joined.length > 1024 && bridge) {
      const bridgeIdx = joined.indexOf(`\n\n${sanitizeHtml(bridge)}`);
      if (bridgeIdx >= 0) {
        joined = joined.slice(0, bridgeIdx) + joined.slice(bridgeIdx + 3 + sanitizeHtml(bridge).length);
      }
    }
  }
  const caption = fitCaption(joined, 1024);

  return {
    headline,
    headline_lines: [headline],
    caption,
    cards,
    tier: analysis.tier,
    source: meta.source || "",
    scheme_id: scheme ? scheme.id : null,
    style_id: style.id,
    topic_id: analysis.topic ? analysis.topic.id : null,
  };
}

// ---------- «мнение студии» ----------

// «Мнение студии»: короткий авторский вывод (1-2 предложения) поверх
// правилового поста. Правила дают структуру (заголовок, шаги, советы), а живое
// мнение делает пост «человеческим». Без LLM остаётся шаблонное мнение схемы.
const OPINION_SYSTEM =
  "Ты — редактор канала TrustNode о кибербезопасности. По тексту новости напиши " +
  "авторское мнение-вывод к посту: 1-2 предложения, живой комментарий редакции " +
  "(что здесь не так, почему это касается читателя, что стоит запомнить). " +
  "Это НЕ пересказ фактов и НЕ совет по защите — это позиция и эмоция редакции. " +
  "Тон: как человек рассказывает знакомому, ирония и предостережение уместны, " +
  "канцелярит и слова «важно/актуально» запрещены. Верни ТОЛЬКО текст мнения, " +
  "без кавычек, пояснений, markdown и слова «мнение редакции».";

// Прямой вызов OpenAI-совместимого API (Gemini и т.п.) за одним мнением.
async function callOpinionLlm(env, text) {
  const base = (env.LLM_API_BASE || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: OPINION_SYSTEM },
        { role: "user", content: String(text).slice(0, 3000) },
      ],
      temperature: 0.85,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`LLM opinion ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const content = String(data.choices?.[0]?.message?.content || "").trim();
  if (content.length < 20) throw new Error("LLM opinion: пустой ответ");
  return content.slice(0, 220);
}

// «Мнение студии» через Render-прокси (GigaChat из Worker нельзя — CA Сбера).
async function callProxyOpinion(env, text) {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL не задан");
  const res = await fetch(`${base}/opinion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(text).slice(0, 3000), provider: "gigachat" }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM proxy /opinion ${res.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  if (data && data.error) throw new Error(`LLM /opinion: ${data.error}`);
  const opinion = String(data.opinion || "").trim();
  if (opinion.length < 20) throw new Error("LLM /opinion: пустой ответ");
  return opinion.slice(0, 220);
}

// Правиловый пост + живое «мнение студии»: meta.opinion подхватывается в
// generateByRules. При недоступности LLM — обычные правила без мнения.
export async function generateRulesWithOpinion(text, env, meta = {}) {
  const src = String(meta.text || text || "");
  let opinion = "";
  if ((env.LLM_PROXY_URL || "").trim()) {
    try {
      opinion = await callProxyOpinion(env, src);
    } catch (e) {
      console.log("[llm] мнение студии (proxy) недоступно:", e.message);
    }
  }
  if (!opinion && env.LLM_API_BASE && env.LLM_API_KEY) {
    try {
      opinion = await callOpinionLlm(env, src);
    } catch (e) {
      console.log("[llm] мнение студии недоступно:", e.message);
    }
  }
  if (!opinion && env.AI && typeof env.AI.run === "function") {
    try {
      opinion = await callWorkersAiOpinion(env, src);
    } catch (e) {
      console.log("[llm] мнение студии (Workers AI) недоступно:", e.message);
    }
  }
  return generateByRules(text, { ...meta, opinion });
}

// ---------- Workers AI (резервный LLM) ----------

// Workers AI: биндинг env.AI, модели хостятся на GPU Cloudflare. Это резервный
// провайдер «на всякий» — когда LLM_PROXY_URL и LLM_API_BASE недоступны (оба
// внешних контура лежат), посты всё равно пишет своя моделька прямо из Worker,
// без ключей и прокси. Free-tier лимит — 10k нейронов/день.
const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Полный пост через Workers AI. Использует тот же LLM_SYSTEM (JSON-контракт),
// результат валидируется validateLlm, как у остальных провайдеров.
async function callWorkersAiLlm(env, text, style = null, prevPost = null, winContext = "") {
  const system = style ? `${LLM_SYSTEM}\n\n${style.instruction}` : LLM_SYSTEM;
  let user = prevPost
    ? `${String(text).slice(0, 6000)}\n\nКонтекст: предыдущий пост канала использовал сетку карточек ${prevPost.layout || "—"}. Сделай другую сетку и другие типы карточек, чтобы посты не выглядели одинаково.`
    : String(text).slice(0, 6000);
  if (winContext) user += `\n\n${winContext}`;
  const res = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.75,
  });
  const content = String(res && (res.response || res.text || "") || "");
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Workers AI вернул не JSON");
  return JSON.parse(m[0]);
}

// «Мнение студии» через Workers AI: короткий авторский вывод по тексту новости.
async function callWorkersAiOpinion(env, text) {
  const res = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [
      { role: "system", content: OPINION_SYSTEM },
      { role: "user", content: String(text).slice(0, 3000) },
    ],
    temperature: 0.85,
    max_tokens: 120,
  });
  const content = String(res && (res.response || res.text || "") || "").trim();
  if (content.length < 20) throw new Error("Workers AI opinion: пустой ответ");
  return content.slice(0, 220);
}

// Дайджест через Workers AI: резервный живой разбор, когда и прокси, и прямые
// ключи недоступны. Тот же JSON-контракт {headline, bullets, advice}, что и у
// callProxyDigest, — сборка текста в generateDigestText переиспользуется.
async function callWorkersAiDigest(env, items) {
  const list = (items || []).slice(0, 4)
    .map(
      (it, i) =>
        `${i + 1}. ${String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 200)}\n` +
        `${String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 800)}\n` +
        `Ссылка: ${it.link || ""}`
    )
    .join("\n\n");
  const prompt =
    "Ты — автор канала TrustNode о кибербезопасности. По списку новостей собери живой разбор:\n" +
    "верни ТОЛЬКО валидный JSON без пояснений:\n" +
    '{"headline":"короткий заголовок выпуска (1 фраза с интригой или позицией)", "bullets":["ровно по 1 булету на каждую новость (до ~320 символов): суть факта + мнение автора"], "advice":["не более 2 советов, каждый до ~50 символов"]}.\n' +
    "Мнение — это НЕ слово «важно» и НЕ пересказ заголовка. Факты бери только из текста новостей; не вставляй URL. Булетов РОВНО столько же, сколько новостей.\n\n" +
    list;
  const res = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [
      { role: "system", content: "Ты редактор телеграм-канала о кибербезопасности. Отвечай только JSON." },
      { role: "user", content: prompt },
    ],
    temperature: 0.75,
    max_tokens: 2048,
  });
  const content = String(res && (res.response || res.text || "") || "");
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Workers AI digest: не JSON");
  const data = JSON.parse(m[0]);
  const bullets = Array.isArray(data.bullets)
    ? data.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, (items || []).length)
    : [];
  const advice = Array.isArray(data.advice)
    ? data.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 2)
    : [];
  if (bullets.length !== (items || []).length) {
    throw new Error(`Workers AI digest: булетов ${bullets.length} из ${(items || []).length} новостей`);
  }
  return { headline: String(data.headline || "").trim() || undefined, bullets, advice };
}

// ---------- дайджест (сводка нескольких новостей одним постом) ----------

const DIGEST_EMOJI = { morning: "🌅", day: "☀️", evening: "🌆", midday: "🌤", pre_evening: "🌇" };

// Якорь свежести новости для сортировки внутри сводки (свежайшие первыми).
function itemFreshMs(c) {
  for (const f of ["pub_ts", "found_at", "created_at"]) {
    const v = c[f];
    if (v === null || v === undefined || v === "") continue;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function domainOf(link) {
  try {
    return String(new URL(link).hostname).replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function humanDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}` : iso || "";
}

// Правила-фолбэк: по каждой новости — заголовок + факт + ссылка, в конце —
// общий блок защиты (советы по темам, без дублей), до 3 советов.
export function digestByRules(items, meta = {}) {
  const label = String(meta.label || "");
  const head =
    `Дайджест TrustNode · ${label}` + (meta.date ? ` — ${humanDate(meta.date)}` : "");
  const bulletTexts = [];
  const advice = [];
  const seenTips = new Set();
  for (const it of items) {
    let a = null;
    try {
      a = analyzePost(it.text || it.title || "", { title: it.title || "" });
    } catch (e) { /* пустой текст */ }
    const title =
      (a && a.headline) ||
      String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 90) ||
      "Новость";
    const fact = a && a.facts && a.facts[0] ? a.facts[0].slice(0, 140) : null;
    let text = sanitizeHtml(title);
    if (fact) text += ` — ${sanitizeHtml(fact)}`;
    bulletTexts.push({ text, link: it.link || "" });
    if (a && a.topic) {
      for (const t of buildAdvice(a.topic)) {
        if (advice.length >= 2) break;
        const key = String(t).toLowerCase();
        if (seenTips.has(key)) continue;
        seenTips.add(key);
        advice.push(sanitizeHtml(t));
      }
    }
  }
  return { headline: head, bulletTexts, advice };
}

// Попытка живого дайджеста от LLM (прямой API): headline + bullets (по одной
// на новость: что произошло и почему касается читателя) + советы.
async function callLlmDigest(env, items) {
  const base = String(env.LLM_API_BASE || "").replace(/\/+$/, "");
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const list = items
    .map(
      (it, i) =>
        `${i + 1}. ${String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 200)}\n` +
        `${String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 800)}\n` +
        `Ссылка: ${it.link || ""}`
    )
    .join("\n\n");
  const prompt =
    "Ты — автор канала TrustNode о кибербезопасности. По списку новостей собери живой разбор:\n" +
    "верни ТОЛЬКО валидный JSON без пояснений:\n" +
    '{"headline":"короткий заголовок выпуска (1 фраза с интригой или позицией)", "bullets":["ровно по 1 булету на каждую новость (до ~320 символов): суть факта + развёрнутое мнение автора"], "advice":["не более 2 советов, каждый до ~50 символов"]}.\n' +
    "Мнение — это НЕ слово «важно» и НЕ пересказ заголовка. Это как человек рассказывает знакомому: эмоция, ирония, сарказм, предостережение, взгляд «что здесь не так», «что это значит для нас» и что стоит сделать.\n" +
    "Примеры эталонов:\n" +
    "— новость «Выявлена схема мошенничества при покупке машин за рубежом» → «Продавцы авто за границей берут задаток и испаряются. Как же знакомо: хочешь выгодно — рискуешь остаться и без машины, и без денег. Совет один: никаких переводов до осмотра и проверки документов.»\n" +
    "— новость «Мошенники наживаются на поиске удалённой работы» → «Работа мечты из дома? Только сначала оплати доступ к вакансии. Спойлер: это ловушка. Настоящие работодатели не берут денег за трудоустройство — если просят предоплату, бросайте это дело и ищите дальше.»\n" +
    "Булетов должно быть РОВНО столько же, сколько новостей в списке. Факты бери только из текста новостей; не вставляй URL и слово «источник» в булет. Весь выпуск должен поместиться в 1024 символа.\n\n" +
    list;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Ты редактор телеграм-канала о кибербезопасности. Отвечай только JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.75,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`LLM digest ${res.status}`);
  const m = String(await res.text()).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM digest: не JSON");
  const data = JSON.parse(m[0]);
  const bullets = Array.isArray(data.bullets)
    ? data.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, items.length)
    : [];
  const advice = Array.isArray(data.advice)
    ? data.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 2)
    : [];
  if (bullets.length !== items.length) {
    throw new Error(`LLM digest: булетов ${bullets.length} из ${items.length} новостей`);
  }
  if (!bullets.length) throw new Error("LLM digest: пустые bullets");
  return { headline: String(data.headline || "").trim() || undefined, bullets, advice };
}

// Дайджест через Render-прокси (/digest): GigaChat/Gemini со стороны Python.
// Первый запрос к спящему free-tier инстансу может упасть на cold start
// (timeout/5xx) — повторяем один раз, обычно хватает разбудить.
async function callProxyDigest(env, items) {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL не задан");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await proxyDigestOnce(base, items);
    } catch (e) {
      if (attempt === 0) {
        console.log(`[llm] /digest попытка ${attempt + 1} не удалась, повторяю:`, e.message);
        continue;
      }
      throw e;
    }
  }
  throw new Error("LLM /digest: не удалось");
}

async function proxyDigestOnce(base, items) {
  const slimItems = (items || []).slice(0, 4).map((it) => ({
    title: String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 200),
    text: String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 900),
    link: it.link || "",
  }));
  const res = await fetch(`${base}/digest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: slimItems, provider: "gigachat" }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM proxy /digest ${res.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  if (data && data.error) throw new Error(`LLM /digest: ${data.error}`);
  const bullets = Array.isArray(data.bullets)
    ? data.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, slimItems.length)
    : [];
  const advice = Array.isArray(data.advice)
    ? data.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 2)
    : [];
  if (bullets.length !== slimItems.length) {
    throw new Error(`LLM /digest: булетов ${bullets.length} из ${slimItems.length} новостей`);
  }
  if (!bullets.length) throw new Error("LLM /digest: пустые bullets");
  return { headline: String(data.headline || "").trim() || undefined, bullets, advice };
}

// Текст дайджеста. Возвращает { headline, caption, digest_text, items }:
//  — caption — короткая подпись обложки (заголовок + футер, влезает в 1024);
//  — digest_text — полный разбор до 4096 симв. (отдельное текстовое сообщение).
// Собирается ТОЛЬКО живым LLM: без него возвращает null, чтобы не постить
// сырые заголовки (лучше пропустить окно).
export async function generateDigestText(items, env = {}, meta = {}) {
  let llm = null;
  if ((env.LLM_PROXY_URL || "").trim()) {
    try {
      llm = await callProxyDigest(env, items);
    } catch (e) {
      console.log("[llm] LLM /digest недоступен:", e.message);
    }
  }
  if (!llm && env.LLM_API_BASE && env.LLM_API_KEY) {
    try {
      llm = await callLlmDigest(env, items);
    } catch (e) {
      console.log("[llm] LLM-дайджест недоступен:", e.message);
    }
  }
  if (!llm && env.AI && typeof env.AI.run === "function") {
    try {
      llm = await callWorkersAiDigest(env, items);
    } catch (e) {
      console.log("[llm] Workers AI дайджест недоступен:", e.message);
    }
  }
  if (!llm || !llm.bullets.length) {
    console.log("[llm] дайджест без живого LLM не собираю (фолбэк-правила не используются)");
    return null;
  }
  const headline = llm.headline ? stripSourceTail(llm.headline) : "";
  const bulletTexts = llm.bullets.map((t, i) => ({
    text: markdownToHtml(stripSourceTail(t)),
    link: items[i] && items[i].link,
  }));
  const advice = llm.advice.map((t) => markdownToHtml(stripSourceTail(t)));

  const emoji = DIGEST_EMOJI[meta.slug] || "📰";
  const headlinePart = `${emoji} <b>${sanitizeHtml(headline)}</b>`;
  const bulletParts = bulletTexts.map((b, i) => {
    let txt = `• <b>${i + 1}.</b> ${b.text}`;
    if (b.link) txt += `\n<a href="${sanitizeLink(b.link)}">источник →</a>`;
    return txt;
  });
  const adviceHeader = "🛡️ <b>Что делать</b>";
  const adviceParts = advice.map((t) => "• " + t);

  // Полный разбор — отдельное текстовое сообщение (лимит TG 4096).
  const fullParts = [headlinePart, ...bulletParts];
  if (adviceParts.length) fullParts.push(adviceHeader, ...adviceParts);
  let digest_text = fitCaption(fullParts.join("\n\n") + "\n\n" + FOOTER_HTML, 4096);

  // Короткая подпись обложки: заголовок + футер (влезает в 1024).
  const caption = fitCaption(`${headlinePart}\n\n${FOOTER_HTML}`, 1024);

  return {
    headline,
    headline_lines: [headline],
    caption,
    digest_text,
    items: items.map((it, i) => ({
      guid: it.guid || "",
      title: String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
      link: it.link || "",
      source: domainOf(it.link || "") || it.source || "",
    })),
  };
}

// Свежайшие первыми — для отбора новостей в выпуск.
export function digestFreshScore(c) {
  return itemFreshMs(c);
}

// ---------- вызов LLM ----------

// Прокси через Render-сервис: GigaChat из Worker напрямую нельзя (CA Сбера).
// Render-сервис держит ключи GigaChat/Gemini и ходит в них сам. provider:
// "gigachat" | "gemini".
async function callProxyLlm(env, text, prevPost = null, provider = "gigachat", style = null, winContext = "") {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL не задан");
  const res = await fetch(`${base}/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, prev_post: prevPost, provider, style: style ? style.id : "", best_posts: winContext }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM proxy ${res.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  if (data && data.error) throw new Error(`LLM вернул error: ${data.error}`);
  return data;
}

// Нормализует «богатый» формат LLM (extract_prompt.md) под схему воркера:
// { headline, headline_lines, caption, cards, tier, source }.
function normalizeProxyData(data, text) {
  const rawHeadline = Array.isArray(data.headline) ? data.headline : [data.headline];
  const headlineLines = rawHeadline
    .map((h) => stripMarkdown(h))
    .filter(Boolean)
    .slice(0, 2);
  const headline =
    headlineLines.join(" ") || truncateAt(stripLink(String(text || "").replace(/\s+/g, " ")), 90) || "Кибербезопасность: главное";
  let caption = markdownToHtml(String(data.caption || "")).trim();
  if (caption) caption += "\n\n" + FOOTER_HTML;
  caption = fitCaption(caption, 1024);
  const cards = Array.isArray(data.cards)
    ? data.cards
        .filter((c) => c && typeof c === "object")
        .slice(0, 4)
        .map((c) => ({
          type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
          number: String(c.number || "").slice(0, 12),
          label: stripMarkdown(c.label).slice(0, 80),
          desc: markdownToHtml(String(c.desc || "")).slice(0, 160),
          before: markdownToHtml(String(c.before || "")).slice(0, 160),
          after: markdownToHtml(String(c.after || "")).slice(0, 160),
          items: Array.isArray(c.items) ? c.items.map((i) => stripMarkdown(i).slice(0, 140)).slice(0, 4) : [],
        }))
    : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, headline_lines: headlineLines, caption, cards, tier, source: "" };
}

const LLM_SYSTEM =
  "Ты — редактор канала TrustNode о кибербезопасности. По тексту новости верни " +
  "ТОЛЬКО валидный JSON без пояснений, с полями: " +
  '"headline" (заголовок, 1 фраза), "caption" (текст поста 500-800 символов на русском, ' +
  'может содержать теги <b> и <a href>), "cards" (массив: {"type":"stat","number":"...",' +
  '"label":"..."} для цифр или {"type":"list","label":"...","items":["..."]} для тезисов, ' +
  "1-3 карточки), \"tier\" (news|real_threat|medium|safe). Не выдумывай цифры сверх текста.";

// ---------- само-критика перед публикацией ----------

// «Самокритик»: второй проход LLM по готовому посту (заголовок + текст), который
// вычищает шаблонную «рыбу» — пустые открывалки, клише «важно/срочно/напоминаем»,
// канцелярит, повторы и сомнительные обобщения. При включённом LLM_CRITIQUE
// вернёт исправленный caption, если видит слабые места, иначе null (пост не трогаем).
const CRITIQUE_SYSTEM =
  "Ты — строгий редактор телеграм-канала TrustNode о кибербезопасности. " +
  "По черновику поста (заголовок + текст) найди признаки «ботопостинга»: " +
  "пустые открывалки (важно/срочно/внимание/напоминаем/не пропустите), " +
  "клише-канцелярит (в сегодняшней статье/по итогам/стоит отметить), " +
  "бессодержательные обобщения («это большая проблема»), повторы мысли. " +
  "Верни ТОЛЬКО валидный JSON без пояснений: " +
  '{"issues":["короткие замечания"], "fixed_caption":"исправленный текст поста (HTML, без источника и футера) или пустая строка, если всё оставить как есть"}. ' +
  "Не выдумывай факты и цифры сверх новости; не добавляй ссылок и футера.";

async function critiqueDraft(env, data, src) {
  const draft =
    `Новость:\n${String(src || "").slice(0, 3000)}\n\n` +
    `Заголовок: ${data.headline || ""}\n\n` +
    `Текст поста:\n${String(data.caption || "").replace(/\n\n🛡️[\s\S]*$/, "")}`;
  let raw = null;
  let err = "";
  // Пробуем прокси, затем прямые ключи (тот же контур, что и генерация текста).
  if ((env.LLM_PROXY_URL || "").trim()) {
    try {
      const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
      const res = await fetch(`${base}/critique`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft, provider: "gigachat" }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`critique proxy ${res.status}: ${text.slice(0, 120)}`);
      raw = text;
    } catch (e) {
      err = e.message;
    }
  }
  if (raw === null && env.LLM_API_BASE && env.LLM_API_KEY) {
    try {
      const base = (env.LLM_API_BASE || "").replace(/\/+$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.LLM_MODEL || "gemini-flash-lite-latest",
          messages: [
            { role: "system", content: CRITIQUE_SYSTEM },
            { role: "user", content: draft.slice(0, 6000) },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`critique ${res.status}`);
      raw = await res.text();
    } catch (e) {
      err = err || e.message;
    }
  }
  if (raw === null) {
    if (err) console.log("[llm] самокритик недоступен:", err);
    return data;
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return data;
    const j = JSON.parse(m[0]);
    const fixed = String(j.fixed_caption || "").trim();
    // Берём исправление только если оно не пустое, не повторяет исходник
    // и вставляет хоть какую-то фактуру.
    if (fixed.length >= 60) {
      return { ...data, caption: fitCaption(fixed, 1024), critique_issues: Array.isArray(j.issues) ? j.issues.slice(0, 5) : [] };
    }
  } catch (e) { /* малокритично */ }
  return data;
}

async function callLlm(env, text, style = null, prevPost = null, winContext = "") {
  const base = (env.LLM_API_BASE || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const system = style
    ? `${LLM_SYSTEM}\n\n${style.instruction}`
    : LLM_SYSTEM;
  let user = prevPost
    ? `${String(text).slice(0, 6000)}\n\nКонтекст: предыдущий пост канала использовал сетку карточек ${prevPost.layout || "—"}. Сделай другую сетку и другие типы карточек, чтобы посты не выглядели одинаково.`
    : String(text).slice(0, 6000);
  // Подсказка «что залетает»: лучшие посты аудитории, чтобы новый пост был похож
  // на успешные, но не копией.
  if (winContext) user += `\n\n${winContext}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.75,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM вернул не JSON");
  return JSON.parse(m[0]);
}

function validateLlm(data, text) {
  const headline = stripMarkdown(String(data.headline || "")).slice(0, 120) || "Кибербезопасность: главное";
  let caption = markdownToHtml(String(data.caption || "")).trim();
  if (!caption) {
    const body = [data.headline, ...((data.cards || []).map((c) => c.label || "")).filter(Boolean)];
    caption = markdownToHtml(body.join("\n\n")).trim();
  }
  if (caption) caption += "\n\n" + FOOTER_HTML;
  caption = fitCaption(caption, 1024);
  const cards = Array.isArray(data.cards)
    ? data.cards
        .filter((c) => c && typeof c === "object")
        .slice(0, 4)
        .map((c) => ({
          type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
          number: String(c.number || "").slice(0, 12),
          label: stripMarkdown(c.label).slice(0, 80),
          desc: markdownToHtml(String(c.desc || "")).slice(0, 160),
          items: Array.isArray(c.items) ? c.items.map((i) => stripMarkdown(i).slice(0, 140)).slice(0, 4) : [],
        }))
    : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, caption, cards, tier, source: "" };
}

// Объединяет результаты двух LLM в «совместный пост»: карточки берём из обоих
// (без дублей по ключу), headline и caption — из более насыщенного ответа.
function mergeDualPost(a, b) {
  const score = (d) => (d.caption ? d.caption.length : 0) + (d.cards || []).length * 60;
  const primary = score(a) >= score(b) ? a : b;
  const secondary = primary === a ? b : a;

  const seen = new Set();
  const cards = [];
  for (const c of [...primary.cards, ...secondary.cards]) {
    const key = `${c.type}|${c.number}|${c.label}|${(c.items || []).join("/")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(c);
    if (cards.length >= 4) break;
  }

  const headlineLines = [...primary.headline_lines];
  for (const h of secondary.headline_lines) {
    if (headlineLines.length >= 2) break;
    if (!headlineLines.includes(h)) headlineLines.push(h);
  }

  return {
    headline: headlineLines.join(" ") || primary.headline,
    headline_lines: headlineLines,
    caption: primary.caption,
    cards: cards.length ? cards : primary.cards,
    tier: primary.tier,
    source: primary.source || secondary.source,
  };
}

// Утро: GigaChat. День: совместный (оба). Вечер: Gemini. Ночь: любой доступный.
export function providerPlan(env, ekb) {
  const hasProxy = !!((env.LLM_PROXY_URL || "").trim());
  if (!hasProxy) return { joint: false, order: [] };
  const h = ekb.hour;
  if (h >= 6 && h < 12) return { joint: false, order: ["gigachat", "gemini"] };
  if (h >= 12 && h < 17) return { joint: true, order: ["gigachat", "gemini"] };
  if (h >= 17 && h < 22) return { joint: false, order: ["gemini", "gigachat"] };
  return { joint: false, order: ["gigachat", "gemini"] };
}

async function generateWithProviders(env, text, meta, order, joint, styleWeights = null, winContext = "") {
  const src = meta.text || text;
  const prev = meta.prev_post || null;
  const style = pickPostStyle(meta, styleWeights);
  const errors = [];

  if (joint) {
    // Совместный пост: пробуем оба LLM, объединяем успешные ответы.
    const attempts = await Promise.allSettled(
      order.map((p) => callProxyLlm(env, src, prev, p, style, winContext).then((d) => normalizeProxyData(d, src)))
    );
    const ok = attempts.filter((a) => a.status === "fulfilled").map((a) => a.value);
    if (ok.length >= 2) return mergeDualPost(ok[0], ok[1]);
    if (ok.length === 1) return ok[0];
    for (const a of attempts) errors.push(a.reason?.message || "unknown");
    throw new Error(errors.join(" | "));
  }

  let lastErr = null;
  for (const p of order) {
    try {
      const data = await callProxyLlm(env, src, prev, p, style, winContext);
      return normalizeProxyData(data, src);
    } catch (e) {
      lastErr = e;
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error(errors.join(" | ") || (lastErr && lastErr.message));
}

export async function generatePostData(text, env, meta = {}) {
  // meta.provider: "gigachat" | "gemini" | "rules" — принудительный провайдер
  // (кнопки/команды админа). "rules" — без LLM вообще.
  const forced = meta.provider || "";

  // Атрибуты поста для статистики: схема, жанр, тема — считаются один раз и
  // прикрепляются к данным независимо от того, какой провайдер сработал.
  const src = String(meta.text || text || "");
  // Сигналы аудитории из статов: веса жанров для ротации + подсказка «что
  // сейчас залетает» для LLM (чтобы новые посты были похожи на успешные).
  let styleWeights = null;
  let winContext = "";
  if (env && env.BOT_KV) {
    try {
      const { getContentWeights, winningContextText } = await import("./stats.js");
      const { getLog } = await import("./kv.js");
      const cw = await getContentWeights(env);
      if (cw && cw.style && Object.keys(cw.style).length) styleWeights = cw.style;
      const log = await getLog(env);
      winContext = winningContextText(log);
    } catch (e) { /* статы недоступны — ротация по хешу */ }
  }
  const attrs = postAttrs(src, meta, styleWeights);

  // Контекст предыдущего поста (чтобы не повторять сетку) — берём из истории,
  // если вызывающий не передал явный prev_post.
  let prevPost = meta.prev_post || null;
  if (!prevPost && env && env.BOT_KV) {
    try {
      const { getLog } = await import("./kv.js");
      const log = await getLog(env);
      const prev = log.find((e) => e && (e.kind === "news" || e.kind === "digest") && (e.card_types && e.card_types.length));
      if (prev) {
        prevPost = {
          cards: (prev.card_types || []).map((t) => ({ type: t })),
          layout: prev.layout || prev.card_types.join("-") || "",
        };
      }
    } catch (e) { /* без контекста — ничего страшного */ }
  }
  const ctxMeta = prevPost ? { ...meta, prev_post: prevPost } : meta;

  if (forced === "rules") {
    // Принудительно «без ИИ» (кнопка админа): чистые правила, без LLM-мнений.
    return { ...generateByRules(text, meta), ...attrs };
  }

  const plan = providerPlan(env, ekbNow());
  let order = plan.order;
  let joint = plan.joint;
  if (forced === "gemini" || forced === "gigachat") {
    // Принудительно: пробуем только запрошенный провайдер.
    order = [forced];
    joint = false;
  }
  if (order.length) {
    try {
      const data = await generateWithProviders(env, meta.text || text, ctxMeta, order, joint, styleWeights, winContext);
      const out = { ...data, llm_provider: joint ? "gigachat+gemini" : order[0], ...attrs };
      if (env.LLM_CRITIQUE) {
        try { return await critiqueDraft(env, out, src); } catch (e) { console.log("[llm] самокритик:", e.message); }
      }
      return out;
    } catch (e) {
      console.log("[llm] LLM-прокси недоступен, использую правила:", e.message);
    }
  }
  if (!forced && env.LLM_API_KEY && env.LLM_API_BASE) {
    try {
      const data = await callLlm(env, meta.text || text, pickPostStyle(ctxMeta, styleWeights), ctxMeta.prev_post || null, winContext);
      const out = { ...validateLlm(data, text), llm_provider: "gemini-direct", ...attrs };
      if (env.LLM_CRITIQUE) {
        try { return await critiqueDraft(env, out, src); } catch (e) { console.log("[llm] самокритик:", e.message); }
      }
      return out;
    } catch (e) {
      console.log("[llm] LLM недоступен, использую правила:", e.message);
    }
  }
  if (!forced && env.AI && typeof env.AI.run === "function") {
    try {
      const data = await callWorkersAiLlm(env, meta.text || text, pickPostStyle(ctxMeta, styleWeights), ctxMeta.prev_post || null, winContext);
      const out = { ...validateLlm(data, text), llm_provider: "workers-ai", ...attrs };
      if (env.LLM_CRITIQUE) {
        try { return await critiqueDraft(env, out, src); } catch (e) { console.log("[llm] самокритик:", e.message); }
      }
      return out;
    } catch (e) {
      console.log("[llm] Workers AI недоступен, использую правила:", e.message);
    }
  }
  return { ...(await generateRulesWithOpinion(text, env, ctxMeta)), ...attrs };
}

// Атрибуты поста для статистики: схема мошенничества, жанр подачи, тема.
function postAttrs(src, meta, styleWeights = null) {
  let schemeId = null;
  let topicId = null;
  try {
    const scheme = detectScheme(src);
    if (scheme) schemeId = scheme.id;
  } catch (e) { /* не распознали схему */ }
  try {
    const analysis = analyzePost(src, meta);
    if (analysis.topic) topicId = analysis.topic.id;
  } catch (e) { /* нет темы */ }
  return {
    scheme_id: schemeId,
    topic_id: topicId,
    style_id: pickPostStyle(meta, styleWeights).id,
  };
}
