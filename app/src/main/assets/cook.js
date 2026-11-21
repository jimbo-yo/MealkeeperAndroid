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

function kitchenNumber(v) {
  if (v <= 0) return '0';
  if (v >= 10) return String(Math.round(v));
  let whole = Math.floor(v),
    frac = v - whole;
  // Never round a small positive amount down to 0 ("0 tsp").
  if (frac < 0.04 && whole > 0) return String(whole);
  if (frac > 0.96) return String(whole + 1);
  let near = KITCHEN_FRACTIONS.reduce((a, f) => Math.abs(f[0] - frac) < Math.abs(a[0] - frac) ? f : a);
  if (Math.abs(near[0] - frac) > 0.04) return String(Math.max(0.01, Math.round(v * 100) / 100));
  return (whole ? whole + ' ' : '') + near[1];
}

// A quantity scaled for the chosen servings, written the way a cook measures it: 1.5 -> "1 ½", 0.33 -> "⅓".
// Text quantities ("a pinch") and unscaled amounts are left exactly as the recipe gives them.
function scaledQty(q, unit, factor) {
  if (typeof q !== 'number' || factor === 1) return fmtQty(q, unit);
  let v = q * factor;
  if (v <= 0) return fmtQty(0, unit);
  let numStr = kitchenNumber(v),
    shownVal = parseStepNum(numStr);
  return [numStr, matchUnitNumber(unit, shownVal != null ? shownVal : v)].filter(Boolean).join(' ');
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

// ---- Scaling numbers inside step text ----

// Discrete portion/yield nouns in step prose ("shape 6 patties", "divide into 8 equal buns") that scale with servings.
const PORTION_PAIRS = [
  ['patty', 'patties'], ['burger', 'burgers'], ['bun', 'buns'], ['roll', 'rolls'], ['ball', 'balls'],
  ['piece', 'pieces'], ['portion', 'portions'], ['serving', 'servings'], ['biscuit', 'biscuits'],
  ['muffin', 'muffins'], ['scone', 'scones'], ['bagel', 'bagels'], ['loaf', 'loaves'], ['cookie', 'cookies'],
  ['brownie', 'brownies'], ['bar', 'bars'], ['pancake', 'pancakes'], ['waffle', 'waffles'], ['crepe', 'crepes'],
  ['tortilla', 'tortillas'], ['taco', 'tacos'], ['enchilada', 'enchiladas'], ['burrito', 'burritos'],
  ['quesadilla', 'quesadillas'], ['slider', 'sliders'], ['sandwich', 'sandwiches'], ['wrap', 'wraps'],
  ['skewer', 'skewers'], ['kebab', 'kebabs'], ['meatball', 'meatballs'], ['dumpling', 'dumplings'],
  ['empanada', 'empanadas'], ['croquette', 'croquettes'], ['fritter', 'fritters'], ['cake', 'cakes'],
  ['cupcake', 'cupcakes'], ['tart', 'tarts'], ['pie', 'pies'], ['pizza', 'pizzas'], ['flatbread', 'flatbreads'],
  ['fillet', 'fillets'], ['filet', 'filets'], ['steak', 'steaks'], ['chop', 'chops'], ['cutlet', 'cutlets'],
  ['breast', 'breasts'], ['thigh', 'thighs'], ['drumstick', 'drumsticks'], ['wing', 'wings'], ['rib', 'ribs'],
  ['sausage', 'sausages'], ['link', 'links'], ['bowl', 'bowls'], ['plate', 'plates'], ['ramekin', 'ramekins'],
  ['jar', 'jars'], ['glass', 'glasses'], ['mug', 'mugs'], ['wedge', 'wedges'], ['disk', 'disks'],
  ['disc', 'discs'], ['log', 'logs'], ['mound', 'mounds'], ['scoop', 'scoops'], ['round', 'rounds'],
  ['square', 'squares'], ['rectangle', 'rectangles'], ['triangle', 'triangles'], ['strip', 'strips'], ['egg', 'eggs']
];
const PORTION_FORMS = Object.fromEntries(PORTION_PAIRS.flatMap(([sg, pl]) => [[sg, [sg, pl]], [pl, [sg, pl]]]));
const NON_MODIFIER_WORDS = new Set(('inch inches in cm mm foot feet ft min mins minute minutes hr hrs hour hours ' +
  'sec secs second seconds degree degrees percent batch batches step steps stage stages layer layers side sides ' +
  'rack racks to or of on at for with and the a an each every per from into onto over under by as').split(' '));
const COOKWARE_RE = /^\s+(?:pot|pots|pan|pans|skillet|skillets|saucepan|saucepans|dutch\s+oven|baking\s+dish|casserole|pitcher|container|measure|measuring)\b/i;
const FRAC_VALUES = {'⅛': 1 / 8, '¼': 1 / 4, '⅓': 1 / 3, '⅜': 3 / 8, '½': 1 / 2, '⅝': 5 / 8, '⅔': 2 / 3, '¾': 3 / 4, '⅞': 7 / 8};

const STEP_NUM_ATOM = '(?:\\d+\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s+[⅛¼⅓⅜½⅝⅔¾⅞]|\\d+\\s*\\/\\s*\\d+|[⅛¼⅓⅜½⅝⅔¾⅞]|\\d+(?:\\.\\d+)?)';
const SCALE_UNIT_RE = '(?:tbsp|tbs|tsp|oz|fl\\.?\\s*oz|lb|lbs|g|kg|ml|l|c\\.|pt|qt|gal|pkg|tablespoons?|teaspoons?|ounces?|pounds?|grams?|kilograms?|milliliters?|liters?|cups?|pints?|quarts?|gallons?|cloves?|cans?|bunches?|sprigs?|stalks?|slices?|heads?|sticks?|pinch(?:es)?|dash(?:es)?|packages?|sheets?|leaves?)\\.?';
const STEP_SCALABLE_NUM_RE = new RegExp(`(${STEP_NUM_ATOM})(?:\\s*([–—-])\\s*(${STEP_NUM_ATOM}))?`, 'g');
const UNIT_FOLLOW_RE = new RegExp(`^([ \\t]+)(${SCALE_UNIT_RE})(?![A-Za-z0-9-])`, 'i');
const WORDS_FOLLOW_RE = /^([ \t]+)([A-Za-z]+)(?:([ \t]+)([A-Za-z]+))?(?:([ \t]+)([A-Za-z]+))?/;

function parseStepNum(s) {
  s = s.trim();
  let m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) return +m[1] + (+m[2] / +m[3]);
  m = /^(\d+)\s+([⅛¼⅓⅜½⅝⅔¾⅞])$/.exec(s);
  if (m) return +m[1] + FRAC_VALUES[m[2]];
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) return +m[1] / +m[2];
  if (FRAC_VALUES[s]) return FRAC_VALUES[s];
  let n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function preserveCase(orig, word) {
  if (!orig || !word) return word;
  if (orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return word.toUpperCase();
  if (orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

// Scales inline measured quantities ("2 tbsp olive oil"), yield/portion counts ("shape 6 patties", "divide into 6
// equal buns"), and countable whole ingredients ("add 2 bell peppers") inside step prose when servings change.
// Leaves temperatures, durations, pan/dimension sizes, and per-item counts ("cut each into 4 wedges") untouched.
function scaleStepText(text, r, factor) {
  if (!text || factor === 1 || !(factor > 0)) return text || '';
  let allIngs = (r && r.ingredients) || [];
  let countedTerms = allIngs.filter(x => !str(x.unit).trim())
    .flatMap(x => ingredientTerms(x, allIngs))
    .sort((a, b) => b.length - a.length);
  let countedRe = countedTerms.length
    ? new RegExp('^([ \\t]+(?:[A-Za-z]+[ \\t]+)?)(' + countedTerms.map(escapeRegex).join('|') + ')\\b', 'i')
    : null;

  let out = '',
    pos = 0,
    re = new RegExp(STEP_SCALABLE_NUM_RE.source, 'g'),
    m;
  while ((m = re.exec(text))) {
    let start = m.index,
      end = start + m[0].length,
      prev = start > 0 ? text[start - 1] : '',
      next = text[end] || '';
    if (/[A-Za-z0-9.\-x×#°/]/.test(prev) || /[-°%x×"\/]/.test(next)) continue;

    let clauseBefore = text.slice(0, start).split(/[.,;:\n]/).pop();
    if (/\b(?:each|every|per|step|no\.?)\b/i.test(clauseBefore)) continue;

    let after = text.slice(end);
    if (/^(?:[ \t]+[A-Za-z]+){0,4}[ \t]+(?:per|each)\b/i.test(after)) continue;

    let v1 = parseStepNum(m[1]),
      dash = m[2] || '',
      v2 = m[3] ? parseStepNum(m[3]) : null;
    if (!(v1 > 0)) continue;

    // 1. Inline measured quantity ("2 tbsp", "1/2 cup", "2–3 tsp")
    let um = UNIT_FOLLOW_RE.exec(after);
    if (um && !COOKWARE_RE.test(after.slice(um[0].length))) {
      let unit = um[2],
        rep = v2 != null
          ? `${scaledQty(v1, '', factor)}${dash}${scaledQty(v2, unit, factor)}`
          : scaledQty(v1, unit, factor);
      out += text.slice(pos, start) + rep;
      pos = end + um[0].length;
      re.lastIndex = pos;
      continue;
    }

    // 2. Portion/yield count with 0–2 modifier words ("6 patties", "6 burger buns", "6 equal pieces")
    let wm = WORDS_FOLLOW_RE.exec(after);
    if (wm) {
      let words = [wm[2], wm[4], wm[6]].filter(Boolean),
        seps = [wm[1], wm[3], wm[5]],
        matchedIdx = -1;
      for (let k = 0; k < words.length; k++) {
        let lw = words[k].toLowerCase();
        if (PORTION_FORMS[lw]) {
          matchedIdx = k;
          continue;
        }
        if (matchedIdx >= 0 || NON_MODIFIER_WORDS.has(lw)) break;
      }
      if (matchedIdx >= 0) {
        let s1 = Math.max(1, Math.round(v1 * factor)),
          s2 = v2 != null ? Math.max(1, Math.round(v2 * factor)) : null,
          pair = PORTION_FORMS[words[matchedIdx].toLowerCase()],
          target = s2 != null ? s2 : s1,
          noun = preserveCase(words[matchedIdx], target > 1 ? pair[1] : pair[0]),
          prefix = '';
        for (let k = 0; k < matchedIdx; k++) prefix += seps[k] + words[k];
        prefix += seps[matchedIdx];
        let consumedLen = prefix.length + words[matchedIdx].length;
        out += text.slice(pos, start) + (s2 != null ? `${s1}${dash}${s2}` : String(s1)) + prefix + noun;
        pos = end + consumedLen;
        re.lastIndex = pos;
        continue;
      }
    }

    // 3. Countable whole recipe ingredient ("2 bell peppers", "1 ripe avocado")
    let cm = countedRe && countedRe.exec(after);
    if (cm) {
      let mod = cm[1].trim().toLowerCase();
      if (!mod || !NON_MODIFIER_WORDS.has(mod)) {
        let rep = v2 != null
          ? `${scaledQty(v1, '', factor)}${dash}${scaledQty(v2, '', factor)}`
          : scaledQty(v1, '', factor);
        out += text.slice(pos, start) + rep + cm[0];
        pos = end + cm[0].length;
        re.lastIndex = pos;
      }
    }
  }
  return out + text.slice(pos);
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

// A step as HTML, with inline amounts/yields scaled, each ingredient it mentions highlighted, and its (scaled) amount
// written in front of it (unless the step already writes an amount right before the ingredient).
function markedStep(r, i, factor) {
  let text = scaleStepText(r.instructions[i] || '', r, factor),
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
  let c = cookingState(),
    title = !c ? '' : c.mode === 'timeline' ? ((c.m.timeline[cook.step] && c.m.timeline[cook.step].task) || c.m.name) : c.r.title,
    msg = title ? `${title} (${label})` : label;
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

function stepTimersHtmlFromList(timers) {
  if (!timers.length) return '';
  let hasClock = !!(window.MealkeeperAndroid && window.MealkeeperAndroid.setTimer);
  return `<div class="cook-step-timers">${timers.map(t =>
    `<div class="cook-timer-offer"><button type="button" class="secondary cook-timer-start${flashed('timer')}" onclick="startCookTimer(${t.seconds},'${escapeHtml(t.label)}')">⏱ Start ${escapeHtml(t.label)} timer</button>${hasClock ? `<button type="button" class="outline cook-timer-clock" onclick="openSystemTimer(${t.seconds},'${escapeHtml(t.label)}')" aria-label="Open ${escapeHtml(t.label)} timer in Clock app">Clock ↗</button>` : ''}</div>`
  ).join('')}</div>`;
}

function stepTimersHtml(r, i) {
  return stepTimersHtmlFromList(stepTimers(r.instructions[i] || ''));
}

// Timers for a meal timeline step: the step's scheduled duration plus any distinct durations mentioned in details.
function timelineStepTimers(t) {
  let out = [],
    seen = new Set();
  if (t && t.duration > 0) {
    let sec = Math.round(t.duration * 60);
    seen.add(sec);
    out.push({seconds: sec, label: fmtMinutes(t.duration)});
  }
  for (let extra of stepTimers((t && t.details) || '')) {
    if (!seen.has(extra.seconds)) {
      seen.add(extra.seconds);
      out.push(extra);
    }
  }
  return out;
}

// ---- Meal timeline helpers for Cook mode ----

function timelineClock(m) {
  let span = timelineSpan(m.timeline),
    serve = clockMinutes(m.serveAt),
    start = serve - span;
  return {span, serve, start};
}

function timelineLinkedRecipe(m, t) {
  return (t && t.recipeId && m.recipes.find(x => x.id === t.recipeId)) || null;
}

// Ingredients relevant to a timeline step: the linked recipe's ingredients (scaled), or merged across the meal for
// meal-wide steps (e.g. "Prep everything").
function timelineStepContext(m, t) {
  let r = timelineLinkedRecipe(m, t);
  if (r) {
    let factor = servingsFactor(m, r);
    return {
      recipe: r,
      factor,
      ingredients: r.ingredients.map((ing, idx) => ({ing, factor, key: `${r.id}:${idx}`, recipeTitle: r.title}))
    };
  }
  let byName = new Map(),
    list = [];
  m.recipes.forEach(rec => {
    let factor = servingsFactor(m, rec);
    rec.ingredients.forEach((ing, idx) => {
      let key = `${rec.id}:${idx}`,
        norm = ing.name.toLowerCase().trim(),
        entry = {ing, factor, key, recipeTitle: rec.title};
      list.push(entry);
      if (!byName.has(norm)) byName.set(norm, []);
      byName.get(norm).push(entry);
    });
  });
  // For inline highlighting on meal-wide steps, combine same-named ingredients only when units match; otherwise
  // highlight without an ambiguous single-recipe quantity.
  let matchable = [];
  for (let [, group] of byName) {
    if (group.length === 1) {
      let {ing, factor} = group[0];
      matchable.push({...ing, _factor: factor});
    } else {
      let units = new Set(group.map(g => str(g.ing.unit).trim().toLowerCase()));
      let allNum = group.every(g => typeof g.ing.quantity === 'number');
      if (allNum && units.size === 1) {
        let total = group.reduce((sum, g) => sum + g.ing.quantity * g.factor, 0);
        matchable.push({name: group[0].ing.name, quantity: total, unit: group[0].ing.unit, notes: '', _factor: 1});
      } else {
        matchable.push({name: group[0].ing.name, quantity: null, unit: '', notes: '', _factor: 1});
      }
    }
  }
  return {recipe: null, factor: 1, ingredients: list, matchable};
}

function markedTimelineStep(m, t) {
  let ctx = timelineStepContext(m, t),
    raw = (t && t.details) || '',
    text = ctx.recipe ? scaleStepText(raw, ctx.recipe, ctx.factor) : raw,
    ings = ctx.recipe ? ctx.recipe.ingredients : ctx.matchable,
    out = '',
    pos = 0;
  for (let h of mentions(text, ings)) {
    let f = ctx.recipe ? ctx.factor : (h.ing._factor || 1),
      amount = hasLeadingQty(text.slice(0, h.start)) ? '' : scaledQty(h.ing.quantity, h.ing.unit, f);
    out += escapeHtml(text.slice(pos, h.start)) + `<mark>${amount ? `<b>${escapeHtml(amount)}</b> ` : ''}${escapeHtml(text.slice(h.start, h.end))}</mark>`;
    pos = h.end;
  }
  return out + escapeHtml(text.slice(pos));
}

function timelineMatchedEntries(m, t) {
  let ctx = timelineStepContext(m, t),
    raw = ((t && t.task) || '') + ' ' + ((t && t.details) || ''),
    ings = ctx.recipe ? ctx.recipe.ingredients : ctx.matchable,
    hitNames = new Set(mentions(raw, ings).map(h => h.ing.name.toLowerCase().trim()));
  return ctx.ingredients.filter(e => hitNames.has(e.ing.name.toLowerCase().trim()));
}

function setCookServeAt(v) {
  let c = cookingState();
  if (!c || c.mode !== 'timeline' || !/^\d{1,2}:\d{2}$/.test(v)) return;
  c.m.serveAt = v;
  render();
  renderCook();
}

// ---- Cook mode ----

// null, or {mode: 'recipe'|'timeline', meal, recipe, keeper, step, added: {key: true}, sheet: false|'ingredients'|'overview'|'dish', timers: [...]}.
let cook = null,
  cookSwipeBound = false;

function cookingState() {
  if (!cook) return null;
  if (cook.mode === 'timeline') {
    let m = meals.find(x => x.id === cook.meal);
    return m && m.timeline.length ? {mode: 'timeline', m} : null;
  }
  if (cook.keeper != null) {
    let k = keeperById(cook.keeper);
    return k ? {mode: 'recipe', m: keeperMeal(k), r: k.recipe} : null;
  }
  let m = meals.find(x => x.id === cook.meal),
    r = m && m.recipes[cook.recipe];
  return r ? {mode: 'recipe', m, r} : null;
}

function cookingRecipe() {
  let c = cookingState();
  return c && c.mode === 'recipe' ? c : null;
}

function cookStepCount(c) {
  return c.mode === 'timeline' ? c.m.timeline.length : c.r.instructions.length;
}

function startCookSession(session) {
  clearTimeout(window._cookFlash);
  clearTimerTick();
  cook = {mode: 'recipe', step: 0, ...session, added: {}, sheet: false, timers: []};
  voiceProblem = '';
  flash = '';
  heardCommand = '';
  renderCook();
  syncAwake();
}

function openCook(i) {
  let m = currentMeal();
  if (!m || !m.recipes[i]) return;
  startCookSession({mode: 'recipe', meal: m.id, recipe: i, keeper: null});
}

function openCookKeeper(id) {
  let k = keeperById(id);
  if (!k) return;
  startCookSession({mode: 'recipe', meal: null, recipe: null, keeper: k.id});
}

function openCookTimeline(startStep = 0) {
  let m = currentMeal();
  if (!m || !m.timeline.length) return;
  let step = Math.min(m.timeline.length - 1, Math.max(0, startStep));
  startCookSession({mode: 'timeline', meal: m.id, recipe: null, keeper: null, step});
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
  let c = cookingState();
  if (!c) return;
  cook.step = Math.min(cookStepCount(c), Math.max(0, step));
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
  cook.sheet = open === true ? 'ingredients' : open || false;
  renderCook();
}

function toggleAdded(k) {
  if (!cook) return;
  if (cook.added[k]) delete cook.added[k];
  else cook.added[k] = true;
  renderCook();
}

function cookIngredientRow(r, ing, factor, large, key) {
  let k = key != null ? key : r.ingredients.indexOf(ing),
    got = !!cook.added[k],
    arg = typeof k === 'string' ? `'${escapeHtml(k)}'` : k;
  return `<button class="cook-ing${large ? ' large' : ''}${got ? ' got' : ''}" onclick="toggleAdded(${arg})" aria-pressed="${got}"><span class="amt">${escapeHtml(scaledQty(ing.quantity, ing.unit, factor))}</span><span>${escapeHtml(ing.name)}${ing.notes ? ` <span class="muted">(${escapeHtml(ing.notes)})</span>` : ''}</span></button>`;
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
    let c = cookingState();
    if (!c) return;
    if (dx < 0 && cook.step < cookStepCount(c)) cookStep(1);
    else if (dx > 0 && cook.step > 0) cookStep(-1);
  }, {passive: true});
}

function renderCookTimeline(el, m, bodyTop, sheetTop) {
  let {span, serve, start} = timelineClock(m),
    n = m.timeline.length,
    i = cook.step,
    done = i >= n,
    t = done ? null : m.timeline[i],
    linked = t ? timelineLinkedRecipe(m, t) : null,
    linkedIdx = linked ? m.recipes.indexOf(linked) : -1,
    hasAnyIngredients = m.recipes.some(r => r.ingredients.length);

  let body = done
    ? `<div class="cook-finish"><h2>All steps done</h2><p class="subhead">Time to serve! Target serve time: ${escapeHtml(fmtClock(serve))}.</p></div>`
    : `<div class="cook-step-head"><span>Step ${i + 1} of ${n} · ${escapeHtml(fmtClock(start + t.offset))}</span>${t.duration ? `<span class="cook-serves">${escapeHtml(fmtMinutes(t.duration))}</span>` : ''}</div>
       ${linked ? `<div class="cook-dish-tag">${escapeHtml(linked.icon)} ${escapeHtml(linked.title)}</div>` : ''}
       <h2 class="cook-task${flashed('repeat')}">${escapeHtml(t.task)}</h2>
       ${t.details ? `<p class="cook-step${flashed('repeat')}">${markedTimelineStep(m, t)}</p>` : ''}
       ${stepTimersHtmlFromList(timelineStepTimers(t))}
       <div class="divider"></div>
       <p class="cook-next">${i + 1 < n ? `<strong>Next (${escapeHtml(fmtClock(start + m.timeline[i + 1].offset))}):</strong> ${escapeHtml(m.timeline[i + 1].task)}` : `<strong>Last step — serve at ${escapeHtml(fmtClock(serve))}.</strong>`}</p>
       <div class="cook-actions-row">${hasAnyIngredients ? `<button class="text-btn cook-show${flashed('ingredients', 'close')}" onclick="cookSheet('ingredients')">Show ingredients</button>` : ''}${linked && linked.instructions.length ? `<button class="text-btn cook-show" onclick="cookSheet('dish')">View dish steps</button>` : ''}</div>`;

  let sheet = '';
  if (cook.sheet === 'ingredients') {
    let uses = done ? [] : timelineMatchedEntries(m, t);
    let restHtml = linked
      ? `<h3>${escapeHtml(linked.icon)} ${escapeHtml(linked.title)}</h3>${linked.ingredients.map((x, idx) => cookIngredientRow(linked, x, servingsFactor(m, linked), false, `${linked.id}:${idx}`)).join('')}`
      : m.recipes.filter(r => r.ingredients.length).map(r => `<h3>${escapeHtml(r.icon)} ${escapeHtml(r.title)}</h3>${r.ingredients.map((x, idx) => cookIngredientRow(r, x, servingsFactor(m, r), false, `${r.id}:${idx}`)).join('')}`).join('');
    sheet = `<div class="cook-sheet-bg" onclick="if(event.target===this)cookSheet(false)"><div class="cook-sheet" role="dialog" aria-label="Ingredients">
      ${uses.length ? `<h3>For step ${i + 1}</h3>${uses.map(e => cookIngredientRow(null, e.ing, e.factor, true, e.key)).join('')}` : ''}
      ${restHtml}
      <p class="muted small">Tap an ingredient once it's in.</p>
      <button class="secondary" onclick="cookSheet(false)">Close</button></div></div>`;
  } else if (cook.sheet === 'overview') {
    let hasAlarm = !!(window.MealkeeperAndroid && window.MealkeeperAndroid.setAlarm);
    sheet = `<div class="cook-sheet-bg" onclick="if(event.target===this)cookSheet(false)"><div class="cook-sheet" role="dialog" aria-label="Meal overview">
      <h3>Meal timeline overview</h3>
      <p class="muted small" style="margin:0 0 10px">Start at <strong>${escapeHtml(fmtClock(start))}</strong> · serve at <strong>${escapeHtml(fmtClock(serve))}</strong> · ${escapeHtml(fmtMinutes(span))} total</p>
      <div class="cook-overview-serve"><label class="field-label" style="margin:0" for="cook-serve-at">Target serving time</label><input id="cook-serve-at" class="field" type="time" value="${escapeHtml(m.serveAt)}" onchange="setCookServeAt(this.value)"></div>
      ${hasAlarm ? `<button class="secondary" style="margin:0 0 12px" onclick="setStartAlarm()">⏰ Set alarm for ${escapeHtml(fmtClock(start))}</button>` : ''}
      <div class="cook-overview-list">${m.timeline.map((step, k) => {
        let dish = timelineLinkedRecipe(m, step);
        return `<button type="button" class="cook-overview-row${k === i ? ' now' : k < i ? ' done' : ''}" onclick="cookGoTo(${k})"><span class="cook-ov-time">${escapeHtml(fmtClock(start + step.offset))}</span><span class="cook-ov-main"><strong>${escapeHtml(step.task)}</strong>${dish || step.duration ? `<span class="muted small">${escapeHtml([dish && dish.title, step.duration && fmtMinutes(step.duration)].filter(Boolean).join(' · '))}</span>` : ''}</span></button>`;
      }).join('')}<div class="cook-overview-row serve-row"><span class="cook-ov-time">${escapeHtml(fmtClock(serve))}</span><span class="cook-ov-main"><strong>Serve</strong><span class="muted small">Everything ready</span></span></div></div>
      <button class="secondary" onclick="cookSheet(false)">Close</button></div></div>`;
  } else if (cook.sheet === 'dish' && linked) {
    let factor = servingsFactor(m, linked);
    sheet = `<div class="cook-sheet-bg" onclick="if(event.target===this)cookSheet(false)"><div class="cook-sheet" role="dialog" aria-label="${escapeHtml(linked.title)}">
      <h3>${escapeHtml(linked.icon)} ${escapeHtml(linked.title)}</h3>
      <ol class="cook-dish-steps">${linked.instructions.map(s => `<li>${escapeHtml(scaleStepText(s, linked, factor))}</li>`).join('')}</ol>
      ${linkedIdx >= 0 ? `<button class="primary" style="width:100%;justify-content:center;margin-top:10px" onclick="openCook(${linkedIdx})">Cook just this dish</button>` : ''}
      <button class="secondary" onclick="cookSheet(false)">Close</button></div></div>`;
  }

  let hasTimers = !!(cook.timers.length || (t && timelineStepTimers(t).length));
  el.innerHTML = `<div class="cook-top"><button class="outline" onclick="closeCook()">Exit</button><strong class="cook-title">${escapeHtml(m.name)}</strong>${voiceButton()}</div>
    <div class="cook-progress" aria-label="Meal timeline steps">${m.timeline.map((_, k) => `<button type="button" class="cook-seg" onclick="cookGoTo(${k})" aria-label="Step ${k + 1} of ${n}"${k === i ? ' aria-current="step"' : ''}><i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i></button>`).join('')}</div>
    <div class="cook-tl-bar"><span>Start <strong>${escapeHtml(fmtClock(start))}</strong> · Serve <strong>${escapeHtml(fmtClock(serve))}</strong></span><button type="button" class="outline cook-tl-ov-btn${flashed('overview')}" onclick="cookSheet('overview')">Overview</button></div>
    ${timerBarHtml()}
    ${voiceStatus(hasTimers, true)}
    <div class="cook-body" id="cook-body">${body}</div>
    <div class="cook-foot"><button class="outline${i > 0 ? flashed('back') : ''}" onclick="cookStep(-1)" ${i === 0 ? 'disabled' : ''}>Back</button><button class="primary${flashed('next')}" onclick="${done ? 'closeCook()' : 'cookStep(1)'}">${done ? 'Back to timeline' : i + 1 < n ? 'Next step' : 'Finish'}</button></div>
    ${sheet}`;
  let nextBody = document.getElementById('cook-body'),
    nextSheet = el.querySelector('.cook-sheet');
  if (nextBody) nextBody.scrollTop = bodyTop;
  if (nextSheet) nextSheet.scrollTop = sheetTop;
}

function renderCook(resetBodyScroll = false) {
  let el = document.getElementById('cook'),
    c = cookingState();
  if (!c) return closeCook();
  bindCookSwipe(el);
  let prevBody = document.getElementById('cook-body'),
    prevSheet = el.querySelector('.cook-sheet'),
    bodyTop = resetBodyScroll ? 0 : (prevBody ? prevBody.scrollTop : 0),
    sheetTop = prevSheet ? prevSheet.scrollTop : 0;
  document.documentElement.classList.add('cooking');
  el.hidden = false;
  if (c.mode === 'timeline') return renderCookTimeline(el, c.m, bodyTop, sheetTop);

  let {m, r} = c,
    n = r.instructions.length,
    i = cook.step,
    factor = servingsFactor(m, r),
    s = servingsOf(m, r),
    done = i >= n;
  let body = done
    ? `<div class="cook-finish"><h2>All steps done</h2><p class="subhead">Enjoy it.</p></div>`
    : `<div class="cook-step-head"><span>Step ${i + 1} of ${n}</span>${s ? `<span class="cook-serves">Serves ${s}</span>` : ''}</div>
       <p class="cook-step${flashed('repeat')}">${markedStep(r, i, factor)}</p>
       ${stepTimersHtml(r, i)}
       <div class="divider"></div>
       <p class="cook-next">${i + 1 < n ? `<strong>Next:</strong> ${escapeHtml(scaleStepText(r.instructions[i + 1], r, factor))}` : '<strong>Last step.</strong>'}</p>
       ${r.ingredients.length ? `<button class="text-btn cook-show${flashed('ingredients', 'close')}" onclick="cookSheet('ingredients')">Show ingredients</button>` : ''}`;
  let uses = done ? [] : stepIngredients(r, i);
  let sheet = !cook.sheet ? '' : `<div class="cook-sheet-bg" onclick="if(event.target===this)cookSheet(false)"><div class="cook-sheet" role="dialog" aria-label="Ingredients">
       ${uses.length ? `<h3>For step ${i + 1}</h3>${uses.map(x => cookIngredientRow(r, x, factor, true)).join('')}` : ''}
       <h3>${uses.length ? 'Everything in this recipe' : 'Ingredients'}</h3>${r.ingredients.map(x => cookIngredientRow(r, x, factor, false)).join('')}
       <p class="muted small">Tap an ingredient once it's in.</p>
       <button class="secondary" onclick="cookSheet(false)">Close</button></div></div>`;
  let hasTimers = !!(cook.timers.length || (i < n && stepTimers(r.instructions[i]).length));
  el.innerHTML = `<div class="cook-top"><button class="outline" onclick="closeCook()">Exit</button><strong class="cook-title">${escapeHtml(r.title)}</strong>${voiceButton()}</div>
    <div class="cook-progress" aria-label="Recipe steps">${r.instructions.map((_, k) => `<button type="button" class="cook-seg" onclick="cookGoTo(${k})" aria-label="Step ${k + 1} of ${n}"${k === i ? ' aria-current="step"' : ''}><i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i></button>`).join('')}</div>
    ${timerBarHtml()}
    ${voiceStatus(hasTimers, false)}
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
  ['overview', ['overview', 'timeline', 'schedule']],
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

function voiceStatus(hasTimer, isTimeline) {
  if (voiceProblem) return `<p class="cook-voice-status problem" role="alert">${escapeHtml(voiceProblem)}</p>`;
  if (cookVoice === 'off') return '';
  let hints = ['“next”', '“back”', '“repeat”', '“ingredients”'];
  if (isTimeline) hints.push('“overview”');
  if (hasTimer) hints.push('“timer”');
  hints.push(isTimeline ? '“exit”' : '“recipe”');
  let text = cookVoice === 'starting' ? 'Getting voice control ready…'
    : heardCommand ? `Heard “${heardCommand}”`
    : `Listening. Say ${hints.slice(0, -1).join(', ')} or ${hints[hints.length - 1]}.`;
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
  let c = cookingState();
  if (!command || !c) return;
  let total = cookStepCount(c);
  // With a sheet open, "back" closes it rather than going to the previous step.
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
    if (cook.step < total) return cookStep(1);
    return closeCook();
  } else if (command === 'back') {
    if (cook.step > 0) return cookStep(-1);
  } else if (command === 'repeat') {
    speakStep(true);
  } else if (command === 'ingredients') {
    cook.sheet = 'ingredients';
    speak(c.mode === 'timeline' ? spokenTimelineIngredients(c.m, cook.step) : spokenIngredients(c.m, c.r, cook.step));
  } else if (command === 'overview') {
    if (c.mode === 'timeline') {
      cook.sheet = 'overview';
      let {start, serve} = timelineClock(c.m);
      speak(`Start at ${fmtClock(start)}, serve at ${fmtClock(serve)}.`);
    }
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
      let offers = cook.step < total
        ? (c.mode === 'timeline' ? timelineStepTimers(c.m.timeline[cook.step]) : stepTimers(c.r.instructions[cook.step]))
        : [];
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
  let c = cookingState();
  if (!c || cookVoice !== 'on' || !(readSteps || asked)) return;
  let n = cookStepCount(c);
  if (cook.step >= n) return speak(c.mode === 'timeline' ? 'All steps done. Time to serve.' : 'All steps done.');
  speak(c.mode === 'timeline' ? spokenTimelineStep(c.m, cook.step) : spokenStep(c.m, c.r, cook.step));
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
  let shown = typeof q === 'number' ? kitchenNumber(q * factor) : scaledQty(q, '', factor),
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
  let factor = servingsFactor(m, r),
    text = scaleStepText(r.instructions[i] || '', r, factor),
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
    .replace(new RegExp(`(${STEP_NUM_ATOM})[ \\t]+(${SCALE_UNIT_RE})(?![A-Za-z0-9-])`, 'gi'), (full, n, u) => {
      let v = parseStepNum(n);
      return v > 0 ? spokenAmount(v, u, 1) : full;
    })
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

function spokenTimelineStep(m, i) {
  let t = m.timeline[i];
  if (!t) return '';
  let {start} = timelineClock(m),
    ctx = timelineStepContext(m, t),
    raw = t.details || '',
    text = ctx.recipe ? scaleStepText(raw, ctx.recipe, ctx.factor) : raw,
    ings = ctx.recipe ? ctx.recipe.ingredients : ctx.matchable,
    out = '',
    pos = 0;
  for (let h of mentions(text, ings)) {
    let f = ctx.recipe ? ctx.factor : (h.ing._factor || 1),
      amount = hasLeadingQty(text.slice(0, h.start)) ? '' : spokenAmount(h.ing.quantity, h.ing.unit, f);
    out += text.slice(pos, h.start) + (amount ? amount + ' ' : '') + text.slice(h.start, h.end);
    pos = h.end;
  }
  let body = (out + text.slice(pos))
    .replace(/(\d+)\s*°\s*F\b/gi, '$1 degrees')
    .replace(/(\d+)\s*°\s*C\b/gi, '$1 degrees Celsius')
    .replace(/(\d+)\s*°(?!\s*[FC])/g, '$1 degrees')
    .replace(new RegExp(`(${STEP_NUM_ATOM})[ \\t]+(${SCALE_UNIT_RE})(?![A-Za-z0-9-])`, 'gi'), (full, n, u) => {
      let v = parseStepNum(n);
      return v > 0 ? spokenAmount(v, u, 1) : full;
    })
    .replace(/(\d+)\s*[–—-]\s*(\d+)/g, '$1 to $2');
  let head = `Step ${i + 1}, at ${fmtClock(start + t.offset)}. ${ctx.recipe ? ctx.recipe.title + ': ' : ''}${t.task}.`;
  return body ? `${head} ${body}` : head;
}

function spokenTimelineIngredients(m, i) {
  let t = i != null && i < m.timeline.length ? m.timeline[i] : null,
    uses = t ? timelineMatchedEntries(m, t) : [],
    ctx = t ? timelineStepContext(m, t) : null,
    list = uses.length ? uses : (ctx ? ctx.ingredients : []),
    prefix = uses.length ? `For step ${i + 1}: ` : 'Ingredients: ',
    items = list.map(e => [spokenAmount(e.ing.quantity, e.ing.unit, e.factor), e.ing.name].filter(Boolean).join(' ') + (e.ing.notes ? `, ${e.ing.notes}` : ''));
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
