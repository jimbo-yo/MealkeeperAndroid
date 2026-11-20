// Cook mode and the recipe screen's servings. Loaded before app.js; uses its helpers (str, fmtQty, escapeHtml, ...).
// Cook mode shows one step of a recipe at a time, full screen, with each ingredient's amount written into the step,
// so nobody has to scroll back to the ingredient list with their hands full.

// ---- Servings ----

// Servings chosen on the recipe screen, by "mealId/recipeId". Not saved: a recipe opens at its own servings.
const chosenServings = {};

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

const KITCHEN_FRACTIONS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];

// A quantity scaled for the chosen servings, written the way a cook measures it: 1.5 -> "1 ½", 0.33 -> "⅓".
// Text quantities ("a pinch") and unscaled amounts are left exactly as the recipe gives them.
function scaledQty(q, unit, factor) {
  if (typeof q !== 'number' || factor === 1) return fmtQty(q, unit);
  let v = q * factor;
  if (v >= 10) return fmtQty(Math.round(v), unit);
  let whole = Math.floor(v),
    frac = v - whole;
  if (frac < 0.04) return fmtQty(whole, unit);
  if (frac > 0.96) return fmtQty(whole + 1, unit);
  let near = KITCHEN_FRACTIONS.reduce((a, f) => Math.abs(f[0] - frac) < Math.abs(a[0] - frac) ? f : a);
  if (Math.abs(near[0] - frac) > 0.04) return fmtQty(Math.round(v * 100) / 100, unit);
  return [(whole ? whole + ' ' : '') + near[1], str(unit)].filter(Boolean).join(' ');
}

function servingsBar(m, r, i) {
  if (!(r.servings > 0)) return '';
  let s = servingsOf(m, r);
  return `<div class="servings-bar"><button onclick="setServings(${i},-1)" ${s <= 1 ? 'disabled' : ''} aria-label="Fewer servings">−</button><div><b>${s}</b><span>${s === 1 ? 'serving' : 'servings'}</span></div><button onclick="setServings(${i},1)" aria-label="More servings">+</button></div>`;
}

// ---- Which ingredients a step uses ----

// Words that describe an ingredient rather than name it; alone they'd match the wrong thing ("fresh", "powder").
const VAGUE_WORDS = new Set(('fresh ground large small medium chopped crushed dried whole sliced minced diced grated shredded ' +
  'extra virgin fillet fillets boneless skinless unsalted salted powder sauce juice leaves clove cloves can cans red green ' +
  'white black yellow light dark baby frozen canned cooked raw heavy links pieces stick sticks bunch').split(' '));

// Words that can stand for an ingredient in a step: its name, the singular, and any distinctive word of a longer name
// ("salmon" for "salmon fillets"), unless another ingredient of the recipe shares that word.
function ingredientTerms(ing, all) {
  let name = ing.name.toLowerCase().trim(),
    terms = new Set([name, name.replace(/es$/, ''), name.replace(/s$/, '')]),
    words = name.split(/[\s,]+/).filter(Boolean);
  if (words.length > 1) {
    let others = new Set(all.filter(x => x !== ing).flatMap(x => x.name.toLowerCase().split(/[\s,]+/)));
    for (let w of words)
      if (w.length >= 4 && !VAGUE_WORDS.has(w) && !others.has(w)) {
        terms.add(w);
        terms.add(w.replace(/s$/, ''));
      }
  }
  return [...terms].filter(t => t.length >= 3).sort((a, b) => b.length - a.length);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');
}

// The first mention of each ingredient in a step, in reading order and without overlaps: [{start, end, ing}].
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
  hits.sort((a, b) => a.start - b.start);
  return hits.filter((h, k) => !hits.slice(0, k).some(o => h.start < o.end && o.start < h.end));
}

function stepIngredients(r, i) {
  return [...new Set(mentions(r.instructions[i] || '', r.ingredients).map(h => h.ing))];
}

// A step as HTML, with each ingredient it mentions highlighted and its (scaled) amount written in front of it.
function markedStep(r, i, factor) {
  let text = r.instructions[i] || '',
    out = '',
    pos = 0;
  for (let h of mentions(text, r.ingredients)) {
    let amount = scaledQty(h.ing.quantity, h.ing.unit, factor);
    out += escapeHtml(text.slice(pos, h.start)) + `<mark>${amount ? `<b>${escapeHtml(amount)}</b> ` : ''}${escapeHtml(text.slice(h.start, h.end))}</mark>`;
    pos = h.end;
  }
  return out + escapeHtml(text.slice(pos));
}

// ---- Cook mode ----

// null, or {meal, recipe, step, added: {ingredient index: true}, sheet: whether the ingredients list is open}.
let cook = null;

function cookingRecipe() {
  let m = cook && meals.find(x => x.id === cook.meal),
    r = m && m.recipes[cook.recipe];
  return r ? {m, r} : null;
}

function openCook(i) {
  let m = currentMeal();
  if (!m || !m.recipes[i]) return;
  cook = {meal: m.id, recipe: i, step: 0, added: {}, sheet: false};
  renderCook();
  syncAwake();
}

function closeCook() {
  cook = null;
  let el = document.getElementById('cook');
  el.hidden = true;
  el.innerHTML = '';
  document.documentElement.classList.remove('cooking');
  syncAwake();
}

function cookStep(delta) {
  let c = cookingRecipe();
  if (!c) return;
  cook.step = Math.min(c.r.instructions.length, Math.max(0, cook.step + delta));
  cook.sheet = false;
  renderCook();
  let body = document.getElementById('cook-body');
  if (body) body.scrollTop = 0;
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

function renderCook() {
  let el = document.getElementById('cook'),
    c = cookingRecipe();
  if (!c) return closeCook();
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
       <p class="cook-step">${markedStep(r, i, factor)}</p>
       <div class="divider"></div>
       <p class="cook-next">${i + 1 < n ? `<strong>Next:</strong> ${escapeHtml(r.instructions[i + 1])}` : '<strong>Last step.</strong>'}</p>
       ${r.ingredients.length ? '<button class="text-btn cook-show" onclick="cookSheet(true)">Show ingredients</button>' : ''}`;
  let uses = done ? [] : stepIngredients(r, i);
  let sheet = !cook.sheet ? '' : `<div class="cook-sheet-bg" onclick="if(event.target===this)cookSheet(false)"><div class="cook-sheet" role="dialog" aria-label="Ingredients">
       ${uses.length ? `<h3>For step ${i + 1}</h3>${uses.map(x => cookIngredientRow(r, x, factor, true)).join('')}` : ''}
       <h3>${uses.length ? 'Everything in this recipe' : 'Ingredients'}</h3>${r.ingredients.map(x => cookIngredientRow(r, x, factor, false)).join('')}
       <p class="muted small">Tap an ingredient once it's in.</p>
       <button class="secondary" onclick="cookSheet(false)">Close</button></div></div>`;
  el.innerHTML = `<div class="cook-top"><button class="outline" onclick="closeCook()">Exit</button><strong class="cook-title">${escapeHtml(r.title)}</strong></div>
    <div class="cook-progress" aria-hidden="true">${r.instructions.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i>`).join('')}</div>
    <div class="cook-body" id="cook-body">${body}</div>
    <div class="cook-foot"><button class="outline" onclick="cookStep(-1)" ${i === 0 ? 'disabled' : ''}>Back</button><button class="primary" onclick="${done ? 'closeCook()' : 'cookStep(1)'}">${done ? 'Back to recipe' : i + 1 < n ? 'Next step' : 'Finish'}</button></div>
    ${sheet}`;
}

// Android's back button: the ingredients list first, then Cook mode itself. True if it did something.
function cookBack() {
  if (!cook) return false;
  if (cook.sheet) cookSheet(false);
  else closeCook();
  return true;
}
