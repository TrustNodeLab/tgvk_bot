// worker/lib/nlp.js — детерминированный NLP-движок TrustNode ("своя модель").
// Работает прямо в Worker, без внешних LLM. Этапы:
//   1. Нормализация и сегментация на предложения (с защитой сокращений).
//   2. Тематическая классификация: взвешенный словарь-«модель» по темам
//      мошенничества. Веса суммируются, побеждает тема с максимумом.
//   3. Извлечение сущностей: суммы/проценты (с предложением-контекстом),
//      лёгкий поиск упомянутых организаций.
//   4. Ранжирование фактов по важности (цифры, ключевые слова темы,
//      позиция, плотность смысла).
//   5. Рерайт: заголовок (тема + шаблон), лид (срез вводных конструкций),
//      факты, tier опасности.
//   6. Генератор карточек для визуала поста.

// ---------- 1. Сегментация и токенизация ----------

// Сокращения, после точки которых НЕ конец предложения.
const NON_END_ABBR = new Set([
  "т.е", "т.е.", "т.д", "т.д.", "т.п", "т.п.", "т.к", "т.к.", "т.н", "т.н.",
  "г", "г.", "гг", "гг.", "руб", "руб.", "млн", "млн.", "млрд", "млрд.",
  "тыс", "тыс.", "стр", "стр.", "см", "см.", "др", "др.", "проч", "проч.",
  "напр", "напр.", "им", "им.", "ул", "ул.", "пл", "пл.", "обл", "обл.",
  "в т.ч", "в т.ч.", "с", "с.", "ок", "ок.", "номер", "номер.",
]);

export function splitSentences(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const parts = src.split(/(?<=[.!?…])\s+/);
  const out = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    // Если предложение оканчивается сокращением — склеиваем со следующим.
    const prev = out[out.length - 1];
    const m = p.match(/(?:^|\s)([а-яёa-z.]{1,5}\.\.?)$/i);
    if (m && NON_END_ABBR.has(m[1].toLowerCase())) {
      if (prev) out[out.length - 1] = prev + " " + p;
      else out.push(p);
      continue;
    }
    // Приставка из 1-2 слов + точка (например «Как сообщили в МВД.» и т.п.) — не сокращение.
    out.push(p);
  }
  return out;
}

export function tokens(text) {
  return String(text || "").toLowerCase().match(/[а-яёa-z0-9]+/g) || [];
}

// ---------- 2. Тематический классификатор ----------

// Модель тем. weight — вклад темы в общий балл, keywords — регулярные
// выражения (проверяются по нижнему регистру). threat — насколько тема
// опасна для tier. tips — советы по защите (для карточки и caption).
// hint — короткое название темы для лейблов карточек.
const TOPIC_MODEL = [
  {
    id: "call",
    label: "Телефонное мошенничество",
    hint: "Звонок мошенника",
    weight: 2.0,
    threat: 2,
    re: [
      /звон(?:ят|ит|ают)|позвонил|телефонн\w+|по телефону|оператор|колл-центр|представился\w*\s*(сотрудником|банк|оператором)/,
      /безопасн\w*\s*счёт|безопасный счет|перевести\s+деньги|перевод\s+денег|лжеоператор\w*|снят\w+\s+по\s+телефону/,
      /из\s+банка|банка\s+звонят|служб\w*\s+безопасност\w*/,
    ],
    tips: [
      "Положите трубку и перезвоните в банк по номеру с обратной стороны карты",
      "Сотрудники банка никогда не просят код из SMS или перевод «на безопасный счёт»",
    ],
  },
  {
    id: "sms",
    label: "Код из SMS",
    hint: "Код подтверждения",
    weight: 1.5,
    threat: 2,
    re: [
      /код (?:из |в )?[сs]мс?|код подтверждени\w*|смс-код|подтверждени\w*\s+вход|телефонную подтвержден/,
      /не\s+(?:называй|сообщай|передавай|говори)\w*\s+код/,
      /смс|сообщени\w+\s+с\s+кодом|sms/,
    ],
    tips: [
      "Код из SMS — это ключ к вашему аккаунту. Никому его не называйте.",
      "Банк, госорган и «служба безопасности» никогда не запрашивают код по телефону",
    ],
  },
  {
    id: "phishing",
    label: "Фишинг",
    hint: "Фишинг-ссылка",
    weight: 2.0,
    threat: 2,
    re: [
      /фишинг|фишингов\w+|фейков\w+\s*(?:сайт|страниц|приложени|ссылк)|поддельн\w+\s*(?:сайт|ссылк|страниц)/,
      /перейти\s+по\s+ссылк|ссылка\s+на\s+сайт|подозрительн\w+\s+ссылк|ссылк\w+\s+заблокирован/,
      /qr-код|qr\s+код|фейк\w*|поддел\w+\s+(?:сайт|приложени)/,
    ],
    tips: [
      "Проверяйте адрес сайта перед вводом данных — подделка может отличаться одной буквой",
      "Не переходите по ссылкам и QR-кодам от незнакомцев и в сомнительных сообщениях",
    ],
  },
  {
    id: "invest",
    label: "Фейковые инвестиции",
    hint: "Инвестиции/крипто",
    weight: 1.8,
    threat: 2,
    re: [
      /инвест\w+|крипто|криптовалют\w+|биткоин|пассивн\w+\s+доход|гарантированн\w+\s+доход/,
      /вложени\w+|доходност\w+\s+до|заработ\w+\s+без\s+вложени|брокер\w+|пирамид\w+/,
      /обман\w*\s+вклад|реклам\w*\s+заработ/,
    ],
    tips: [
      "Гарантированный доход «прямо сейчас» — признак мошенничества",
      "Не выводите средства на «безопасный счёт» и не передавайте доступ к кошельку",
    ],
  },
  {
    id: "gosuslugi",
    label: "Госуслуги",
    hint: "Аккаунт на Госуслугах",
    weight: 1.6,
    threat: 2,
    re: [
      /госуслуг\w+|аккаунт\s+взлома\w*|взлом\w+\s+аккаунт|восстанови\w*\s+доступ/,
      /портал\s+госуслуг|мошенник\w*\s+госуслуг/,
    ],
    tips: [
      "Настоящие сотрудники не просят код из SMS или «подтверждение входа» по телефону",
      "Смените пароль только через официальный портал, не по ссылке из сообщения",
    ],
  },
  {
    id: "fake_org",
    label: "Фейковый сотрудник",
    hint: "Фейковый сотрудник",
    weight: 1.7,
    threat: 2,
    re: [
      /представил\w*\s+(?:полицейск\w+|сотрудник\w+\s+фсб|следовател\w+|прокурор\w+|фсб|полицейск\w+)/,
      /служб\w*\s+безопасност\w+|следовател\w+|фсб|прокурор\w+|полицейск\w+/,
      /звон\w+\s+из\s+прокуратур\w+|орган\w+\s+(?:следстви\w+|дознани\w+)/,
    ],
    tips: [
      "Незнакомец «из органов» не имеет права требовать деньги или доступ по телефону",
      "Перепроверяйте личность звонящего, позвонив по официальному номеру ведомства",
    ],
  },
  {
    id: "card",
    label: "Банковские карты",
    hint: "Карты и платежи",
    weight: 1.4,
    threat: 1,
    re: [
      /банковск\w+\s+карт\w+|платежн\w+\s+карт\w+|виртуальн\w+\s+карт\w+/,
      /списан\w+\s+(?:деньги|средств\w+|карт\w+)|деньги\s+с\s+карт\w*|списани\w*\s+средств/,
      /перевыпуск\w*\s+карт\w+|привязанн\w+\s+карт\w+|бесконтактн\w+\s+платеж\w+/,
    ],
    tips: [
      "Держите лимит на интернет-платежи и используйте виртуальную карту для покупок",
      "При подозрительном списании сразу заблокируйте карту в приложении банка",
    ],
  },
  {
    id: "malware",
    label: "Вредоносное ПО",
    hint: "Вирус/троян",
    weight: 1.6,
    threat: 2,
    re: [
      /вредоносн\w+\s+по|вредонос\w+|троян\w+|шпионск\w+\s+по|вирус\w+/,
      /зловред\w+|зараженн\w+\s+(?:устройств|приложени)|malware|ransomware/,
      /приложени\w+\s+мошенник\w*|поддел\w+\s+приложени\w+|перехват\w+\s+смс/,
    ],
    tips: [
      "Ставьте приложения только из официальных магазинов и проверяйте разработчика",
      "Не открывайте вложения из незнакомых писем — там часто бывают трояны",
    ],
  },
  {
    id: "leak",
    label: "Утечка данных",
    hint: "Утечка данных",
    weight: 1.4,
    threat: 1,
    re: [
      /утечк\w+\s+(?:данн\w+|персональн\w+|баз\w+)|слили\s+баз\w+|слит\w+\s+данн\w+/,
      /персональн\w+\s+данн\w+|база\s+данн\w+\s+(?:оказалась|попал\w*|появилась)/,
      /данные\s+(?:попали|утекли|были\s+скомпрометированы)/,
    ],
    tips: [
      "После утечки смените пароли и включите двухфакторную аутентификацию",
      "Проверьте, использовали ли вы одинаковый пароль на утёкших сервисах",
    ],
  },
  {
    id: "job",
    label: "Ложные вакансии",
    hint: "Вакансии-приманки",
    weight: 1.4,
    threat: 1,
    re: [
      /ваканси\w+|работодател\w+|зaрплат\w+|набор\s+сотрудник\w+|удалённ\w+\s+работ/,
      /предлагают\s+заработок|заработок\s+в\s+интернет|заработ\w+\s+на\s+отзыв\w+/,
      /оформление\w*\s+займ\w+|кредит\w+\s+на\s+вас/,
    ],
    tips: [
      "Не отправляйте паспортные данные в «личные сообщения» незнакомым работодателям",
      "Проверяйте компанию по ИНН и официальному сайту перед передачей документов",
    ],
  },
];

export function classifyTopics(text) {
  const src = String(text || "").toLowerCase();
  const scored = TOPIC_MODEL.map((t) => {
    let hits = 0;
    for (const re of t.re) if (re.test(src)) hits++;
    return { ...t, score: hits ? t.weight + Math.min(hits - 1, 2) * 0.5 : 0 };
  }).filter((t) => t.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function mainTopic(text) {
  const list = classifyTopics(text);
  return list.length ? list[0] : null;
}

// ---------- 3. Извлечение сущностей ----------

// Суммы, проценты, «во сколько раз» — число + единица измерения.
const STAT_RE =
  /(\d[\d\s.,]*\d?)\s*(%|млн|млрд|тыс\.?|₽|руб(?:лей)?|миллион\w*|тысяч\w*|млрд\s*руб|процент\w*|из\s+\d+)/gi;

export function extractStats(text) {
  const sents = splitSentences(text);
  const out = [];
  for (let i = 0; i < sents.length; i++) {
    const s = sents[i];
    const m = s.match(STAT_RE);
    if (!m) continue;
    for (const raw of m) {
      const val = raw.replace(/\s+/g, " ");
      if (!/\d/.test(val)) continue;
      out.push({
        value: val.slice(0, 14),
        context: stripInSentence(s),
        sentenceIdx: i,
      });
      break; // одно число на предложение достаточно
    }
  }
  return out;
}

// Организации/ведомства, встречающиеся в тексте (упрощённый словарь).
const ORG_RE =
  /(?:^|[^а-яёa-z])(МВД|ЦБ|Центробанк|Банк России|Госуслуг\w*|ФСБ|Минцифры|Роскомнадзор|прокуратур\w*|СКР|Следственн\w+\s+комитет|РЖД|Сбербанк|ВТБ|Т-Банк|Альфа-Банк|Минфин|ФНС|ФАС)(?=$|[^а-яёa-z])/gi;

export function extractOrgs(text) {
  const found = new Set();
  const m = String(text || "").match(ORG_RE);
  if (m) for (const o of m) found.add(o.trim());
  return [...found];
}

// ---------- 4. Ранжирование фактов ----------

const LEAD_WORDS = [
  "по данным", "как сообщ", "по информации", "согласно", "сообщил", "сообщила",
  "рассказал", "рассказала", "заявил", "заявила", "отметила", "подчеркнул",
  "как передаёт", "по словам", "стало известно", "источник сказал", "выяснилось",
];

export function stripLead(sent) {
  let s = String(sent || "").trim();
  const low = s.toLowerCase();
  for (const w of LEAD_WORDS) {
    if (!low.startsWith(w)) continue;
    const afterWord = s.slice(w.length).replace(/^[,: ]+/, "");
    // Если вводная фраза отделена запятой — выбрасываем её целиком.
    const commaIdx = afterWord.indexOf(",");
    if (commaIdx > 3 && commaIdx < 40) s = afterWord.slice(commaIdx + 1).trim();
    else s = afterWord;
    if (s.length < 20) return String(sent || "").trim();
    break;
  }
  return capFirst(s);
}

export function capFirst(s) {
  const t = String(s || "").trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

// Оценка «важности» предложения: цифры + термины темы + позиция + плотность.
export function factScore(sent, topic, idx) {
  let score = 10 - Math.min(idx, 5) * 1.2; // ранние предложения важнее
  if (/\d/.test(sent)) score += 4;
  if (topic) {
    for (const re of topic.re) if (re.test(sent.toLowerCase())) score += 2;
  }
  if (/(мошенник|атака|взлом|утечк|схем|фрод)/i.test(sent)) score += 1.5;
  const len = sent.length;
  if (len >= 40 && len <= 170) score += 2;
  else if (len < 20) score -= 2;
  if (stripLead(sent) !== sent.trim()) score -= 0.5;
  return score;
}

export function rankFacts(sentences, topic, { max = 4, minLen = 25, maxLen = 180 } = {}) {
  const skipFirst = sentences.length > 1; // первое предложение — это обычно лид/заголовок
  return sentences
    .map((s, i) => ({ s, i, score: factScore(s, topic, i) }))
    .filter((f) => {
      if (skipFirst && f.i === 0) return false;
      const t = f.s.replace(/^[\s\d.,\-–:]+/, "").trim();
      return t.length >= minLen && t.length <= maxLen && !/^(москва|риа|tass|интерфакс)/i.test(t);
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((f) => stripPunct(stripLead(f.s)))
    .map((s) => s.slice(0, 150));
}

export function stripPunct(s) {
  return String(s || "").replace(/^[\s\d.,:–-]+/, "").replace(/[.;,]+$/, "").trim();
}

// ---------- 5. Рерайт ----------

// Приставка новостного лида вида «Москва, 5 августа», «МОСКВА, 5 авг.».
const NEWS_PREFIX =
  /^([а-яё]+(?:[ —-]+[а-яё]+)?),\s*\d{1,2}\s+[а-яё]+(?:[,.]|\s*[,.]?\s+\d{4})?\.?\s+/i;

export function stripNewsPrefix(s) {
  return String(s || "").trim().replace(NEWS_PREFIX, "");
}

export function headlineWorthy(line) {
  const l = stripNewsPrefix(String(line || "").trim());
  return l.length >= 10 && l.length <= 110 && !/^(москва|риа|tass|интерфакс)/i.test(l);
}

// Заголовок: явный title > первая строка > шаблон по теме > первое предложение.
export function buildHeadline(raw, meta, analysis) {
  const title = stripLink(String(meta.title || "")).trim();
  if (title) return trimEndPunct(truncate(title, 85));

  const lines = String(raw || "").split(/\n+/).map((l) => stripLink(l).trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  if (headlineWorthy(firstLine)) return trimEndPunct(truncate(stripNewsPrefix(firstLine), 85));

  const theme = analysis.topic;
  const lead = analysis.lead;
  if (theme && theme.template) {
    const subject = leadWord(lead) || "мошенники";
    const h = theme.template.replace("{subject}", capFirst(subject));
    if (h.length >= 10) return trimEndPunct(truncate(h, 85));
  }
  if (lead) return trimEndPunct(truncate(lead, 85));
  return "Кибербезопасность: главное";
}

function trimEndPunct(s) {
  return String(s || "").replace(/\s*[.,;:]+$/, "").trim();
}

function leadWord(sent) {
  const words = tokens(sent).filter((w) => w.length > 3 && !STOP.has(w));
  return words[0] ? capFirst(words[0]) : "";
}

export function truncate(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "") + "…";
}

export function stripLink(s) {
  return String(s || "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function stripInSentence(s) {
  return stripLink(s).replace(/^[\s\d.,:–-]+/, "").replace(/[.;,]+$/, "").trim();
}

// Экранирование URL для вставки в href (HTML-safe).
export function sanitizeLink(url) {
  return String(url || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const STOP = new Set([
  "это", "что", "как", "для", "при", "все", "еще", "уже", "они", "нам", "вас",
  "было", "быть", "будет", "стало", "есть", "также", "только", "можно", "нужно",
  "которые", "который", "однако", "поэтому", "потому", "сейчас", "сегодня", "весь",
]);

// ---------- tier ----------

export function estimateTier(text, topic) {
  const t = String(text || "").toLowerCase();
  const danger = /(атаку\w+|взлом\w+|похитил\w+|украл\w+|утрата\w+|кража\w+|мошенничество|реальн\w+\s+угроз\w+)/i;
  if (danger.test(t) || (topic && topic.threat >= 2)) return "real_threat";
  if (/(совету\w+|предупредил\w+|посоветовал\w+|не\s+верьте|будьте\s+внимательн\w+)/i.test(t)) return "medium";
  if (topic) return "medium";
  return "safe";
}

// ---------- анализ документа ----------

export function analyzePost(text, meta = {}) {
  const src = String(meta.text || text || "");
  const lines = src.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const bodyText = lines.slice(1).join(" ").trim();
  const cleaned = lines.join(" ");

  const sents = splitSentences(bodyText || firstLine || src);
  const topic = mainTopic(cleaned || firstLine);
  const lead = sents.length ? stripLead(sents[0]) : null;
  const facts = rankFacts(sents, topic);
  const stats = extractStats(cleaned);
  const orgs = extractOrgs(cleaned);
  const tier = estimateTier(cleaned, topic);

  const analysis = {
    headline: null, // заполнит buildHeadline
    lead,
    facts,
    topic,
    stats,
    orgs,
    tier,
    firstLine,
    bodyText,
    sents,
  };
  analysis.headline = buildHeadline(src, meta, analysis);
  return analysis;
}

// ---------- 6. Карточки ----------

export function buildCards(analysis, meta = {}) {
  const cards = [];
  const stat = analysis.stats[0];
  if (stat) {
    cards.push({
      type: "stat",
      number: stat.value,
      label: "ключевая цифра",
      desc: capFirst(stat.context || analysis.headline).slice(0, 160),
    });
  }
  if (analysis.facts.length >= 1) {
    cards.push({
      type: "list",
      label: analysis.topic ? analysis.topic.hint : "Суть",
      items: analysis.facts,
    });
  }
  if (analysis.topic) {
    cards.push({
      type: "list",
      label: "Как защититься",
      items: buildAdvice(analysis.topic),
    });
  }
  if (!cards.length) {
    cards.push({
      type: "list",
      label: "Суть",
      items: analysis.sents.slice(0, 3).map((s) => stripLink(s).slice(0, 150)),
    });
  }
  return cards.slice(0, 4);
}

export function buildAdvice(topic) {
  const tips = topic ? topic.tips.slice(0, 2) : [];
  tips.push("При малейшем сомнении перезвоните сами — официальный номер с обратной стороны карты или сайта");
  tips.push("Расскажите о схеме близким: мошенники часто давят на доверие и страх");
  return tips.slice(0, 3);
}
