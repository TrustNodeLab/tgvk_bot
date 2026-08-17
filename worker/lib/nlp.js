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
    template: "{subject} атакуют по телефону: как не стать жертвой",
    weight: 2.0,
    threat: 2,
    re: [
      /звон(?:ят|ит|ают)|позвонил|телефонн[а-яёa-z0-9]+|по телефону|оператор|колл-центр|представился[а-яёa-z0-9]*\s*(сотрудником|банк|оператором)/,
      /безопасн[а-яёa-z0-9]*\s*счёт|безопасный счет|перевести\s+деньги|перевод\s+денег|лжеоператор[а-яёa-z0-9]*|снят[а-яёa-z0-9]+\s+по\s+телефону/,
      /из\s+банка|банка\s+звонят|служб[а-яёa-z0-9]*\s+безопасност[а-яёa-z0-9]*/,
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
    template: "Код из SMS: почему его нельзя никому называть",
    weight: 1.5,
    threat: 2,
    re: [
      /код (?:из |в )?[сs]мс?|код подтверждени[а-яёa-z0-9]*|смс-код|подтверждени[а-яёa-z0-9]*\s+вход|телефонную подтвержден/,
      /не\s+(?:называй|сообщай|передавай|говори)[а-яёa-z0-9]*\s+код/,
      /смс|сообщени[а-яёa-z0-9]+\s+с\s+кодом|sms/,
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
    template: "{subject} маскируются под знакомый сайт: как не попасться",
    weight: 2.0,
    threat: 2,
    re: [
      /фишинг|фишингов[а-яёa-z0-9]+|фейков[а-яёa-z0-9]+\s*(?:сайт|страниц|приложени|ссылк)|поддельн[а-яёa-z0-9]+\s*(?:сайт|ссылк|страниц)/,
      /перейти\s+по\s+ссылк|ссылка\s+на\s+сайт|подозрительн[а-яёa-z0-9]+\s+ссылк|ссылк[а-яёa-z0-9]+\s+заблокирован/,
      /qr-код|qr\s+код|фейк[а-яёa-z0-9]*|поддел[а-яёa-z0-9]+\s+(?:сайт|приложени)/,
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
    template: "«Гарантированный доход»: как разводят на инвестициях",
    weight: 1.8,
    threat: 2,
    re: [
      /инвест[а-яёa-z0-9]+|крипто|криптовалют[а-яёa-z0-9]+|биткоин|пассивн[а-яёa-z0-9]+\s+доход|гарантированн[а-яёa-z0-9]+\s+доход/,
      /вложени[а-яёa-z0-9]+|доходност[а-яёa-z0-9]+\s+до|заработ[а-яёa-z0-9]+\s+без\s+вложени|брокер[а-яёa-z0-9]+|пирамид[а-яёa-z0-9]+/,
      /обман[а-яёa-z0-9]*\s+вклад|реклам[а-яёa-z0-9]*\s+заработ/,
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
    template: "{subject} добрались до Госуслуг: как защитить аккаунт",
    weight: 1.6,
    threat: 2,
    re: [
      /госуслуг[а-яёa-z0-9]+|аккаунт\s+взлома[а-яёa-z0-9]*|взлом[а-яёa-z0-9]+\s+аккаунт|восстанови[а-яёa-z0-9]*\s+доступ/,
      /портал\s+госуслуг|мошенник[а-яёa-z0-9]*\s+госуслуг/,
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
    template: "«{subject}» из органов звонит: как проверить",
    weight: 1.7,
    threat: 2,
    re: [
      /представил[а-яёa-z0-9]*\s+(?:полицейск[а-яёa-z0-9]+|сотрудник[а-яёa-z0-9]+\s+фсб|следовател[а-яёa-z0-9]+|прокурор[а-яёa-z0-9]+|фсб|полицейск[а-яёa-z0-9]+)/,
      /служб[а-яёa-z0-9]*\s+безопасност[а-яёa-z0-9]+|следовател[а-яёa-z0-9]+|фсб|прокурор[а-яёa-z0-9]+|полицейск[а-яёa-z0-9]+/,
      /звон[а-яёa-z0-9]+\s+из\s+прокуратур[а-яёa-z0-9]+|орган[а-яёa-z0-9]+\s+(?:следстви[а-яёa-z0-9]+|дознани[а-яёa-z0-9]+)/,
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
    template: "{subject} списывают деньги с карт: как защититься",
    weight: 1.4,
    threat: 1,
    re: [
      /банковск[а-яёa-z0-9]+\s+карт[а-яёa-z0-9]+|платежн[а-яёa-z0-9]+\s+карт[а-яёa-z0-9]+|виртуальн[а-яёa-z0-9]+\s+карт[а-яёa-z0-9]+/,
      /списан[а-яёa-z0-9]+\s+(?:деньги|средств[а-яёa-z0-9]+|карт[а-яёa-z0-9]+)|деньги\s+с\s+карт[а-яёa-z0-9]*|списани[а-яёa-z0-9]*\s+средств/,
      /перевыпуск[а-яёa-z0-9]*\s+карт[а-яёa-z0-9]+|привязанн[а-яёa-z0-9]+\s+карт[а-яёa-z0-9]+|бесконтактн[а-яёa-z0-9]+\s+платеж[а-яёa-z0-9]+/,
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
    template: "Троян в телефоне: как не подцепить и что делать",
    weight: 1.6,
    threat: 2,
    re: [
      /вредоносн[а-яёa-z0-9]+\s+по|вредонос[а-яёa-z0-9]+|троян[а-яёa-z0-9]+|шпионск[а-яёa-z0-9]+\s+по|вирус[а-яёa-z0-9]+/,
      /зловред[а-яёa-z0-9]+|зараженн[а-яёa-z0-9]+\s+(?:устройств|приложени)|malware|ransomware/,
      /приложени[а-яёa-z0-9]+\s+мошенник[а-яёa-z0-9]*|поддел[а-яёa-z0-9]+\s+приложени[а-яёa-z0-9]+|перехват[а-яёa-z0-9]+\s+смс/,
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
    template: "Ваши данные утекли: что делать прямо сейчас",
    weight: 1.4,
    threat: 1,
    re: [
      /утечк[а-яёa-z0-9]+\s+(?:данн[а-яёa-z0-9]+|персональн[а-яёa-z0-9]+|баз[а-яёa-z0-9]+)|слили\s+баз[а-яёa-z0-9]+|слит[а-яёa-z0-9]+\s+данн[а-яёa-z0-9]+/,
      /персональн[а-яёa-z0-9]+\s+данн[а-яёa-z0-9]+|база\s+данн[а-яёa-z0-9]+\s+(?:оказалась|попал[а-яёa-z0-9]*|появилась)/,
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
    template: "«Лёгкий заработок» оказался ловушкой: как распознать",
    weight: 1.4,
    threat: 1,
    re: [
      /ваканси[а-яёa-z0-9]+|работодател[а-яёa-z0-9]+|зaрплат[а-яёa-z0-9]+|набор\s+сотрудник[а-яёa-z0-9]+|удалённ[а-яёa-z0-9]+\s+работ/,
      /предлагают\s+заработок|заработок\s+в\s+интернет|заработ[а-яёa-z0-9]+\s+на\s+отзыв[а-яёa-z0-9]+/,
      /оформление[а-яёa-z0-9]*\s+займ[а-яёa-z0-9]+|кредит[а-яёa-z0-9]+\s+на\s+вас/,
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
  /(\d[\d\s.,]*\d?)\s*(%|млн|млрд|тыс\.?|₽|руб(?:лей)?|миллион[а-яёa-z0-9]*|тысяч[а-яёa-z0-9]*|млрд\s*руб|процент[а-яёa-z0-9]*|из\s+\d+)/gi;

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
  /(?:^|[^а-яёa-z])(МВД|ЦБ|Центробанк|Банк России|Госуслуг[а-яёa-z0-9]*|ФСБ|Минцифры|Роскомнадзор|прокуратур[а-яёa-z0-9]*|СКР|Следственн[а-яёa-z0-9]+\s+комитет|РЖД|Сбербанк|ВТБ|Т-Банк|Альфа-Банк|Минфин|ФНС|ФАС)(?=$|[^а-яёa-z])/gi;

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
    // Если вводная фраза отделена запятой — выбрасываем её целиком
    // (включая короткое название источника: «по данным ЦБ, за год…»).
    const commaIdx = afterWord.indexOf(",");
    if (commaIdx >= 1 && commaIdx < 40) s = afterWord.slice(commaIdx + 1).trim();
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

// ---------- клише-открывалки (шаблонные «рыбы» редакционки) ----------

// Фразы-клише, которые превращают пост в «ботопостинг» и убивают охваты:
// пустые призывы «важно/срочно», канцелярит «по итогам», шаблонные открывалки
// «как стало известно». В правилах они фильтруются из заголовков и лидов,
// а score заголовка их штрафует, чтобы лучший вариант не оказался клише.
const CLICHE_OPENERS = [
  /^важно[!:\s,]/i,
  /^срочно[!:\s,]/i,
  /^внимание[!:\s,]/i,
  /^ааа[!….\s]/i,
  /^эксперты\s+(предупредили|рассказали|сообщили)/i,
  /^аналитик[а-яё]*\s+(предупредил[а-яё]*|рассказал[а-яё]*)/i,
  /^в\.\s*сентября\s+\d{4}\s+года|^в\s+\d{4}\s+году/i,
  /^как\s+стало\s+известно/i,
  /^по\s+итогам/i,
  /^удивительно,\s+но/i,
  /^не\s+поверите/i,
  /^шокирующ[а-яё]*/i,
  /^будьте\s+осторожн[а-яё]*/i,
];

// Проверяет, начинается ли текст с клише-открывалки. Возвращает время среза
// (длину приставки) или null.
export function clicheOpenerLen(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  for (const re of CLICHE_OPENERS) {
    const m = s.match(re);
    if (m) return m[0].length;
  }
  return null;
}

// Срезает клише-открывалку с начала строки (для заголовка/лида).
export function stripCliche(s) {
  const len = clicheOpenerLen(s);
  if (len === null) return String(s || "").trim();
  return String(s || "").slice(len).replace(/^[,\s:—–-]+/, "").trim();
}

// Скор штрафа: сколько клише в тексте (для score заголовка).
export function clichePenalty(text) {
  const s = String(text || "");
  let n = 0;
  if (clicheOpenerLen(s) !== null) n += 1;
  // «рыбные» слова-разбавители в любом месте заголовка.
  if (/\b(обратите внимание|не пропустите|оставайтесь с нами)\b/i.test(s)) n += 1;
  return n;
}

// Главный «действующий субъект» текста: мошенники/хакеры/ведомство/организация.
// Используется в шаблонах заголовков ({subject}) вместо сухого «мошенники».
const SUBJECT_WORDS = [
  /мошенник[а-яё]*/gi, /злоумышленник[а-яё]*/gi, /аферист[а-яё]*/gi, /хакер[а-яё]*/gi,
  /дроппер[а-яё]*/gi, /преступник[а-яё]*/gi, /киберпреступник[а-яё]*/gi, /лжеоператор[а-яё]*/gi,
];

export function extractSubject(text) {
  const src = String(text || "");
  for (const re of SUBJECT_WORDS) {
    const m = src.match(re);
    if (m) return m[0];
  }
  const org = extractOrgs(src)[0];
  if (org) return org;
  return "";
}

// Переписывает факт в короткий «пунш» для буллета: срезает вводные, кавычки,
// «по словам», новостную приставку; оставляет суть и цифры. max — целевая длина.
export function punchFact(s, max = 130) {
  let t = String(s || "").trim();
  t = t.replace(/^«|»$/g, "").replace(/[«»"]/g, "");
  t = stripNewsPrefix(t);
  t = stripLead(t);
  t = stripPunct(t);
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "") + "…";
  }
  return t;
}

// Первое осмысленное слово предложения для шаблонов (не служебное).
export function firstContentWord(sent) {
  const words = tokens(sent).filter((w) => w.length > 3 && !STOP.has(w));
  return words[0] || "";
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

// Заголовок: явный title > первая строка > шаблон по теме > лид > дефолт.
export function buildHeadline(raw, meta, analysis) {
  const title = stripLink(String(meta.title || "")).trim();
  if (title) return trimEndPunct(truncate(title, 85));

  const lines = String(raw || "").split(/\n+/).map((l) => stripLink(l).trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  if (headlineWorthy(firstLine)) return trimEndPunct(truncate(stripNewsPrefix(firstLine), 85));

  const theme = analysis.topic;
  const lead = analysis.lead;
  if (theme && theme.template) {
    const subject = capFirst(extractSubject(raw) || leadWord(lead) || "мошенники");
    const h = theme.template.replace("{subject}", subject);
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
  const danger = /(атаку[а-яёa-z0-9]+|взлом[а-яёa-z0-9]+|похитил[а-яёa-z0-9]+|украл[а-яёa-z0-9]+|утрата[а-яёa-z0-9]+|кража[а-яёa-z0-9]+|мошенничество|реальн[а-яёa-z0-9]+\s+угроз[а-яёa-z0-9]+)/i;
  if (danger.test(t) || (topic && topic.threat >= 2)) return "real_threat";
  if (/(совету[а-яёa-z0-9]+|предупредил[а-яёa-z0-9]+|посоветовал[а-яёa-z0-9]+|не\s+верьте|будьте\s+внимательн[а-яёa-z0-9]+)/i.test(t)) return "medium";
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
  const subject = extractSubject(cleaned) || capFirst(firstContentWord(lead || firstLine));

  const analysis = {
    headline: null, // заполнит buildHeadline
    lead,
    facts,
    topic,
    stats,
    orgs,
    tier,
    subject,
    firstLine,
    bodyText,
    sents,
  };
  analysis.headline = buildHeadline(src, meta, analysis);
  return analysis;
}

// ---------- 6. Карточки ----------

export function buildCards(analysis, meta = {}, scheme = null) {
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
  const facts = (analysis.facts || []).map((f) => punchFact(f, 135)).filter(Boolean).slice(0, 4);
  if (facts.length >= 1) {
    cards.push({
      type: "list",
      label: scheme && scheme.hint ? scheme.hint : (analysis.topic ? analysis.topic.hint : "Суть"),
      items: facts,
    });
  }
  if (analysis.topic || scheme) {
    const advice = scheme && scheme.advice
      ? mergeAdvice(scheme.advice, buildAdvice(analysis.topic))
      : buildAdvice(analysis.topic);
    if (advice.length) {
      cards.push({
        type: "list",
        label: "Как защититься",
        items: advice.slice(0, 3).map((t) => t.slice(0, 120)),
      });
    }
  }
  // Механика «почему сработало»: психологический рычаг, на который давит схема.
  // Объясняет, а не пугает — читатель понимает, почему ловушка срабатывает.
  if (scheme && scheme.why && scheme.why.length) {
    cards.push({
      type: "list",
      label: "Почему это работает",
      items: scheme.why.slice(0, 2).map((t) => t.slice(0, 120)),
    });
  }
  if (!cards.length) {
    cards.push({
      type: "list",
      label: "Суть",
      items: analysis.sents.slice(0, 3).map((s) => punchFact(s, 135)).filter(Boolean),
    });
  }
  return cards.slice(0, 4);
}

function mergeAdvice(primary, fallback) {
  const seen = new Set();
  const out = [];
  const add = (t) => {
    const s = String(t || "").trim();
    if (!s || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  for (const t of primary) add(t);
  for (const t of fallback) add(t);
  return out;
}

export function buildAdvice(topic) {
  const tips = topic ? topic.tips.slice(0, 2) : [];
  tips.push("При малейшем сомнении перезвоните сами — официальный номер с обратной стороны карты или сайта");
  tips.push("Расскажите о схеме близким: мошенники часто давят на доверие и страх");
  return tips.slice(0, 3);
}
