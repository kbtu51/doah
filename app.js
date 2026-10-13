'use strict';

/* ================= Справочники ================= */

const GROUPS = [
  { id: 'chest', name: 'Грудь', color: '#ff7a59' },
  { id: 'back', name: 'Спина', color: '#4cc2ff' },
  { id: 'legs', name: 'Ноги', color: '#3ddc97' },
  { id: 'shoulders', name: 'Плечи', color: '#f5b544' },
  { id: 'biceps', name: 'Бицепс', color: '#c38bff' },
  { id: 'triceps', name: 'Трицепс', color: '#ff6bb5' },
  { id: 'abs', name: 'Пресс', color: '#ffd84d' },
  { id: 'cardio', name: 'Кардио', color: '#5ee7e7' },
];
const GROUP = Object.fromEntries(GROUPS.map(g => [g.id, g]));

const DEFAULTS = { sleep: 7.5, weight: 75 };
const LIMITS = { sleep: [0, 16], weight: [30, 250] };
const FOOD_WORDS = ['', 'сорвался', 'сорвался', 'плохо', 'так себе', 'так себе', 'нормально', 'нормально', 'хорошо', 'отлично', 'идеально'];

/* ================= Даты ================= */

const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);

const fmt = (opts) => new Intl.DateTimeFormat('ru-RU', opts);
const fmtLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fmtDM = fmt({ day: 'numeric', month: 'short' });
const fmtWd = fmt({ weekday: 'short' });
const fmtMonth = fmt({ month: 'long', year: 'numeric' });
const fmtMonthShort = fmt({ month: 'short' });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const num = (v, d = 1) => v.toFixed(d).replace('.', ',');

/* ================= Хранилище (IndexedDB) ================= */

const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('doah', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  },
  all: () => DB.tx('days', 'readonly', s => s.getAll()),
  put: day => DB.tx('days', 'readwrite', s => s.put(day)),
  del: date => DB.tx('days', 'readwrite', s => s.delete(date)),
  getMeta: key => DB.tx('meta', 'readonly', s => s.get(key)).then(r => r && r.value),
  setMeta: (key, value) => DB.tx('meta', 'readwrite', s => s.put({ key, value })),
  getPhoto: id => DB.tx('photos', 'readonly', s => s.get(id)),
  putPhoto: p => DB.tx('photos', 'readwrite', s => s.put(p)),
  delPhoto: id => DB.tx('photos', 'readwrite', s => s.delete(id)),
  allPhotos: () => DB.tx('photos', 'readonly', s => s.getAll()),
};

/* ================= Фото ================= */

const MAX_PHOTOS = 4;

/** Сжимает фото: длинная сторона до max px, JPEG */
async function shrink(blob, max, quality) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}

const thumbUrls = new Map(); // id -> objectURL миниатюры
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const p = await DB.getPhoto(id);
  if (!p) return null;
  const u = URL.createObjectURL(p.thumb || p.blob);
  thumbUrls.set(id, u);
  return u;
}

/** Рисует миниатюры фото в контейнер (асинхронно подгружает картинки) */
function photoThumbs(ids) {
  return (ids || []).map(id => `<span class="ph" role="button" data-photo="${id}"><img data-thumb="${id}" alt=""></span>`).join('');
}
function fillThumbs(root) {
  root.querySelectorAll('img[data-thumb]:not([src])').forEach(async img => {
    const u = await thumbUrl(img.dataset.thumb);
    if (u) img.src = u;
  });
}

async function addPhotos(files) {
  const date = state.date;
  const d = { ...getDay(date) };
  const ids = [...(d.photos || [])];
  const room = MAX_PHOTOS - ids.length;
  if (room <= 0) { toast(`Максимум ${MAX_PHOTOS} фото на день`); return; }
  const list = [...files].slice(0, room);
  if (files.length > room) toast(`Добавлю только ${room} — максимум ${MAX_PHOTOS} на день`);
  for (const f of list) {
    try {
      const blob = await shrink(f, 1600, 0.82);
      const thumb = await shrink(blob, 320, 0.7);
      const id = `${date}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await DB.putPhoto({ id, date, blob, thumb });
      ids.push(id);
    } catch (e) {
      console.error(e); toast('Не получилось открыть фото');
    }
  }
  d.photos = ids;
  if (!d.photos.length) delete d.photos;
  await saveDay(d);
  if (state.date === date) renderToday();
}

let viewing = null;
async function openPhoto(id, canDelete) {
  const p = await DB.getPhoto(id);
  if (!p) return;
  viewing = { id, url: URL.createObjectURL(p.blob) };
  $('#photoImg').src = viewing.url;
  $('#pvDelete').hidden = !canDelete;
  $('#photoView').showModal();
}
function closePhoto() {
  $('#photoView').close();
}

async function deletePhoto(id) {
  const p = await DB.getPhoto(id);
  const date = p ? p.date : state.date;
  const d = { ...getDay(date) };
  d.photos = (d.photos || []).filter(x => x !== id);
  if (!d.photos.length) delete d.photos;
  await DB.delPhoto(id);
  if (thumbUrls.has(id)) { URL.revokeObjectURL(thumbUrls.get(id)); thumbUrls.delete(id); }
  await saveDay(d);
  renderAll();
}

/* ================= Состояние ================= */

const days = new Map(); // date -> запись
const state = {
  view: 'today',
  date: todayKey(),
  range: 30,
  month: todayKey().slice(0, 7),
  calSel: null,
  dMonth: todayKey().slice(0, 7),
  query: '',
  profile: null,     // норма питания
  myFoods: [],       // «Мои блюда»
  dishCat: 'main',
  openDish: null,
  editFoods: false,
  lastExport: null,
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function getDay(date) {
  return days.get(date) || { date };
}

function isEmpty(d) {
  return d.sleep == null && d.food == null && d.weight == null && d.sys == null && d.dia == null
    && !(d.workout && d.workout.length) && !d.rest && !(d.note && d.note.trim()) && !(d.photos && d.photos.length) && !(d.meals && d.meals.length);
}

let persistAsked = false;
async function saveDay(d) {
  d.updated = Date.now();
  if (isEmpty(d)) { days.delete(d.date); await DB.del(d.date); }
  else { days.set(d.date, d); await DB.put(d); }
  flashSaved();
  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
}

function update(field, value) {
  const d = { ...getDay(state.date) };
  if (value == null) delete d[field]; else d[field] = value;
  saveDay(d);
  renderToday();
}

/** Последнее значение поля до указанной даты */
function lastBefore(field, date) {
  let best = null;
  for (const d of days.values()) {
    if (d.date < date && d[field] != null && (!best || d.date > best.date)) best = d;
  }
  return best;
}

const sortedDays = () => [...days.values()].sort((a, b) => a.date < b.date ? -1 : 1);

/* ================= Сегодня ================= */

function dayTitle(k) {
  const diff = daysBetween(k, todayKey());
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  if (diff === 2) return 'Позавчера';
  return cap(fmtDM.format(parseKey(k)));
}

function renderToday() {
  const d = getDay(state.date);
  const today = todayKey();

  $('#dayTitle').textContent = dayTitle(state.date);
  $('#daySub').textContent = cap(fmtLong.format(parseKey(state.date)));
  $('#nextDay').style.visibility = state.date >= today ? 'hidden' : 'visible';

  // Прогресс заполнения
  const done = [d.sleep != null, d.food != null, !!(d.workout && d.workout.length) || !!d.rest, d.weight != null];
  $$('#progress span').forEach((s, i) => s.classList.toggle('done', done[i]));
  $$('.card').forEach(c => {
    const m = c.dataset.metric;
    const f = { sleep: done[0], food: done[1], workout: done[2], weight: done[3], bp: d.sys != null }[m];
    c.classList.toggle('filled', !!f);
  });

  // Сон
  renderStepper('sleep', d, 'ч', 1);
  const wk = [];
  for (let i = 1; i <= 7; i++) { const x = days.get(addDays(state.date, -i)); if (x && x.sleep != null) wk.push(x.sleep); }
  $('#sleepHint').textContent = wk.length >= 3 ? `в среднем ${num(avg(wk))} ч за неделю` : '';

  // Питание
  const fs = $('#foodScale');
  if (!fs.children.length) {
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement('button');
      b.textContent = i; b.dataset.v = i;
      b.style.setProperty('--sc', foodColor(i));
      fs.appendChild(b);
    }
  }
  [...fs.children].forEach(b => {
    const v = +b.dataset.v;
    b.classList.toggle('on', d.food === v);
    b.classList.toggle('in', d.food != null && v < d.food);
  });
  const kc = dayKcal(d);
  $('#foodHint').textContent = [d.food ? FOOD_WORDS[d.food] : (kc ? '' : 'насколько чисто ел'), kc ? `${kc} ккал` : ''].filter(Boolean).join(' · ');

  // Тренировка
  const wc = $('#workoutChips');
  if (!wc.children.length) {
    for (const g of GROUPS) wc.appendChild(chip(g.id, g.name, g.color));
    const r = chip('rest', 'Отдых', null); r.classList.add('rest'); wc.appendChild(r);
  }
  const sel = new Set(d.workout || []);
  [...wc.children].forEach(c => c.classList.toggle('on', c.dataset.g === 'rest' ? !!d.rest : sel.has(c.dataset.g)));
  const monthCount = [...days.values()].filter(x => x.date.slice(0, 7) === state.date.slice(0, 7) && x.workout && x.workout.length).length;
  $('#workoutHint').textContent = sel.size ? `${monthCount}-я в этом месяце` : (monthCount ? `${monthCount} в этом месяце` : '');

  // Вес
  renderStepper('weight', d, 'кг', 1);
  const prevW = lastBefore('weight', state.date);
  if (d.weight != null && prevW) {
    const diff = d.weight - prevW.weight;
    $('#weightHint').textContent = Math.abs(diff) < 0.05 ? 'как в прошлый раз' : `${diff > 0 ? '+' : '−'}${num(Math.abs(diff))} к прошлому`;
  } else $('#weightHint').textContent = '';

  // Давление
  for (const [id, f] of [['#bpSys', 'sys'], ['#bpDia', 'dia']]) {
    const el = $(id);
    if (document.activeElement !== el) el.value = d[f] ?? '';
  }
  $('#bpHint').textContent = d.sys && d.dia ? bpLabel(d.sys, d.dia) : '';

  // Дневник
  const ta = $('#noteText');
  if (document.activeElement !== ta) { ta.value = d.note || ''; growNote(); }
  const ph = d.photos || [];
  $('#notePhotos').innerHTML = photoThumbs(ph) + (ph.length < MAX_PHOTOS
    ? `<label class="add" for="photoInput"><svg viewBox="0 0 24 24"><path d="M4 8a2 2 0 0 1 2-2h2l2-2h4l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>Фото</label>` : '');
  fillThumbs($('#notePhotos'));
  $('#noteHint').textContent = ph.length ? `${ph.length} фото` : '';

  renderNag();
}

function chip(id, name, color) {
  const b = document.createElement('button');
  b.className = 'chip'; b.dataset.g = id; b.textContent = name;
  if (color) b.style.setProperty('--gc', color);
  return b;
}

function renderStepper(field, d, unit, digits) {
  const btn = $(`#${field}Value`);
  if (d[field] != null) {
    btn.className = 'value';
    btn.innerHTML = `${num(d[field], digits)}<span class="unit">${unit}</span>`;
  } else {
    const last = lastBefore(field, state.date);
    btn.className = 'value empty';
    btn.textContent = last ? `Нажми: ${num(last[field], digits)} ${unit}, как в прошлый раз` : (field === 'sleep' ? 'Сколько спал?' : 'Сколько весишь?');
  }
}

function baseValue(field) {
  const last = lastBefore(field, state.date);
  return last ? last[field] : DEFAULTS[field];
}

function clampRound(field, v) {
  const [lo, hi] = LIMITS[field];
  const step = field === 'sleep' ? 0.5 : 0.1;
  v = Math.round(v / step) * step;
  return +Math.min(hi, Math.max(lo, v)).toFixed(1);
}

function onStep(field, delta) {
  const cur = getDay(state.date)[field];
  update(field, clampRound(field, (cur ?? baseValue(field)) + (cur == null ? 0 : delta)));
}

function onValueTap(field) {
  const cur = getDay(state.date)[field];
  if (cur == null) { update(field, baseValue(field)); return; }
  // Ручной ввод
  const btn = $(`#${field}Value`);
  const input = document.createElement('input');
  input.className = 'value-input';
  input.inputMode = 'decimal';
  input.value = num(cur);
  btn.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const raw = input.value.trim().replace(',', '.');
    input.replaceWith(btn);
    if (raw === '') update(field, null);
    else if (!isNaN(+raw)) update(field, clampRound(field, +raw));
    else renderToday();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
}

function foodColor(v) {
  // 1 — красный, 5 — янтарный, 10 — зелёный
  const stops = [[1, [255, 107, 107]], [5, [245, 181, 68]], [10, [61, 220, 151]]];
  let a = stops[0], b = stops[1];
  if (v > 5) { a = stops[1]; b = stops[2]; }
  const t = (v - a[0]) / (b[0] - a[0]);
  const c = a[1].map((x, i) => Math.round(x + (b[1][i] - x) * t));
  return `rgb(${c.join(',')})`;
}

function bpLabel(s, d) {
  if (s >= 140 || d >= 90) return 'высокое';
  if (s >= 130 || d >= 85) return 'повышенное';
  if (s < 90 || d < 60) return 'пониженное';
  return 'норма';
}

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

let savedTimer;
function flashSaved() {
  const el = $('#savedNote');
  el.textContent = 'Сохранено ✓';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.textContent = 'Всё сохраняется само'; }, 1500);
}

function renderNag() {
  const box = $('#backupNag');
  const n = days.size;
  const since = state.lastExport ? daysBetween(keyOf(new Date(state.lastExport)), todayKey()) : null;
  if (n >= 5 && (since == null || since >= 7)) {
    box.innerHTML = `<div class="nag"><span>${since == null ? 'Ты ещё ни разу не сохранял копию данных' : `Копии не было ${since} ${plural(since, 'день', 'дня', 'дней')}`}</span><button id="nagBtn">Сохранить</button></div>`;
    $('#nagBtn').onclick = exportData;
  } else box.innerHTML = '';
}

function growNote() {
  const ta = $('#noteText');
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 3 + 'px';
}

let noteTimer, notePending = null;
function onNoteInput() {
  growNote();
  notePending = { date: state.date, text: $('#noteText').value };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 600);
}
function flushNote() {
  clearTimeout(noteTimer);
  if (!notePending) return;
  const { date, text } = notePending;
  notePending = null;
  const d = { ...getDay(date) };
  if ((d.note || '') === text) return;
  if (text.trim()) d.note = text; else delete d.note;
  saveDay(d);
}

/* ================= Дневник ================= */

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dayMeta(d) {
  const m = [];
  if (d.workout && d.workout.length) m.push('🏋 ' + d.workout.map(g => GROUP[g] ? GROUP[g].name : g).join(', '));
  if (d.sleep != null) m.push(`сон ${num(d.sleep)} ч`);
  if (d.food != null) m.push(`еда ${d.food}`);
  return m.join(' · ');
}

function diaryRow(k, opts = {}) {
  const d = days.get(k) || { date: k };
  const dt = parseKey(k);
  const wd = dt.getDay();
  const cls = ['diary-row'];
  if (wd === 0 || wd === 6) cls.push('weekend');
  if (k === todayKey()) cls.push('today');
  let txt;
  if (d.note) {
    txt = esc(d.note);
    if (opts.q) txt = txt.replace(new RegExp(escRe(esc(opts.q)), 'gi'), m => `<mark>${m}</mark>`);
  } else { cls.push('blank'); txt = '—'; }
  const meta = dayMeta(d);
  const label = opts.full ? `${fmtMonthShort.format(dt).replace('.', '')} ${dt.getFullYear()}` : fmtWd.format(dt);
  return `<button class="${cls.join(' ')}" data-date="${k}"><div class="dn"><b>${dt.getDate()}</b><span>${label}</span></div>
    <div><div class="txt">${txt}</div>${meta ? `<div class="meta">${meta}</div>` : ''}${d.photos && d.photos.length ? `<div class="photos">${photoThumbs(d.photos)}</div>` : ''}</div></button>`;
}

function renderDiary() {
  const today = todayKey();
  const q = state.query.trim().toLowerCase();
  const list = $('#diaryList');

  $('#prevDMonth').parentElement.hidden = !!q;
  if (q) {
    const found = sortedDays().reverse().filter(d => d.note && d.note.toLowerCase().includes(q));
    $('#memory').innerHTML = `<p class="muted small" style="margin:0 4px 6px">${found.length ? `Нашлось: ${found.length}` : 'Ничего не нашлось'}</p>`;
    list.innerHTML = found.map(d => diaryRow(d.date, { q, full: true })).join('');
    fillThumbs(list);
    return;
  }

  const [y, m] = state.dMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysIn = new Date(y, m, 0).getDate();
  $('#dMonthTitle').textContent = cap(fmtMonth.format(first)).replace(' г.', '');
  const written = [...days.values()].filter(d => d.date.slice(0, 7) === state.dMonth && (d.note || (d.photos && d.photos.length))).length;
  $('#dMonthSub').textContent = written ? `записей: ${written}` : 'записей нет';
  $('#nextDMonth').style.visibility = state.dMonth >= today.slice(0, 7) ? 'hidden' : 'visible';

  // «В этот день» — год назад и раньше
  let mem = '';
  if (state.dMonth === today.slice(0, 7)) {
    for (let yAgo = 1; yAgo <= 10; yAgo++) {
      const k = `${+today.slice(0, 4) - yAgo}${today.slice(4)}`;
      const d = days.get(k);
      if (d && (d.note || (d.photos && d.photos.length))) {
        mem += `<div class="memory"><div class="lbl">В этот день ${yAgo === 1 ? 'год' : yAgo + ' ' + plural(yAgo, 'год', 'года', 'лет')} назад</div>${diaryRow(k, { full: true })}</div>`;
      }
    }
  }
  $('#memory').innerHTML = mem;

  let html = '';
  for (let dn = 1; dn <= daysIn; dn++) {
    const k = `${state.dMonth}-${pad(dn)}`;
    if (k > today) break;
    html += diaryRow(k);
  }
  list.innerHTML = html || '<p class="muted small" style="text-align:center">Этот месяц ещё не начался</p>';
  fillThumbs(list);
  fillThumbs($('#memory'));
}

/* ================= Питание ================= */

const ACT_K = [1.2, 1.375, 1.55, 1.725]; // 0, 1–2, 3–4, 5+ тренировок в неделю
const dayKcal = d => (d.meals || []).reduce((a, m) => a + (m.k || 0), 0);
const dayProt = d => (d.meals || []).reduce((a, m) => a + (m.p || 0), 0);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function currentWeight(beforeOrOn) {
  const d = days.get(beforeOrOn);
  if (d && d.weight != null) return d.weight;
  const last = lastBefore('weight', beforeOrOn);
  return last ? last.weight : (state.profile && state.profile.weight) || null;
}

/** Норма по формуле Миффлина — Сан Жеора с дефицитом под темп */
function calcNorm(pf, weight) {
  if (!pf || !pf.age || !pf.height || !weight) return null;
  const bmr = 10 * weight + 6.25 * pf.height - 5 * pf.age + (pf.sex === 'f' ? -161 : 5);
  const tdee = bmr * ACT_K[pf.act ?? 1];
  const losing = pf.goal && pf.goal < weight - 0.2;
  const deficit = losing ? (pf.pace || 0.5) * 7700 / 7 : 0;
  const floor = Math.max(bmr, pf.sex === 'f' ? 1200 : 1500);
  const target = Math.round(Math.max(floor, tdee - deficit) / 10) * 10;
  const realDeficit = tdee - target;
  const protein = Math.round((pf.goal && losing ? Math.max(pf.goal, weight * 0.9) : weight) * 1.8);
  let weeks = null;
  if (losing && realDeficit > 50) weeks = Math.ceil((weight - pf.goal) * 7700 / (realDeficit * 7));
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), target, protein, weeks, losing, clamped: target > tdee - deficit + 5 };
}

function normText(n) {
  if (!n) return '<span class="muted">Заполни возраст, рост и вес — посчитаю норму.</span>';
  let s = `Норма: <b>${n.target}</b> ккал в день, белок <b>${n.protein}</b> г`;
  s += `<div class="muted">Расход без диеты ≈ ${n.tdee} ккал.`;
  if (n.weeks) {
    const end = new Date(); end.setDate(end.getDate() + n.weeks * 7);
    s += ` Цель примерно к ${fmtDM.format(end).replace('.', '')} ${end.getFullYear()} (${n.weeks} ${plural(n.weeks, 'неделя', 'недели', 'недель')}).`;
  } else if (!n.losing) s += ' Цель — держать вес.';
  if (n.clamped) s += ' Темп урезан: ниже этой нормы есть опасно, будет срываться.';
  return s + '</div>';
}

function renderFood() {
  const today = todayKey();
  const d = getDay(state.date);
  $('#fDayTitle').textContent = dayTitle(state.date);
  $('#fDaySub').textContent = cap(fmtLong.format(parseKey(state.date)));
  $('#nextFDay').style.visibility = state.date >= today ? 'hidden' : 'visible';

  // Сводка
  const norm = calcNorm(state.profile, currentWeight(state.date));
  const kc = dayKcal(d), pr = dayProt(d);
  const sum = $('#foodSummary');
  if (!norm) {
    sum.innerHTML = `<div class="setup-card"><p><b>Посчитаем норму</b><br><span class="muted small">Возраст, рост, вес и цель — 20 секунд. Без этого можно просто записывать еду.</span></p><button class="btn primary" id="openProfile2">Настроить</button></div>`
      + (kc ? `<div class="fsum" style="margin-top:10px"><div class="left">Съедено</div><div class="big">${kc} <small>ккал · белок ${pr} г</small></div></div>` : '');
    $('#openProfile2').onclick = openProfile;
  } else {
    const left = norm.target - kc;
    const pct = Math.min(100, kc / norm.target * 100);
    const ppct = Math.min(100, pr / norm.protein * 100);
    sum.innerHTML = `<div class="fsum">
      <div class="left">${left >= 0 ? 'Осталось' : 'Перебор'}</div>
      <div class="big ${left < 0 ? 'over' : ''}">${Math.abs(left)} <small>ккал</small></div>
      <div class="meter" style="--mc:${left < 0 ? 'var(--bp)' : 'var(--food)'}"><div class="lbl"><span>Калории</span><span>${kc} / ${norm.target}</span></div><div class="track"><span style="width:${pct}%"></span></div></div>
      <div class="meter" style="--mc:var(--weight)"><div class="lbl"><span>Белок</span><span>${pr} / ${norm.protein} г</span></div><div class="track"><span style="width:${ppct}%"></span></div></div>
      <div class="foot"><span>${weekLine(norm)}</span><button class="link" id="openProfile2">Норма</button></div></div>`;
    $('#openProfile2').onclick = openProfile;
  }

  // Съел
  const ml = $('#mealList');
  const meals = d.meals || [];
  ml.innerHTML = meals.length ? meals.map(m => `<div class="meal"><div class="mn"><div>${esc(m.n)}</div><small>${m.p ? `белок ${m.p} г` : ''}</small></div><div class="mk">${m.k} ккал</div><button class="x" data-del="${m.id}" aria-label="Убрать">×</button></div>`).join('')
    : '<p class="empty-note">Пока пусто. Тапни блюдо ниже или добавь своё.</p>';

  // Мои блюда
  const mf = $('#myFoods');
  mf.classList.toggle('editing', state.editFoods);
  $('#editMyFoods').textContent = state.editFoods ? 'Готово' : 'Изменить';
  $('#editMyFoods').hidden = !state.myFoods.length;
  const sorted = state.myFoods.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0));
  mf.innerHTML = sorted.map(f => `<button class="chip" data-my="${f.id}">${esc(f.n)} <small>${f.k}</small></button>`).join('')
    + (state.editFoods ? '' : '<button class="chip add" id="addMeal">+ Своё блюдо</button>');

  // Подборка
  const cats = $('#dishCats');
  cats.innerHTML = FOOD_CATS.map(c => `<button class="chip ${c.id === state.dishCat ? 'on' : ''}" data-cat="${c.id}">${c.name}</button>`).join('');
  const fit = $('#fitOnly').checked && norm;
  const left = norm ? norm.target - kc : Infinity;
  let list = FOOD_BASE.filter(x => x.c === state.dishCat);
  const hidden = fit ? list.filter(x => x.k > left).length : 0;
  if (fit) list = list.filter(x => x.k <= left);
  list.sort((a, b) => (b.p / b.k) - (a.p / a.k)); // сначала самые белковые на калорию
  $('#dishList').innerHTML = list.map(x => `<div class="dish">
      <button data-dish="${x.id}"><div class="dn">${x.n}<small>${x.w}</small></div><div class="dk">${x.k}<small>белок ${x.p} г</small></div></button>
      ${state.openDish === x.id ? `<div class="more">${x.r ? `<p>${x.r}</p>` : ''}<div class="acts"><button class="btn primary" data-eat="${x.id}">Съел</button><button class="btn" data-keep="${x.id}">В мои блюда</button></div></div>` : ''}
    </div>`).join('')
    + (!list.length ? `<p class="empty-note">${hidden ? 'В остаток ничего из этого не влезает. Сними галочку, чтобы увидеть всё.' : 'Пусто.'}</p>` : '')
    + (list.length && hidden ? `<p class="empty-note">Ещё ${hidden} не влезают в остаток.</p>` : '');
}

function weekLine(norm) {
  // Средний перебор/недобор за 7 дней по дням, где есть записи еды
  const arr = [];
  for (let i = 0; i < 7; i++) { const x = days.get(addDays(state.date, -i)); if (x && x.meals && x.meals.length) arr.push(dayKcal(x)); }
  if (arr.length < 2) return norm.weeks ? `до цели ≈ ${norm.weeks} ${plural(norm.weeks, 'неделя', 'недели', 'недель')}` : '';
  return `за неделю в среднем ${Math.round(avg(arr))} ккал/день`;
}

function addMeal(item) {
  const d = { ...getDay(state.date) };
  d.meals = [...(d.meals || []), { id: uid(), n: item.n, k: Math.round(item.k) || 0, p: Math.round(item.p) || 0 }];
  saveDay(d);
  toast(`+ ${item.k} ккал`);
  renderFood();
}

function removeMeal(id) {
  const d = { ...getDay(state.date) };
  d.meals = (d.meals || []).filter(m => m.id !== id);
  if (!d.meals.length) delete d.meals;
  saveDay(d);
  renderFood();
}

async function saveMyFoods() {
  await DB.setMeta('myFoods', state.myFoods);
}

function rememberFood(item) {
  const same = state.myFoods.find(f => f.n.toLowerCase() === item.n.toLowerCase());
  if (same) { same.k = item.k; same.p = item.p; }
  else state.myFoods.push({ id: uid(), n: item.n, k: Math.round(item.k), p: Math.round(item.p) || 0, uses: 0 });
  saveMyFoods();
}

function openMealDlg() {
  $('#mName').value = ''; $('#mKcal').value = ''; $('#mProt').value = '';
  $('#mRemember').checked = true;
  $('#mealDlg').showModal();
  setTimeout(() => $('#mName').focus(), 50);
}

function saveMealDlg() {
  const n = $('#mName').value.trim();
  const k = +$('#mKcal').value;
  const p = +$('#mProt').value || 0;
  if (!n) { toast('Напиши, что съел'); return; }
  if (!k || k < 0 || k > 5000) { toast('Укажи калории'); return; }
  const item = { n, k, p };
  if ($('#mRemember').checked) rememberFood(item);
  $('#mealDlg').close();
  addMeal(item);
}

/* --- Профиль / норма --- */

function segVal(id) { const b = $(`#${id} .on`); return b ? b.dataset.v : null; }
function setSeg(id, v) { $$(`#${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); }
const numIn = id => { const v = parseFloat(($(`#${id}`).value || '').replace(',', '.')); return isNaN(v) ? null : v; };

function readProfileForm() {
  return {
    sex: segVal('pfSex') || 'm',
    age: numIn('pfAge'), height: numIn('pfHeight'),
    weight: numIn('pfWeight'), goal: numIn('pfGoal'),
    act: +(segVal('pfAct') ?? 1), pace: +(segVal('pfPace') ?? 0.5),
  };
}

function openProfile() {
  const pf = state.profile || {};
  const w = currentWeight(todayKey());
  setSeg('pfSex', pf.sex || 'm'); setSeg('pfAct', pf.act ?? 1); setSeg('pfPace', pf.pace ?? 0.5);
  $('#pfAge').value = pf.age ?? ''; $('#pfHeight').value = pf.height ?? '';
  $('#pfWeight').value = w != null ? num(w) : ''; $('#pfGoal').value = pf.goal != null ? num(pf.goal) : '';
  updateProfileCalc();
  $('#profileDlg').showModal();
}

function updateProfileCalc() {
  const f = readProfileForm();
  $('#pfResult').innerHTML = normText(calcNorm(f, f.weight));
}

async function saveProfile() {
  const f = readProfileForm();
  if (!f.age || !f.height || !f.weight) { toast('Нужны возраст, рост и вес'); return; }
  if (f.age < 14 || f.age > 90 || f.height < 120 || f.height > 230 || f.weight < 30 || f.weight > 250) { toast('Проверь цифры'); return; }
  state.profile = f;
  await DB.setMeta('profile', f);
  // Вес из формы записываем в сегодняшний день, если сегодня его ещё нет
  const t = getDay(todayKey());
  if (t.weight == null) await saveDay({ ...t, weight: clampRound('weight', f.weight) });
  $('#profileDlg').close();
  toast('Норма сохранена');
  renderAll();
}

function bindFood() {
  $('#prevFDay').onclick = () => { state.date = addDays(state.date, -1); renderFood(); };
  $('#nextFDay').onclick = () => { if (state.date < todayKey()) { state.date = addDays(state.date, 1); renderFood(); } };
  $('#mealList').onclick = e => { const b = e.target.closest('[data-del]'); if (b) removeMeal(b.dataset.del); };
  $('#myFoods').onclick = e => {
    if (e.target.closest('#addMeal')) { openMealDlg(); return; }
    const c = e.target.closest('[data-my]'); if (!c) return;
    const f = state.myFoods.find(x => x.id === c.dataset.my); if (!f) return;
    if (state.editFoods) {
      state.myFoods = state.myFoods.filter(x => x !== f);
      saveMyFoods(); if (!state.myFoods.length) state.editFoods = false;
      renderFood(); return;
    }
    f.uses = (f.uses || 0) + 1; saveMyFoods();
    addMeal(f);
  };
  $('#editMyFoods').onclick = () => { state.editFoods = !state.editFoods; renderFood(); };
  $('#dishCats').onclick = e => { const c = e.target.closest('[data-cat]'); if (!c) return; state.dishCat = c.dataset.cat; state.openDish = null; renderFood(); };
  $('#fitOnly').onchange = renderFood;
  $('#dishList').onclick = e => {
    const eat = e.target.closest('[data-eat]'), keep = e.target.closest('[data-keep]'), row = e.target.closest('[data-dish]');
    if (eat) { const x = FOOD_BASE.find(f => f.id === eat.dataset.eat); state.openDish = null; addMeal(x); return; }
    if (keep) { const x = FOOD_BASE.find(f => f.id === keep.dataset.keep); rememberFood(x); toast('Добавил в «Мои блюда»'); renderFood(); return; }
    if (row) { state.openDish = state.openDish === row.dataset.dish ? null : row.dataset.dish; renderFood(); }
  };
  $('#mSave').onclick = saveMealDlg;
  $('#mealForm').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveMealDlg(); } });
  for (const id of ['pfSex', 'pfAct', 'pfPace']) {
    $(`#${id}`).onclick = e => { const b = e.target.closest('button'); if (!b) return; setSeg(id, b.dataset.v); updateProfileCalc(); };
  }
  $('#profileForm').addEventListener('input', updateProfileCalc);
  $('#pfSave').onclick = saveProfile;
  for (const id of ['profileDlg', 'mealDlg']) $(`#${id}`).addEventListener('click', e => { if (e.target.id === id) $(`#${id}`).close(); });
}

/* ================= Хронология ================= */

function renderTimeline() {
  const today = todayKey();
  const all = sortedDays();
  const from = state.range ? addDays(today, -(state.range - 1)) : (all[0] ? all[0].date : today);
  const list = all.filter(d => d.date >= from && d.date <= today);
  const span = Math.max(1, daysBetween(from, today));

  const pts = f => list.filter(d => d[f] != null).map(d => ({ x: daysBetween(from, d.date), y: d[f], date: d.date }));
  const charts = [];

  // Вес
  const w = pts('weight');
  {
    let sub = '';
    if (w.length >= 2) {
      const diff = w[w.length - 1].y - w[0].y;
      sub = `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${num(Math.abs(diff))} кг за период · мин ${num(Math.min(...w.map(p => p.y)))} · макс ${num(Math.max(...w.map(p => p.y)))}`;
    }
    charts.push(chartCard('Вес', w.length ? `${num(w[w.length - 1].y)} кг` : '', sub, 'var(--weight)',
      w.length >= 2 ? lineChart([{ pts: w, color: 'var(--weight)' }], span, from, { area: true }) : null));
  }

  // Сон
  const s = pts('sleep');
  charts.push(chartCard('Сон', s.length ? `${num(avg(s.map(p => p.y)))} ч` : '', s.length ? `в среднем · ${s.length} ${plural(s.length, 'ночь', 'ночи', 'ночей')} записано` : '', 'var(--sleep)',
    s.length ? barChart(s, span, from, 'var(--sleep)', { min: 0, max: Math.max(10, ...s.map(p => p.y)), ref: 8 }) : null));

  // Питание
  const f = pts('food');
  charts.push(chartCard('Питание', f.length ? `${num(avg(f.map(p => p.y)))} / 10` : '', f.length ? 'в среднем' : '', 'var(--food)',
    f.length ? barChart(f, span, from, null, { min: 0, max: 10, colorFn: foodColor }) : null));

  // Калории (только если записывал еду)
  const kcPts = list.filter(d => d.meals && d.meals.length).map(d => ({ x: daysBetween(from, d.date), y: dayKcal(d) }));
  if (kcPts.length) {
    const norm = calcNorm(state.profile, currentWeight(today));
    const mx = Math.max(norm ? norm.target * 1.3 : 0, ...kcPts.map(p => p.y));
    charts.push(chartCard('Калории', `${Math.round(avg(kcPts.map(p => p.y)))}`, `в среднем за день${norm ? ` · норма ${norm.target}` : ''} · ${kcPts.length} ${plural(kcPts.length, 'день', 'дня', 'дней')} записано`, 'var(--food)',
      barChart(kcPts, span, from, null, { min: 0, max: mx, ref: norm ? norm.target : null, colorFn: v => norm && v > norm.target ? 'var(--bp)' : 'var(--food)' })));
  }

  // Давление
  const sys = pts('sys'), dia = pts('dia');
  charts.push(chartCard('Давление', sys.length ? `${sys[sys.length - 1].y}/${dia.length ? dia[dia.length - 1].y : '–'}` : '',
    sys.length ? `последнее · в среднем ${Math.round(avg(sys.map(p => p.y)))}/${dia.length ? Math.round(avg(dia.map(p => p.y))) : '–'}` : '', 'var(--bp)',
    sys.length >= 2 ? lineChart([{ pts: sys, color: 'var(--bp)' }, { pts: dia, color: 'color-mix(in srgb, var(--bp) 55%, var(--muted))' }], span, from, { refs: [120, 80] }) : null));

  // Тренировки — сводка
  const tr = list.filter(d => d.workout && d.workout.length).length;
  const weeks = Math.max(1, (span + 1) / 7);
  charts.push(`<div class="chart-card"><div class="chart-head"><h2>Тренировки</h2><span class="big" style="color:var(--workout)">${tr}</span></div>
    <div class="chart-sub">${tr ? `≈ ${num(tr / weeks)} в неделю` : 'пока не было'}</div></div>`);

  $('#charts').innerHTML = charts.join('');

  // Лента дней
  const feed = $('#feed');
  if (!list.length) { feed.innerHTML = `<p class="muted small" style="text-align:center">Пока пусто. Заполни «Сегодня» — и здесь начнёт расти твоя история.</p>`; return; }
  feed.innerHTML = list.slice().reverse().map(d => {
    const dt = parseKey(d.date);
    const v = [];
    if (d.sleep != null) v.push(`<i style="--c:var(--sleep)">${num(d.sleep)} ч</i>`);
    if (d.food != null) v.push(`<i style="--c:${foodColor(d.food)}">еда ${d.food}</i>`);
    if (d.meals && d.meals.length) v.push(`<i style="--c:var(--food)">${dayKcal(d)} ккал</i>`);
    if (d.weight != null) v.push(`<i style="--c:var(--weight)">${num(d.weight)} кг</i>`);
    if (d.sys != null) v.push(`<i style="--c:var(--bp)">${d.sys}/${d.dia ?? '–'}</i>`);
    if (d.workout && d.workout.length) v.push(`<i class="groups">🏋 ${d.workout.map(g => GROUP[g] ? GROUP[g].name : g).join(', ')}</i>`);
    else if (d.rest) v.push(`<i class="groups">отдых</i>`);
    if (d.note) v.push(`<i class="note">${esc(d.note.split('\n')[0])}</i>`);
    else if (d.photos && d.photos.length) v.push(`<i class="note">📷 ${d.photos.length} фото</i>`);
    return `<button class="day-row" data-date="${d.date}"><div class="day-date"><b>${dt.getDate()}</b><span>${fmtMonthShort.format(dt).replace('.', '')}, ${fmtWd.format(dt)}</span></div><div class="day-vals">${v.join('')}</div></button>`;
  }).join('');
}

function chartCard(title, big, sub, color, svg) {
  return `<div class="chart-card"><div class="chart-head"><h2>${title}</h2><span class="big" style="color:${color}">${big}</span></div>
    ${sub ? `<div class="chart-sub">${sub}</div>` : ''}
    ${svg ? `<div class="chart">${svg}</div>` : `<div class="empty-chart">${big ? 'Нужно хотя бы 2 записи для графика' : 'Нет данных за период'}</div>`}</div>`;
}

const CW = 320, CH = 120, PL = 30, PR = 6, PT = 8, PB = 18;

function niceRange(vals, pad = 0.1) {
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

function axisX(span, from) {
  const end = addDays(from, span);
  const lbl = k => fmtDM.format(parseKey(k)).replace('.', '');
  return `<text x="${PL}" y="${CH - 3}">${lbl(from)}</text><text x="${CW - PR}" y="${CH - 3}" text-anchor="end">${lbl(end)}</text>`;
}

function lineChart(series, span, from, opts = {}) {
  const vals = series.flatMap(s => s.pts.map(p => p.y)).concat(opts.refs || []);
  const [lo, hi] = niceRange(vals);
  const X = x => PL + (x / span) * (CW - PL - PR);
  const Y = y => PT + (1 - (y - lo) / (hi - lo)) * (CH - PT - PB);
  let out = `<svg viewBox="0 0 ${CW} ${CH}">`;
  // Сетка
  for (const v of [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1]) {
    const y = Y(v);
    out += `<line x1="${PL}" x2="${CW - PR}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-dasharray="2 4"/>`;
    out += `<text x="${PL - 6}" y="${y + 3}" text-anchor="end">${hi - lo < 10 ? num(v) : Math.round(v)}</text>`;
  }
  for (const r of opts.refs || []) out += `<line x1="${PL}" x2="${CW - PR}" y1="${Y(r)}" y2="${Y(r)}" stroke="var(--muted)" stroke-opacity=".35"/>`;
  series.forEach((s, i) => {
    if (!s.pts.length) return;
    const d = s.pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    if (opts.area && i === 0) {
      out += `<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`;
      out += `<path d="${d}L${X(s.pts[s.pts.length - 1].x).toFixed(1)},${CH - PB}L${X(s.pts[0].x).toFixed(1)},${CH - PB}Z" fill="url(#ga)"/>`;
    }
    out += `<path d="${d}" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (s.pts.length <= 45) out += s.pts.map(p => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2.6" fill="${s.color}"/>`).join('');
    const last = s.pts[s.pts.length - 1];
    out += `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4.5" fill="var(--surface)" stroke="${s.color}" stroke-width="2.2"/>`;
  });
  return out + axisX(span, from) + '</svg>';
}

function barChart(pts, span, from, color, opts) {
  const { min, max } = opts;
  const slots = span + 1;
  const bw = (CW - PL - PR) / slots;
  const X = x => PL + x * bw;
  const Y = y => PT + (1 - (y - min) / (max - min)) * (CH - PT - PB);
  let out = `<svg viewBox="0 0 ${CW} ${CH}">`;
  for (const v of [min, (min + max) / 2, max]) {
    out += `<line x1="${PL}" x2="${CW - PR}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-dasharray="2 4"/>`;
    out += `<text x="${PL - 6}" y="${Y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  if (opts.ref) out += `<line x1="${PL}" x2="${CW - PR}" y1="${Y(opts.ref)}" y2="${Y(opts.ref)}" stroke="var(--muted)" stroke-opacity=".45"/>`;
  const gap = bw > 6 ? bw * 0.22 : 0.4;
  const rx = Math.min(3, (bw - gap) / 2);
  for (const p of pts) {
    const y = Y(p.y);
    out += `<rect x="${(X(p.x) + gap / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.8, bw - gap).toFixed(1)}" height="${Math.max(1, CH - PB - y).toFixed(1)}" rx="${rx.toFixed(1)}" fill="${opts.colorFn ? opts.colorFn(p.y) : color}"/>`;
  }
  return out + axisX(span, from) + '</svg>';
}

/* ================= Тренировки ================= */

function renderWorkouts() {
  const [y, m] = state.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysIn = new Date(y, m, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // Пн = 0
  const today = todayKey();

  $('#monthTitle').textContent = cap(fmtMonth.format(first)).replace(' г.', '');
  const inMonth = [...days.values()].filter(d => d.date.slice(0, 7) === state.month && d.workout && d.workout.length);
  $('#monthSub').textContent = inMonth.length ? `${inMonth.length} ${plural(inMonth.length, 'тренировка', 'тренировки', 'тренировок')}` : 'тренировок нет';
  $('#nextMonth').style.visibility = state.month >= today.slice(0, 7) ? 'hidden' : 'visible';

  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(w => `<div class="wd">${w}</div>`).join('');
  for (let i = 0; i < offset; i++) html += `<div class="d out"></div>`;
  for (let dn = 1; dn <= daysIn; dn++) {
    const k = `${state.month}-${pad(dn)}`;
    const d = days.get(k);
    const cls = ['d'];
    if (k === today) cls.push('today');
    if (k > today) cls.push('future');
    if (k === state.calSel) cls.push('sel');
    let dots = '';
    if (d && d.workout && d.workout.length) {
      cls.push('trained');
      dots = `<span class="dots">${d.workout.slice(0, 4).map(g => `<b style="--gc:${GROUP[g] ? GROUP[g].color : '#888'}"></b>`).join('')}</span>`;
    } else if (d && d.rest) cls.push('rest');
    html += `<button class="${cls.join(' ')}" data-date="${k}">${dn}${dots}</button>`;
  }
  $('#calendar').innerHTML = html;

  // Детали выбранного дня
  const det = $('#calDetail');
  if (state.calSel && state.calSel.slice(0, 7) === state.month) {
    const d = days.get(state.calSel);
    const what = d && d.workout && d.workout.length ? d.workout.map(g => GROUP[g] ? GROUP[g].name : g).join(', ') : d && d.rest ? 'Отдых' : 'Ничего не записано';
    det.innerHTML = `<div class="cal-detail"><div><div class="small muted">${cap(fmtLong.format(parseKey(state.calSel)))}</div><div>${what}</div></div>${state.calSel <= today ? '<button id="openDay">Открыть</button>' : ''}</div>`;
    const ob = $('#openDay');
    if (ob) ob.onclick = () => { state.date = state.calSel; show('today'); };
  } else det.innerHTML = '';

  // Давно не качал
  const last = {}, count30 = {};
  const from30 = addDays(today, -29);
  for (const d of days.values()) {
    for (const g of d.workout || []) {
      if (!last[g] || d.date > last[g]) last[g] = d.date;
      if (d.date >= from30 && d.date <= today) count30[g] = (count30[g] || 0) + 1;
    }
  }
  const maxC = Math.max(1, ...Object.values(count30));
  const rows = GROUPS.map(g => ({ g, ago: last[g.id] ? daysBetween(last[g.id], today) : Infinity, c: count30[g.id] || 0 }))
    .sort((a, b) => b.ago - a.ago);
  $('#groupStats').innerHTML = rows.map(r => {
    const ago = r.ago === Infinity ? 'ни разу' : r.ago === 0 ? 'сегодня' : r.ago === 1 ? 'вчера' : `${r.ago} ${plural(r.ago, 'день', 'дня', 'дней')} назад`;
    return `<div class="gstat" style="--gc:${r.g.color}"><span>${r.g.name}</span><div class="bar" title="${r.c} за 30 дней"><span style="width:${(r.c / maxC) * 100}%"></span></div><span class="ago ${r.ago >= 7 && r.ago !== Infinity ? 'warn' : ''}">${ago}</span></div>`;
  }).join('') + `<p class="muted small" style="margin:6px 4px">Полоска — сколько раз за последние 30 дней.</p>`;
}

/* ================= Копия данных ================= */

async function exportData() {
  flushNote();
  toast('Готовлю копию…');
  const photos = [];
  for (const p of await DB.allPhotos()) photos.push({ id: p.id, date: p.date, data: await blobToDataUrl(p.blob) });
  const payload = { app: 'DOAH', format: 2, exported: new Date().toISOString(), days: sortedDays(), photos, profile: state.profile, myFoods: state.myFoods };
  const name = `doah-копия-${todayKey()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Копия DOAH' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // закрыл окно «Поделиться»
    toast('Не получилось сохранить копию'); return;
  }
  state.lastExport = Date.now();
  await DB.setMeta('lastExport', state.lastExport);
  toast(`Копия готова: ${days.size} ${plural(days.size, 'день', 'дня', 'дней')}, ${photos.length} фото, ${(blob.size / 1048576).toFixed(1).replace('.', ',')} МБ`);
  renderNag(); renderSettings();
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Это не файл копии DOAH'); return; }
  if (!data || data.app !== 'DOAH' || !Array.isArray(data.days)) { toast('Это не файл копии DOAH'); return; }
  const valid = data.days.filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (!confirm(`В копии ${valid.length} ${plural(valid.length, 'день', 'дня', 'дней')}. Добавить их? Если день есть и там, и тут — останется более свежая версия.`)) return;
  let n = 0;
  for (const p of data.photos || []) {
    try {
      if (await DB.getPhoto(p.id)) continue;
      const blob = await (await fetch(p.data)).blob();
      await DB.putPhoto({ id: p.id, date: p.date, blob, thumb: await shrink(blob, 320, 0.7) });
    } catch (e) { console.error(e); }
  }
  if (data.profile && !state.profile) { state.profile = data.profile; await DB.setMeta('profile', data.profile); }
  if (Array.isArray(data.myFoods)) {
    const names = new Set(state.myFoods.map(f => f.n.toLowerCase()));
    for (const f of data.myFoods) if (f && f.n && !names.has(f.n.toLowerCase())) state.myFoods.push(f);
    await DB.setMeta('myFoods', state.myFoods);
  }
  for (const d of valid) {
    const cur = days.get(d.date);
    if (!cur || (d.updated || 0) > (cur.updated || 0)) { days.set(d.date, d); await DB.put(d); n++; }
  }
  toast(`Восстановлено: ${n}`);
  renderAll(); renderSettings();
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

async function renderSettings() {
  const n = days.size;
  const first = sortedDays()[0];
  $('#dataInfo').textContent = n
    ? `Записано ${n} ${plural(n, 'день', 'дня', 'дней')}, с ${fmtDM.format(parseKey(first.date)).replace('.', '')}. ${state.lastExport ? `Последняя копия: ${fmtDM.format(new Date(state.lastExport)).replace('.', '')}.` : 'Копию ещё не делал.'}`
    : 'Пока нет записей.';
  if (navigator.storage && navigator.storage.persisted) {
    const p = await navigator.storage.persisted();
    $('#persistInfo').textContent = p ? 'Браузер обещал не удалять данные сам ✓' : 'Браузер может почистить данные при нехватке места — копия обязательна. Установи приложение на главный экран, так надёжнее.';
  }
}

/* ================= Общее ================= */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

function show(view) {
  flushNote();
  state.view = view;
  $$('.view').forEach(v => v.hidden = v.id !== `view-${view}`);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  renderAll();
  window.scrollTo(0, 0);
}

function renderAll() {
  if (state.view === 'today') renderToday();
  if (state.view === 'timeline') renderTimeline();
  if (state.view === 'workouts') renderWorkouts();
  if (state.view === 'diary') renderDiary();
  if (state.view === 'food') renderFood();
}

function openDayNote(e) {
  const r = e.target.closest('.diary-row'); if (!r) return;
  state.date = r.dataset.date; show('today');
  setTimeout(() => $('[data-metric="note"]').scrollIntoView({ block: 'center' }), 50);
}

function bind() {
  bindFood();
  $$('.tabs button').forEach(b => b.onclick = () => {
    if (b.dataset.view === 'today' && state.view === 'today') state.date = todayKey();
    show(b.dataset.view);
  });

  $('#prevDay').onclick = () => { flushNote(); state.date = addDays(state.date, -1); renderToday(); };
  $('#nextDay').onclick = () => { flushNote(); if (state.date < todayKey()) { state.date = addDays(state.date, 1); renderToday(); } };

  // Дневник и фото
  $('#noteText').addEventListener('input', onNoteInput);
  $('#noteText').addEventListener('blur', flushNote);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNote(); });
  $('#photoInput').onchange = e => { const f = e.target.files; if (f && f.length) addPhotos(f); e.target.value = ''; };
  document.addEventListener('click', e => {
    const b = e.target.closest('.ph[data-photo]'); if (!b) return;
    e.stopPropagation();
    openPhoto(b.dataset.photo, state.view === 'today');
  }, true);
  $('#pvClose').onclick = closePhoto;
  $('#photoView').addEventListener('close', () => { if (viewing) { URL.revokeObjectURL(viewing.url); viewing = null; } });
  $('#pvDelete').onclick = async () => {
    if (!viewing || !confirm('Удалить это фото?')) return;
    const id = viewing.id; closePhoto(); await deletePhoto(id);
  };

  const shiftDMonth = n => {
    const [y, m] = state.dMonth.split('-').map(Number);
    state.dMonth = keyOf(new Date(y, m - 1 + n, 1)).slice(0, 7); renderDiary();
  };
  $('#prevDMonth').onclick = () => shiftDMonth(-1);
  $('#nextDMonth').onclick = () => shiftDMonth(1);
  $('#diarySearch').addEventListener('input', e => { state.query = e.target.value; renderDiary(); });
  $('#diaryList').onclick = openDayNote;
  $('#memory').onclick = openDayNote;

  $$('.step').forEach(b => b.onclick = () => onStep(b.dataset.field, +b.dataset.delta));
  $('#sleepValue').onclick = () => onValueTap('sleep');
  $('#weightValue').onclick = () => onValueTap('weight');

  $('#foodScale').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = +b.dataset.v;
    update('food', getDay(state.date).food === v ? null : v);
  };

  $('#workoutChips').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const d = { ...getDay(state.date) };
    const g = c.dataset.g;
    if (g === 'rest') {
      d.rest = !d.rest || undefined;
      if (d.rest) delete d.workout;
    } else {
      const s = new Set(d.workout || []);
      s.has(g) ? s.delete(g) : s.add(g);
      d.workout = GROUPS.map(x => x.id).filter(id => s.has(id));
      if (!d.workout.length) delete d.workout;
      delete d.rest;
    }
    if (!d.rest) delete d.rest;
    saveDay(d); renderToday();
  };

  for (const [id, f, lo, hi] of [['#bpSys', 'sys', 60, 250], ['#bpDia', 'dia', 30, 160]]) {
    const el = $(id);
    el.addEventListener('change', () => {
      const v = el.value === '' ? null : Math.round(+el.value);
      if (v != null && (v < lo || v > hi)) { toast(`Странное значение: ${v}`); el.value = getDay(state.date)[f] ?? ''; return; }
      update(f, v);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { if (id === '#bpSys') $('#bpDia').focus(); else el.blur(); }
    });
  }

  $('#rangeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    state.range = +b.dataset.range;
    $$('#rangeSeg button').forEach(x => x.classList.toggle('on', x === b));
    renderTimeline();
  };
  $('#feed').onclick = e => {
    const r = e.target.closest('.day-row'); if (!r) return;
    state.date = r.dataset.date; show('today');
  };

  const shiftMonth = n => {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    state.month = keyOf(d).slice(0, 7); renderWorkouts();
  };
  $('#prevMonth').onclick = () => shiftMonth(-1);
  $('#nextMonth').onclick = () => shiftMonth(1);
  $('#calendar').onclick = e => {
    const c = e.target.closest('.d[data-date]'); if (!c) return;
    state.calSel = state.calSel === c.dataset.date ? null : c.dataset.date;
    renderWorkouts();
  };

  $('#openSettings').onclick = () => { renderSettings(); $('#settings').showModal(); };
  $('#settings').addEventListener('click', e => { if (e.target.id === 'settings') $('#settings').close(); });
  $('#exportBtn').onclick = exportData;
  $('#importFile').onchange = e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; };

  // Если приложение висело в фоне и наступил новый день — перескочить на сегодня
  let lastSeen = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const t = todayKey();
    if (t !== lastSeen) {
      if (state.date === lastSeen) state.date = t;
      lastSeen = t; renderAll();
    }
  });
}

async function init() {
  bind();
  try {
    await DB.open();
    for (const d of await DB.all()) days.set(d.date, d);
    state.lastExport = await DB.getMeta('lastExport') || null;
    state.profile = await DB.getMeta('profile') || null;
    state.myFoods = await DB.getMeta('myFoods') || [];
  } catch (e) {
    toast('Не удалось открыть хранилище');
    console.error(e);
  }
  renderAll();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setupInstall();
}

/* Своя кнопка «Установить» — Chrome сам присылает событие, когда установка возможна */
function setupInstall() {
  let promptEvent = null;
  const box = $('#installBox');
  const standalone = () => matchMedia('(display-mode: standalone)').matches;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    promptEvent = e;
    if (!standalone()) box.hidden = false;
  });
  $('#installBtn').onclick = async () => {
    if (!promptEvent) return;
    promptEvent.prompt();
    await promptEvent.userChoice.catch(() => {});
    promptEvent = null;
    box.hidden = true;
  };
  window.addEventListener('appinstalled', () => { box.hidden = true; toast('DOAH установлен — открывай с главного экрана'); });
}

init();
