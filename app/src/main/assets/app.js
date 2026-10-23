// Prompt to Pan single-page app. Runs in the Android WebView (MainActivity) and in a normal browser.
// The app was called Mealkeeper; internal names (mealkeeper-v1, mealkeeper_id, storage keys, MealkeeperAndroid)
// keep that name so saved data, backups and earlier AI exports still work.
// Android-only features go through window.MealkeeperAndroid; MainActivity calls back into the window.* functions below.

// ---- State ----

const meals = [];

let navStack = [],
  page = 'home',
  selectedMeal = 1,
  mealTab = 'recipes',
  awake = false,
  cookAwake = true,
  recipeOpen = false,
  lastAwake = null,
  importText = '',
  myAi = 'chatgpt',
  appearance = 'light',
  lastAppearance = null,
  clipOffer = true,
  lastClipOffer = null,
  pendingImport = null,
  pendingAsk = null;

const STORE_KEY = 'mealkeeper.state.v1',
  BACKUP_FORMAT = 'mealkeeper-backup-v1';

let pendingRestore = null;

// ---- Small helpers ----

function str(x) {
  return x == null ? '' : String(x)
}

function arr(x) {
  return Array.isArray(x) ? x : []
}

function obj(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : {}
}

function num(x) {
  if (typeof x === 'number') return isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '' && isFinite(+x)) return +x;
  return null
}

function cleanQty(q) {
  let n = num(q);
  return n !== null ? n : typeof q === 'string' && q.trim() ? q.trim() : null
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  } [c]))
}

const COURSE_ICONS = {
  starter: '🥗',
  appetizer: '🥗',
  salad: '🥗',
  soup: '🍲',
  main: '🍽️',
  entree: '🍽️',
  side: '🥦',
  dessert: '🍰',
  drink: '🍹',
  breakfast: '🍳',
  bread: '🥖',
  sauce: '🥣'
};

function courseIcon(c) {
  return COURSE_ICONS[str(c).toLowerCase().split(/[^a-z]/)[0]] || '🍴'
}

function fmtMinutes(n) {
  n = num(n);
  if (!(n > 0)) return '';
  let h = Math.floor(n / 60),
    m = Math.round(n % 60);
  return h ? `${h} hr${m?` ${m} min`:''}` : `${m} min`
}

const FRACTIONS = {
  0.25: '¼',
  0.33: '⅓',
  0.5: '½',
  0.67: '⅔',
  0.75: '¾'
};

function fmtQty(q, unit) {
  let s = str(q);
  if (typeof q === 'number') {
    let w = Math.floor(q),
      f = Math.round((q - w) * 100) / 100;
    s = FRACTIONS[f] ? (w ? w + ' ' : '') + FRACTIONS[f] : String(Math.round(q * 100) / 100)
  }
  return [s, str(unit)].filter(Boolean).join(' ')
}

function timelineSpan(t) {
  return t.reduce((a, s) => Math.max(a, s.offset + s.duration), 0)
}

function clockMinutes(hhmm) {
  let [h, m] = str(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0)
}

function fmtClock(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60),
    m = min % 60;
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`
}

// ---- Meal data: cleaning saved data and importing the mealkeeper-v1 format ----

function cleanMeal(m, i) {
  if (!m || typeof m !== 'object' || !m.name) return null;
  let id = Number.isFinite(m.id) ? m.id : Date.now() + i,
    demo = DEMO_MEALS.find(d => d.id === id);
  // Saves from before recipes were stored in full kept recipes as [icon,title,subtitle]; demo meals get their full data back.
  if (arr(m.recipes).some(Array.isArray)) {
    if (demo) return cleanMeal(JSON.parse(JSON.stringify(demo)), i);
    m = {
      ...m,
      recipes: m.recipes.map(r => Array.isArray(r) ? {
        icon: r[0],
        title: r[1],
        course: str(r[2]).split(' · ')[0],
        time: str(r[2]).split(' · ')[1]
      } : r)
    }
  }
  return {
    id,
    name: str(m.name),
    desc: str(m.desc),
    emoji: str(m.emoji) || '🍽️',
    art: ['pasta', 'soup', 'taco'].includes(m.art) ? m.art : '',
    tag: str(m.tag),
    time: str(m.time) || '—',
    servings: num(m.servings) || 3,
    serveAt: /^\d{1,2}:\d{2}$/.test(m.serveAt) ? m.serveAt : '18:30',
    recipes: arr(m.recipes).map(cleanRecipe),
    shopping: arr(m.shopping).map(cleanShoppingItem).filter(x => x.name),
    timeline: arr(m.timeline).map(cleanStep).filter(t => t.task).sort((a, b) => a.offset - b.offset)
  }
}

// Saved data, backups and AI exports all come from outside this page, so every meal is rebuilt from known fields only.
function cleanRecipe(r, j) {
  r = obj(r);
  return {
    id: str(r.id) || 'r' + j,
    icon: str(r.icon) || courseIcon(r.course),
    title: str(r.title) || 'Recipe',
    course: str(r.course),
    servings: num(r.servings),
    prep: num(r.prep),
    cook: num(r.cook),
    time: str(r.time),
    ingredients: arr(r.ingredients).map(obj).filter(x => x.name).map(x => ({
      name: str(x.name),
      quantity: cleanQty(x.quantity),
      unit: str(x.unit),
      notes: str(x.notes)
    })),
    instructions: arr(r.instructions).map(str).filter(Boolean),
    makeAhead: str(r.makeAhead),
    source: str(r.source)
  }
}

function cleanShoppingItem(x) {
  x = obj(x);
  return {
    name: str(x.name),
    qty: str(x.qty) || 'as needed',
    group: str(x.group) || 'Other',
    usedIn: arr(x.usedIn).map(str).filter(Boolean),
    checked: x.checked === true
  }
}

function cleanStep(t) {
  t = obj(t);
  return {
    offset: Math.max(0, num(t.offset) || 0),
    duration: Math.max(0, num(t.duration) || 0),
    task: str(t.task),
    recipeId: str(t.recipeId),
    details: str(t.details)
  }
}

// Converts the mealkeeper-v1 export format (see EXPORT_FORMAT) into the app's own meal shape.
function fromV1Meal(m, i) {
  m = obj(m);
  let recipes = arr(m.recipes).map((r, j) => {
    r = obj(r);
    return cleanRecipe({
      id: r.id,
      title: r.title || r.name,
      course: r.course,
      servings: r.servings,
      prep: r.prep_time_minutes,
      cook: r.cook_time_minutes,
      time: fmtMinutes(r.total_time_minutes) || (typeof r.total_time === 'number' ? fmtMinutes(r.total_time) : r.total_time),
      ingredients: arr(r.ingredients).map(x => typeof x === 'string' ? {
        name: x
      } : x),
      instructions: arr(r.instructions).map(s => s && typeof s === 'object' ? s.text || s.step : s),
      makeAhead: r.make_ahead_notes,
      source: r.source
    }, j)
  });
  let titleOf = id => (recipes.find(r => r.id === str(id)) || {
    title: str(id)
  }).title;
  let shopping = arr(m.shopping_list).map(obj).map(x => cleanShoppingItem({
    name: x.name,
    qty: fmtQty(cleanQty(x.quantity), x.unit),
    group: x.category || x.group,
    usedIn: arr(x.used_in).map(titleOf)
  })).filter(x => x.name);
  let timeline = arr(m.timeline).map(obj).map(t => cleanStep({
    offset: t.start_offset_minutes,
    duration: t.duration_minutes,
    task: t.task,
    recipeId: t.recipe_id,
    details: Array.isArray(t.instructions) ? t.instructions.join(' ') : t.instructions
  })).filter(t => t.task).sort((a, b) => a.offset - b.offset);
  return cleanMeal({
    id: Date.now() + i,
    name: str(m.name) || 'Imported meal',
    desc: str(m.description) || 'Imported AI meal collection.',
    tag: 'IMPORTED',
    time: typeof m.total_time === 'number' ? fmtMinutes(m.total_time) : str(m.total_time) || fmtMinutes(timelineSpan(timeline)),
    servings: m.servings,
    recipes,
    shopping: shopping.length ? shopping : buildShoppingList(recipes),
    timeline
  }, i)
}

// Used when an export has recipes but no shopping_list: merge ingredients with the same name and unit.
function buildShoppingList(recipes) {
  let map = new Map();
  recipes.forEach(r => r.ingredients.forEach(x => {
    let k = x.name.toLowerCase().trim() + '|' + x.unit.toLowerCase().trim(),
      e = map.get(k);
    if (!e) map.set(k, e = {
      name: x.name,
      unit: x.unit,
      qtys: [],
      usedIn: []
    });
    e.qtys.push(x.quantity);
    if (!e.usedIn.includes(r.title)) e.usedIn.push(r.title)
  }));
  return [...map.values()].map(e => {
    let nums = e.qtys.filter(q => typeof q === 'number'),
      parts = nums.length ? [fmtQty(nums.reduce((a, b) => a + b, 0), e.unit)] : [];
    e.qtys.filter(q => typeof q === 'string').forEach(q => parts.push(fmtQty(q, e.unit)));
    return cleanShoppingItem({
      name: e.name,
      qty: parts.join(' + '),
      usedIn: e.usedIn
    })
  })
}

// AI replies often wrap JSON in ``` fences or add a sentence around it; pull out the outermost {...} block.
// The inverse of fromV1Meal, used to hand a meal back to an AI to revise. mealkeeper_id lets the reply update it.
function toV1Meal(m) {
  let idOf = title => (m.recipes.find(r => r.title === title) || {}).id || title;
  return {
    mealkeeper_id: String(m.id),
    name: m.name,
    description: m.desc,
    servings: m.servings,
    total_time: m.time,
    recipes: m.recipes.map(r => ({
      id: r.id,
      title: r.title,
      course: r.course,
      servings: r.servings,
      prep_time_minutes: r.prep,
      cook_time_minutes: r.cook,
      total_time: r.time,
      ingredients: r.ingredients.map(x => ({name: x.name, quantity: x.quantity, unit: x.unit || null, notes: x.notes || null})),
      instructions: r.instructions,
      make_ahead_notes: r.makeAhead || null,
      source: r.source || null
    })),
    shopping_list: m.shopping.map(x => ({name: x.name, quantity: x.qty, unit: null, category: x.group, used_in: x.usedIn.map(idOf)})),
    timeline: m.timeline.map(t => ({
      start_offset_minutes: t.offset,
      duration_minutes: t.duration,
      task: t.task,
      recipe_id: t.recipeId || null,
      instructions: t.details || null
    }))
  };
}

// The meal an incoming export would update: same mealkeeper_id, or failing that the same name.
function existingMealFor(v1) {
  v1 = obj(v1);
  let id = num(v1.mealkeeper_id), name = str(v1.name).trim().toLowerCase();
  return (id !== null && meals.find(m => m.id === id)) || (name && meals.find(m => m.name.trim().toLowerCase() === name)) || null;
}

// Takes an AI's new version of a meal, keeping the serving time and check marks on items still on the list.
function updateMeal(target, fresh, v1) {
  let checked = new Set(target.shopping.filter(x => x.checked).map(x => x.name.trim().toLowerCase()));
  target.name = fresh.name;
  if (str(v1.description)) target.desc = fresh.desc;
  if (str(v1.total_time) || fresh.timeline.length) target.time = fresh.time;
  if (num(v1.servings)) target.servings = fresh.servings;
  target.recipes = fresh.recipes;
  target.timeline = fresh.timeline;
  target.shopping = fresh.shopping.map(x => ({...x, checked: checked.has(x.name.trim().toLowerCase())}));
}

function parseMealkeeperJson(text) {
  let t = text.replace(/```(?:json)?/gi, '').trim(),
    a = t.indexOf('{'),
    b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o;
  try {
    o = JSON.parse(t.slice(a, b + 1))
  } catch (e) {
    return null
  }
  if (!o || typeof o !== 'object') return null;
  if (!Array.isArray(o.meals) && Array.isArray(o.recipes)) o = {
    format: o.format,
    meals: [o]
  };
  return o
}

const sampleExport = JSON.stringify(SAMPLE_EXPORT, null, 2);

// ---- AI handoff: what ChatGPT / Claude are told ----

// The mealkeeper-v1 format written for an AI. The skeleton is valid JSON (tests check the importer accepts it).
// It asks for a code block because both apps put a Copy button on code blocks, compact JSON because it streams
// faster, and a closing "Ready" line because the Copy button appears before the block is finished.
const EXPORT_FORMAT = `Reply with one compact JSON code block (no indentation) in this format, then the line "✅ Ready to copy". No other text.

{"format": "mealkeeper-v1", "meals": [{
  "mealkeeper_id": null, "name": "…", "description": "…", "servings": 4, "total_time": "1 hr 15 min",
  "recipes": [{
    "id": "short-id", "title": "…", "course": "Main", "servings": 4,
    "prep_time_minutes": 15, "cook_time_minutes": 40, "total_time_minutes": 55,
    "ingredients": [{"name": "…", "quantity": 1.5, "unit": "lb", "notes": "diced"}],
    "instructions": ["…", "…"],
    "make_ahead_notes": null, "source": null
  }],
  "shopping_list": [{"name": "…", "quantity": 1.5, "unit": "lb", "category": "Produce", "used_in": ["short-id"]}],
  "timeline": [{"start_offset_minutes": 0, "duration_minutes": 10, "task": "…", "recipe_id": "short-id", "instructions": "…"}]
}]}

Rules:
- One recipe per dish, with all of its ingredients and steps.
- Quantities are numbers (1.5, not "1 1/2"); use null if unknown, don't guess.
- Merge duplicate shopping items; "category" is the store section; "used_in" lists recipe ids.
- start_offset_minutes counts from when cooking starts. Order the timeline so every dish is ready at serving time, including preheating and resting.
- Keep any existing mealkeeper_id unchanged.`;

// Standing instructions for a ChatGPT or Claude project, so the user can just say "send it to the pan".
const AI_SETUP_INSTRUCTIONS = `I cook the meals I plan with you using an app called Prompt to Pan. Brainstorm and refine meals with me as usual. When I say "send it to the pan", turn the meal we've settled on into the Prompt to Pan format.

${EXPORT_FORMAT}`;

// For a chat that wasn't set up: pasted at the end, it sends that chat's meal.
const ONE_OFF_PROMPT = `Send the meal we've planned in this conversation to my Prompt to Pan app. If we haven't planned one yet, suggest a complete meal first.

${EXPORT_FORMAT}`;

const AI_GUIDES = {
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    newChat: 'https://chatgpt.com/?q=',
    steps: [
      'Tap <strong>Copy instructions</strong> below.',
      'In ChatGPT, create a project (for example “Meal planning”) from <strong>Projects</strong> in the sidebar.',
      'Open the project’s <strong>Instructions</strong> and paste.',
      'Plan your meals in chats inside that project.'
    ]
  },
  claude: {
    name: 'Claude',
    url: 'https://claude.ai/',
    newChat: 'https://claude.ai/new?q=',
    steps: [
      'Tap <strong>Copy instructions</strong> below.',
      'In Claude, create a project (for example “Meal planning”) from <strong>Projects</strong> in the sidebar.',
      'Open the project’s <strong>instructions</strong> and paste.',
      'Plan your meals in chats inside that project.'
    ]
  }
};

// ---- Saved state and backups ----

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      meals,
      selectedMeal,
      awake,
      cookAwake,
      clipOffer,
      ai: myAi,
      appearance
    }))
  } catch (e) {}
}

function loadState() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(STORE_KEY))
  } catch (e) {}
  if (s) applyState(s)
}

function applyState(s) {
  if (Array.isArray(s.meals)) {
    meals.length = 0;
    s.meals.map(cleanMeal).filter(Boolean).forEach(m => meals.push(m))
  }
  let legacy = meals.find(m => m.id === 1);
  if (Array.isArray(s.checked) && legacy) s.checked.forEach(i => {
    if (Number.isInteger(i) && legacy.shopping[i]) legacy.shopping[i].checked = true
  });
  if (Number.isFinite(s.selectedMeal)) selectedMeal = s.selectedMeal;
  awake = !!s.awake;
  cookAwake = s.cookAwake !== false;
  clipOffer = s.clipOffer !== false;
  // Saves from before the "Your AI" setting stored the AI last used as aiTab.
  let ai = s.ai || s.aiTab;
  if (ai in AI_GUIDES) myAi = ai;
  if (APPEARANCES[s.appearance]) appearance = s.appearance;
}

function exportBackup() {
  let name = `prompt-to-pan-backup-${new Date().toISOString().slice(0,10)}.json`,
    data = JSON.stringify({
      format: BACKUP_FORMAT,
      exported_at: new Date().toISOString(),
      meals,
      settings: {
        awake,
        cookAwake,
        clipOffer,
        appearance
      }
    }, null, 2);
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.saveBackupFile) {
    window.MealkeeperAndroid.saveBackupFile(name, data)
  } else {
    let a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], {
      type: 'application/json'
    }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    notify('Backup downloaded')
  }
}

window.onBackupSaved = function(ok) {
  notify(ok ? 'Backup saved' : 'Couldn\'t save the backup file. Please try again.')
};

function restoreBackup() {
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.openBackupFile) {
    window.MealkeeperAndroid.openBackupFile()
  } else {
    let i = document.createElement('input');
    i.type = 'file';
    i.accept = '.json,application/json,text/plain';
    i.onchange = () => {
      if (i.files[0]) i.files[0].text().then(receiveBackupFile)
    };
    i.click()
  }
}

window.receiveBackupFile = function(text) {
  let o = parseMealkeeperJson(text || '');
  if (o && o.format === BACKUP_FORMAT && Array.isArray(o.meals)) {
    pendingRestore = o;
    let when = Date.parse(o.exported_at);
    openModal(`<h2>Restore this backup?</h2><p class="subhead">Your current ${meals.length} meal collection(s) and shopping checklist will be replaced with the ${o.meals.length} meal collection(s) in this backup${when?' from '+escapeHtml(new Date(when).toLocaleString()):''}.</p><div class="modal-foot"><button class="outline" onclick="pendingRestore=null;closeModal()">Cancel</button><button class="primary" onclick="confirmRestore()">Replace my data</button></div>`)
  } else if (o && o.meals && o.meals.length) {
    offerImport(text, 'FROM A FILE')
  } else {
    notify('That file isn\'t a Prompt to Pan backup or recipe export.')
  }
};

function confirmRestore() {
  if (!pendingRestore) return;
  applyState({
    meals: pendingRestore.meals,
    checked: pendingRestore.checked,
    awake: obj(pendingRestore.settings).awake,
    cookAwake: obj(pendingRestore.settings).cookAwake,
    clipOffer: obj(pendingRestore.settings).clipOffer,
    appearance: obj(pendingRestore.settings).appearance
  });
  pendingRestore = null;
  closeModal();
  navStack = [];
  page = 'home';
  render();
  notify(`Backup restored: ${meals.length} meal collection(s)`)
}

// ---- Navigation, modal and toast ----

function currentMeal() {
  return meals.find(m => m.id === selectedMeal) || meals[0]
}

function go(p) {
  if (p !== page) {
    navStack.push(page);
    if (navStack.length > 50) navStack.shift()
  }
  page = p;
  render();
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  })
}

// Meals are kept most recently used first, so Home's "Recent" list, Meals and the meal picker follow that order.
function bringToFront(m) {
  let i = meals.indexOf(m);
  if (i > 0) meals.unshift(...meals.splice(i, 1));
}

function pickMeal(id) {
  selectedMeal = id;
  bringToFront(currentMeal());
  render();
}

function openMeal(id) {
  if (page !== 'meal') navStack.push(page);
  selectedMeal = id;
  bringToFront(currentMeal());
  mealTab = 'recipes';
  page = 'meal';
  render();
  window.scrollTo({
    top: 0
  })
}

const PAGES = {
  home,
  meals: mealsPage,
  meal: mealPage,
  shopping: () => shoppingPage(),
  timeline: () => timelinePage(),
  ai: aiPage,
  settings: settingsPage
};

function render() {
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.getElementById('main').innerHTML = (PAGES[page] || home)();
  saveState();
  syncAwake();
  syncClipOffer();
  syncAppearance();
}

window.handleBack = function() {
  if (document.getElementById('modal-bg').style.display === 'flex') {
    closeModal();
    return true
  }
  if (navStack.length) {
    let back = navStack.pop();
    if (typeof back === 'object') {
      // Came here from a recipe (see openFromRecipe): go back to its meal and reopen it.
      page = back.page;
      selectedMeal = back.meal;
      mealTab = back.tab;
      render();
      showRecipe(back.recipe);
    } else {
      page = back;
      render();
    }
    window.scrollTo({
      top: 0
    });
    return true
  }
  if (page !== 'home') {
    page = 'home';
    render();
    window.scrollTo({
      top: 0
    });
    return true
  }
  return false
};

function notify(s, ms = 2500) {
  let t = document.getElementById('toast');
  t.textContent = s;
  t.style.display = 'block';
  clearTimeout(window._toast);
  window._toast = setTimeout(() => t.style.display = 'none', ms)
}

// centered: show mid-screen instead of as a bottom sheet (see offerImport).
function openModal(html, centered = false) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modal-bg').classList.toggle('centered', centered);
  document.getElementById('modal-bg').style.display = 'flex'
}

// When the keyboard opens, the dialog moves up and shrinks (see --dialog-bottom in app.css); keep the field in view.
document.getElementById('modal').addEventListener('focusin', e => setTimeout(() => e.target.scrollIntoView({block: 'nearest'}), 350));

function closeModal() {
  document.getElementById('modal-bg').style.display = 'none';
  recipeOpen = false;
  syncAwake()
}

// ---- Screens ----

function home() {
  let m = currentMeal(),
    list = m ? m.shopping : [],
    left = list.filter(x => !x.checked).length;
  return `<div class="eyebrow">YOUR RECIPE WORKSPACE</div><div class="spread" style="align-items:flex-start"><div><h1 class="headline">What are we cooking?</h1><p class="subhead">Your AI-created recipes, meal plans, and shopping lists — all together.</p></div><button class="primary" onclick="go('ai')">✧ Plan with AI</button></div><div class="stats"><div class="stat"><div class="number">${meals.length}</div><div class="label">Meal collections</div></div><div class="stat"><div class="number">${meals.reduce((a,x)=>a+x.recipes.length,0)}</div><div class="label">Recipes organized</div></div><div class="stat"><div class="number">${left}</div><div class="label">Items to shop for</div></div></div><div class="section-head"><h2>Recent meal collections</h2><button class="text-btn" onclick="go('meals')">View all →</button></div><div class="meal-grid">${meals.slice(0,4).map(mealCard).join('')}</div>${m?`<div class="section-head"><h2>Pick up where you left off</h2><button class="text-btn" onclick="go('timeline')">Open timeline →</button></div><div class="panel"><div class="row"><div class="recipe-icon">◷</div><div style="flex:1"><strong style="font-size:14px">${escapeHtml(m.name)}</strong><div class="muted small" style="margin-top:5px">${escapeHtml(m.timeline.length?`Start with: ${m.timeline[0].task} · ${fmtMinutes(timelineSpan(m.timeline))} total`:`${m.recipes.length} recipes · ${m.time}`)}</div></div><button class="secondary" onclick="openMeal(${m.id})">Open meal</button></div></div><div class="panel"><div class="spread"><div class="row"><div class="recipe-icon">☷</div><div><strong style="font-size:14px">Shopping list</strong><div class="muted small" style="margin-top:5px">${list.length?`${list.length-left} of ${list.length} items checked`:'No shopping list for this meal yet'}</div></div></div><button class="outline" onclick="go('shopping')">View list</button></div><div style="height:7px;background:var(--track);border-radius:9px;margin-top:16px;overflow:hidden"><div style="width:${list.length?(list.length-left)/list.length*100:0}%;height:100%;background:#66845b;border-radius:9px"></div></div></div>`:''}`
}

function mealCard(m) {
  return `<article class="meal-card" onclick="openMeal(${m.id})"><div class="meal-art ${escapeHtml(m.art)}"><span class="art-tag">${escapeHtml(m.tag)}</span><span class="art-emoji">${escapeHtml(m.emoji)}</span></div><div class="meal-content"><h3>${escapeHtml(m.name)}</h3><p>${escapeHtml(m.desc)}</p><div class="meta"><span>◷ ${escapeHtml(m.time)} &nbsp;·&nbsp; ${m.recipes.length} recipes</span><span class="mini-avatars"><span class="avatar">🍽</span><span class="avatar">☷</span><span class="avatar">◷</span></span></div></div></article>`
}

function mealsPage() {
  return `<div class="eyebrow">YOUR COLLECTIONS</div><div class="spread" style="align-items:flex-start"><div><h1 class="headline">Meal collections</h1><p class="subhead">Keep every course, recipe, shopping item, and cooking step together.</p></div><button class="primary" onclick="newMeal()">＋ New meal</button></div>${meals.length ? `<div class="meal-grid">${meals.map(mealCard).join('')}</div>` : emptyPanel('🍲', 'No meals yet', 'Plan one with ChatGPT or Claude and send it here, or start one with New meal.')}`
}

function mealPage() {
  let m = currentMeal();
  if (!m) return mealsPage();
  return `<button class="text-btn" onclick="go('meals')">← All meal collections</button><div style="height:15px"></div><div class="eyebrow">MEAL COLLECTION</div><div class="spread" style="align-items:flex-start"><div><h1 class="headline">${escapeHtml(m.name)}</h1><p class="subhead">${escapeHtml(m.desc)}</p><div class="row muted small">◷ ${escapeHtml(m.time)} &nbsp;·&nbsp; ${m.recipes.length} recipes &nbsp;·&nbsp; Serves ${escapeHtml(m.servings)}</div></div><div class="actions"><button class="secondary" onclick="reviseMeal()">✧ Revise with AI</button><button class="outline" onclick="openImport()">＋ Import</button></div></div><div class="tabs"><button class="tab ${mealTab==='recipes'?'active':''}" onclick="mealTab='recipes';render()">Recipes (${m.recipes.length})</button><button class="tab ${mealTab==='shopping'?'active':''}" onclick="mealTab='shopping';render()">Shopping list</button><button class="tab ${mealTab==='timeline'?'active':''}" onclick="mealTab='timeline';render()">Cooking timeline</button></div>${mealTab==='recipes'?`<div class="section-head" style="margin-top:12px"><h2>Courses & recipes</h2><button class="text-btn" onclick="go('ai')">✧ Plan with AI</button></div><div class="recipe-list">${m.recipes.length?m.recipes.map((r,i)=>`<div class="recipe-row" onclick="showRecipe(${i})"><div class="recipe-icon">${escapeHtml(r.icon)}</div><div><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml([r.course,r.time].filter(Boolean).join(' · '))}</p></div><span class="arrow">›</span></div>`).join(''):`<div class="panel empty"><div style="font-size:34px;margin-bottom:12px">🥘</div><strong>No recipes yet</strong><p class="small">Import a recipe bundle from your AI, and all the courses will appear here.</p><button class="primary" onclick="openImport()">Import recipes</button></div>`}</div>`:mealTab==='shopping'?shoppingPage(true):timelinePage(true)}<div class="actions" style="margin-top:20px"><button class="secondary" onclick="go('shopping')">☷ Open full shopping list</button><button class="secondary" onclick="go('timeline')">◷ Plan cooking order</button></div><div class="divider" style="margin-top:28px"></div><button class="outline danger" onclick="confirmDeleteMeal()">Delete meal</button>`
}

function showRecipe(i) {
  let m = currentMeal(),
    r = m && m.recipes[i];
  if (!r) return;
  recipeOpen = true;
  syncAwake();
  let facts = [
    ['Prep', fmtMinutes(r.prep)],
    ['Cook', fmtMinutes(r.cook)],
    ['Total', r.time],
    ['Serves', str(r.servings || '')]
  ].filter(f => f[1]);
  openModal(`<div class="eyebrow">${escapeHtml(m.name)}</div><h2>${escapeHtml(r.icon)} ${escapeHtml(r.title)}</h2>${r.course?`<p class="subhead" style="margin-bottom:10px">${escapeHtml(r.course)}</p>`:''}${facts.length?`<div class="muted small" style="margin-bottom:14px">${facts.map(f=>`${f[0]}: <strong>${escapeHtml(f[1])}</strong>`).join(' &nbsp;·&nbsp; ')}</div>`:''}${r.ingredients.length?`<div class="panel"><strong>Ingredients</strong>${r.ingredients.map(x=>`<div class="checkrow"><span>${escapeHtml(x.name)}${x.notes?` <span class="muted small">(${escapeHtml(x.notes)})</span>`:''}</span><span class="qty">${escapeHtml(fmtQty(x.quantity,x.unit))}</span></div>`).join('')}</div>`:''}${r.instructions.length?`<div class="panel"><strong>Instructions</strong><ol style="padding-left:20px;margin:10px 0 0;line-height:1.6;font-size:14px">${r.instructions.map(s=>`<li style="margin-bottom:8px">${escapeHtml(s)}</li>`).join('')}</ol></div>`:''}${r.ingredients.length||r.instructions.length?'':`<div class="panel"><p class="muted small" style="line-height:1.6;margin:0">No ingredients or steps are saved for this recipe. Send the meal from ChatGPT or Claude to get the full recipe.</p></div>`}${r.makeAhead?`<div class="panel"><strong>Make ahead</strong><p class="muted small" style="line-height:1.6;margin-bottom:0">${escapeHtml(r.makeAhead)}</p></div>`:''}${r.source?`<p class="muted small">Source: ${escapeHtml(r.source)}</p>`:''}<button class="text-btn danger" style="margin-top:6px" onclick="confirmDeleteRecipe(${i})">Delete this recipe</button><div class="modal-foot"><button class="secondary" onclick="askAbout('recipe',${i})">✧ Ask AI</button><button class="secondary" onclick="openFromRecipe(${i},'shopping')">Shopping list</button><button class="primary" onclick="closeModal()">Done</button></div>`)
}

function showRecipeTitled(title) {
  let m = currentMeal(), i = m ? m.recipes.findIndex(r => r.title === title) : -1;
  if (i >= 0) showRecipe(i);
}

// Opens the shopping list or timeline from a recipe, so Back (and the link at the top) reopens that recipe.
function openFromRecipe(i, p) {
  closeModal();
  if (page === p) return;
  navStack.push({page, recipe: i, meal: currentMeal().id, tab: mealTab});
  page = p;
  render();
  window.scrollTo({top: 0});
}

function shoppingPage(embedded = false) {
  let m = currentMeal(),
    head = embedded ? '' : `${backLink()}<div class="eyebrow">READY FOR THE STORE</div><h1 class="headline">Shopping list</h1><p class="subhead">One consolidated list for the whole meal. Check items off as you shop.</p>${mealPicker(m)}`;
  if (!m || !m.shopping.length) return head + emptyPanel('☷', 'No shopping list yet', 'Send this meal from ChatGPT or Claude to get a combined shopping list.');
  let list = m.shopping,
    done = list.filter(x => x.checked).length,
    groups = [...new Set(list.map(x => x.group))];
  return `${head}<div class="panel"><div class="spread"><div><strong>${list.length-done} items left</strong><div class="muted small" style="margin-top:4px">${done} of ${list.length} checked</div></div><div class="actions"><button class="outline" onclick="clearChecks()">Uncheck all</button><button class="secondary" onclick="copyList()">Copy list</button></div></div><div style="height:6px;background:var(--track);border-radius:9px;margin-top:15px;overflow:hidden"><div style="height:100%;width:${done/list.length*100}%;background:#66845b"></div></div></div>${groups.map(g=>`<div class="panel"><div class="spread"><h3 style="font-size:15px;margin:0">${escapeHtml(g)}</h3><span class="muted small">${list.filter(x=>x.group===g).length} items</span></div>${list.map((x,i)=>({...x,i})).filter(x=>x.group===g).map(x=>`<label class="checkrow ${x.checked?'checked':''}"><input type="checkbox" ${x.checked?'checked':''} onchange="toggleItem(${x.i},this.checked)"><span><span class="checktext">${escapeHtml(x.name)}</span>${x.usedIn.length?`<span class="muted small" style="display:block;margin-top:3px">for ${x.usedIn.map(recipeLink).join(', ')}</span>`:''}</span><span class="qty">${escapeHtml(x.qty)}</span></label>`).join('')}</div>`).join('')}`;
}

// Timeline offsets count from when cooking starts, so the start time is worked back from the serving time.
function timelinePage(embedded = false) {
  let m = currentMeal(),
    head = embedded ? '' : `${backLink()}<div class="eyebrow">COOKING MODE</div><h1 class="headline">Cooking timeline</h1><p class="subhead">A coordinated order of operations so courses finish at the right time.</p>${mealPicker(m)}`;
  if (!m || !m.timeline.length) return head + emptyPanel('◷', 'No cooking timeline yet', 'Send this meal from ChatGPT or Claude to get a coordinated cooking order.');
  let span = timelineSpan(m.timeline),
    serve = clockMinutes(m.serveAt),
    start = serve - span,
    titleOf = id => (m.recipes.find(r => r.id === id) || {}).title;
  return `${head}<div class="panel"><div class="spread"><div><strong>${escapeHtml(m.name)}</strong><div class="muted small" style="margin-top:4px">Start at ${fmtClock(start)} · serve at ${fmtClock(serve)} · ${fmtMinutes(span)} total</div></div><span class="badge">${m.recipes.length} recipes</span></div><label class="field-label">Target serving time</label><input class="field" type="time" value="${escapeHtml(m.serveAt)}" onchange="setServeAt(this.value)"></div><div class="panel"><div class="timeline">${m.timeline.map((t,i)=>`<div class="time">${fmtClock(start+t.offset)}</div><div class="timeitem"><strong>${escapeHtml(t.task)}</strong>${t.duration?` <span class="muted small">· ${fmtMinutes(t.duration)}</span>`:''}${titleOf(t.recipeId)?`<div class="muted small" style="margin-top:3px">${recipeLink(titleOf(t.recipeId))}</div>`:''}${t.details?`<p>${escapeHtml(t.details)}</p>`:''}<button class="text-btn" style="font-size:12px;padding:6px 0 0" onclick="askAbout('step',${i})">✧ Ask AI about this step</button></div>`).join('')}<div class="time">${fmtClock(serve)}</div><div class="timeitem"><strong>Serve</strong><p>Everything should be ready now.</p></div></div><div class="divider"></div><div class="spread"><span class="muted small">${awake||cookAwake?'Your screen stays on while this timeline is open.':'Your screen may sleep while you cook.'}</span><button class="secondary" onclick="go('settings')">Configure</button></div></div>`
}

function aiPage() {
  let guide = AI_GUIDES[myAi],
    step = (n, title, body) => `<div class="row" style="align-items:flex-start;margin-bottom:12px"><div class="recipe-icon" style="width:38px;height:38px;font-size:16px">${n}</div><div><strong>${title}</strong><div class="muted small" style="margin-top:4px;line-height:1.5">${body}</div></div></div>`;
  return `<div class="eyebrow">PLAN WITH YOUR AI</div><h1 class="headline">Brainstorm there, cook here</h1><p class="subhead">Plan meals with ChatGPT or Claude the way you normally would. When you're happy, say <strong>“send it to the pan”</strong> and the meal comes here with its recipes, shopping list and cooking timeline.</p>
<div class="panel">${step('1', 'Set up your AI once', 'Give it standing instructions, so you never have to paste a prompt into a chat.')}
<div class="muted small" style="margin-top:4px">Your AI</div>${aiChoice()}
<ol style="padding-left:20px;margin:0 0 14px;line-height:1.6;font-size:14px">${guide.steps.map(x => `<li style="margin-bottom:6px">${x}</li>`).join('')}</ol>
<div class="actions"><button class="primary" onclick="copySetup()">▣ Copy instructions</button><button class="secondary" onclick="openAi(myAi)">Open ${guide.name} ↗</button></div>
<details style="margin-top:14px"><summary class="muted small">Show the instructions</summary><textarea class="field" rows="12" readonly style="margin-top:10px">${escapeHtml(AI_SETUP_INSTRUCTIONS)}</textarea></details></div>
<div class="panel">${step('2', 'Plan, then send it here', `When the meal is right, say “send it to the pan”. Tap <strong>Copy</strong> on the code block it replies with, then come back here. ${clipOffer ? 'Prompt to Pan will offer to import it.' : 'Then tap Import and paste it. (Turn on “Offer to import copied meals” in Settings to skip this.)'}`)}
${step('↗', 'Or share it', 'Long-press the reply, tap <strong>Share</strong>, and pick Prompt to Pan.')}
<button class="secondary" onclick="openImport()">↥ Import manually</button></div>
<div class="panel"><strong>Not set up yet?</strong><p class="muted small" style="line-height:1.5;margin:6px 0 12px">Paste this prompt at the end of any chat to send that meal over.</p>
<div class="actions"><button class="secondary" onclick="copyPrompt()">▣ Copy prompt</button><button class="secondary" onclick="sharePrompt()">☍ Share prompt</button></div>
<button class="outline" style="margin-top:12px" onclick="sendPrompt(myAi, ONE_OFF_PROMPT)">Start a new chat in ${guide.name} ↗</button></div>`
}

function settingsPage() {
  return `<div class="eyebrow">PREFERENCES</div><h1 class="headline">Settings</h1><p class="subhead">Tune your cooking experience and recipe import behavior.</p><div class="panel"><div class="row"><div class="recipe-icon">◑</div><div style="flex:1"><strong>Appearance</strong><div class="muted small" style="margin-top:4px">Light is linen; dark is a soft olive.</div></div></div><div class="tabs" style="margin:10px 0 0">${Object.entries(APPEARANCES).map(([k, name]) => `<button class="tab ${k === appearance ? 'active' : ''}" onclick="setAppearance('${k}')">${name}</button>`).join('')}</div></div><div class="panel"><div class="spread" style="flex-wrap:nowrap"><div class="row"><div class="recipe-icon">☀</div><div><strong>Keep screen awake while cooking</strong><div class="muted small" style="margin-top:5px">Stays on while a cooking timeline or recipe is open.</div></div></div><input class="toggle" type="checkbox" ${cookAwake?'checked':''} onchange="setCookAwake(this.checked)"></div><div class="divider"></div><div class="spread" style="flex-wrap:nowrap"><div class="row"><div class="recipe-icon">◐</div><div><strong>Always keep screen awake</strong><div class="muted small" style="margin-top:5px">Stays on whenever Prompt to Pan is open. Uses more battery.</div></div></div><input class="toggle" type="checkbox" ${awake?'checked':''} onchange="setAwake(this.checked)"></div></div><div class="panel"><div class="row"><div class="recipe-icon">↥</div><div style="flex:1"><strong>Import recipes</strong><div class="muted small" style="margin-top:4px">Paste a meal export from ChatGPT, Claude or another AI.</div></div><button class="secondary" onclick="openImport()">Import</button></div><div class="divider"></div><div class="row"><div class="recipe-icon">✦</div><div style="flex:1"><strong>Your AI</strong><div class="muted small" style="margin-top:4px">Revise with AI and Ask AI open a new chat here.</div></div></div>${aiChoice()}<div class="row"><div class="recipe-icon">✧</div><div style="flex:1"><strong>Plan with AI</strong><div class="muted small" style="margin-top:4px">Set up ChatGPT or Claude to send meals here.</div></div><button class="secondary" onclick="go('ai')">Set up</button></div><div class="divider"></div><div class="spread" style="flex-wrap:nowrap"><div class="row"><div class="recipe-icon">▣</div><div><strong>Offer to import copied meals</strong><div class="muted small" style="margin-top:5px">When you copy a meal in ChatGPT or Claude and come back, Prompt to Pan offers to import it. Android shows a notice each time it checks a new copy.</div></div></div><input class="toggle" type="checkbox" ${clipOffer?'checked':''} onchange="setClipOffer(this.checked)"></div></div><div class="panel"><div class="row"><div class="recipe-icon">⛁</div><div style="flex:1"><strong>Backup & restore</strong><div class="muted small" style="margin-top:4px">Your meals and shopping checklist are saved on this device. Export a backup file to keep them safe or move them to another phone.</div></div></div><div class="actions" style="margin-top:14px"><button class="primary" onclick="exportBackup()">⤓ Export backup</button><button class="secondary" onclick="restoreBackup()">⤒ Restore from file</button></div></div>`
}

// The link back from the shopping list or timeline: to the recipe the user came from, or else to the meal.
function backLink() {
  let from = navStack[navStack.length - 1], m = currentMeal(), r;
  if (from && typeof from === 'object') r = (meals.find(x => x.id === from.meal) || {recipes: []}).recipes[from.recipe];
  if (r) return `<button class="text-btn" onclick="handleBack()">← ${escapeHtml(r.title)}</button><div style="height:15px"></div>`;
  if (!m) return '';
  return `<button class="text-btn" onclick="${from === 'meal' ? 'handleBack()' : `openMeal(${m.id})`}">← ${escapeHtml(m.name)}</button><div style="height:15px"></div>`;
}

// A recipe name that opens the recipe over the current screen. It sits inside a shopping-list <label>, so it
// stops the click from also ticking the item.
function recipeLink(title) {
  return `<span class="recipe-link" onclick="event.preventDefault();event.stopPropagation();showRecipeTitled(this.textContent)">${escapeHtml(title)}</span>`;
}

// The "Your AI" switch, shared by Settings and the Plan with AI screen.
function aiChoice() {
  return `<div class="tabs" style="margin:6px 0 14px">${Object.entries(AI_GUIDES).map(([k, g]) => `<button class="tab ${k === myAi ? 'active' : ''}" onclick="setMyAi('${k}')">${g.name}</button>`).join('')}</div>`;
}

function mealPicker(m) {
  return meals.length < 2 ? '' : `<label class="field-label" style="margin-top:0">Meal</label><select class="field" style="margin-bottom:18px" onchange="pickMeal(Number(this.value))">${meals.map(x=>`<option value="${x.id}" ${x===m?'selected':''}>${escapeHtml(x.name)}</option>`).join('')}</select>`
}

function emptyPanel(icon, title, text) {
  return `<div class="panel empty"><div style="font-size:34px;margin-bottom:12px">${icon}</div><strong>${title}</strong><p class="small">${text}</p><button class="primary" onclick="go('ai')">✧ Plan with AI</button></div>`
}

// ---- Actions ----

function newMeal() {
  openModal(`<h2>Create a meal collection</h2><p class="subhead">Start a collection, then import AI-generated recipes into it.</p><label class="field-label">Meal name</label><input class="field" id="new-name" placeholder="e.g. Friday night dinner"><label class="field-label">Description</label><input class="field" id="new-desc" placeholder="Optional note about the meal"><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary" onclick="addMeal()">Create collection</button></div>`)
}

function addMeal() {
  let n = document.getElementById('new-name').value.trim();
  if (!n) {
    notify('Give your meal a name first.');
    return
  }
  meals.unshift({
    id: Date.now(),
    name: n,
    desc: document.getElementById('new-desc').value || 'A new meal collection.',
    emoji: '🍽️',
    art: '',
    tag: 'NEW COLLECTION',
    time: '—',
    servings: 3,
    serveAt: '18:30',
    recipes: [],
    shopping: [],
    timeline: []
  });
  closeModal();
  openMeal(meals[0].id)
}

function openImport() {
  openModal(`<h2>Import AI-generated recipes</h2><p class="subhead" style="margin-bottom:12px">Paste the structured export from ChatGPT, Claude, or another assistant. You can also load the sample to explore the flow.</p><label class="field-label">Recipe export (JSON or readable format)</label><textarea id="import-area" class="field" placeholder="Paste your recipe export here…" rows="7">${escapeHtml(importText)}</textarea><div class="actions" style="margin-top:12px"><button class="secondary" onclick="document.getElementById('import-area').value=sampleExport">Load sample export</button><button class="outline" onclick="closeModal();go('ai')">Set up your AI</button></div><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary" onclick="doImport()">Import recipes →</button></div>`)
}

function doImport() {
  let v = document.getElementById('import-area').value.trim();
  if (!v) {
    notify('Paste an export or load the sample first.');
    return
  }
  importText = v;
  let parsed = parseMealkeeperJson(v);
  if (parsed && parsed.meals && parsed.meals.length) {
    if (!parsed.meals.some(existingMealFor)) importMeals(parsed);
    else offerImport(v, 'PASTED');
  } else {
    notify(parsed !== null ? 'That JSON has no meals in it. Check it follows the mealkeeper-v1 format.' : looksLikeUnfinishedExport(v) ? 'That looks unfinished. Wait until the AI shows “✅ Ready to copy”, then copy and paste it again.' : 'Couldn\'t find a meal in that text. Make sure you copied the whole AI reply.', 6000)
  }
}

// mode 'update' replaces meals that match an existing one (see existingMealFor); 'copy' always adds new meals.
function importMeals(parsed, mode = 'update') {
  let added = [], updated = [];
  parsed.meals.forEach((v1, i) => {
    let fresh = fromV1Meal(v1, i), target = mode === 'update' && existingMealFor(v1);
    if (!fresh) return;
    if (target) {
      updateMeal(target, fresh, obj(v1));
      updated.push(target);
      bringToFront(target);
    } else {
      added.push(fresh);
    }
  });
  meals.unshift(...added);
  closeModal();
  let all = updated.concat(added);
  if (all.length === 1) {
    notify(`${updated.length ? 'Updated' : 'Imported'} “${all[0].name}”`);
    openMeal(all[0].id);
  } else {
    if (all.length) selectedMeal = all[all.length - 1].id;
    notify([updated.length && `Updated ${updated.length}`, added.length && `imported ${added.length}`].filter(Boolean).join(', ') + ' meal collection(s).');
    go('meals');
  }
}

// Asks before importing a meal that arrived from outside (copied or shared). Returns false if the text isn't one.
function offerImport(text, source) {
  let parsed = parseMealkeeperJson(text || '');
  if (!parsed || !arr(parsed.meals).length) return false;
  pendingImport = parsed;
  let n = parsed.meals.length,
    first = obj(parsed.meals[0]),
    matches = parsed.meals.map(existingMealFor).filter(Boolean),
    title = n === 1 ? str(first.name) || 'this meal' : `${n} meals`,
    detail = n === 1 ? [`${arr(first.recipes).length} recipes`, arr(first.shopping_list).length && `${arr(first.shopping_list).length} shopping items`, arr(first.timeline).length && 'cooking timeline'].filter(Boolean).join(' · ') : parsed.meals.map(m => str(obj(m).name) || 'Untitled meal').join(', '),
    notNow = `<button class="outline" onclick="pendingImport=null;closeModal()">Not now</button>`,
    buttons = matches.length ?
    `${notNow}<button class="secondary" onclick="confirmImport('copy')">Save as new</button><button class="primary" onclick="confirmImport('update')">Update</button>` :
    `${notNow}<button class="primary" onclick="confirmImport('update')">Import</button>`;
  if (matches.length) detail += n === 1 ? '. This replaces its recipes, shopping list and timeline; items you checked off stay checked.' : `. ${matches.length} of them will update meals you already have.`;
  // Centred: when the user comes back from copying in ChatGPT or Claude, Android's copy preview and "pasted from
  // your clipboard" notice sit at the bottom of the screen for a few seconds and would cover a bottom sheet.
  openModal(`<div class="eyebrow">${source}</div><h2>${matches.length && n === 1 ? 'Update' : 'Import'} ${escapeHtml(title)}?</h2><p class="subhead">${escapeHtml(detail)}</p><div class="modal-foot">${buttons}</div>`, true);
  return true;
}

function confirmImport(mode) {
  if (!pendingImport) return;
  let parsed = pendingImport;
  pendingImport = null;
  importMeals(parsed, mode);
}

window.receiveSharedText = function(text) {
  if (!text || offerImport(text, 'SHARED WITH PROMPT TO PAN')) return;
  importText = text;
  go('home');
  openImport();
  notify('Shared text loaded. Check it, then import.');
};

// MainActivity calls this when the app comes back to the front with a new copy that looks like a meal export.
window.receiveClipboardText = function(text) {
  if (!clipOffer || document.getElementById('modal-bg').style.display === 'flex') return;
  if (offerImport(text, 'FROM YOUR CLIPBOARD')) return;
  // Copied while the AI was still writing: the start of an export, but not complete JSON yet.
  if (looksLikeUnfinishedExport(text)) notify('That copy looks unfinished. Wait until the AI shows “✅ Ready to copy”, then copy it again.', 6000);
};

function looksLikeUnfinishedExport(text) {
  return /"format"\s*:\s*"mealkeeper-v1"|"meals"\s*:\s*\[/.test(text || '');
}

function confirmDeleteMeal() {
  let m = currentMeal();
  if (!m) return;
  openModal(`<h2>Delete “${escapeHtml(m.name)}”?</h2><p class="subhead">The meal goes with its ${m.recipes.length} recipe(s), shopping list and timeline. This can't be undone, but restoring a backup (Settings) brings it back.</p><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary danger-fill" onclick="deleteMeal(${m.id})">Delete meal</button></div>`, true);
}

function deleteMeal(id) {
  let i = meals.findIndex(m => m.id === id);
  if (i < 0) return;
  let [gone] = meals.splice(i, 1);
  // Drop history that would lead back to it (meal pages show the selected meal, which is about to change).
  navStack = navStack.filter(e => e !== 'meal' && !(typeof e === 'object' && e.meal === id));
  if (selectedMeal === id && meals.length) selectedMeal = meals[0].id;
  closeModal();
  page = 'meals';
  render();
  notify(`Deleted “${gone.name}”`);
}

// What deleting recipe i takes with it: its timeline steps, and shopping items that no other recipe uses.
function recipeDeletion(m, i) {
  let r = m.recipes[i];
  return {
    r,
    steps: m.timeline.filter(t => t.recipeId && t.recipeId === r.id),
    items: m.shopping.filter(x => x.usedIn.length && x.usedIn.every(title => title === r.title))
  };
}

function confirmDeleteRecipe(i) {
  let m = currentMeal(), {r, steps, items} = recipeDeletion(m, i),
    also = [items.length && `${items.length} shopping item(s) only it uses`, steps.length && `${steps.length} timeline step(s)`].filter(Boolean).join(' and ');
  openModal(`<h2>Delete “${escapeHtml(r.title)}”?</h2><p class="subhead">It comes out of ${escapeHtml(m.name)}${also ? `, along with ${also}` : ''}.</p><div class="modal-foot"><button class="outline" onclick="showRecipe(${i})">Cancel</button><button class="primary danger-fill" onclick="deleteRecipe(${i})">Delete recipe</button></div>`, true);
}

function deleteRecipe(i) {
  let m = currentMeal(), {r, steps, items} = recipeDeletion(m, i);
  m.recipes.splice(i, 1);
  m.timeline = m.timeline.filter(t => !steps.includes(t));
  m.shopping = m.shopping.filter(x => !items.includes(x)).map(x => ({...x, usedIn: x.usedIn.filter(title => title !== r.title)}));
  // Saved "back to recipe" entries for this meal point at recipe positions that just shifted.
  navStack = navStack.filter(e => !(typeof e === 'object' && e.meal === m.id));
  closeModal();
  render();
  notify(`Deleted “${r.title}”`);
}

function toggleItem(i, v) {
  let m = currentMeal();
  if (m && m.shopping[i]) {
    m.shopping[i].checked = v;
    render()
  }
}

function clearChecks() {
  let m = currentMeal();
  if (m) m.shopping.forEach(x => x.checked = false);
  render()
}

function copyList() {
  let m = currentMeal();
  if (!m) return;
  copyText(`${m.name}\n` + m.shopping.map(x => `${x.checked?'[x]':'[ ]'} ${x.name} — ${x.qty}`).join('\n'), 'Shopping list copied');
}

function setServeAt(v) {
  let m = currentMeal();
  if (m && /^\d{1,2}:\d{2}$/.test(v)) {
    m.serveAt = v;
    render()
  }
}

// On Android, copying goes through MainActivity so the app's own copies aren't offered back as imports.
function copyText(text, done) {
  let failed = () => notify('Couldn\'t copy. Select the text and copy it instead.');
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.copyText) {
    window.MealkeeperAndroid.copyText(text);
    notify(done);
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => notify(done)).catch(failed);
  } else {
    failed();
  }
}

function copySetup() {
  copyText(AI_SETUP_INSTRUCTIONS, `Copied. Paste it into your ${AI_GUIDES[myAi].name} project's instructions.`);
}

function copyPrompt() {
  copyText(ONE_OFF_PROMPT, 'Prompt copied. Paste it at the end of your chat.');
}

// On Android, MainActivity opens any non-app link in the browser, or in the ChatGPT / Claude app if installed.
function openUrl(url) {
  if (window.MealkeeperAndroid) location.href = url;
  else window.open(url, '_blank');
}

// Opens the ChatGPT or Claude app (on Android), or its website.
function openAi(ai) {
  let android = window.MealkeeperAndroid;
  if (!(android && android.openAiApp && android.openAiApp(ai))) openUrl(AI_GUIDES[ai].url);
}

function sharePrompt() {
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.shareText) {
    window.MealkeeperAndroid.shareText(ONE_OFF_PROMPT, 'Send prompt to AI assistant')
  } else if (navigator.share) {
    navigator.share({
      text: ONE_OFF_PROMPT
    })
  } else {
    copyPrompt()
  }
}

// A dialog for writing a request, then sending it with context to a new ChatGPT or Claude chat.
// build(text) returns the full prompt; after(), if given, reopens what the user was looking at.
function aiModal(eyebrow, title, intro, placeholder, chips, build, after) {
  pendingAsk = {build, after};
  let name = AI_GUIDES[myAi].name;
  openModal(`<div class="eyebrow">${eyebrow}</div><h2>${escapeHtml(title)}</h2><p class="subhead" style="margin-bottom:12px">${intro}</p><textarea id="ai-request" class="field" rows="3" style="min-height:90px" placeholder="${escapeHtml(placeholder)}"></textarea><div class="actions" style="margin-top:10px">${chips.map(c => `<button class="outline" style="font-size:12px;padding:7px 12px" onclick="document.getElementById('ai-request').value=this.textContent">${escapeHtml(c)}</button>`).join('')}</div><p class="muted small" style="margin:14px 0 0">Opens a new chat in ${name}. <button class="text-btn" style="font-size:12px" onclick="closeModal();go('settings')">Change</button></p><div class="modal-foot"><button class="primary" onclick="sendToAi()">Ask ${name} ↗</button></div>`);
}

function sendToAi() {
  if (!pendingAsk) return;
  let {build, after} = pendingAsk,
    prompt = build(document.getElementById('ai-request').value.trim());
  pendingAsk = null;
  closeModal();
  if (after) after();
  sendPrompt(myAi, prompt);
}

// Starts a new chat with the prompt. On Android it goes to the ChatGPT or Claude app as a share, landing in the
// message box for the user to check and send. Without the app, a web chat opens with the prompt in the link
// (copied too, since very long links can fail and then open a plain new chat).
const MAX_PROMPT_URL = 6000;

function sendPrompt(ai, prompt) {
  let guide = AI_GUIDES[ai],
    android = window.MealkeeperAndroid,
    how = android && android.sendToAiApp ? android.sendToAiApp(ai, prompt) : 'missing';
  if (how === 'shared') return notify(`Opening ${guide.name}. Check the message, then send it.`);
  if (how === 'opened') return copyText(prompt, `Prompt copied. Paste it into a new ${guide.name} chat.`);
  let url = guide.newChat + encodeURIComponent(prompt),
    fits = url.length <= MAX_PROMPT_URL;
  copyText(prompt, fits ? `Opening ${guide.name}. The prompt is copied too, in case you need to paste it.` : `Prompt copied. Paste it into the new ${guide.name} chat.`);
  openUrl(fits ? url : guide.url);
}

function reviseMeal() {
  let m = currentMeal();
  if (!m) return;
  let json = JSON.stringify({format: 'mealkeeper-v1', meals: [toV1Meal(m)]});
  aiModal('REVISE WITH AI', `Change “${m.name}”`, 'Say what to change. Your AI gets the whole meal. When it replies with the new version, copy it and come back to update the meal here.',
    'e.g. make it vegetarian', ['Make it vegetarian', `Serve ${m.servings * 2} instead of ${m.servings}`, 'Make it quicker for a weeknight', 'Add a dessert'],
    request => `Here's a meal from my Prompt to Pan app. ${request || 'I want to change it. Ask me what I have in mind.'}

Talk it through with me if you need to. When the new version is ready (or when I say "send it to the pan"), reply with one compact JSON code block in the same format, then the line "✅ Ready to copy", keeping "mealkeeper_id" unchanged so Prompt to Pan updates the meal instead of adding a copy. Update the shopping list and timeline to match.

${json}`);
}

// Readable text of a recipe for a question: shorter than JSON and easier for the AI to talk about.
function recipeText(r) {
  return [
    `${r.title}${r.course ? ` (${r.course})` : ''}${r.servings ? `, serves ${r.servings}` : ''}`,
    r.ingredients.length ? 'Ingredients:\n' + r.ingredients.map(x => `- ${[fmtQty(x.quantity, x.unit), x.name].filter(Boolean).join(' ')}${x.notes ? `, ${x.notes}` : ''}`).join('\n') : '',
    r.instructions.length ? 'Steps:\n' + r.instructions.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''
  ].filter(Boolean).join('\n\n');
}

// kind is 'recipe' (index into the meal's recipes) or 'step' (index into its timeline).
function askAbout(kind, i) {
  let m = currentMeal();
  if (!m) return;
  let title, context, after;
  if (kind === 'recipe') {
    let r = m.recipes[i];
    if (!r) return;
    title = r.title;
    context = recipeText(r);
    after = () => showRecipe(i);
  } else {
    let t = m.timeline[i], r = t && m.recipes.find(x => x.id === t.recipeId);
    if (!t) return;
    title = t.task;
    context = `I'm at this step of my cooking timeline for ${m.name}: "${t.task}"${t.details ? ` (${t.details})` : ''}.${r ? `\n\n${recipeText(r)}` : ''}`;
  }
  aiModal('ASK YOUR AI', `Ask about “${title}”`, 'Your AI gets the recipe, so you can ask it anything while you cook.',
    'e.g. what can I use instead of ricotta?', ['What can I substitute?', 'How do I know it\'s done?', 'Can I make this ahead?', 'Something went wrong. Help!'],
    question => `I'm cooking from my Prompt to Pan app right now, so keep your answer short and practical.

${question || 'I have a question about this.'}

${context}`, after);
}

const APPEARANCES = {light: 'Light', dark: 'Dark', match: 'Match phone'};

function setAppearance(mode) {
  appearance = mode;
  render();
}

// The page picks its own colours (data-theme, see app.css); MainActivity matches the status bar and window to it.
function syncAppearance() {
  document.documentElement.dataset.theme = appearance;
  if (appearance === lastAppearance) return;
  lastAppearance = appearance;
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.setAppearance) window.MealkeeperAndroid.setAppearance(appearance)
}

function setMyAi(ai) {
  myAi = ai;
  render();
  notify(`Revise and Ask will use ${AI_GUIDES[ai].name}`);
}

function setClipOffer(v) {
  clipOffer = v;
  render();
  notify(v ? 'Prompt to Pan will offer to import meals you copy' : 'Copied meals won\'t be offered')
}

function syncClipOffer() {
  if (clipOffer === lastClipOffer) return;
  lastClipOffer = clipOffer;
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.setClipboardWatch) window.MealkeeperAndroid.setClipboardWatch(clipOffer)
}

function setAwake(v) {
  awake = v;
  render();
  notify(v ? 'Screen will stay on while Prompt to Pan is open' : 'Screen can sleep normally')
}

function setCookAwake(v) {
  cookAwake = v;
  render();
  notify(v ? 'Screen will stay on while cooking' : 'Screen can sleep while cooking')
}

// The screen stays on while a timeline or recipe is open (if enabled), or always if the user asked for that.
function cookingView() {
  return recipeOpen || page === 'timeline' || (page === 'meal' && mealTab === 'timeline')
}

function syncAwake() {
  let want = awake || (cookAwake && cookingView());
  if (want === lastAwake) return;
  lastAwake = want;
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.setKeepScreenOn) window.MealkeeperAndroid.setKeepScreenOn(want)
}

// ---- Startup ----

DEMO_MEALS.map(cleanMeal).forEach(m => meals.push(m));
loadState();
render();
