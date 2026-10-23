// Browser tests for app.js. scripts/run-web-tests.sh loads the app with fake-android.js before it and this file after it.
// Every test starts from the demo data with empty storage (see reset()).

const results = [];
const bridge = window.MealkeeperAndroid;
const main = () => document.getElementById('main');
const modal = () => document.getElementById('modal');
const modalOpen = () => document.getElementById('modal-bg').style.display === 'flex';
const awakeCalls = () => bridge.calls.filter(c => c[0] === 'setKeepScreenOn').map(c => c[1]);
const lastAwakeCall = () => awakeCalls().pop();
const times = () => [...main().querySelectorAll('.time')].map(e => e.textContent);
const hasMarkup = el => el.querySelector('b, i, u, img, script');

// Stand-in for openUrl, which on Android would navigate the test page away.
let opened = [];
openUrl = url => opened.push(url);

function reset() {
  localStorage.clear();
  closeModal();
  meals.length = 0;
  DEMO_MEALS.map(cleanMeal).forEach(m => meals.push(m));
  navStack = [];
  page = 'home';
  selectedMeal = 1;
  mealTab = 'recipes';
  awake = false;
  cookAwake = true;
  recipeOpen = false;
  lastAwake = null;
  importText = '';
  pendingRestore = null;
  pendingImport = null;
  pendingAsk = null;
  aiTab = 'chatgpt';
  clipOffer = true;
  bridge.aiAppResult = 'shared';
  render();
  bridge.calls.length = 0;
}

function test(name, fn) {
  reset();
  try {
    fn();
    results.push({name, ok: true});
  } catch (e) {
    results.push({name, ok: false, error: e.message});
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  let a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ? message + ': ' : ''}expected ${b}, got ${a}`);
}

function importViaDialog(text) {
  openImport();
  document.getElementById('import-area').value = text;
  doImport();
}

const HOSTILE = {
  format: 'mealkeeper-v1',
  meals: [{
    name: '<b>Evil</b>',
    total_time: '<img src=x onerror="window.pwned=1">',
    servings: '<b>9</b>',
    recipes: [{
      id: 'x',
      title: '<b>t</b>',
      course: '<i>c</i>',
      ingredients: [{name: '<img src=y>', quantity: '<i>1</i>', unit: '<u>u</u>'}],
      instructions: ['<script>bad()</script>'],
      make_ahead_notes: '<b>m</b>'
    }],
    shopping_list: [{name: '<b>s</b>', category: '<i>g</i>', used_in: ['<u>x</u>']}],
    timeline: [{task: '<b>k</b>', instructions: '<img src=z>', recipe_id: 'x'}]
  }]
};

// ---- Import parsing ----

test('parses JSON wrapped in ``` fences and chatter', () => {
  eq(parseMealkeeperJson('Here you go:\n```json\n' + sampleExport + '\n```\nEnjoy!').meals.length, 1);
});

test('parses plain JSON', () => {
  eq(parseMealkeeperJson(sampleExport).meals.length, 1);
});

test('wraps a single meal object in a meals list', () => {
  eq(parseMealkeeperJson('{"name":"X","recipes":[{"title":"a"}]}').meals[0].name, 'X');
});

test('returns null for text without JSON', () => {
  eq(parseMealkeeperJson('no json here'), null);
});

test('import with no meals shows an error and keeps the dialog open', () => {
  importViaDialog('{"foo": 1}');
  assert(modalOpen(), 'dialog closed');
  eq(meals.length, 4);
  assert(document.getElementById('toast').textContent.includes('no meals'), 'wrong message');
});

test('imports the full mealkeeper-v1 sample', () => {
  importViaDialog(sampleExport);
  let m = meals[meals.length - 1];
  eq([page, selectedMeal], ['meal', m.id], 'a single imported meal opens');
  eq(m.time, '30 min');
  eq(m.recipes.map(r => [r.title, r.time, r.ingredients.length, r.instructions.length]),
    [['Lemon herb chicken', '25 min', 4, 3], ['Cucumber tomato salad', '10 min', 3, 2]]);
  eq(m.recipes[0].makeAhead, 'Marinate up to 1 day ahead.');
  eq(m.shopping.length, 6);
  eq(m.shopping[0].qty, '1 ½ lb');
  eq(m.shopping[5].usedIn, ['Lemon herb chicken', 'Cucumber tomato salad'], 'used_in ids become titles');
  eq(m.timeline.map(t => t.offset), [0, 10, 15, 25]);
});

test('builds the shopping list from ingredients when the export has none', () => {
  let data = JSON.parse(sampleExport);
  delete data.meals[0].shopping_list;
  importMeals(data);
  let list = meals[meals.length - 1].shopping, oil = list.find(x => x.name === 'Olive oil');
  eq(list.length, 6);
  eq(oil.qty, '3 tbsp', '2 tbsp + 1 tbsp');
  eq(oil.usedIn.length, 2);
});

test('imports the older minimal export (titles and time strings only)', () => {
  importMeals(parseMealkeeperJson('{"meals":[{"name":"Old","total_time":"35 min","recipes":[{"title":"A","total_time":"25 min"}]}]}'));
  let m = meals[meals.length - 1];
  eq([m.time, m.recipes[0].time, m.shopping.length], ['35 min', '25 min', 0]);
});

test('imported text is shown as text, never as HTML', () => {
  importMeals(HOSTILE);
  let id = meals[meals.length - 1].id;
  for (let p of ['meals', 'shopping', 'timeline']) {
    selectedMeal = id;
    go(p);
    assert(!hasMarkup(main()), p + ' page rendered markup');
  }
  openMeal(id);
  assert(!hasMarkup(main()), 'meal page rendered markup');
  assert(main().textContent.includes('<b>Evil</b>'), 'name not shown as text');
  showRecipe(0);
  assert(!hasMarkup(modal()), 'recipe rendered markup');
});

// ---- Formatting ----

test('formats quantities as kitchen fractions', () => {
  eq([fmtQty(1.5, 'lb'), fmtQty(0.5, 'cup'), fmtQty(2, ''), fmtQty(1.2, 'kg'), fmtQty('a pinch', ''), fmtQty(null, 'tsp')],
    ['1 ½ lb', '½ cup', '2', '1.2 kg', 'a pinch', 'tsp']);
});

test('formats minutes and clock times', () => {
  eq([fmtMinutes(55), fmtMinutes(70), fmtMinutes(120), fmtMinutes(0)], ['55 min', '1 hr 10 min', '2 hr', '']);
  eq([fmtClock(clockMinutes('18:30')), fmtClock(clockMinutes('00:05')), fmtClock(-30)], ['6:30 PM', '12:05 AM', '11:30 PM']);
});

// ---- Screens ----

test('timeline works back from the serving time', () => {
  go('timeline');
  let t = times();
  eq([t[0], t[t.length - 1], t.length], ['5:35 PM', '6:30 PM', 7]);
  assert(main().textContent.includes('Sausage & pepper rigatoni'), 'recipe name missing');
  setServeAt('19:00');
  eq(times()[0], '6:05 PM');
  eq(meals[0].serveAt, '19:00');
});

test('check marks belong to the selected meal', () => {
  go('shopping');
  toggleItem(0, true);
  assert(meals[0].shopping[0].checked, 'not checked');
  assert(main().textContent.includes('13 items left'), 'count not updated');
  selectedMeal = 2;
  render();
  assert(main().textContent.includes('No shopping list yet'), 'other meal should be empty');
  assert(main().querySelector('select'), 'meal picker missing');
  clearChecks();
  assert(meals[0].shopping[0].checked, 'clearing another meal changed this one');
});

test('meals without a timeline show an empty state', () => {
  selectedMeal = 3;
  go('timeline');
  assert(main().textContent.includes('No cooking timeline yet'));
});

test('recipe details show ingredients, steps and make-ahead notes', () => {
  openMeal(1);
  showRecipe(0);
  assert(!document.getElementById('modal-bg').classList.contains('centered'), 'other dialogs stay bottom sheets');
  eq(modal().querySelectorAll('ol li').length, 3);
  assert(modal().textContent.includes('Cherry tomatoes'), 'ingredient missing');
  assert(modal().textContent.includes('Make ahead'), 'make-ahead missing');
});

test('home follows the selected meal', () => {
  meals[0].shopping[0].checked = true;
  render();
  assert(main().textContent.includes('Start with: Prep everything'), 'timeline summary missing');
  assert(main().textContent.includes('1 of 14 items checked'), 'shopping summary wrong');
});

test('the meal page survives having no meals', () => {
  applyState({meals: []});
  page = 'meal';
  render();
  assert(main().textContent.includes('Meal collections'));
});

// ---- Back button ----

test('back walks the page history, then lets Android close the app', () => {
  go('meals');
  openMeal(1);
  eq([handleBack(), page], [true, 'meals']);
  eq([handleBack(), page], [true, 'home']);
  eq(handleBack(), false);
});

test('back closes a dialog before changing page', () => {
  go('settings');
  openImport();
  eq([handleBack(), page, modalOpen()], [true, 'settings', false]);
  eq([handleBack(), page], [true, 'home']);
});

test('back from a page with no history goes home', () => {
  page = 'timeline';
  render();
  eq([handleBack(), page], [true, 'home']);
});

// ---- Saving, backups and restore ----

test('every change is saved and loads back', () => {
  meals[0].shopping[3].checked = true;
  meals[0].serveAt = '17:45';
  selectedMeal = 1;
  awake = true;
  cookAwake = false;
  render();
  let saved = JSON.parse(localStorage.getItem(STORE_KEY));
  meals.length = 0;
  selectedMeal = 0;
  awake = false;
  cookAwake = true;
  applyState(saved);
  assert(meals[0].shopping[3].checked && !meals[0].shopping[2].checked, 'check marks');
  eq([meals[0].serveAt, selectedMeal, awake, cookAwake], ['17:45', 1, true, false]);
});

test('older saves (one global checklist, recipes as arrays) are upgraded', () => {
  applyState({
    meals: [
      {id: 1, name: 'Sunday Italian supper', recipes: [['🍅', 'Roasted tomato bruschetta', 'Starter · 15 min']]},
      {id: 99, name: 'Legacy import', recipes: [['🍴', 'Thing', 'Recipe · 20 min']], time: '20 min'}
    ],
    checked: [0, 3],
    awake: false
  });
  eq(meals[0].shopping.length, 14, 'demo meal gets full data back');
  eq(meals[0].shopping.filter(x => x.checked).map(x => x.name), ['Italian sausage links', 'Cherry tomatoes']);
  eq([meals[1].recipes[0].title, meals[1].recipes[0].time], ['Thing', '20 min']);
});

test('export sends the backup to Android', () => {
  exportBackup();
  let call = bridge.calls.find(c => c[0] === 'saveBackupFile');
  assert(call, 'bridge not called');
  assert(/^prompt-to-pan-backup-\d{4}-\d{2}-\d{2}\.json$/.test(call[1]), 'file name ' + call[1]);
  let data = JSON.parse(call[2]);
  eq([data.format, data.meals.length, data.settings], [BACKUP_FORMAT, 4, {awake: false, cookAwake: true, clipOffer: true}]);
});

test('restore asks first, then replaces the data', () => {
  let backup = {format: BACKUP_FORMAT, exported_at: '2026-10-23T10:00:00Z', meals: [{id: 7, name: 'Backed up', recipes: []}], settings: {awake: true}};
  receiveBackupFile('```json\n' + JSON.stringify(backup) + '\n```');
  assert(modalOpen(), 'no confirmation');
  eq(meals.length, 4, 'replaced before confirming');
  confirmRestore();
  eq([meals.length, meals[0].name, page, awake, cookAwake], [1, 'Backed up', 'home', true, true]);
});

test('restored backups are cleaned like imports', () => {
  receiveBackupFile(JSON.stringify({
    format: BACKUP_FORMAT,
    meals: [{name: '<b>x</b>', art: 'pasta" onclick="alert(1)', recipes: ['notarray', {title: '<img src=x>'}]}, {nope: 1}],
    settings: {meals: 'x'}
  }));
  confirmRestore();
  eq([meals.length, meals[0].art, meals[0].recipes.length], [1, '', 2]);
  go('meals');
  assert(!hasMarkup(main()), 'rendered markup');
});

test('restoring a recipe export offers to add its meals; junk is rejected', () => {
  receiveBackupFile(sampleExport);
  assert(modal().textContent.includes('FROM A FILE'), 'no offer');
  confirmImport('update');
  eq(meals.length, 5);
  receiveBackupFile('hello');
  eq(meals.length, 5);
});

// ---- AI handoff ----

const bridgeCalls = name => bridge.calls.filter(c => c[0] === name);

test('the format the AI is given is one the importer accepts', () => {
  let parsed = parseMealkeeperJson(EXPORT_FORMAT);
  assert(parsed, 'skeleton is not valid JSON');
  let m = fromV1Meal(parsed.meals[0], 0);
  eq([m.recipes.length, m.recipes[0].ingredients.length, m.shopping.length, m.timeline.length], [1, 1, 1, 1]);
  eq(m.shopping[0].usedIn, ['…'], 'used_in ids resolve to recipe titles');
  for (let text of [AI_SETUP_INSTRUCTIONS, ONE_OFF_PROMPT]) assert(text.includes(EXPORT_FORMAT), 'format missing');
  assert(AI_SETUP_INSTRUCTIONS.includes('"send it to the pan"'), 'trigger phrase missing');
});

test('"Open ChatGPT" opens the app, or the website without it', () => {
  opened = [];
  openAi('chatgpt');
  eq([bridgeCalls('openAiApp').length, opened.length], [1, 0]);
  bridge.aiAppResult = 'missing';
  openAi('claude');
  eq(opened, ['https://claude.ai/']);
});

test('AI screen has setup steps for ChatGPT and Claude', () => {
  go('ai');
  assert(main().textContent.includes('In ChatGPT, create a project'), 'ChatGPT steps');
  assert(main().textContent.includes('Open ChatGPT'), 'ChatGPT button');
  aiTab = 'claude';
  render();
  assert(main().textContent.includes('In Claude, create a project'), 'Claude steps');
  copySetup();
  eq(bridgeCalls('copyText').map(c => c[1]), [AI_SETUP_INSTRUCTIONS], 'copied through Android');
  copyPrompt();
  eq(bridgeCalls('copyText')[1][1], ONE_OFF_PROMPT);
});

test('a copied meal is offered, then imported and opened', () => {
  receiveClipboardText('```json\n' + sampleExport + '\n```');
  assert(modalOpen(), 'no offer');
  assert(modal().textContent.includes('Import Mediterranean chicken bowls?'), modal().textContent);
  assert(modal().textContent.includes('2 recipes · 6 shopping items · cooking timeline'), modal().textContent);
  assert(document.getElementById('modal-bg').classList.contains('centered'), 'offer should be centred, clear of Android\'s overlays');
  eq(meals.length, 4, 'imported before confirming');
  confirmImport();
  eq([meals.length, page, currentMeal().name, modalOpen()], [5, 'meal', 'Mediterranean chicken bowls', false]);
});

test('"Not now" leaves everything as it was', () => {
  receiveClipboardText(sampleExport);
  modal().querySelector('.outline').click();
  eq([meals.length, modalOpen(), pendingImport], [4, false, null]);
});

test('copied text that isn\'t a meal is ignored', () => {
  receiveClipboardText('{"recipes": "not really"}');
  receiveClipboardText('some "meals" talk');
  eq(modalOpen(), false);
});

test('no offer while a dialog is open or when the setting is off', () => {
  openImport();
  receiveClipboardText(sampleExport);
  assert(modal().textContent.includes('Import AI-generated recipes'), 'replaced the open dialog');
  closeModal();
  setClipOffer(false);
  receiveClipboardText(sampleExport);
  eq(modalOpen(), false);
});

test('a shared meal is offered; other shared text opens the import dialog', () => {
  receiveSharedText(sampleExport);
  assert(modal().textContent.includes('SHARED WITH PROMPT TO PAN'), 'no offer');
  closeModal();
  receiveSharedText('Grandma\'s lasagna: lots of cheese');
  assert(document.getElementById('import-area'), 'import dialog not open');
  eq(document.getElementById('import-area').value, 'Grandma\'s lasagna: lots of cheese');
});

test('setup instructions fit in ChatGPT\'s 1,500-character custom instructions', () => {
  assert(AI_SETUP_INSTRUCTIONS.length <= 1500, AI_SETUP_INSTRUCTIONS.length + ' characters');
});

// ---- Round trips and asking the AI ----

// The last prompt handed to an AI app, or copied when there was no app to hand it to.
const lastPrompt = () => {
  let c = bridge.calls.filter(c => c[0] === 'sendToAiApp' || c[0] === 'copyText').pop();
  return c[0] === 'sendToAiApp' ? c[2] : c[1];
};

test('a meal survives export to the AI format and back', () => {
  let m = meals[0], back = fromV1Meal(toV1Meal(m), 0);
  eq(back.recipes.map(r => [r.id, r.title, r.time, r.ingredients.length, r.instructions.length]),
    m.recipes.map(r => [r.id, r.title, r.time, r.ingredients.length, r.instructions.length]));
  eq(back.shopping.map(x => [x.name, x.qty, x.group, x.usedIn]), m.shopping.map(x => [x.name, x.qty, x.group, x.usedIn]));
  eq(back.timeline, m.timeline);
  eq([back.name, back.desc, back.time, back.servings], [m.name, m.desc, m.time, m.servings]);
});

// What an AI might send back after "make it vegetarian": same id, sausage swapped for mushrooms.
function revisedSupper(changes = {}) {
  let v1 = toV1Meal(meals[0]);
  v1.recipes[1].title = 'Mushroom & pepper rigatoni';
  v1.recipes[1].ingredients[0] = {name: 'Cremini mushrooms', quantity: 1, unit: 'lb', notes: 'sliced'};
  v1.shopping_list = v1.shopping_list.filter(x => x.name !== 'Italian sausage links');
  v1.shopping_list.unshift({name: 'Cremini mushrooms', quantity: 1, unit: 'lb', category: 'Produce', used_in: ['rigatoni']});
  return '```json\n' + JSON.stringify({format: 'mealkeeper-v1', meals: [Object.assign(v1, changes)]}) + '\n```';
}

test('a revised meal from the AI updates the original', () => {
  let m = meals[0];
  m.serveAt = '19:15';
  m.shopping.find(x => x.name === 'Parmesan').checked = true;
  m.shopping.find(x => x.name === 'Italian sausage links').checked = true;
  receiveClipboardText(revisedSupper());
  assert(modal().textContent.includes('Update Sunday Italian supper?'), modal().textContent);
  assert(modal().textContent.includes('items you checked off stay checked'), 'explanation missing');
  confirmImport('update');
  eq([meals.length, meals[0] === m, page, selectedMeal], [4, true, 'meal', 1]);
  eq(m.recipes[1].title, 'Mushroom & pepper rigatoni');
  eq([m.serveAt, m.shopping.length], ['19:15', 14]);
  eq(m.shopping.filter(x => x.checked).map(x => x.name), ['Parmesan'], 'checks kept only for items still listed');
  eq(m.shopping[0].usedIn, ['Mushroom & pepper rigatoni']);
});

test('"Save as new" keeps the original and adds the revision', () => {
  receiveClipboardText(revisedSupper());
  confirmImport('copy');
  eq([meals.length, meals[0].recipes[1].title, meals[4].recipes[1].title], [5, 'Sausage & pepper rigatoni', 'Mushroom & pepper rigatoni']);
});

test('a revision without its id is matched by name', () => {
  receiveClipboardText(revisedSupper({mealkeeper_id: null}));
  assert(modal().textContent.includes('Update Sunday Italian supper?'));
  confirmImport('update');
  eq(meals.length, 4);
});

test('pasting a revision asks before updating; a new meal imports straight away', () => {
  importViaDialog(revisedSupper());
  assert(modal().textContent.includes('PASTED'), 'no update offer');
  closeModal();
  importViaDialog(sampleExport);
  eq([meals.length, modalOpen()], [5, false]);
});

test('Revise with AI sends the whole meal and the request', () => {
  opened = [];
  openMeal(1);
  reviseMeal();
  assert(modal().textContent.includes('Change “Sunday Italian supper”'), 'dialog');
  assert(modal().textContent.includes('Serve 6 instead of 3'), 'servings chip');
  document.getElementById('ai-request').value = 'Make it vegetarian';
  sendToAi('claude');
  let prompt = lastPrompt();
  assert(prompt.startsWith("Here's a meal from my Prompt to Pan app. Make it vegetarian"), prompt.slice(0, 80));
  assert(prompt.includes('"mealkeeper_id":"1"'), 'id missing');
  eq(fromV1Meal(parseMealkeeperJson(prompt).meals[0], 0).recipes.length, 3, 'meal JSON in the prompt imports');
  eq(modalOpen(), false);
  eq(aiTab, 'claude', 'remembers the AI');
  eq(JSON.parse(localStorage.getItem(STORE_KEY)).aiTab, 'claude');
});

test('prompts go straight to the AI app when it\'s installed', () => {
  opened = [];
  openMeal(1);
  reviseMeal();
  sendToAi('chatgpt');
  let call = bridgeCalls('sendToAiApp')[0];
  eq([call[1], call[2] === lastPrompt(), bridgeCalls('copyText').length, opened.length], ['chatgpt', true, 0, 0]);
  sendPrompt('claude', ONE_OFF_PROMPT);
  eq(bridgeCalls('sendToAiApp')[1].slice(1), ['claude', ONE_OFF_PROMPT]);
});

test('if the app only opens, the prompt is copied to paste', () => {
  bridge.aiAppResult = 'opened';
  opened = [];
  sendPrompt('claude', ONE_OFF_PROMPT);
  eq([bridgeCalls('copyText').map(c => c[1]), opened.length], [[ONE_OFF_PROMPT], 0]);
});

test('without the app, the prompt goes in a web link when it fits; otherwise a plain new chat opens', () => {
  bridge.aiAppResult = 'missing';
  opened = [];
  openMeal(1);
  askAbout('recipe', 0);
  sendToAi('chatgpt');
  assert(opened[0].startsWith('https://chatgpt.com/?q='), opened[0]);
  eq(decodeURIComponent(opened[0].slice('https://chatgpt.com/?q='.length)), lastPrompt());
  reviseMeal();
  sendToAi('claude');
  eq(opened[1], 'https://claude.ai/', 'the whole meal is too long for a link');
  assert(lastPrompt().includes('mealkeeper_id'), 'still copied');
});

test('Ask AI about a recipe includes it as readable text', () => {
  openMeal(1);
  showRecipe(1);
  modal().querySelector('[onclick^="askAbout"]').click();
  assert(modal().textContent.includes('Ask about “Sausage & pepper rigatoni”'), modal().textContent);
  document.getElementById('ai-request').value = 'What can I use instead of heavy cream?';
  sendToAi('chatgpt');
  let prompt = lastPrompt();
  assert(prompt.includes('What can I use instead of heavy cream?'), 'question');
  assert(prompt.includes('Sausage & pepper rigatoni (Main), serves 3'), 'title line');
  assert(prompt.includes('- ½ cup Heavy cream'), 'ingredient line');
  assert(prompt.includes('3. Stir in the cream'), 'numbered step');
  assert(modal().textContent.includes('Ingredients'), 'recipe reopens for when you come back');
  eq(lastAwakeCall(), true, 'screen stays on');
});

test('Ask AI about a timeline step includes the step and its recipe', () => {
  go('timeline');
  let buttons = main().querySelectorAll('[onclick^="askAbout(\'step\'"]');
  eq(buttons.length, 6);
  buttons[3].click();
  document.getElementById('ai-request').value = 'How do I know it\'s done?';
  sendToAi('chatgpt');
  let prompt = lastPrompt();
  assert(prompt.includes('"Boil pasta"'), 'step');
  assert(prompt.includes('Sausage & pepper rigatoni (Main)'), 'recipe');
});

test('the copied-meal setting is saved and sent to Android', () => {
  setClipOffer(false);
  eq(bridgeCalls('setClipboardWatch').map(c => c[1]), [false]);
  eq(JSON.parse(localStorage.getItem(STORE_KEY)).clipOffer, false);
  go('settings');
  eq(main().querySelectorAll('.toggle').length, 3);
});

// ---- Keep screen awake ----

test('screen stays on only while cooking', () => {
  let steps = [];
  go('timeline'); steps.push(lastAwakeCall());
  go('home'); steps.push(lastAwakeCall());
  openMeal(1); showRecipe(0); steps.push(lastAwakeCall());
  closeModal(); steps.push(lastAwakeCall());
  mealTab = 'timeline'; render(); steps.push(lastAwakeCall());
  eq(steps, [true, false, true, false, true]);
});

test('keep-awake only calls Android when the state changes', () => {
  go('timeline');
  let n = awakeCalls().length;
  render();
  render();
  eq(awakeCalls().length, n);
});

test('keep-awake settings', () => {
  go('timeline');
  setCookAwake(false);
  eq(lastAwakeCall(), false, 'cooking option off');
  setAwake(true);
  go('home');
  eq(lastAwakeCall(), true, 'always on');
  go('settings');
  eq(main().querySelectorAll('.toggle').length, 3);
});

// ---- Layout ----

test('bottom nav clears the Android navigation bar', () => {
  let nav = document.querySelector('.mobile-nav');
  document.documentElement.style.setProperty('--android-safe-bottom', '24px');
  let padded = getComputedStyle(nav).paddingBottom;
  document.documentElement.style.removeProperty('--android-safe-bottom');
  eq(padded, '31px');
});

// ---- Report ----

reset();
let failed = results.filter(r => !r.ok);
results.forEach(r => console.log(`MKTEST ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' -- ' + r.error}`));
console.log(`MKTEST DONE ${results.length} tests, ${failed.length} failed`);
document.body.innerHTML = `<pre style="padding:16px;white-space:pre-wrap">${escapeHtml(results.map(r =>
  `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : '\n     ' + r.error}`).join('\n'))}\n\n${results.length} tests, ${failed.length} failed</pre>`;
