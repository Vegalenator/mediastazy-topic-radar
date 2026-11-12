"use strict";

const $ = (selector) => document.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const url = (value) => {
  try {
    const parsed = new URL(value);
    if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
  } catch { return ""; }
  return "";
};
const external = (href, text) => url(href)
  ? `<a href="${esc(url(href))}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>`
  : esc(text);
const time = (value, withTime = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "numeric", month: "short", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
};
const count = new Intl.NumberFormat("ru-RU");
const labels = {
  news: "Новости", trends: "Поисковые тенденции", videos: "Видео", research: "Исследования",
};
const phases = {
  topics: ["Кандидат", "Проверка", "В работе", "Опубликовано"],
  shorts: ["Идея", "Проверка", "Сценарий", "Монтаж", "Опубликовано"],
};
const shortKinds = ["Самостоятельный", "Из большого выпуска", "Задел к исследованию"];
const categories = ["Технологии", "Экономика ИИ", "Общество и медиа", "Экономика и власть"];
const criteria = {
  topics: [["Интерес аудитории", 25], ["Противоречие", 25], ["Доказательства", 20], ["Актуальность", 15], ["Визуальный потенциал", 15]],
  shorts: [["Интерес аудитории", 25], ["Первая фраза", 25], ["Ясность за минуту", 25], ["Визуальный потенциал", 25]],
};
const topicBeats = {
  "ai-finance": ["ai-money"], "ai-energy": ["energy"], "ai-memory": ["memory"],
  "digital-tricks": ["attention"], "ai-internet": ["media", "tech"], "tiktok-rabbit": ["attention"],
  "synthetic-polls": ["memory"], "ai-personal-sources": ["media", "memory"],
  "future-news": ["media"], "vk-published": ["power"],
};
const storageKey = "mediastazy-radar-v3";
let base = { topics: [], shorts: [] };
let local = { topics: [], shorts: [] };
let snapshot;
let tab = "topics";
const selected = { topics: null, shorts: null };
let signalKind = "news";
let signalBeat = "";
let signalQuery = "";
let editing;
let noticeTimer;

function notify(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("#notice").hidden = true; }, 4500);
}

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(local));
    return true;
  } catch {
    notify("Браузер не сохранил изменения. Выгрузи резервную копию.");
    return false;
  }
}

function normalize(item, type, legacy = false) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" ||
      typeof item.title !== "string" || !item.id.trim() || !item.title.trim()) return null;
  const textFields = ["id", "title", "category", "kind", "date", "hook", "why", "audiences",
    "audience", "hypothesis", "research", "proof", "visuals", "story", "notes", "related", "evidence"];
  const normalized = Object.fromEntries(textFields.map((key) => [key, typeof item[key] === "string" ? item[key].trim().slice(0, 8000) : ""]));
  normalized.category = ({ "Медиа и аудитория": "Общество и медиа", "ИИ и общество": "Общество и медиа", "Технологии и ИИ": "Технологии" })[normalized.category] || normalized.category || categories[0];
  normalized.status = phases[type].includes(item.status) ? item.status : phases[type][0];
  normalized.kind = shortKinds.includes(normalized.kind) ? normalized.kind : shortKinds[0];
  normalized.saved = item.saved === true;
  normalized.author_interest = item.author_interest === true;
  const marks = Array.isArray(item.scores) ? item.scores : [];
  const values = legacy && type === "topics" ? [marks[0], marks[1], marks[3], null, item.visual] : marks;
  normalized.scores = criteria[type].map((_, index) => (
    Number.isInteger(values[index]) && values[index] >= 0 && values[index] <= 5 ? values[index] : null
  ));
  normalized.sources = Array.isArray(item.sources) ? item.sources.slice(0, 40).flatMap((source) => (
    url(source?.url) ? [{ name: String(source.name || source.url).slice(0, 500), url: url(source.url) }] : []
  )) : [];
  normalized.beats = Array.isArray(item.beats) ? item.beats.filter((id) => typeof id === "string").slice(0, 10) : (topicBeats[item.id] || []);
  return normalized;
}

function loadRows(raw, type, legacy = false) {
  return Array.isArray(raw) ? raw.slice(0, 3000).map((item) => normalize(item, type, legacy)).filter(Boolean) : [];
}

function merge(...lists) {
  return [...new Map(lists.flat().map((item) => [item.id, item])).values()];
}

function rows(type = tab) { return merge(base[type], local[type]); }

function put(type, item) {
  local[type] = merge(local[type], [item]);
  return save();
}

function score(item, type = tab) {
  if (item.scores.some((mark) => mark === null)) return null;
  return Math.round(criteria[type].reduce((total, [, weight], index) => total + item.scores[index] * weight / 5, 0));
}

function options(values, selectedValue = "", placeholder = "") {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
    values.map((value) => `<option value="${esc(value)}" ${value === selectedValue ? "selected" : ""}>${esc(value)}</option>`).join("");
}

function filtered() {
  const query = $("#q").value.trim().toLocaleLowerCase("ru");
  return rows().filter((item) =>
    (!query || [item.title, item.category, item.hook, item.why, item.kind, item.related].join(" ").toLocaleLowerCase("ru").includes(query)) &&
    (!$("#cat").value || item.category === $("#cat").value) &&
    (!$("#state").value || item.status === $("#state").value) &&
    (!$("#onlySaved").checked || item.saved)
  ).sort((a, b) => Number(b.saved) - Number(a.saved) || (score(b) ?? -1) - (score(a) ?? -1));
}

function renderList() {
  const list = filtered();
  if (!list.some((item) => item.id === selected[tab])) selected[tab] = list[0]?.id;
  $("#count").textContent = `${list.length} из ${rows().length}`;
  $("#list").innerHTML = list.map((item) => {
    const active = selected[tab] === item.id;
    const points = score(item);
    return `<button type="button" class="topic ${active ? "active" : ""}" data-topic="${esc(item.id)}" aria-current="${active}">
      <small><span class="dot" aria-hidden="true"></span>${esc(item.category)}</small>
      <div class="tname">${esc(item.title)}</div><div class="meta"><span>${item.saved ? "★ " : ""}${esc(item.status)}</span>
      <span class="scorepill">${points === null ? "Оценка неполная" : points + "/100"}</span></div></button>`;
  }).join("") || '<p class="empty">Нет тем по выбранным условиям.</p>';
}

function panel(title, content, width = "c6") {
  return `<section class="panel ${width}"><h2 class="label">${title}</h2>${content}</section>`;
}
const paragraph = (value) => `<p>${esc(value || "Заполнить при проверке темы.")}</p>`;

function allSignals() { return Object.values(snapshot?.signals || {}).flat(); }

function relevantSignals(item) {
  return allSignals().filter((signal) => signal.beats.some((id) => item.beats.includes(id)));
}

function metric(signal) {
  if (signal.kind === "videos") {
    if (Date.now() - Date.parse(signal.observedAt) > 172800000) return "Замер устарел";
    return `${count.format(signal.views)} просмотров · ${time(signal.observedAt, true)}`;
  }
  if (signal.kind === "trends") return signal.traffic ? `≈ ${signal.traffic} поисков по данным Google Trends` : "Всплеск интереса";
  if (signal.kind === "research") return signal.doi ? `DOI ${signal.doi}` : "Научная публикация";
  return "";
}

function renderTopic() {
  const item = rows().find((record) => record.id === selected[tab]);
  if (!item) {
    $("#detail").innerHTML = '<p class="empty">Выбери тему или добавь новую.</p>';
    return;
  }
  const isShort = tab === "shorts";
  const points = score(item);
  const linked = relevantSignals(item);
  const related = Object.keys(labels).flatMap((kind) => linked.filter((entry) => entry.kind === kind).slice(0, 2));
  const scores = criteria[tab].map(([name, weight], index) => `<label>${name} · ${weight}%
    <select class="subbtn" data-mark="${index}" aria-label="${name}"><option value="">Без оценки</option>
    ${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${item.scores[index] === n ? "selected" : ""}>${n} из 5</option>`).join("")}</select></label>`).join("");
  const refs = item.sources.map((source) => `<div>${external(source.url, source.name)}</div>`).join("");
  const query = encodeURIComponent(item.hook || item.title);
  const manualSearch = `<div class="tools">${external("https://wordstat.yandex.ru/?words=" + query, "Яндекс Вордстат")}
    ${external("https://trends.google.com/trends/explore?geo=RU&q=" + query, "Google Trends")}
    ${external("https://www.youtube.com/results?search_query=" + query, "Поиск YouTube")}</div>`;
  $("#detail").innerHTML = `<button class="subbtn side-return" data-action="back">← К списку</button>
    <div class="eyebrow">${esc(item.category)} · ${isShort ? esc(item.kind) : "Досье выпуска"}</div>
    <div class="hero"><div><h1>${esc(item.title)}</h1>
      <div class="kv"><span class="tag">${esc(item.status)}</span>${item.date ? `<span class="tag">${time(item.date)}</span>` : ""}
      ${item.related ? `<span class="tag">${esc(item.related)}</span>` : ""}</div></div>
      <div class="actions">
        <button class="subbtn" data-action="favorite" aria-pressed="${item.saved}">${item.saved ? "★ В избранном" : "☆ В избранное"}</button>
        <button class="subbtn" data-action="interest" aria-pressed="${item.author_interest}">${item.author_interest ? "♥ Мне интересно" : "♡ Мой интерес"}</button>
        <button class="subbtn" data-action="edit">Редактировать</button>
        <select class="subbtn" id="phase" aria-label="Изменить этап">${options(phases[tab], item.status)}</select>
      </div></div>
    <div class="grid">
      ${panel(isShort ? "Первая фраза" : "Главный вопрос", `<div class="quote"><p class="hook">${esc(item.hook || item.title)}</p></div>`, "c12")}
      ${panel("Зачем это «Медиастазам»", paragraph(item.why))}
      ${panel("Кому и почему будет интересно", paragraph(item.audience || item.audiences))}
      ${panel(isShort ? "Как рассказать за минуту" : "Гипотеза и альтернативное объяснение", paragraph(item.story || item.hypothesis))}
      ${panel("Что будет доказательством", paragraph(item.proof || item.research))}
      ${panel("Что увидит зритель", paragraph(item.visuals))}
      ${panel("Материалы для проверки", refs ? `<div class="source-list">${refs}</div>` : paragraph("Добавь первоисточник перед подготовкой сценария."))}
      ${panel("Редакционная оценка", `<p class="foot">${points === null ? "Итог появится после заполнения всех критериев." : `<strong>${points}/100</strong> · Редакционная оценка.`}
        ${item.author_interest ? "" : " Авторский интерес пока не отмечен."}</p><div class="score-inputs">${scores}</div>`, "c12")}
      ${panel("Сигналы по направлению", (related.length ? `<ul class="signal-inline">${related.map((signal) => `<li><span class="signal-meta">${labels[signal.kind]} · </span>${external(signal.url, signal.title)}</li>`).join("")}</ul>` : paragraph("Тематических совпадений в свежей выборке пока нет.")) + manualSearch, "c12")}
      ${panel("Редакторские заметки", `<p class="foot">Сохраняются в этом браузере.</p><textarea aria-label="Редакторские заметки" id="notes" class="edit" maxlength="8000">${esc(item.notes)}</textarea>`, "c12")}
    </div>`;
  $("#phase").onchange = (event) => { put(tab, { ...item, status: event.target.value }); render(); };
  $("#notes").oninput = (event) => { item.notes = event.target.value; put(tab, item); };
  all("[data-mark]").forEach((select) => {
    select.onchange = () => {
      item.scores[Number(select.dataset.mark)] = select.value === "" ? null : Number(select.value);
      put(tab, item);
      render();
    };
  });
}

function renderSourceStatus() {
  const states = { ok: "Доступен", stale: "Предыдущая выдача", error: "Ошибка сбора" };
  return `<section class="panel signal-section"><details><summary>Состояние источников · ${snapshot.sources.filter((s) => s.status === "ok").length} из ${snapshot.sources.length} доступны</summary>
    ${snapshot.sources.map((s) => `<div class="source-row"><div>${external(s.url, s.label)}
      <div class="signal-meta">${labels[s.kind]} · Последний успешный сбор ${time(s.lastSuccessAt, true)}</div></div>
      <div class="${s.status === "ok" ? "fresh" : "warn"}">${states[s.status]} · ${s.count}${s.message ? `<div class="signal-meta">${esc(s.message)}</div>` : ""}</div></div>`).join("")}
  </details></section>`;
}

function signalActions(kind, id) {
  return `<div class="actions"><button class="subbtn" data-create="${kind}" data-ref="${esc(id)}" data-format="topics">+ В исследование</button>
    <button class="subbtn" data-create="${kind}" data-ref="${esc(id)}" data-format="shorts">+ В короткие</button></div>`;
}

function renderSignalCards() {
  const query = signalQuery.trim().toLocaleLowerCase("ru");
  const matches = (entry) => (!signalBeat || entry.beats.includes(signalBeat)) &&
    (!query || `${entry.title} ${entry.source}`.toLocaleLowerCase("ru").includes(query));
  const cards = snapshot.signals[signalKind].filter(matches);
  const renderCard = (entry) => `<article class="panel signal-card"><div class="signal-meta">${esc(entry.source)} · ${time(entry.publishedAt)}</div>
    <h3>${external(entry.url, entry.title)}</h3>${metric(entry) ? `<div class="signal-metric">${esc(metric(entry))}</div>` : ""}
    ${entry.beats.length ? `<div class="signal-meta">${esc(entry.beats.map((id) => snapshot.beats.find((beat) => beat.id === id)?.name).filter(Boolean).join(" · "))}</div>` : ""}
    ${signalActions("item", entry.id)}</article>`;
  let shown = cards.map(renderCard).join("");
  if (signalKind === "videos" && cards.length) {
    const groups = [[false, "Обычные видео"], [true, "Короткие ролики"]];
    shown = groups.map(([short, title]) => {
      const group = cards.filter((entry) => Boolean(entry.short) === short);
      return group.length ? `<section class="signal-section"><h2>${title}</h2><div class="signal-grid">${group.map(renderCard).join("")}</div></section>` : "";
    }).join("");
  } else {
    shown = `<div class="signal-grid">${shown}</div>`;
  }
  $("#signalResults").innerHTML = cards.length ? shown : '<p class="empty">В этой выборке нет записей по фильтру.</p>';
}

function renderSignals() {
  if (!snapshot) {
    $("#detail").innerHTML = '<h1>Сигналы и источники</h1><p class="empty">Сводка недоступна. Открой сайт снова после следующего обновления.</p>';
    return;
  }
  const freshNews = snapshot.signals.news.filter((entry) => Date.parse(entry.publishedAt) > Date.parse(snapshot.generatedAt) - 259200000);
  const leads = snapshot.beats.map((beat) => {
    const entries = freshNews.filter((entry) => entry.beats.includes(beat.id));
    const sources = [...new Set(entries.map((entry) => entry.source))];
    return { beat, entries, sources };
  }).filter((item) => item.sources.length >= 2).sort((a, b) => b.sources.length - a.sources.length);
  $("#detail").innerHTML = `<div class="hero"><div><div class="eyebrow">Радар тем</div><h1>Сигналы и источники</h1>
    <p>Сбор ${time(snapshot.generatedAt, true)} мск. Плановое обновление каждые шесть часов.</p></div></div>
    ${Date.now() - Date.parse(snapshot.generatedAt) > 46800000 ? '<p class="warn" role="status">Сводка старше 13 часов. Проверь последний запуск сбора.</p>' : ""}
    <section class="signal-section"><h2>Повестка по направлениям</h2>
      <p class="foot">Подборки по ключевым словам за 72 часа. Порог показа — два разных источника.</p>
      <div class="signal-grid">${leads.map(({ beat, entries, sources }) => `<article class="panel signal-card">
        <div class="signal-meta">${entries.length} материалов · ${sources.length} источников</div>
        <h3>${esc(beat.name)}</h3>
        <ul class="signal-inline">${[...new Map(entries.map((entry) => [entry.source, entry])).values()].slice(0, 3).map((entry) => `<li>${external(entry.url, entry.title)}</li>`).join("")}</ul>
        ${signalActions("beat", beat.id)}</article>`).join("") || '<p class="empty">Совпадений у двух источников пока нет.</p>'}</div>
    </section>
    <div class="signal-toolbar" aria-label="Тип сигнала">
      ${Object.entries(labels).map(([kind, name]) => `<button type="button" class="subbtn ${kind === signalKind ? "active" : ""}" data-signal-kind="${kind}" aria-pressed="${kind === signalKind}">${name} · ${snapshot.signals[kind].length}</button>`).join("")}
    </div>
    <div class="signal-toolbar">
      <label>Направление <select class="subbtn" id="signalBeat" aria-label="Направление сигнала"><option value="">Все направления</option>
      ${snapshot.beats.map((beat) => `<option value="${esc(beat.id)}" ${signalBeat === beat.id ? "selected" : ""}>${esc(beat.name)}</option>`).join("")}</select></label>
      <input class="search" id="signalQuery" type="search" aria-label="Поиск по сигналам" placeholder="Поиск по сигналам" value="${esc(signalQuery)}">
    </div>
    <p class="foot">${{
      news: "Открытые ленты изданий и ведомств. Ссылки ведут на исходные публикации.",
      trends: "Google Trends, Россия и США. Объём приблизительный. Показаны запросы из ленты всплесков интереса.",
      videos: "Недавние публикации наблюдаемых каналов за период до 30 дней. Внутри каждого формата порядок задан числом просмотров из открытой ленты.",
      research: "Недавние журнальные статьи из Crossref. Метод и выводы проверяются по полному тексту.",
    }[signalKind]}</p><div id="signalResults"></div>${renderSourceStatus()}`;
  $("#signalBeat").onchange = (event) => { signalBeat = event.target.value; renderSignalCards(); };
  $("#signalQuery").oninput = (event) => { signalQuery = event.target.value; renderSignalCards(); };
  renderSignalCards();
}

function renderMethod() {
  $("#detail").innerHTML = `<div class="hero"><div><h1>Как выбирать темы</h1>
    <p>Сформулируй проверяемый вопрос и назови доказательство, которое зритель увидит в кадре.</p></div></div>
    <div class="grid">
      ${panel("Большой выпуск", paragraph("Нужны несколько связанных механизмов, первичные документы, данные и проверка альтернатив. Вес оценки: интерес аудитории 25%, противоречие 25%, доказательства 20%, актуальность 15%, визуальный потенциал 15%."))}
      ${panel("Короткий ролик", paragraph("Понятный вопрос в первые четыре секунды, одно доказательство и одно конкретное последствие. Четыре равных критерия: интерес, первая фраза, ясность за минуту и визуальный потенциал."))}
      ${panel("Три вида спроса", paragraph("Выраженный виден в запросах, просмотрах и обсуждениях. Скрытый обнаруживается по повторяющимся вопросам и поведению аудитории. Созданный появляется, когда знакомую ситуацию удаётся объяснить с неожиданной стороны."))}
      ${panel("Проверка темы", paragraph("Зафиксируй, что могло бы опровергнуть гипотезу. Для чисел укажи период, единицу и базу сравнения. Для исследования проверь выборку и границы вывода. Перед переводом темы в работу отметь авторский интерес."))}
      ${panel("Где смотреть данные", paragraph("Новостные ленты, Google Trends, открытые ленты наблюдаемых каналов YouTube и Crossref обновляются по расписанию. Вордстат и YouTube Studio можно открыть для ручной проверки формулировки и своей аудитории."))}
      ${panel("Рабочая копия", paragraph("Добавленные темы, отметки, баллы и заметки сохраняются в этом браузере. Для переноса на другое устройство или из версии 2.0 выгрузи файл и открой его кнопкой «Импорт». Совпадающие карточки из файла заменяют местные по идентификатору."))}
    </div>`;
}

function render(resetFilters = false) {
  const isTopic = Boolean(phases[tab]);
  $("#sidebar").hidden = !isTopic;
  $("#new").hidden = !isTopic;
  all("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
    button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  });
  if (isTopic) {
    if (resetFilters) {
      $("#q").value = "";
      $("#onlySaved").checked = false;
    }
    $("#cat").innerHTML = options([...new Set(rows().map((item) => item.category))].sort(), resetFilters ? "" : $("#cat").value, "Все направления");
    $("#state").innerHTML = options(phases[tab], resetFilters ? "" : $("#state").value, "Все этапы");
    $("#sideTitle").textContent = tab === "shorts" ? "Запас коротких роликов" : "База больших исследований";
    $("#new").textContent = tab === "shorts" ? "+ Короткий ролик" : "+ Тема";
    renderList();
    renderTopic();
  } else if (tab === "signals") renderSignals();
  else renderMethod();
}

function openEditor(type, item = null, draft = null) {
  const short = type === "shorts";
  const row = item || draft || {};
  editing = { type, item, draft };
  $("#editorTitle").textContent = item ? "Редактировать тему" : (short ? "Новый короткий ролик" : "Новое исследование");
  const input = (key, name, required = false) => `<label>${name}<input name="${key}" value="${esc(row[key])}" maxlength="300" ${required ? "required" : ""}></label>`;
  const area = (key, name) => `<label>${name}<textarea name="${key}" maxlength="8000">${esc(row[key])}</textarea></label>`;
  $("#editorFields").innerHTML = `<div class="edit-fields">${input("title", "Рабочее название", true)}
    <label>Направление<select name="category">${options([...new Set([...categories, ...(row.category ? [row.category] : [])])], row.category)}</select></label>
    ${short ? `<label>Тип сюжета<select name="kind">${options(shortKinds, row.kind)}</select></label>` : ""}
    ${area("hook", short ? "Первая фраза" : "Главный вопрос")}${area("why", "Почему подходит каналу")}
    ${area(short ? "audience" : "audiences", "Кому и почему интересно")}
    ${area(short ? "story" : "hypothesis", short ? "Ход истории" : "Гипотеза")}
    ${area(short ? "proof" : "research", "Что нужно проверить")}${area("visuals", "Как показать")}
    <label>Ссылки на источники, по одной на строку<textarea name="sources" maxlength="16000">${esc((row.sources || []).map((source) => source.url).join("\n"))}</textarea></label></div>`;
  $("#editor").showModal();
}

function createFromSignal(type, kind, id) {
  const entry = kind === "item" ? allSignals().find((signal) => signal.id === id) : null;
  const beat = snapshot.beats.find((item) => item.id === (entry ? entry.beats[0] : id));
  if (!entry && !beat) return;
  const key = `signal-${type}-${kind}-${id}`;
  const existing = rows(type).find((item) => item.id === key);
  if (existing) {
    tab = type;
    selected[type] = existing.id;
    render(true);
    notify("Эта карточка уже в базе.");
    return;
  }
  const links = entry ? [entry] : snapshot.signals.news.filter((signal) => signal.beats.includes(id)).slice(0, 6);
  const prompt = type === "shorts" ? beat?.short : beat?.long;
  openEditor(type, null, {
    id: key, title: entry?.title || prompt, hook: prompt || "", category: beat?.category,
    beats: entry?.beats || [id], sources: links.map((link) => ({ name: link.title, url: link.url })),
    [type === "shorts" ? "proof" : "research"]: beat?.proof || "",
  });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.tab) {
    tab = button.dataset.tab;
    document.body.classList.remove("mobile-detail");
    $("#main").scrollTop = 0;
    render(true);
  } else if (button.dataset.topic) {
    selected[tab] = button.dataset.topic;
    document.body.classList.add("mobile-detail");
    render();
    $("#main").scrollTop = 0;
    window.scrollTo(0, 0);
  } else if (button.dataset.signalKind) {
    signalKind = button.dataset.signalKind;
    renderSignals();
  } else if (button.dataset.create) {
    createFromSignal(button.dataset.format, button.dataset.create, button.dataset.ref);
  } else if (button.dataset.action) {
    const action = button.dataset.action;
    const item = rows().find((row) => row.id === selected[tab]);
    if (action === "back") document.body.classList.remove("mobile-detail");
    if (action === "edit") openEditor(tab, item);
    if (action === "favorite") { put(tab, { ...item, saved: !item.saved }); render(); }
    if (action === "interest") { put(tab, { ...item, author_interest: !item.author_interest }); render(); }
  }
});

$("#editorForm").onsubmit = (event) => {
  event.preventDefault();
  const { type, item, draft } = editing;
  const previous = item || draft || {};
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  if (!fields.title.trim()) return;
  const sourceUrls = fields.sources.split(/\s*\n\s*/).filter(Boolean);
  if (sourceUrls.some((entry) => !url(entry))) {
    notify("Проверь ссылки. Укажи полный адрес с https:// или http://.");
    return;
  }
  fields.sources = [...new Set(sourceUrls.map(url))].map((href) => (
    previous.sources?.find((source) => source.url === href) || { name: href, url: href }
  ));
  const record = normalize({
    id: crypto.randomUUID?.() || "manual-" + Date.now(),
    date: new Date().toISOString(), ...previous, ...fields,
  }, type);
  put(type, record);
  $("#editor").close();
  tab = type;
  selected[type] = record.id;
  document.body.classList.add("mobile-detail");
  render(true);
};

$("#new").onclick = () => openEditor(tab);
$("#cancel").onclick = () => $("#editor").close();
$("#q").oninput = () => { renderList(); renderTopic(); };
for (const selector of ["#cat", "#state", "#onlySaved"]) {
  $(selector).onchange = () => { renderList(); renderTopic(); };
}

$("#export").onclick = () => {
  const data = { format: "Медиастазы Радар тем", version: 3, exported: new Date().toISOString(), topics: rows("topics"), shorts: rows("shorts") };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  link.download = "mediastazy-radar-backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

$("#import").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (event) => {
  try {
    const file = event.target.files[0];
    if (!file || file.size > 5_000_000) throw Error();
    const data = JSON.parse(await file.text());
    if (data.format !== "Медиастазы Радар тем" || ![2, 3].includes(data.version) ||
        !Array.isArray(data.topics) || !Array.isArray(data.shorts)) throw Error();
    for (const type of ["topics", "shorts"]) local[type] = merge(local[type], loadRows(data[type], type, data.version === 2));
    if (save()) notify("Редакторская база импортирована.");
    render(true);
  } catch { notify("Не удалось импортировать файл. Нужна выгрузка «Радара тем» версии 2 или 3."); }
  finally { event.target.value = ""; }
};

async function getData(name) {
  const embedded = document.getElementById(name + "-data");
  if (embedded) return JSON.parse(embedded.textContent);
  const response = await fetch("./data/" + name + ".json", { cache: "no-cache" });
  if (!response.ok) throw Error("HTTP " + response.status);
  return response.json();
}

async function start() {
  const [topics, signals] = await Promise.allSettled([getData("topics"), getData("signals")]);
  if (topics.status === "fulfilled") {
    for (const type of ["topics", "shorts"]) base[type] = loadRows(topics.value[type], type, topics.value.version !== 3);
  }
  const saved = readLocal(storageKey);
  if (saved) {
    for (const type of ["topics", "shorts"]) local[type] = loadRows(saved[type], type);
  } else {
    local.topics = loadRows(readLocal("mediastazy_radar_2026_v1"), "topics", true);
    local.shorts = loadRows(readLocal("mediastazy_shorts_2026_v2"), "shorts", true);
  }
  if (signals.status === "fulfilled") snapshot = signals.value;
  const stamp = snapshot?.generatedAt;
  $("#update").textContent = stamp ? `Сбор сигналов · ${time(stamp, true)} мск` : "Сводка сигналов недоступна";
  if (topics.status === "rejected") notify("Базу тем не удалось загрузить. Можно открыть автономную копию.");
  render(true);
}

start();
