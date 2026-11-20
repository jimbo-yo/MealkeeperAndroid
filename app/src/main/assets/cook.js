// Cook mode, inline step timers, hands-free voice commands, and recipe servings scaling.
// Loaded before app.js; uses its helpers (str, fmtQty, escapeHtml, ...).
// Cook mode shows one step of a recipe at a time, full screen, with each ingredient's amount written into the step,
// so nobody has to scroll back to the ingredient list with their hands full.

// ---- Servings ----

// Servings chosen on the recipe/keeper screen, by "<mealOrKeeperId>/<recipeId>". Not saved: recipes open at their own servings.
const chosenServings = {};

function keeperMeal(k) {
  return {id: 'keeper-' + k.id};
}

function servingsOf(m, r) {
  return chosenServings[m.id + '/' + r.id] || r.servings || 0;
}

// How much to scale a recipe's amounts by (1 when it has no servings to scale from).
function servingsFactor(m, r) {
  let s = servingsOf(m, r);
  return r.servings > 0 && s > 0 ? s / r.servings : 1;
}

function setServings(i, delta) {
  let m = currentMeal(),
    r = m && m.recipes[i];
  if (!r || !(r.servings > 0)) return;
  chosenServings[m.id + '/' + r.id] = Math.max(1, servingsOf(m, r) + delta);
  let box = document.getElementById('modal'),
    top = box.scrollTop;
  showRecipe(i);
  box.scrollTop = top;
}

function setKeeperServings(id, delta) {
  let k = keeperById(id),
    r = k && k.recipe;
  if (!r || !(r.servings > 0)) return;
  let m = keeperMeal(k);
  chosenServings[m.id + '/' + r.id] = Math.max(1, servingsOf(m, r) + delta);
  let box = document.getElementById('modal'),
    top = box.scrollTop;
  showKeeper(id);
  box.scrollTop = top;
}

const KITCHEN_FRACTIONS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];

// Countable units that switch between singular and plural when a recipe is scaled.
const UNIT_PAIRS = [
  ['cup', 'cups'], ['clove', 'cloves'], ['pint', 'pints'], ['quart', 'quarts'], ['gallon', 'gallons'],
  ['can', 'cans'], ['bunch', 'bunches'], ['sprig', 'sprigs'], ['stalk', 'stalks'], ['slice', 'slices'],
  ['head', 'heads'], ['stick', 'sticks'], ['piece', 'pieces'], ['link', 'links'], ['pinch', 'pinches'],
  ['dash', 'dashes'], ['package', 'packages'], ['sheet', 'sheets'], ['leaf', 'leaves'],
  ['tablespoon', 'tablespoons'], ['teaspoon', 'teaspoons'], ['ounce', 'ounces'], ['pound', 'pounds'],
  ['gram', 'grams'], ['kilogram', 'kilograms'], ['milliliter', 'milliliters'], ['liter', 'liters']
];
const UNIT_FORMS = Object.fromEntries(UNIT_PAIRS.flatMap(([sg, pl]) => [[sg, [sg, pl]], [pl, [sg, pl]]]));

function matchUnitNumber(unit, value) {
  let u = str(unit).trim(),
    pair = UNIT_FORMS[u.toLowerCase()];
  if (!pair) return u;
  return value > 1 ? pair[1] : pair[0];
}

// A quantity scaled for the chosen servings, written the way a cook measures it: 1.5 -> "1 ½", 0.33 -> "⅓".
// Text quantities ("a pinch") and unscaled amounts are left exactly as the recipe gives them.
function scaledQty(q, unit, factor) {
  if (typeof q !== 'number' || factor === 1) return fmtQty(q, unit);
  let v = q * factor;
  if (v <= 0) return fmtQty(0, unit);
  let u = matchUnitNumber(unit, v);
  if (v >= 10) return fmtQty(Math.round(v), u);
  let whole = Math.floor(v),
    frac = v - whole;
  // Never round a small positive amount down to 0 ("0 tsp").
  if (frac < 0.04 && whole > 0) return fmtQty(whole, u);
  if (frac > 0.96) return fmtQty(whole + 1, matchUnitNumber(unit, whole + 1));
  let near = KITCHEN_FRACTIONS.reduce((a, f) => Math.abs(f[0] - frac) < Math.abs(a[0] - frac) ? f : a);
  if (Math.abs(near[0] - frac) > 0.04) {
    let rounded = Math.max(0.01, Math.round(v * 100) / 100);
    return fmtQty(rounded, matchUnitNumber(unit, rounded));
  }
  return [(whole ? whole + ' ' : '') + near[1], u].filter(Boolean).join(' ');
}

function servingsBarHtml(s, decCall, incCall) {
  return `<div class="servings-bar"><button onclick="${decCall}" ${s <= 1 ? 'disabled' : ''} aria-label="Fewer servings">−</button><div><b>${s}</b><span>${s === 1 ? 'serving' : 'servings'}</span></div><button onclick="${incCall}" aria-label="More servings">+</button></div>`;
}

function servingsBar(m, r, i) {
  if (!(r.servings > 0)) return '';
  return servingsBarHtml(servingsOf(m, r), `setServings(${i},-1)`, `setServings(${i},1)`);
}

function keeperServingsBar(k) {
  if (!(k.recipe.servings > 0)) return '';
  return servingsBarHtml(servingsOf(keeperMeal(k), k.recipe), `setKeeperServings(${k.id},-1)`, `setKeeperServings(${k.id},1)`);
}

// ---- Which ingredients a step uses ----

// Words that describe an ingredient rather than name it; alone they'd match the wrong thing ("fresh", "powder", "italian").
const VAGUE_WORDS = new Set(('fresh ground large small medium chopped crushed dried whole sliced minced diced grated shredded ' +
  'extra virgin fillet fillets boneless skinless unsalted salted powder sauce juice leaves clove cloves can cans red green ' +
  'white black yellow light dark baby frozen canned cooked raw heavy links pieces stick sticks bunch ' +
  'italian french greek asian mexican kosher sea brown sweet sour hot cold warm melted softened beaten toasted roasted ' +
  'smoked packed thinly finely roughly lightly freshly pinch dash sprig sprigs head stalk stalks slice slices strip strips ' +
  'cube cubes halves quarters plain pure organic all-purpose granulated confectioners powdered low-sodium reduced-sodium ' +
  'unsweetened sweetened').split(' '));

function singularForms(s) {
  let out = [s];
  if (s.length > 4 && /ies$/.test(s)) {
    out.push(s.replace(/ies$/, 'y'));
    out.push(s.replace(/es$/, ''));
  } else if (/(?:[oxz]|ch|sh)es$/.test(s)) {
    out.push(s.replace(/es$/, ''));
  } else if (/s$/.test(s) && !/ss$/.test(s)) {
    out.push(s.replace(/s$/, ''));
  }
  return out;
}

// Words that can stand for an ingredient in a step: its name, its singular forms, and any distinctive word of a longer
// name ("salmon" for "salmon fillets"), unless another ingredient of the recipe shares that word.
function ingredientTerms(ing, all) {
  let name = ing.name.toLowerCase().trim(),
    terms = new Set(singularForms(name)),
    words = name.split(/[\s,]+/).filter(Boolean);
  if (words.length > 1) {
    let others = new Set(all.filter(x => x !== ing).flatMap(x => x.name.toLowerCase().split(/[\s,]+/)));
    for (let w of words)
      if (w.length >= 4 && !VAGUE_WORDS.has(w) && !others.has(w)) {
        for (let f of singularForms(w)) terms.add(f);
      }
  }
  return [...terms].filter(t => t.length >= 3).sort((a, b) => b.length - a.length);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');
}

// True when text right before an ingredient already states a quantity ("2 tbsp ", "a pinch of ", "half the "),
// so we don't prepend a duplicate amount in front of it.
const QTY_UNIT_RE = '(?:tbsp|tbs|tsp|oz|fl\\.?\\s*oz|lb|lbs|g|kg|ml|l|c|pt|qt|gal|pkg|tablespoons?|teaspoons?|ounces?|pounds?|grams?|kilograms?|milliliters?|liters?|cups?|pints?|quarts?|gallons?|cloves?|cans?|bunches?|sprigs?|stalks?|slices?|heads?|sticks?|pieces?|links?|pinch(?:es)?|dash(?:es)?|splash(?:es)?|drizzle|handfuls?)\\.?';
const HAS_LEADING_QTY_RE = new RegExp(
  '(?:' +
    '(?:\\d+(?:\\.\\d+)?(?:\\s*\\/\\s*\\d+)?|[½¼¾⅓⅔⅛⅜⅝⅞])\\s*(?:' + QTY_UNIT_RE + '\\s+)?(?:of\\s+)?(?:the\\s+)?' +
    '|\\b(?:a|an|one|two|three|four)\\s+' + QTY_UNIT_RE + '\\s+(?:of\\s+)?(?:the\\s+)?' +
    '|\\b(?:half|quarter)\\s+(?:of\\s+)?(?:the\\s+)' +
  ')$',
  'i'
);

function hasLeadingQty(prefix) {
  return HAS_LEADING_QTY_RE.test(prefix);
}

// The first mention of each ingredient in a step, in reading order and without overlaps: [{start, end, ing}].
// Tie-breaks same-start matches by longest match ("red wine vinegar" beats "red wine") and only rejects against kept hits.
function mentions(text, ingredients) {
  let hits = [];
  for (let ing of ingredients)
    for (let term of ingredientTerms(ing, ingredients)) {
      let m = new RegExp('\\b' + escapeRegex(term) + '\\b', 'i').exec(text);
      if (m) {
        hits.push({start: m.index, end: m.index + m[0].length, ing});
        break;
      }
    }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let kept = [];
  for (let h of hits)
    if (!kept.some(o => h.start < o.end && o.start < h.end)) kept.push(h);
  return kept;
}

function stepIngredients(r, i) {
  return [...new Set(mentions(r.instructions[i] || '', r.ingredients).map(h => h.ing))];
}

// A step as HTML, with each ingredient it mentions highlighted and its (scaled) amount written in front of it
// (unless the step already writes an amount right before the ingredient).
function markedStep(r, i, factor) {
  let text = r.instructions[i] || '',
    out = '',
    pos = 0;
  for (let h of mentions(text, r.ingredients)) {
    let amount = hasLeadingQty(text.slice(0, h.start)) ? '' : scaledQty(h.ing.quantity, h.ing.unit, factor);
    out += escapeHtml(text.slice(pos, h.start)) + `<mark>${amount ? `<b>${escapeHtml(amount)}</b> ` : ''}${escapeHtml(text.slice(h.start, h.end))}</mark>`;
    pos = h.end;
  }
  return out + escapeHtml(text.slice(pos));
}

// ---- Step timers ----

// Finds cooking durations in a step ("about 8 minutes", "6–7 minutes", "1 hr 15 min", "30 seconds").
// Ranges use the lower bound so food gets checked before it can burn.
function stepTimers(text) {
  let found = [],
    seen = new Set(),
    re = /\b(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours)\s*(?:(?:and\s+)?(\d+)\s*(?:min|mins|minute|minutes))?\b|\b(\d+(?:\.\d+)?)\s*(?:[–—-]|to)\s*(\d+(?:\.\d+)?)\s*(hr|hrs|hour|hours|min|mins|minute|minutes|sec|secs|second|seconds)\b|\b(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|sec|secs|second|seconds)\b/gi,
    m;
  while ((m = re.exec(text || ''))) {
    let seconds, label;
    if (m[1]) {
      let h = parseFloat(m[1]),
        mins = m[2] ? parseInt(m[2], 10) : 0;
      seconds = Math.round(h * 3600 + mins * 60);
      label = mins ? `${m[1]} hr ${mins} min` : `${m[1]} ${h === 1 ? 'hr' : 'hrs'}`;
    } else if (m[3]) {
      let lo = parseFloat(m[3]),
        hi = parseFloat(m[4]),
        u = m[5].toLowerCase(),
        mult = u.startsWith('h') ? 3600 : u.startsWith('m') ? 60 : 1,
        shortU = u.startsWith('h') ? 'hr' : u.startsWith('m') ? 'min' : 'sec';
      seconds = Math.round(lo * mult);
      label = `${lo}–${hi} ${shortU}`;
    } else {
      let v = parseFloat(m[6]),
        u = m[7].toLowerCase(),
        mult = u.startsWith('m') ? 60 : 1,
        shortU = u.startsWith('m') ? 'min' : 'sec';
      seconds = Math.round(v * mult);
      label = `${m[6]} ${shortU}`;
    }
    if (seconds > 0 && seconds <= 24 * 3600 && !seen.has(seconds)) {
      seen.add(seconds);
      found.push({seconds, label});
    }
  }
  return found;
}

function fmtTimer(ms) {
  let total = Math.max(0, Math.ceil(ms / 1000)),
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60,
    pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function spokenDuration(seconds) {
  let total = Math.max(1, Math.round(seconds)),
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60,
    parts = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (s && !h) parts.push(`${s} ${s === 1 ? 'second' : 'seconds'}`);
  return parts.join(' and ') || '1 second';
}

let cookTimerTick = null,
  nextTimerId = 1;

function ensureTimerTick() {
  if (!cookTimerTick) cookTimerTick = setInterval(tickCookTimers, 500);
}

function clearTimerTick() {
  if (cookTimerTick) {
    clearInterval(cookTimerTick);
    cookTimerTick = null;
  }
}

function startCookTimer(seconds, label) {
  if (!cook || !(seconds > 0)) return;
  let stepNum = cook.step + 1;
  cook.timers.push({
    id: nextTimerId++,
    step: stepNum,
    label: `Step ${stepNum} · ${label}`,
    shortLabel: label,
    totalSeconds: seconds,
    remainingMs: seconds * 1000,
    endAt: Date.now() + seconds * 1000,
    paused: false,
    done: false
  });
  ensureTimerTick();
  renderCook();
}

function toggleCookTimer(id) {
  let t = cook && cook.timers.find(x => x.id === id);
  if (!t || t.done) return;
  if (t.paused) {
    t.paused = false;
    t.endAt = Date.now() + t.remainingMs;
  } else {
    t.paused = true;
    t.remainingMs = Math.max(0, t.endAt - Date.now());
  }
  renderCook();
}

function bumpCookTimer(id, extraSeconds) {
  let t = cook && cook.timers.find(x => x.id === id);
  if (!t) return;
  let addMs = extraSeconds * 1000;
  if (t.done) {
    t.done = false;
    t.paused = false;
    t.remainingMs = addMs;
    t.endAt = Date.now() + addMs;
    ensureTimerTick();
  } else if (t.paused) {
    t.remainingMs += addMs;
  } else {
    t.endAt += addMs;
  }
  renderCook();
}

function dismissCookTimer(id) {
  if (!cook) return;
  cook.timers = cook.timers.filter(x => x.id !== id);
  if (!cook.timers.some(x => !x.done)) clearTimerTick();
  renderCook();
}

function openSystemTimer(seconds, label) {
  if (!window.MealkeeperAndroid || !window.MealkeeperAndroid.setTimer) return;
  let c = cookingRecipe(),
    msg = c ? `${c.r.title} (${label})` : label;
  if (!window.MealkeeperAndroid.setTimer(seconds, msg)) notify('No clock app found to set a timer.');
}

function tickCookTimers() {
  if (!cook || !cook.timers.length) return clearTimerTick();
  let now = Date.now(),
    changed = false;
  for (let t of cook.timers) {
    if (t.paused || t.done) continue;
    let left = Math.max(0, t.endAt - now);
    t.remainingMs = left;
    if (left === 0) {
      t.done = true;
      changed = true;
      chimeTimer();
      speak(`${t.label.replace(' · ', ' ')} timer done.`);
    } else {
      let node = document.querySelector(`[data-timer-id="${t.id}"] .cook-timer-time`);
      if (node) node.textContent = fmtTimer(left);
    }
  }
  if (!cook.timers.some(x => !x.done)) clearTimerTick();
  if (changed) renderCook();
}

function chimeTimer() {
  try {
    let Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    let ctx = new Ctx(),
      t = ctx.currentTime;
    [880, 1174.66, 880].forEach((freq, k) => {
      let osc = ctx.createOscillator(),
        gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, t + k * 0.22);
      gain.gain.exponentialRampToValueAtTime(0.22, t + k * 0.22 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + k * 0.22 + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + k * 0.22);
      osc.stop(t + k * 0.22 + 0.21);
    });
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch (e) {}
}

function timerBarHtml() {
  if (!cook || !cook.timers.length) return '';
  let now = Date.now();
  return `<div class="cook-timers" aria-live="polite">${cook.timers.map(t => {
    let left = t.done ? 0 : t.paused ? t.remainingMs : Math.max(0, t.endAt - now);
    return `<div class="cook-timer-chip${t.done ? ' done' : t.paused ? ' paused' : ''}" data-timer-id="${t.id}">
      <span class="cook-timer-label">${escapeHtml(t.label)}</span>
      <strong class="cook-timer-time">${t.done ? 'Done!' : fmtTimer(left)}</strong>
      ${t.done ? '' : `<button type="button" class="outline cook-timer-btn" onclick="toggleCookTimer(${t.id})">${t.paused ? 'Resume' : 'Pause'}</button>`}
      <button type="button" class="outline cook-timer-btn" onclick="bumpCookTimer(${t.id},60)" aria-label="Add 1 minute">+1m</button>
      <button type="button" class="outline cook-timer-btn" onclick="dismissCookTimer(${t.id})" aria-label="Dismiss timer">✕</button>
    </div>`;
  }).join('')}</div>`;
}

function stepTimersHtml(r, i) {
  let timers = stepTimers(r.instructions[i] || '');
  if (!timers.length) return '';
  let hasClock = !!(window.MealkeeperAndroid && window.MealkeeperAndroid.setTimer);
  return `<div class="cook-step-timers">${timers.map(t =>
    `<div class="cook-timer-offer"><button type="button" class="secondary cook-timer-start${flashed('timer')}" onclick="startCookTimer(${t.seconds},'${escapeHtml(t.label)}')">⏱ Start ${escapeHtml(t.label)} timer</button>${hasClock ? `<button type="button" class="outline cook-timer-clock" onclick="openSystemTimer(${t.seconds},'${escapeHtml(t.label)}')" aria-label="Open ${escapeHtml(t.label)} timer in Clock app">Clock ↗</button>` : ''}</div>`
  ).join('')}</div>`;
}

// ---- Cook mode ----

// null, or {meal, recipe, keeper, step, added: {ingredient index: true}, sheet: bool, timers: [...]}.
let cook = null,
  cookSwipeBound = false;

function cookingRecipe() {
  if (!cook) return null;
  if (cook.keeper != null) {
    let k = keeperById(cook.keeper);
    return k ? {m: keeperMeal(k), r: k.recipe} : null;
  }
  let m = meals.find(x => x.id === cook.meal),
    r = m && m.recipes[cook.recipe];
  return r ? {m, r} : null;
}

function startCookSession(session) {
  clearTimeout(window._cookFlash);
  clearTimerTick();
  cook = {...session, step: 0, added: {}, sheet: false, timers: []};
  voiceProblem = '';
  flash = '';
  heardCommand = '';
  renderCook();
  syncAwake();
}

function openCook(i) {
  let m = currentMeal();
  if (!m || !m.recipes[i]) return;
  startCookSession({meal: m.id, recipe: i, keeper: null});
}

function openCookKeeper(id) {
  let k = keeperById(id);
  if (!k) return;
  startCookSession({meal: null, recipe: null, keeper: k.id});
}

function closeCook() {
  clearTimeout(window._cookFlash);
  clearTimerTick();
  stopCookVoice();
  cook = null;
  let el = document.getElementById('cook');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
  document.documentElement.classList.remove('cooking');
  syncAwake();
}

function cookGoTo(step) {
  let c = cookingRecipe();
  if (!c) return;
  cook.step = Math.min(c.r.instructions.length, Math.max(0, step));
  cook.sheet = false;
  renderCook(true);
  speakStep();
}

function cookStep(delta) {
  if (!cook) return;
  cookGoTo(cook.step + delta);
}

function cookSheet(open) {
  if (!cook) return;
  cook.sheet = open;
  renderCook();
}

function toggleAdded(k) {
  if (!cook) return;
  if (cook.added[k]) delete cook.added[k];
  else cook.added[k] = true;
  renderCook();
}

function cookIngredientRow(r, ing, factor, large) {
  let k = r.ingredients.indexOf(ing),
    got = !!cook.added[k];
  return `<button class="cook-ing${large ? ' large' : ''}${got ? ' got' : ''}" onclick="toggleAdded(${k})" aria-pressed="${got}"><span class="amt">${escapeHtml(scaledQty(ing.quantity, ing.unit, factor))}</span><span>${escapeHtml(ing.name)}${ing.notes ? ` <span class="muted">(${escapeHtml(ing.notes)})</span>` : ''}</span></button>`;
}

// Horizontal swipe on the step body moves between steps without needing buttons.
function bindCookSwipe(el) {
  if (cookSwipeBound || !el) return;
  cookSwipeBound = true;
  let startX = 0,
    startY = 0,
    tracking = false;
  el.addEventListener('touchstart', e => {
    if (!cook || cook.sheet || e.touches.length !== 1 || !e.target.closest('#cook-body')) {
      tracking = false;
      return;
    }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, {passive: true});
  el.addEventListener('touchend', e => {
    if (!tracking || !cook || cook.sheet || !e.changedTouches.length) return;
    tracking = false;
    let dx = e.changedTouches[0].clientX - startX,
      dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    let c = cookingRecipe();
    if (!c) return;
    if (dx < 0 && cook.step < c.r.instructions.length) cookStep(1);
    else if (dx > 0 && cook.step > 0) cookStep(-1);
  }, {passive: true});
}

function renderCook(resetBodyScroll = false) {
  let el = document.getElementById('cook'),
    c = cookingRecipe();
  if (!c) return closeCook();
  bindCookSwipe(el);
  let prevBody = document.getElementById('cook-body'),
    prevSheet = el.querySelector('.cook-sheet'),
    bodyTop = resetBodyScroll ? 0 : (prevBody ? prevBody.scrollTop : 0),
    sheetTop = prevSheet ? prevSheet.scrollTop : 0;
  let {m, r} = c,
    n = r.instructions.length,
    i = cook.step,
    factor = servingsFactor(m, r),
    s = servingsOf(m, r),
    done = i >= n;
  document.documentElement.classList.add('cooking');
  el.hidden = false;
  let body = done
    ? `<div class="cook-finish"><h2>All steps done</h2><p class="subhead">Enjoy it.</p></div>`
    : `<div class="cook-step-head"><span>Step ${i + 1} of ${n}</span>${s ? `<span class="cook-serves">Serves ${s}</span>` : ''}</div>
       <p class="cook-step${flashed('repeat')}">${markedStep(r, i, factor)}</p>
       ${stepTimersHtml(r, i)}
       <div class="divider"></div>
       <p class="cook-next">${i + 1 < n ? `<strong>Next:</strong> ${escapeHtml(r.instructions[i + 1])}` : '<strong>Last step.</strong>'}</p>
       ${r.ingredients.length ? `<button class="text-btn cook-show${flashed('ingredients', 'close')}" onclick="cookSheet(true)">Show ingredients</button>` : ''}`;
  let uses = done ? [] : stepIngredients(r, i);
  let sheet = !cook.sheet ? '' : `<div class="cook-sheet-bg" onclick="if(event.target===this)cookSheet(false)"><div class="cook-sheet" role="dialog" aria-label="Ingredients">
       ${uses.length ? `<h3>For step ${i + 1}</h3>${uses.map(x => cookIngredientRow(r, x, factor, true)).join('')}` : ''}
       <h3>${uses.length ? 'Everything in this recipe' : 'Ingredients'}</h3>${r.ingredients.map(x => cookIngredientRow(r, x, factor, false)).join('')}
       <p class="muted small">Tap an ingredient once it's in.</p>
       <button class="secondary" onclick="cookSheet(false)">Close</button></div></div>`;
  el.innerHTML = `<div class="cook-top"><button class="outline" onclick="closeCook()">Exit</button><strong class="cook-title">${escapeHtml(r.title)}</strong>${voiceButton()}</div>
    <div class="cook-progress" aria-label="Recipe steps">${r.instructions.map((_, k) => `<button type="button" class="cook-seg" onclick="cookGoTo(${k})" aria-label="Step ${k + 1} of ${n}"${k === i ? ' aria-current="step"' : ''}><i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i></button>`).join('')}</div>
    ${timerBarHtml()}
    ${voiceStatus(r, i)}
    <div class="cook-body" id="cook-body">${body}</div>
    <div class="cook-foot"><button class="outline${i > 0 ? flashed('back') : ''}" onclick="cookStep(-1)" ${i === 0 ? 'disabled' : ''}>Back</button><button class="primary${flashed('next')}" onclick="${done ? 'closeCook()' : 'cookStep(1)'}">${done ? 'Back to recipe' : i + 1 < n ? 'Next step' : 'Finish'}</button></div>
    ${sheet}`;
  let nextBody = document.getElementById('cook-body'),
    nextSheet = el.querySelector('.cook-sheet');
  if (nextBody) nextBody.scrollTop = bodyTop;
  if (nextSheet) nextSheet.scrollTop = sheetTop;
}

// Android's back button: the ingredients list first, then Cook mode itself. True if it did something.
function cookBack() {
  if (!cook) return false;
  if (cook.sheet) cookSheet(false);
  else closeCook();
  return true;
}

// ---- Voice: hands-free commands (Android app only; CookVoice.kt does the listening) ----

// 'off', 'starting' (loading the speech model or asking for the microphone) or 'on'.
let cookVoice = 'off',
  heardCommand = '',
  voiceProblem = '',
  flash = '';

function hasCookVoice() {
  return !!(window.MealkeeperAndroid && window.MealkeeperAndroid.cookVoiceAvailable && window.MealkeeperAndroid.cookVoiceAvailable());
}

// The words a command can be said with. The recognizer only hears these (CookVoice's COMMAND_WORDS) plus harmless carrier words.
const COOK_COMMANDS = [
  ['next', ['next', 'forward', 'continue']],
  ['back', ['back', 'previous']],
  ['repeat', ['repeat', 'again', 'read']],
  ['ingredients', ['ingredients', 'ingredient']],
  ['close', ['close', 'hide']],
  ['stop', ['stop', 'quiet']],
  ['timer', ['timer', 'timers']],
  ['recipe', ['recipe', 'exit']]
];

// The last command word in what was heard ("okay next" -> next, "go back" -> back), or ''.
function parseCookCommand(text) {
  let found = '';
  for (let w of str(text).toLowerCase().split(/[^a-z]+/))
    for (let [command, words] of COOK_COMMANDS)
      if (words.includes(w)) found = command;
  return found;
}

function voiceButton() {
  if (!hasCookVoice()) return '';
  return cookVoice === 'off'
    ? '<button class="outline cook-voice" onclick="toggleCookVoice()">Voice</button>'
    : '<button class="primary cook-voice" onclick="toggleCookVoice()" aria-pressed="true">Voice on</button>';
}

function voiceStatus(r, i) {
  if (voiceProblem) return `<p class="cook-voice-status problem" role="alert">${escapeHtml(voiceProblem)}</p>`;
  if (cookVoice === 'off') return '';
  let hasTimer = !!(cook && (cook.timers.length || (r && i < r.instructions.length && stepTimers(r.instructions[i]).length)));
  let text = cookVoice === 'starting' ? 'Getting voice control ready…'
    : heardCommand ? `Heard “${heardCommand}”`
    : hasTimer ? 'Listening. Say “next”, “back”, “repeat”, “ingredients”, “timer” or “recipe”.'
    : 'Listening. Say “next”, “back”, “repeat”, “ingredients” or “recipe”.';
  return `<p class="cook-voice-status${heardCommand ? ' heard' : ''}" role="status">${escapeHtml(text)}</p>`;
}

// ' flash' on the control a voice command just used, so it's clear the command was heard.
function flashed(...commands) {
  return commands.includes(flash) ? ' flash' : '';
}

function toggleCookVoice() {
  if (cookVoice !== 'off') return stopCookVoice(true);
  voiceProblem = '';
  cookVoice = 'starting';
  window.MealkeeperAndroid.cookVoiceStart();
  syncAwake();
  renderCook();
}

function stopCookVoice(render) {
  clearTimeout(window._cookFlash);
  if (cookVoice !== 'off' && window.MealkeeperAndroid && window.MealkeeperAndroid.cookVoiceStop) window.MealkeeperAndroid.cookVoiceStop();
  cookVoice = 'off';
  heardCommand = '';
  flash = '';
  syncAwake();
  if (render && cook) renderCook();
}

// CookVoice reports back here; see its header comment.
window.onCookVoice = function(event, text) {
  if (!cook) return;
  if (event === 'listening') {
    cookVoice = 'on';
    syncAwake();
    renderCook();
    speakStep();
  } else if (event === 'heard') {
    runCookCommand(parseCookCommand(text));
  } else if (event === 'error') {
    cookVoice = 'off';
    voiceProblem = {
      denied: 'Voice control needs the microphone. Allow it when asked, or in the phone\'s app settings.',
      model: 'Voice control couldn\'t load its speech model. Try reinstalling the app.'
    }[text] || 'Voice control stopped: the microphone isn\'t available.';
    syncAwake();
    renderCook();
  } else if (event === 'stopped') {
    cookVoice = 'off';
    heardCommand = '';
    flash = '';
    syncAwake();
    renderCook();
  }
};

function runCookCommand(command) {
  let c = cookingRecipe();
  if (!command || !c) return;
  // With the ingredients list open, "back" closes it rather than going to the previous step.
  if (command === 'back' && cook.sheet) command = 'close';
  heardCommand = command;
  flash = command;
  clearTimeout(window._cookFlash);
  window._cookFlash = setTimeout(() => {
    flash = '';
    heardCommand = '';
    if (cook) renderCook();
  }, 1500);
  if (command === 'next') {
    if (cook.step < c.r.instructions.length) return cookStep(1);
    return closeCook();
  } else if (command === 'back') {
    if (cook.step > 0) return cookStep(-1);
  } else if (command === 'repeat') {
    speakStep(true);
  } else if (command === 'ingredients') {
    cook.sheet = true;
    speak(spokenIngredients(c.m, c.r, cook.step));
  } else if (command === 'close') {
    cook.sheet = false;
    quiet();
  } else if (command === 'stop') {
    quiet();
  } else if (command === 'timer') {
    let ringing = cook.timers.filter(x => x.done);
    if (ringing.length) {
      cook.timers = cook.timers.filter(x => !x.done);
      if (!cook.timers.length) clearTimerTick();
      quiet();
    } else {
      let offers = cook.step < c.r.instructions.length ? stepTimers(c.r.instructions[cook.step]) : [];
      let nextOffer = offers.find(o => !cook.timers.some(t => t.step === cook.step + 1 && t.totalSeconds === o.seconds)) || offers[0];
      if (nextOffer) {
        startCookTimer(nextOffer.seconds, nextOffer.label);
        speak(`Timer set for ${spokenDuration(nextOffer.seconds)}.`);
        return;
      }
      let active = cook.timers.find(x => !x.done);
      if (active) {
        let left = active.paused ? active.remainingMs : Math.max(0, active.endAt - Date.now());
        speak(`${spokenDuration(Math.ceil(left / 1000))} left.`);
      }
    }
  } else if (command === 'recipe') {
    return closeCook();
  }
  renderCook();
}

function speak(text) {
  if (cookVoice === 'on' && text) window.MealkeeperAndroid.cookVoiceSpeak(text);
}

function quiet() {
  if (cookVoice === 'on') window.MealkeeperAndroid.cookVoiceQuiet();
}

// Reads the current step aloud when voice is on and Settings asks for it (always, for "repeat").
function speakStep(asked) {
  let c = cookingRecipe();
  if (!c || cookVoice !== 'on' || !(readSteps || asked)) return;
  let n = c.r.instructions.length;
  speak(cook.step >= n ? 'All steps done.' : spokenStep(c.m, c.r, cook.step));
}

const SPOKEN_FRACTIONS = {'½': 'a half', '¼': 'a quarter', '¾': 'three quarters', '⅓': 'a third', '⅔': 'two thirds', '⅛': 'an eighth', '⅜': 'three eighths', '⅝': 'five eighths', '⅞': 'seven eighths'};
const SPOKEN_UNITS = {
  tbsp: ['tablespoon', 'tablespoons'], tbs: ['tablespoon', 'tablespoons'],
  tsp: ['teaspoon', 'teaspoons'], oz: ['ounce', 'ounces'], 'fl oz': ['fluid ounce', 'fluid ounces'],
  lb: ['pound', 'pounds'], lbs: ['pound', 'pounds'], g: ['gram', 'grams'], kg: ['kilogram', 'kilograms'],
  ml: ['milliliter', 'milliliters'], l: ['liter', 'liters'],
  c: ['cup', 'cups'], pt: ['pint', 'pints'], qt: ['quart', 'quarts'], gal: ['gallon', 'gallons'],
  pkg: ['package', 'packages'],
  ...UNIT_FORMS
};

function articleFor(word) {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

// An amount as it should sound: "1 ½ tbsp" -> "1 and a half tablespoons", "½ oz" -> "half an ounce".
function spokenAmount(q, unit, factor) {
  let shown = scaledQty(q, '', factor),
    m = /^(\d+(?:\.\d+)?)?\s*([½¼¾⅓⅔⅛⅜⅝⅞])?$/.exec(shown.trim()),
    u = str(unit).trim(),
    norm = u.replace(/\.$/, '').replace(/\s+/g, ' ').toLowerCase(),
    pair = SPOKEN_UNITS[norm];
  if (!m || (!m[1] && !m[2])) return [shown, u].filter(Boolean).join(' ');
  let whole = m[1] || '',
    frac = m[2] ? SPOKEN_FRACTIONS[m[2]] : '';
  if (!u) return whole && frac ? `${whole} and ${frac}` : whole || frac;
  if (!pair) return [whole && frac ? `${whole} and ${frac}` : whole || frac, u].join(' ');
  let [sg, pl] = pair;
  if (!whole) return frac === 'a half' ? `half ${articleFor(sg)} ${sg}` : `${frac} of ${articleFor(sg)} ${sg}`;
  if (frac) return `${whole} and ${frac} ${pl}`;
  return whole === '1' ? `1 ${sg}` : `${whole} ${pl}`;
}

function spokenStep(m, r, i) {
  let text = r.instructions[i] || '',
    factor = servingsFactor(m, r),
    out = '',
    pos = 0;
  for (let h of mentions(text, r.ingredients)) {
    let amount = hasLeadingQty(text.slice(0, h.start)) ? '' : spokenAmount(h.ing.quantity, h.ing.unit, factor);
    out += text.slice(pos, h.start) + (amount ? amount + ' ' : '') + text.slice(h.start, h.end);
    pos = h.end;
  }
  return `Step ${i + 1}. ${out + text.slice(pos)}`
    .replace(/(\d+)\s*°\s*F\b/gi, '$1 degrees')
    .replace(/(\d+)\s*°\s*C\b/gi, '$1 degrees Celsius')
    .replace(/(\d+)\s*°(?!\s*[FC])/g, '$1 degrees')
    .replace(/(\d+)\s*[–—-]\s*(\d+)/g, '$1 to $2');
}

function spokenIngredients(m, r, stepIndex) {
  let factor = servingsFactor(m, r),
    uses = stepIndex != null && stepIndex < r.instructions.length ? stepIngredients(r, stepIndex) : [],
    list = uses.length ? uses : r.ingredients,
    prefix = uses.length ? `For step ${stepIndex + 1}: ` : 'Ingredients: ',
    items = list.map(x => [spokenAmount(x.quantity, x.unit, factor), x.name].filter(Boolean).join(' ') + (x.notes ? `, ${x.notes}` : ''));
  return items.length ? prefix + items.join('. ') + '.' : '';
}

// Settings: only where voice control exists (the Android app).
function readStepsSetting() {
  if (!hasCookVoice()) return '';
  return `<div class="divider"></div><div class="spread" style="flex-wrap:nowrap"><div class="row"><div class="recipe-icon">♪</div><div><strong>Read steps aloud</strong><div class="muted small" style="margin-top:5px">When voice control is on in Cook mode, each step is read out with its amounts. Talk over it to give the next command.</div></div></div><input class="toggle" type="checkbox" ${readSteps ? 'checked' : ''} onchange="setReadSteps(this.checked)"></div>`;
}

function setReadSteps(v) {
  readSteps = v;
  render();
  notify(v ? 'Cook mode will read steps aloud' : 'Cook mode won\'t read steps aloud');
}
