// Keepers: favourite recipes saved apart from their meals (Meals → Keepers), to bring into any meal later.
// A keeper is a copy, so deleting or revising the meal it came from doesn't change it. A recipe that came from (or
// was saved as) a keeper remembers it (recipe.keeper); when the recipe changes, the app offers to update the keeper.
// Loaded before app.js, so it only uses app.js's functions and constants when called, never at load time.

const keepers = [];      // {id, recipe, shopping, steps, savedAt, lastMade} (saved); see cleanKeeper
let mealsTab = 'meals',  // the Meals screen's tab: 'meals' or 'keepers'
  keeperQuery = '';      // the Keepers search box

function cleanKeeper(k, i) {
  k = obj(k);
  let recipe = cleanRecipe(k.recipe, 0);
  if (!str(obj(k.recipe).title)) return null;
  delete recipe.keeper;
  delete recipe.keeperSig;
  return {
    id: Number.isFinite(k.id) ? k.id : Date.now() + i,
    recipe,
    shopping: arr(k.shopping).map(cleanShoppingItem).filter(x => x.name).map(x => ({...x, usedIn: [recipe.title], checked: false})),
    steps: arr(k.steps).map(cleanStep).filter(t => t.task).map(t => ({...t, recipeId: recipe.id})).sort((a, b) => a.offset - b.offset),
    savedAt: num(k.savedAt) || Date.now(),
    lastMade: num(k.lastMade)
  };
}

// Ids are creation times, nudged to stay unique when several are made at once.
function newId(taken) {
  let id = Date.now();
  while (taken.some(x => x.id === id)) id++;
  return id;
}

function keeperById(id) {
  return id === null || id === undefined ? null : keepers.find(k => k.id === id) || null;
}

// What a recipe is, for telling whether it changed: everything the user reads, not where it sits in the meal.
function recipeSig(r) {
  let s = JSON.stringify([r.title, r.course, r.servings, r.prep, r.cook, r.time, r.ingredients, r.instructions, r.makeAhead]), h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// A recipe changed since it was kept (or since the user last chose to keep the saved version). recipe.keeperSig is
// the version the user has already seen.
function keeperChanged(r) {
  let k = keeperById(r.keeper), sig = recipeSig(r);
  return !!k && sig !== r.keeperSig && sig !== recipeSig(k.recipe);
}

function keeperChanges(m) {
  return m ? m.recipes.filter(keeperChanged) : [];
}

// The shopping-list name that goes with an ingredient: the same name, or one that contains the other
// ("Garlic" and "Garlic cloves").
function matchingItem(items, name) {
  let n = name.trim().toLowerCase();
  return items.find(x => x.name.trim().toLowerCase() === n) ||
    items.find(x => {
      let s = x.name.trim().toLowerCase();
      return s && n && (s.includes(n) || n.includes(s));
    });
}

// The recipe's own share of the meal's shopping list. Items only it uses come as they are; items shared with other
// recipes have the whole meal's quantity, so those are rebuilt from its ingredients, keeping the store section.
function recipeShopping(m, r) {
  let own = m.shopping.filter(x => x.usedIn.length === 1 && x.usedIn[0] === r.title),
    rest = buildShoppingList([{...r, ingredients: r.ingredients.filter(x => !matchingItem(own, x.name))}])
      .map(x => ({...x, group: (matchingItem(m.shopping, x.name) || {}).group || 'Other'}));
  return own.concat(rest).map(x => cleanShoppingItem({...x, usedIn: [r.title], checked: false}));
}

// The recipe's timeline steps, counted from its own first step.
function recipeSteps(m, r) {
  let steps = m.timeline.filter(t => t.recipeId && t.recipeId === r.id),
    first = steps.length ? Math.min(...steps.map(t => t.offset)) : 0;
  return steps.map(t => ({...t, offset: t.offset - first}));
}

function keeperFrom(m, r, id) {
  let recipe = {...r, ingredients: r.ingredients.map(x => ({...x})), instructions: r.instructions.slice()};
  delete recipe.keeper;
  delete recipe.keeperSig;
  return {id, recipe, shopping: recipeShopping(m, r), steps: recipeSteps(m, r), savedAt: Date.now(), lastMade: null};
}

// ---- Keeping and updating ----

// ☆ Keep on a recipe. A recipe with the same name as a keeper is linked to it rather than kept twice; if they differ,
// the recipe then offers to update the keeper.
function keepRecipe(i) {
  let m = currentMeal(), r = m && m.recipes[i];
  if (!r) return;
  let same = keepers.find(k => k.recipe.title.trim().toLowerCase() === r.title.trim().toLowerCase());
  if (same) {
    r.keeper = same.id;
    r.keeperSig = recipeSig(same.recipe);
    render();
    showRecipe(i);
    return notify(keeperChanged(r) ? `“${r.title}” is already a keeper, saved differently` : `“${r.title}” is already a keeper`);
  }
  let k = keeperFrom(m, r, newId(keepers));
  keepers.unshift(k);
  r.keeper = k.id;
  r.keeperSig = recipeSig(r);
  render();
  showRecipe(i);
  notify(`Saved “${r.title}” to your keepers`);
}

// Copies the meal's version of a recipe into its keeper.
function updateKeeperFrom(m, r) {
  let k = keeperById(r.keeper);
  if (!k) return;
  Object.assign(k, keeperFrom(m, r, k.id), {savedAt: k.savedAt, lastMade: k.lastMade});
  r.keeperSig = recipeSig(r);
}

// From the recipe screen: update the keeper, or keep the saved version (the offer comes back if the recipe changes again).
function resolveKeeperChange(i, update) {
  let m = currentMeal(), r = m && m.recipes[i];
  if (!r) return;
  if (update) updateKeeperFrom(m, r);
  else r.keeperSig = recipeSig(r);
  render();
  showRecipe(i);
  notify(update ? `Keeper “${r.title}” updated` : 'Your keeper stays as you saved it');
}

// After a revision (an import or the chat's save_meal): offer to update each keeper whose recipe changed.
function offerKeeperUpdates(mealId) {
  let m = meals.find(x => x.id === mealId), changed = keeperChanges(m);
  if (!changed.length) return false;
  let one = changed.length === 1;
  openModal(`<div class="eyebrow">KEEPERS</div><h2>${one ? `Update your keeper “${escapeHtml(changed[0].title)}”?` : 'Update your keepers?'}</h2><p class="subhead">${one ? 'This recipe' : 'These recipes'} changed in the new version of ${escapeHtml(m.name)}. Your keepers still have the versions you saved.</p>${one ? '' : `<div class="panel">${changed.map(r => `<label class="checkrow"><input type="checkbox" class="keeper-pick" value="${escapeHtml(r.id)}" checked><span>${escapeHtml(r.title)}</span></label>`).join('')}</div>`}<div class="modal-foot"><button class="outline" onclick="applyKeeperUpdates(${m.id},false)">Keep as saved</button><button class="primary" onclick="applyKeeperUpdates(${m.id},true)">${one ? 'Update keeper' : 'Update selected'}</button></div>`, true);
  return true;
}

function applyKeeperUpdates(mealId, update) {
  let m = meals.find(x => x.id === mealId);
  if (!m) return closeModal();
  let picks = [...document.querySelectorAll('.keeper-pick')], chosen = new Set(picks.filter(p => p.checked).map(p => p.value)), n = 0;
  keeperChanges(m).forEach(r => {
    if (update && (!picks.length || chosen.has(r.id))) {
      updateKeeperFrom(m, r);
      n++;
    } else {
      r.keeperSig = recipeSig(r);
    }
  });
  closeModal();
  render();
  notify(n ? `Updated ${n === 1 ? 'your keeper' : `${n} keepers`}` : 'Your keepers stay as you saved them');
}

// A revised meal comes back as new recipe objects; carry each recipe's keeper link over (same id, else same name).
function carryKeeperLinks(oldRecipes, fresh) {
  fresh.forEach(r => {
    let old = oldRecipes.find(o => o.id === r.id) || oldRecipes.find(o => o.title.trim().toLowerCase() === r.title.trim().toLowerCase());
    if (old && keeperById(old.keeper)) {
      r.keeper = old.keeper;
      r.keeperSig = old.keeperSig;
    }
  });
}

// ---- Bringing a keeper into a meal ----

function addToMealModal(id) {
  let k = keeperById(id);
  if (!k) return;
  openModal(`<div class="eyebrow">ADD TO A MEAL</div><h2>Where should “${escapeHtml(k.recipe.title)}” go?</h2><p class="subhead">Its ingredients join the meal's shopping list and its steps join the timeline, timed to finish with everything else.</p><div class="recipe-list">${meals.map(m => `<div class="recipe-row" onclick="addKeeperToMeal(${k.id},${m.id})"><div class="recipe-icon">${escapeHtml(m.emoji)}</div><div><h3>${escapeHtml(m.name)}</h3><p>${m.recipes.length} recipes</p></div><span class="arrow">›</span></div>`).join('')}<div class="recipe-row" onclick="addKeeperToMeal(${k.id},null)"><div class="recipe-icon">＋</div><div><h3>New meal</h3><p>Start a meal with this recipe</p></div><span class="arrow">›</span></div></div><div class="modal-foot"><button class="outline" onclick="showKeeper(${k.id})">Back</button></div>`);
}

function addKeeperToMeal(id, mealId) {
  let k = keeperById(id);
  if (!k) return;
  let m = mealId === null ? null : meals.find(x => x.id === mealId);
  if (mealId !== null && !m) return;
  if (m && m.recipes.some(r => r.title.trim().toLowerCase() === k.recipe.title.trim().toLowerCase())) return notify(`“${k.recipe.title}” is already in ${m.name}`);
  if (!m) {
    m = cleanMeal({id: newId(meals), name: k.recipe.title, desc: 'Started from a keeper.', tag: 'KEEPER', emoji: k.recipe.icon, recipes: [], shopping: [], timeline: []}, 0);
    meals.unshift(m);
  }
  mergeKeeper(m, k);
  k.lastMade = Date.now();
  bringToFront(m);
  closeModal();
  openMeal(m.id);
  notify(`Added “${k.recipe.title}” to ${m.name}`);
}

// Adds the keeper's recipe, shopping items and steps to the meal. The steps are shifted to finish when the meal's
// timeline does; if the keeper takes longer, the meal's own steps move later instead, so everything still ends at
// serving time.
function mergeKeeper(m, k) {
  let r = {...k.recipe, ingredients: k.recipe.ingredients.map(x => ({...x})), instructions: k.recipe.instructions.slice()}, n = 2;
  while (m.recipes.some(x => x.id === r.id)) r.id = `${k.recipe.id}-${n++}`;
  r.keeper = k.id;
  r.keeperSig = recipeSig(r);
  m.recipes.push(r);
  k.shopping.forEach(item => {
    let same = matchingItem(m.shopping, item.name);
    if (!same || same.name.trim().toLowerCase() !== item.name.trim().toLowerCase()) return m.shopping.push({...item, usedIn: [r.title]});
    same.qty = same.qty === 'as needed' ? item.qty : item.qty === 'as needed' ? same.qty : `${same.qty} + ${item.qty}`;
    if (!same.usedIn.includes(r.title)) same.usedIn.push(r.title);
    same.checked = false;
  });
  if (k.steps.length) {
    let mealSpan = timelineSpan(m.timeline), span = timelineSpan(k.steps), end = Math.max(mealSpan, span);
    m.timeline.forEach(t => t.offset += end - mealSpan);
    m.timeline.push(...k.steps.map(t => ({...t, recipeId: r.id, offset: t.offset + end - span})));
    m.timeline.sort((a, b) => a.offset - b.offset);
    if (end > mealSpan || m.time === '—') m.time = fmtMinutes(end);
  }
}

// ---- Keepers screen ----

// The Meals screen's tabs.
function mealsTabs() {
  return `<div class="tabs"><button class="tab ${mealsTab === 'meals' ? 'active' : ''}" onclick="mealsTab='meals';render()">Meals (${meals.length})</button><button class="tab ${mealsTab === 'keepers' ? 'active' : ''}" onclick="mealsTab='keepers';render()">Keepers (${keepers.length})</button></div>`;
}

function courseGroup(course) {
  let c = str(course).trim();
  return c ? c[0].toUpperCase() + c.slice(1) : 'Other';
}

function keepersPage() {
  let head = `<div class="eyebrow">YOUR RECIPE BOX</div><h1 class="headline">Keepers</h1><p class="subhead">Recipes worth making again. Bring one into any meal.</p>${mealsTabs()}`;
  if (!keepers.length) return `${head}<div class="panel empty"><div style="font-size:34px;margin-bottom:12px">☆</div><strong>No keepers yet</strong><p class="small">Open a recipe in one of your meals and tap ☆ Keep to save it here.</p></div>`;
  let sorted = keepers.slice().sort((a, b) => a.recipe.title.localeCompare(b.recipe.title)),
    groups = [...new Set(sorted.map(k => courseGroup(k.recipe.course)))].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  return `${head}<input class="field" id="keeper-search" type="search" placeholder="Search by name or ingredient" value="${escapeHtml(keeperQuery)}" oninput="keeperQuery=this.value;filterKeepers()" style="margin-bottom:6px">${groups.map(g => `<div class="keeper-group"><div class="section-head"><h2>${escapeHtml(g)}</h2></div><div class="recipe-list">${sorted.filter(k => courseGroup(k.recipe.course) === g).map(k => `<div class="recipe-row keeper-row" data-search="${escapeHtml(keeperSearchText(k))}" onclick="showKeeper(${k.id})"><div class="recipe-icon">${escapeHtml(k.recipe.icon)}</div><div><h3>${escapeHtml(k.recipe.title)}</h3><p>${escapeHtml([k.recipe.time, k.lastMade && `last added ${new Date(k.lastMade).toLocaleDateString()}`].filter(Boolean).join(' · '))}</p></div><span class="arrow">›</span></div>`).join('')}</div></div>`).join('')}<p class="muted small" id="keeper-none" hidden>No keepers match.</p>`;
}

function keeperSearchText(k) {
  return [k.recipe.title, k.recipe.course, ...k.recipe.ingredients.map(x => x.name)].join(' ').toLowerCase();
}

// Filters in place, so typing doesn't re-render the screen and close the keyboard.
function filterKeepers() {
  let words = keeperQuery.toLowerCase().split(/\s+/).filter(Boolean), any = false;
  document.querySelectorAll('.keeper-group').forEach(g => {
    let shown = 0;
    g.querySelectorAll('.keeper-row').forEach(row => {
      let hit = words.every(w => row.dataset.search.includes(w));
      row.hidden = !hit;
      shown += hit;
    });
    g.hidden = !shown;
    any = any || shown > 0;
  });
  let none = document.getElementById('keeper-none');
  if (none) none.hidden = any;
}

function showKeeper(id) {
  let k = keeperById(id);
  if (!k) return closeModal();
  recipeOpen = true;
  syncAwake();
  let r = k.recipe, note = [`Kept ${new Date(k.savedAt).toLocaleDateString()}`, k.lastMade && `last added to a meal ${new Date(k.lastMade).toLocaleDateString()}`].filter(Boolean).join(' · ');
  openModal(`<div class="eyebrow">KEEPER</div><h2>${escapeHtml(r.icon)} ${escapeHtml(r.title)}</h2>${recipeBody(r)}<p class="muted small">${escapeHtml(note)}</p><button class="text-btn danger" style="margin-top:6px" onclick="confirmDeleteKeeper(${k.id})">Delete this keeper</button><div class="modal-foot"><button class="outline" onclick="closeModal()">Done</button><button class="primary" onclick="addToMealModal(${k.id})">＋ Add to a meal</button></div>`);
}

function confirmDeleteKeeper(id) {
  let k = keeperById(id);
  if (!k) return;
  openModal(`<h2>Delete the keeper “${escapeHtml(k.recipe.title)}”?</h2><p class="subhead">It comes out of your keepers. Meals that use the recipe keep their copy.</p><div class="modal-foot"><button class="outline" onclick="showKeeper(${k.id})">Cancel</button><button class="primary danger-fill" onclick="deleteKeeper(${k.id})">Delete keeper</button></div>`, true);
}

function deleteKeeper(id) {
  let i = keepers.findIndex(k => k.id === id);
  if (i < 0) return;
  let [gone] = keepers.splice(i, 1);
  meals.forEach(m => m.recipes.forEach(r => {
    if (r.keeper === id) r.keeper = r.keeperSig = null;
  }));
  closeModal();
  render();
  notify(`Deleted the keeper “${gone.recipe.title}”`);
}

// ---- Deleting a meal ----

// Recipes in a meal that aren't keepers yet, offered before the meal is deleted.
function unkeptRecipes(m) {
  return m.recipes.filter(r => !keeperById(r.keeper) && !keepers.some(k => k.recipe.title.trim().toLowerCase() === r.title.trim().toLowerCase()));
}

// Keeps the recipes ticked in the delete dialog (see confirmDeleteMeal).
function keepPickedRecipes(m) {
  let picked = new Set([...document.querySelectorAll('.keep-pick:checked')].map(p => p.value));
  unkeptRecipes(m).filter(r => picked.has(r.id)).forEach(r => keepers.unshift(keeperFrom(m, r, newId(keepers))));
  return picked.size;
}
