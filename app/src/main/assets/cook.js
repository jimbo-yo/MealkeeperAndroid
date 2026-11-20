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
  voiceProblem = '';
  flash = '';
  heardCommand = '';
  renderCook();
  syncAwake();
}

function closeCook() {
  stopCookVoice();
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
  speakStep();
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
       <p class="cook-step${flashed('repeat')}">${markedStep(r, i, factor)}</p>
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
    <div class="cook-progress" aria-hidden="true">${r.instructions.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i>`).join('')}</div>
    ${voiceStatus()}
    <div class="cook-body" id="cook-body">${body}</div>
    <div class="cook-foot"><button class="outline${flashed('back')}" onclick="cookStep(-1)" ${i === 0 ? 'disabled' : ''}>Back</button><button class="primary${flashed('next')}" onclick="${done ? 'closeCook()' : 'cookStep(1)'}">${done ? 'Back to recipe' : i + 1 < n ? 'Next step' : 'Finish'}</button></div>
    ${sheet}`;
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

// The words a command can be said with. The recognizer only hears these (CookVoice's COMMAND_WORDS) and "go"/"step".
const COOK_COMMANDS = [
  ['next', ['next', 'forward', 'continue']],
  ['back', ['back', 'previous']],
  ['repeat', ['repeat', 'again', 'read']],
  ['ingredients', ['ingredients', 'ingredient']],
  ['close', ['close', 'hide']],
  ['stop', ['stop', 'quiet']],
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

function voiceStatus() {
  if (voiceProblem) return `<p class="cook-voice-status problem" role="alert">${escapeHtml(voiceProblem)}</p>`;
  if (cookVoice === 'off') return '';
  let text = cookVoice === 'starting' ? 'Getting voice control ready…'
    : heardCommand ? ` Heard “${heardCommand}”`
    : 'Listening. Say “next”, “back”, “repeat”, “ingredients” or “recipe”.';
  return `<p class="cook-voice-status${heardCommand ? ' heard' : ''}" role="status">${escapeHtml(text.trim())}</p>`;
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
  renderCook();
}

function stopCookVoice(render) {
  if (cookVoice !== 'off' && window.MealkeeperAndroid && window.MealkeeperAndroid.cookVoiceStop) window.MealkeeperAndroid.cookVoiceStop();
  cookVoice = 'off';
  heardCommand = '';
  if (render && cook) renderCook();
}

// CookVoice reports back here; see its header comment.
window.onCookVoice = function(event, text) {
  if (!cook) return;
  if (event === 'listening') {
    cookVoice = 'on';
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
    renderCook();
  } else if (event === 'stopped') {
    cookVoice = 'off';
    heardCommand = '';
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
  } else if (command === 'back') {
    if (cook.step > 0) return cookStep(-1);
  } else if (command === 'repeat') {
    speakStep(true);
  } else if (command === 'ingredients') {
    cook.sheet = true;
    if (readSteps) speak(spokenIngredients(c.m, c.r));
  } else if (command === 'close') {
    cook.sheet = false;
    quiet();
  } else if (command === 'stop') {
    quiet();
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
const SPOKEN_UNITS = {tbsp: 'tablespoon', tbs: 'tablespoon', tsp: 'teaspoon', oz: 'ounce', lb: 'pound', lbs: 'pound', g: 'gram', kg: 'kilogram', ml: 'milliliter', l: 'liter'};

// An amount as it should sound: "1 ½ tbsp" -> "1 and a half tablespoons", "½ tsp" -> "half a teaspoon".
function spokenAmount(q, unit, factor) {
  let shown = scaledQty(q, '', factor),
    m = /^(\d+(?:\.\d+)?)?\s*([½¼¾⅓⅔⅛⅜⅝⅞])?$/.exec(shown.trim());
  let u = str(unit).trim(),
    word = SPOKEN_UNITS[u.toLowerCase()];
  if (!m || (!m[1] && !m[2])) return [shown, u].filter(Boolean).join(' ');
  let whole = m[1] || '',
    frac = m[2] ? SPOKEN_FRACTIONS[m[2]] : '';
  if (!u) return whole && frac ? `${whole} and ${frac}` : whole || frac;
  if (!word) return [whole && frac ? `${whole} and ${frac}` : whole || frac, u].join(' ');
  if (!whole) return frac === 'a half' ? ` half a ${word}`.trim() : `${frac} of a ${word}`;
  if (frac) return `${whole} and ${frac} ${word}s`;
  return whole === '1' ? ` 1 ${word}`.trim() : `${whole} ${word}s`;
}

function spokenStep(m, r, i) {
  let text = r.instructions[i] || '',
    factor = servingsFactor(m, r),
    out = '',
    pos = 0;
  for (let h of mentions(text, r.ingredients)) {
    let amount = spokenAmount(h.ing.quantity, h.ing.unit, factor);
    out += text.slice(pos, h.start) + (amount ? amount + ' ' : '') + text.slice(h.start, h.end);
    pos = h.end;
  }
  return ` Step ${i + 1}. ${out + text.slice(pos)}`.trim().replace(/°F/g, ' degrees').replace(/°C/g, ' degrees Celsius');
}

function spokenIngredients(m, r) {
  let factor = servingsFactor(m, r);
  return r.ingredients.map(x => [spokenAmount(x.quantity, x.unit, factor), x.name].filter(Boolean).join(' ')).join('. ');
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
