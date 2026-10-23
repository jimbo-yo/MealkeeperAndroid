// Mealkeeper single-page app. Runs in the Android WebView (MainActivity) and in a normal browser.
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
  importText = '';

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

// Converts the mealkeeper-v1 export format (see promptPage) into the app's own meal shape.
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

// ---- Saved state and backups ----

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      meals,
      selectedMeal,
      awake,
      cookAwake
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
  cookAwake = s.cookAwake !== false
}

function exportBackup() {
  let name = `mealkeeper-backup-${new Date().toISOString().slice(0,10)}.json`,
    data = JSON.stringify({
      format: BACKUP_FORMAT,
      exported_at: new Date().toISOString(),
      meals,
      settings: {
        awake,
        cookAwake
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
    importMeals(o)
  } else {
    notify('That file isn\'t a Mealkeeper backup or recipe export.')
  }
};

function confirmRestore() {
  if (!pendingRestore) return;
  applyState({
    meals: pendingRestore.meals,
    checked: pendingRestore.checked,
    awake: obj(pendingRestore.settings).awake,
    cookAwake: obj(pendingRestore.settings).cookAwake
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

function openMeal(id) {
  if (page !== 'meal') navStack.push(page);
  selectedMeal = id;
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
  prompt: promptPage,
  settings: settingsPage
};

function render() {
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.getElementById('main').innerHTML = (PAGES[page] || home)();
  saveState();
  syncAwake();
}

window.handleBack = function() {
  if (document.getElementById('modal-bg').style.display === 'flex') {
    closeModal();
    return true
  }
  if (navStack.length) {
    page = navStack.pop();
    render();
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

function notify(s) {
  let t = document.getElementById('toast');
  t.textContent = s;
  t.style.display = 'block';
  clearTimeout(window._toast);
  window._toast = setTimeout(() => t.style.display = 'none', 2500)
}

function openModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modal-bg').style.display = 'flex'
}

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
  return `<div class="eyebrow">YOUR RECIPE WORKSPACE</div><div class="spread" style="align-items:flex-start"><div><h1 class="headline">What are we cooking?</h1><p class="subhead">Your AI-created recipes, meal plans, and shopping lists — all together.</p></div><button class="primary" onclick="go('prompt')">✧ Generate AI prompt</button></div><div class="stats"><div class="stat"><div class="number">${meals.length}</div><div class="label">Meal collections</div></div><div class="stat"><div class="number">${meals.reduce((a,x)=>a+x.recipes.length,0)}</div><div class="label">Recipes organized</div></div><div class="stat"><div class="number">${left}</div><div class="label">Items to shop for</div></div></div><div class="section-head"><h2>Recent meal collections</h2><button class="text-btn" onclick="go('meals')">View all →</button></div><div class="meal-grid">${meals.slice(0,4).map(mealCard).join('')}</div>${m?`<div class="section-head"><h2>Pick up where you left off</h2><button class="text-btn" onclick="go('timeline')">Open timeline →</button></div><div class="panel"><div class="row"><div class="recipe-icon">◷</div><div style="flex:1"><strong style="font-size:14px">${escapeHtml(m.name)}</strong><div class="muted small" style="margin-top:5px">${escapeHtml(m.timeline.length?`Start with: ${m.timeline[0].task} · ${fmtMinutes(timelineSpan(m.timeline))} total`:`${m.recipes.length} recipes · ${m.time}`)}</div></div><button class="secondary" onclick="openMeal(${m.id})">Open meal</button></div></div><div class="panel"><div class="spread"><div class="row"><div class="recipe-icon">☷</div><div><strong style="font-size:14px">Shopping list</strong><div class="muted small" style="margin-top:5px">${list.length?`${list.length-left} of ${list.length} items checked`:'No shopping list for this meal yet'}</div></div></div><button class="outline" onclick="go('shopping')">View list</button></div><div style="height:7px;background:light-dark(#e8eae2,#30372f);border-radius:9px;margin-top:16px;overflow:hidden"><div style="width:${list.length?(list.length-left)/list.length*100:0}%;height:100%;background:#66845b;border-radius:9px"></div></div></div>`:''}`
}

function mealCard(m) {
  return `<article class="meal-card" onclick="openMeal(${m.id})"><div class="meal-art ${escapeHtml(m.art)}"><span class="art-tag">${escapeHtml(m.tag)}</span><span class="art-emoji">${escapeHtml(m.emoji)}</span></div><div class="meal-content"><h3>${escapeHtml(m.name)}</h3><p>${escapeHtml(m.desc)}</p><div class="meta"><span>◷ ${escapeHtml(m.time)} &nbsp;·&nbsp; ${m.recipes.length} recipes</span><span class="mini-avatars"><span class="avatar">🍽</span><span class="avatar">☷</span><span class="avatar">◷</span></span></div></div></article>`
}

function mealsPage() {
  return `<div class="eyebrow">YOUR COLLECTIONS</div><div class="spread" style="align-items:flex-start"><div><h1 class="headline">Meal collections</h1><p class="subhead">Keep every course, recipe, shopping item, and cooking step together.</p></div><button class="primary" onclick="newMeal()">＋ New meal</button></div><div class="meal-grid">${meals.map(mealCard).join('')}</div>`
}

function mealPage() {
  let m = currentMeal();
  if (!m) return mealsPage();
  return `<button class="text-btn" onclick="go('meals')">← All meal collections</button><div style="height:15px"></div><div class="eyebrow">MEAL COLLECTION</div><div class="spread" style="align-items:flex-start"><div><h1 class="headline">${escapeHtml(m.name)}</h1><p class="subhead">${escapeHtml(m.desc)}</p><div class="row muted small">◷ ${escapeHtml(m.time)} &nbsp;·&nbsp; ${m.recipes.length} recipes &nbsp;·&nbsp; Serves ${escapeHtml(m.servings)}</div></div><button class="outline" onclick="openImport()">＋ Import recipes</button></div><div class="tabs"><button class="tab ${mealTab==='recipes'?'active':''}" onclick="mealTab='recipes';render()">Recipes (${m.recipes.length})</button><button class="tab ${mealTab==='shopping'?'active':''}" onclick="mealTab='shopping';render()">Shopping list</button><button class="tab ${mealTab==='timeline'?'active':''}" onclick="mealTab='timeline';render()">Cooking timeline</button></div>${mealTab==='recipes'?`<div class="section-head" style="margin-top:12px"><h2>Courses & recipes</h2><button class="text-btn" onclick="go('prompt')">✧ AI export format</button></div><div class="recipe-list">${m.recipes.length?m.recipes.map((r,i)=>`<div class="recipe-row" onclick="showRecipe(${i})"><div class="recipe-icon">${escapeHtml(r.icon)}</div><div><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml([r.course,r.time].filter(Boolean).join(' · '))}</p></div><span class="arrow">›</span></div>`).join(''):`<div class="panel empty"><div style="font-size:34px;margin-bottom:12px">🥘</div><strong>No recipes yet</strong><p class="small">Import a recipe bundle from your AI, and all the courses will appear here.</p><button class="primary" onclick="openImport()">Import recipes</button></div>`}</div>`:mealTab==='shopping'?shoppingPage(true):timelinePage(true)}<div class="actions" style="margin-top:20px"><button class="secondary" onclick="go('shopping')">☷ Open full shopping list</button><button class="secondary" onclick="go('timeline')">◷ Plan cooking order</button></div>`
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
  openModal(`<div class="eyebrow">${escapeHtml(m.name)}</div><h2>${escapeHtml(r.icon)} ${escapeHtml(r.title)}</h2>${r.course?`<p class="subhead" style="margin-bottom:10px">${escapeHtml(r.course)}</p>`:''}${facts.length?`<div class="muted small" style="margin-bottom:14px">${facts.map(f=>`${f[0]}: <strong>${escapeHtml(f[1])}</strong>`).join(' &nbsp;·&nbsp; ')}</div>`:''}${r.ingredients.length?`<div class="panel"><strong>Ingredients</strong>${r.ingredients.map(x=>`<div class="checkrow"><span>${escapeHtml(x.name)}${x.notes?` <span class="muted small">(${escapeHtml(x.notes)})</span>`:''}</span><span class="qty">${escapeHtml(fmtQty(x.quantity,x.unit))}</span></div>`).join('')}</div>`:''}${r.instructions.length?`<div class="panel"><strong>Instructions</strong><ol style="padding-left:20px;margin:10px 0 0;line-height:1.6;font-size:14px">${r.instructions.map(s=>`<li style="margin-bottom:8px">${escapeHtml(s)}</li>`).join('')}</ol></div>`:''}${r.ingredients.length||r.instructions.length?'':`<div class="panel"><p class="muted small" style="line-height:1.6;margin:0">No ingredients or steps are saved for this recipe. Import the meal from your AI using the Mealkeeper prompt to get the full recipe.</p></div>`}${r.makeAhead?`<div class="panel"><strong>Make ahead</strong><p class="muted small" style="line-height:1.6;margin-bottom:0">${escapeHtml(r.makeAhead)}</p></div>`:''}${r.source?`<p class="muted small">Source: ${escapeHtml(r.source)}</p>`:''}<div class="modal-foot"><button class="secondary" onclick="closeModal();go('shopping')">Shopping list</button><button class="primary" onclick="closeModal()">Done</button></div>`)
}

function shoppingPage(embedded = false) {
  let m = currentMeal(),
    head = embedded ? '' : `<div class="eyebrow">READY FOR THE STORE</div><h1 class="headline">Shopping list</h1><p class="subhead">One consolidated list for the whole meal. Check items off as you shop.</p>${mealPicker(m)}`;
  if (!m || !m.shopping.length) return head + emptyPanel('☷', 'No shopping list yet', 'Import this meal from your AI with the Mealkeeper prompt to get a combined shopping list.');
  let list = m.shopping,
    done = list.filter(x => x.checked).length,
    groups = [...new Set(list.map(x => x.group))];
  return `${head}<div class="panel"><div class="spread"><div><strong>${list.length-done} items left</strong><div class="muted small" style="margin-top:4px">${done} of ${list.length} checked</div></div><div class="actions"><button class="outline" onclick="clearChecks()">Uncheck all</button><button class="secondary" onclick="copyList()">Copy list</button></div></div><div style="height:6px;background:light-dark(#e7e9e0,#30372f);border-radius:9px;margin-top:15px;overflow:hidden"><div style="height:100%;width:${done/list.length*100}%;background:#66845b"></div></div></div>${groups.map(g=>`<div class="panel"><div class="spread"><h3 style="font-size:15px;margin:0">${escapeHtml(g)}</h3><span class="muted small">${list.filter(x=>x.group===g).length} items</span></div>${list.map((x,i)=>({...x,i})).filter(x=>x.group===g).map(x=>`<label class="checkrow ${x.checked?'checked':''}"><input type="checkbox" ${x.checked?'checked':''} onchange="toggleItem(${x.i},this.checked)"><span><span class="checktext">${escapeHtml(x.name)}</span>${x.usedIn.length?`<span class="muted small" style="display:block;margin-top:3px">for ${escapeHtml(x.usedIn.join(', '))}</span>`:''}</span><span class="qty">${escapeHtml(x.qty)}</span></label>`).join('')}</div>`).join('')}`;
}

// Timeline offsets count from when cooking starts, so the start time is worked back from the serving time.
function timelinePage(embedded = false) {
  let m = currentMeal(),
    head = embedded ? '' : `<div class="eyebrow">COOKING MODE</div><h1 class="headline">Cooking timeline</h1><p class="subhead">A coordinated order of operations so courses finish at the right time.</p>${mealPicker(m)}`;
  if (!m || !m.timeline.length) return head + emptyPanel('◷', 'No cooking timeline yet', 'Import this meal from your AI with the Mealkeeper prompt to get a coordinated cooking order.');
  let span = timelineSpan(m.timeline),
    serve = clockMinutes(m.serveAt),
    start = serve - span,
    titleOf = id => (m.recipes.find(r => r.id === id) || {}).title;
  return `${head}<div class="panel"><div class="spread"><div><strong>${escapeHtml(m.name)}</strong><div class="muted small" style="margin-top:4px">Start at ${fmtClock(start)} · serve at ${fmtClock(serve)} · ${fmtMinutes(span)} total</div></div><span class="badge">${m.recipes.length} recipes</span></div><label class="field-label">Target serving time</label><input class="field" type="time" value="${escapeHtml(m.serveAt)}" onchange="setServeAt(this.value)"></div><div class="panel"><div class="timeline">${m.timeline.map(t=>`<div class="time">${fmtClock(start+t.offset)}</div><div class="timeitem"><strong>${escapeHtml(t.task)}</strong>${t.duration?` <span class="muted small">· ${fmtMinutes(t.duration)}</span>`:''}${titleOf(t.recipeId)?`<div class="muted small" style="margin-top:3px">${escapeHtml(titleOf(t.recipeId))}</div>`:''}${t.details?`<p>${escapeHtml(t.details)}</p>`:''}</div>`).join('')}<div class="time">${fmtClock(serve)}</div><div class="timeitem"><strong>Serve</strong><p>Everything should be ready now.</p></div></div><div class="divider"></div><div class="spread"><span class="muted small">${awake||cookAwake?'Your screen stays on while this timeline is open.':'Your screen may sleep while you cook.'}</span><button class="secondary" onclick="go('settings')">Configure</button></div></div>`
}

function promptPage() {
  let prompt = `You are a recipe and meal-planning assistant. Return your complete answer as valid JSON only, using the Mealkeeper format below. Do not wrap the JSON in Markdown fences or add commentary outside it. Preserve every recipe in the meal as a separate recipe, and include a combined shopping list and an ordered cooking timeline. Use consistent units and quantities. If a value is unknown, use null rather than inventing it.\n\nSchema example:\n${sampleExport}\n\nFor each recipe, include: id, title, course, servings, prep_time_minutes, cook_time_minutes, total_time_minutes, ingredients (array of {name, quantity, unit, notes}), instructions (ordered array of strings), make_ahead_notes, and source. At meal level include name, description, servings, total_time, recipes, shopping_list (array of {name, quantity, unit, category, used_in}), and timeline (array of {start_offset_minutes, duration_minutes, task, recipe_id, instructions}, where start_offset_minutes counts from when cooking begins). Combine duplicate shopping ingredients where practical, but retain which recipes use each item. Ensure the JSON is syntactically valid and follows format: mealkeeper-v1.`;
  return `<div class="eyebrow">CONNECT YOUR AI TO MEALKEEPER</div><h1 class="headline">AI export prompt</h1><p class="subhead">Copy this prompt into ChatGPT, Claude, or another AI after asking it to create your meal. It requests a consistent structure that keeps recipes, ingredients, and timing connected.</p><div class="panel"><div class="spread"><div class="row"><div class="recipe-icon">✧</div><div><strong>Mealkeeper JSON format</strong><div class="muted small" style="margin-top:4px">Version 1 · Structured recipes + shared list + timeline</div></div></div><span class="badge">v1</span></div><label class="field-label">Copy-ready instruction prompt</label><textarea class="field" id="prompt-text" rows="15" readonly>${escapeHtml(prompt)}</textarea><div class="actions" style="margin-top:14px"><button class="primary" onclick="openChatGPT()">✦ Open in ChatGPT</button><button class="primary" onclick="openInClaude()">✦ Open in Claude</button><button class="secondary" onclick="sharePrompt()">☍ Share prompt</button><button class="outline" onclick="copyPrompt()">▣ Copy prompt</button><button class="secondary" onclick="openImport()">↥ Import AI response</button></div></div><div class="panel"><h3 style="margin:0 0 8px;font-size:16px">What this format preserves</h3>${[['▦','Meal grouping','One meal object holds all its courses and recipes.'],['☷','Combined shopping list','Quantities, categories, and which recipes use each item.'],['◷','Cooking timeline','Relative start offsets and durations for coordinating dishes.'],['↗','Portability','Plain JSON can be saved, pasted, or generated by different AI assistants.']].map(x=>`<div class="row" style="padding:11px 0"><div class="recipe-icon" style="width:38px;height:38px;font-size:17px">${x[0]}</div><div><strong style="font-size:13px">${x[1]}</strong><div class="muted small" style="margin-top:4px">${x[2]}</div></div></div>`).join('')}</div><div class="panel"><h3 style="font-size:16px;margin:0 0 7px">Suggested workflow</h3><p class="muted small" style="line-height:1.7">1. Copy the prompt.<br>2. Ask your AI to create a complete meal and follow the format.<br>3. Copy the JSON response.<br>4. Select <strong>Import recipes</strong> and paste it here.</p><button class="primary" onclick="openImport()">Import recipes →</button></div>`
}

function settingsPage() {
  return `<div class="eyebrow">PREFERENCES</div><h1 class="headline">Settings</h1><p class="subhead">Tune your cooking experience and recipe import behavior.</p><div class="panel"><div class="spread" style="flex-wrap:nowrap"><div class="row"><div class="recipe-icon">☀</div><div><strong>Keep screen awake while cooking</strong><div class="muted small" style="margin-top:5px">Stays on while a cooking timeline or recipe is open.</div></div></div><input class="toggle" type="checkbox" ${cookAwake?'checked':''} onchange="setCookAwake(this.checked)"></div><div class="divider"></div><div class="spread" style="flex-wrap:nowrap"><div class="row"><div class="recipe-icon">◐</div><div><strong>Always keep screen awake</strong><div class="muted small" style="margin-top:5px">Stays on whenever Mealkeeper is open. Uses more battery.</div></div></div><input class="toggle" type="checkbox" ${awake?'checked':''} onchange="setAwake(this.checked)"></div></div><div class="panel"><div class="row"><div class="recipe-icon">↥</div><div style="flex:1"><strong>Import recipes</strong><div class="muted small" style="margin-top:4px">Paste a Mealkeeper JSON export generated by an AI assistant.</div></div><button class="secondary" onclick="openImport()">Import</button></div><div class="divider"></div><div class="row"><div class="recipe-icon">✧</div><div style="flex:1"><strong>Export format prompt</strong><div class="muted small" style="margin-top:4px">Generate the instruction to use with your AI.</div></div><button class="secondary" onclick="go('prompt')">Open prompt</button></div></div><div class="panel"><div class="row"><div class="recipe-icon">⛁</div><div style="flex:1"><strong>Backup & restore</strong><div class="muted small" style="margin-top:4px">Your meals and shopping checklist are saved on this device. Export a backup file to keep them safe or move them to another phone.</div></div></div><div class="actions" style="margin-top:14px"><button class="primary" onclick="exportBackup()">⤓ Export backup</button><button class="secondary" onclick="restoreBackup()">⤒ Restore from file</button></div></div>`
}

function mealPicker(m) {
  return meals.length < 2 ? '' : `<label class="field-label" style="margin-top:0">Meal</label><select class="field" style="margin-bottom:18px" onchange="selectedMeal=Number(this.value);render()">${meals.map(x=>`<option value="${x.id}" ${x===m?'selected':''}>${escapeHtml(x.name)}</option>`).join('')}</select>`
}

function emptyPanel(icon, title, text) {
  return `<div class="panel empty"><div style="font-size:34px;margin-bottom:12px">${icon}</div><strong>${title}</strong><p class="small">${text}</p><button class="primary" onclick="go('prompt')">Open AI prompt</button></div>`
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
  openModal(`<h2>Import AI-generated recipes</h2><p class="subhead" style="margin-bottom:12px">Paste the structured export from ChatGPT, Claude, or another assistant. You can also load the sample to explore the flow.</p><label class="field-label">Recipe export (JSON or readable format)</label><textarea id="import-area" class="field" placeholder="Paste your recipe export here…" rows="7">${escapeHtml(importText)}</textarea><div class="actions" style="margin-top:12px"><button class="secondary" onclick="document.getElementById('import-area').value=sampleExport">Load sample export</button><button class="outline" onclick="go('prompt');closeModal()">Get export prompt</button></div><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary" onclick="doImport()">Import recipes →</button></div>`)
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
    importMeals(parsed)
  } else {
    notify(parsed === null ? 'Couldn\'t find valid JSON in that text. Make sure you copied the whole AI response.' : 'That JSON has no meals in it. Check it follows the mealkeeper-v1 format.')
  }
}

function importMeals(parsed) {
  let added = parsed.meals.map((m, i) => fromV1Meal(m, i)).filter(Boolean);
  added.forEach(m => meals.push(m));
  if (added.length) selectedMeal = added[added.length - 1].id;
  closeModal();
  notify(`Imported ${added.length} meal collection(s).`);
  go('meals')
}

window.receiveSharedText = function(text) {
  if (!text) return;
  importText = text;
  go('home');
  openImport();
  notify('Shared recipe text loaded ready to import');
};

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
  let s = `${m.name}\n` + m.shopping.map(x => `${x.checked?'[x]':'[ ]'} ${x.name} — ${x.qty}`).join('\n');
  if (navigator.clipboard) navigator.clipboard.writeText(s).then(() => notify('Shopping list copied')).catch(() => notify('List ready to copy'));
  else notify('List ready to copy')
}

function setServeAt(v) {
  let m = currentMeal();
  if (m && /^\d{1,2}:\d{2}$/.test(v)) {
    m.serveAt = v;
    render()
  }
}

function copyPrompt() {
  let t = document.getElementById('prompt-text').value;
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => notify('AI export prompt copied')).catch(() => notify('Select and copy the prompt text'));
  else {
    document.getElementById('prompt-text').select();
    notify('Select and copy the prompt text')
  }
}

function openChatGPT() {
  let p = document.getElementById('prompt-text').value;
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.openInChatGPT) {
    window.MealkeeperAndroid.openInChatGPT(p)
  } else {
    window.open('https://chatgpt.com/?q=' + encodeURIComponent(p), '_blank')
  }
}

// On Android, MainActivity opens any non-app link in the browser (or the Claude app, if installed).
function openInClaude() {
  let url = 'https://claude.ai/new?q=' + encodeURIComponent(document.getElementById('prompt-text').value);
  if (window.MealkeeperAndroid) location.href = url;
  else window.open(url, '_blank');
}

function sharePrompt() {
  let p = document.getElementById('prompt-text').value;
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.shareText) {
    window.MealkeeperAndroid.shareText(p, 'Send prompt to AI assistant')
  } else if (navigator.share) {
    navigator.share({
      text: p
    })
  } else {
    copyPrompt()
  }
}

function setAwake(v) {
  awake = v;
  render();
  notify(v ? 'Screen will stay on while Mealkeeper is open' : 'Screen can sleep normally')
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
