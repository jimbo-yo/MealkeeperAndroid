// Browser tests for app.js. scripts/run-web-tests.sh loads the app with fake-android.js before it and this file after it.
// Every test starts from the demo data with empty storage (see reset()).

const results = [];
const bridge = window.MealkeeperAndroid;
const main = () => document.getElementById('main');
const modal = () => document.getElementById('modal');
const modalOpen = () => document.getElementById('modal-bg').style.display === 'flex';
const awakeCalls = () => bridge.calls.filter(c => c[0] === 'setKeepScreenOn').map(c => c[1]);
const lastAwakeCall = () => awakeCalls().pop();
const bridgeCalls = name => bridge.calls.filter(c => c[0] === name);
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
  myAi = 'chatgpt';
  appearance = 'light';
  clipOffer = true;
  bridge.aiAppResult = 'shared';
  bridge.keys = {};
  refreshAiKeys();
  Object.keys(aiCalls).forEach(id => delete aiCalls[id]);
  chat = null;
  chatTurn = null;
  chatError = null;
  chatDraft = '';
  aiModels = {};
  aiModelLists = {};
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
  let m = meals[0];
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
  let list = meals[0].shopping, oil = list.find(x => x.name === 'Olive oil');
  eq(list.length, 6);
  eq(oil.qty, '3 tbsp', '2 tbsp + 1 tbsp');
  eq(oil.usedIn.length, 2);
});

test('imports the older minimal export (titles and time strings only)', () => {
  importMeals(parseMealkeeperJson('{"meals":[{"name":"Old","total_time":"35 min","recipes":[{"title":"A","total_time":"25 min"}]}]}'));
  let m = meals[0];
  eq([m.time, m.recipes[0].time, m.shopping.length], ['35 min', '25 min', 0]);
});

test('imported text is shown as text, never as HTML', () => {
  importMeals(HOSTILE);
  let id = meals[0].id;
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

test('the shopping list links back to the recipe it was opened from', () => {
  openMeal(1);
  showRecipe(1);
  modal().querySelector('[onclick^="openFromRecipe"]').click();
  eq([page, modalOpen()], ['shopping', false]);
  let back = main().querySelector('.text-btn');
  eq(back.textContent, '← Sausage & pepper rigatoni');
  back.click();
  eq([page, modalOpen()], ['meal', true]);
  assert(modal().textContent.includes('Sausage & pepper rigatoni'), 'recipe not reopened');
});

test('Android back from the shopping list also reopens the recipe', () => {
  openMeal(1);
  showRecipe(0);
  openFromRecipe(0, 'shopping');
  eq([handleBack(), page, modalOpen()], [true, 'meal', true]);
  assert(modal().textContent.includes('Roasted tomato bruschetta'));
});

test('from a meal, the shopping list and timeline link back to the meal', () => {
  openMeal(1);
  go('timeline');
  let back = main().querySelector('.text-btn');
  eq(back.textContent, '← Sunday Italian supper');
  back.click();
  eq(page, 'meal');
  go('home');
  go('shopping');
  main().querySelector('.text-btn').click();
  eq([page, selectedMeal], ['meal', 1], 'opens the meal even when you came from elsewhere');
});

test('recipe names on the shopping list open the recipe without ticking the item', () => {
  go('shopping');
  let item = [...main().querySelectorAll('.checkrow')].find(r => r.textContent.includes('Ricotta cheese'));
  item.querySelector('.recipe-link').click();
  assert(modalOpen() && modal().textContent.includes('Lemon ricotta cups'), 'recipe not shown');
  eq(meals[0].shopping.find(x => x.name === 'Ricotta cheese').checked, false);
  eq(page, 'shopping', 'stays on the list underneath');
  modal().querySelector('[onclick^="openFromRecipe"]').click();
  eq([page, modalOpen()], ['shopping', false], '"Shopping list" just closes the recipe');
});

test('recipe names on the timeline open the recipe', () => {
  go('timeline');
  main().querySelector('.recipe-link').click();
  assert(modal().textContent.includes('Sausage & pepper rigatoni'));
});

test('the most recently opened, picked or imported meal comes first', () => {
  const order = () => meals.map(m => m.id);
  openMeal(3);
  eq(order(), [3, 1, 2, 4]);
  go('home');
  eq(main().querySelector('.meal-card h3').textContent, 'Cozy autumn dinner', 'Home lists it first');
  go('shopping');
  let picker = main().querySelector('select');
  picker.value = '4';
  picker.dispatchEvent(new Event('change'));
  eq(order(), [4, 3, 1, 2]);
  importMeals(parseMealkeeperJson(sampleExport));
  eq(meals[0].name, 'Mediterranean chicken bowls');
  receiveClipboardText(revisedSupper());
  confirmImport('update');
  eq(meals[0].id, 1, 'an AI update brings the meal back to the top');
  let saved = JSON.parse(localStorage.getItem(STORE_KEY));
  eq(saved.meals.map(m => m.id).slice(0, 2), [1, meals[1].id], 'order is saved');
});

// ---- Sharing a meal with someone else ----

test('Share sends an importable meal file and a readable version', () => {
  openMeal(1);
  [...main().querySelectorAll('button')].find(b => b.textContent.includes('Share')).click();
  let [, fileName, json, text, title] = bridgeCalls('shareMeal')[0];
  eq([fileName, title], ['Sunday Italian supper.prompttopan.json', 'Sunday Italian supper']);
  let v1 = JSON.parse(json).meals[0], back = fromV1Meal(v1, 0);
  eq('mealkeeper_id' in v1, false, 'no internal id');
  eq([back.recipes.length, back.recipes[1].ingredients.length, back.shopping.length, back.timeline.length], [3, 7, 14, 6]);
  assert(text.startsWith('Sunday Italian supper (serves 3, 55 min)'), text.slice(0, 60));
  assert(text.includes('Sausage & pepper rigatoni (Main), serves 3') && text.includes('- 1 lb Italian sausage links'), 'recipes in the text');
  assert(text.endsWith('cooking timeline too.'), 'note about the file');
});

test('a shared meal file arrives as an import offer', () => {
  openMeal(1);
  shareMeal();
  let json = bridgeCalls('shareMeal')[0][2];
  deleteMeal(1);
  receiveSharedText(json);
  assert(modal().textContent.includes('SHARED WITH PROMPT TO PAN') && modal().textContent.includes('Import Sunday Italian supper?'), modal().textContent);
  confirmImport('update');
  eq([meals[0].name, meals[0].recipes.length, meals[0].shopping.length, page], ['Sunday Italian supper', 3, 14, 'meal']);
});

test('receiving a meal you already have offers Update or Save as new', () => {
  openMeal(1);
  shareMeal();
  receiveSharedText(bridgeCalls('shareMeal')[0][2]);
  assert(modal().textContent.includes('Update Sunday Italian supper?'), 'matched by name');
  confirmImport('copy');
  eq(meals.filter(m => m.name === 'Sunday Italian supper').length, 2);
});

// ---- Deleting ----

test('deleting a meal asks first, then removes it and is saved', () => {
  openMeal(1);
  main().querySelector('.outline.danger').click();
  assert(modal().textContent.includes('Delete “Sunday Italian supper”?'), 'no confirmation');
  modal().querySelector('.modal-foot .outline').click();
  eq(meals.length, 4, 'Cancel keeps it');
  confirmDeleteMeal();
  modal().querySelector('.danger-fill').click();
  eq([meals.length, page, meals.some(m => m.id === 1)], [3, 'meals', false]);
  assert(selectedMeal !== 1, 'another meal is selected');
  eq(JSON.parse(localStorage.getItem(STORE_KEY)).meals.length, 3);
  eq(handleBack() && page, 'home', 'Back doesn\'t return to the deleted meal');
});

test('with every meal deleted, the Meals page says so', () => {
  [...meals].forEach(m => deleteMeal(m.id));
  eq(meals.length, 0);
  assert(main().textContent.includes('No meals yet'), main().textContent.slice(0, 120));
  go('home');
  go('shopping');
  go('timeline');
  assert(main().textContent.includes('No cooking timeline yet'));
});

test('deleting a recipe takes its steps and the shopping items only it used', () => {
  let m = meals[0];
  openMeal(1);
  showRecipe(2);
  modal().querySelector('.text-btn.danger').click();
  assert(modal().textContent.includes('along with 3 shopping item(s) only it uses and 1 timeline step(s)'), modal().textContent);
  modal().querySelector('.modal-foot .outline').click();
  assert(modal().textContent.includes('Ingredients'), 'Cancel goes back to the recipe');
  confirmDeleteRecipe(2);
  modal().querySelector('.danger-fill').click();
  eq(m.recipes.map(r => r.title), ['Roasted tomato bruschetta', 'Sausage & pepper rigatoni']);
  eq(['Ricotta cheese', 'Lemons', 'Honey'].filter(n => m.shopping.some(x => x.name === n)), []);
  eq(m.timeline.some(t => t.recipeId === 'ricotta'), false);
  eq(m.shopping.length, 11);
  deleteRecipe(0);
  eq(m.shopping.find(x => x.name === 'Olive oil').usedIn, ['Sausage & pepper rigatoni'], 'shared items stay, minus the recipe');
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
  eq([data.format, data.meals.length, data.settings], [BACKUP_FORMAT, 4, {awake: false, cookAwake: true, clipOffer: true, appearance: 'light'}]);
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
  setMyAi('claude');
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

test('a meal copied before the AI finished writing gets a hint, not silence', () => {
  receiveClipboardText(sampleExport.slice(0, 900));
  eq(modalOpen(), false);
  assert(document.getElementById('toast').textContent.includes('unfinished'), document.getElementById('toast').textContent);
  importViaDialog(sampleExport.slice(0, 900));
  assert(document.getElementById('toast').textContent.includes('Ready to copy'), 'paste hint');
});

test('the AI is asked to say when the JSON is complete', () => {
  assert(EXPORT_FORMAT.includes('"✅ Ready to copy"'), 'export format');
  openMeal(1);
  reviseMeal();
  myAi = 'claude';
  sendToAi();
  assert(bridge.calls.filter(c => c[0] === 'sendToAiApp').pop()[2].includes('"✅ Ready to copy"'), 'revise prompt');
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
  let v1 = toV1Meal(meals.find(m => m.id === 1));
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
  let original = meals.find(m => m.id === 1);
  eq([meals.length, meals[0].recipes[1].title, original.recipes[1].title], [5, 'Mushroom & pepper rigatoni', 'Sausage & pepper rigatoni']);
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
  myAi = 'claude';
  sendToAi();
  let prompt = lastPrompt();
  assert(prompt.startsWith("Here's a meal from my Prompt to Pan app. Make it vegetarian"), prompt.slice(0, 80));
  assert(prompt.includes('"mealkeeper_id":"1"'), 'id missing');
  eq(fromV1Meal(parseMealkeeperJson(prompt).meals[0], 0).recipes.length, 3, 'meal JSON in the prompt imports');
  eq(modalOpen(), false);
  eq(bridgeCalls('sendToAiApp').pop()[1], 'claude', 'uses your AI');
});

test('Your AI is a setting; the dialogs have one button for it', () => {
  go('settings');
  [...main().querySelectorAll('.tab')].find(b => b.textContent === 'Claude').click();
  eq([myAi, JSON.parse(localStorage.getItem(STORE_KEY)).ai], ['claude', 'claude']);
  openMeal(1);
  reviseMeal();
  let buttons = [...modal().querySelectorAll('.modal-foot button')].map(b => b.textContent);
  eq(buttons, ['Ask Claude ↗']);
  modal().querySelector('.modal-foot .primary').click();
  eq(bridgeCalls('sendToAiApp').pop()[1], 'claude');
});

test('older saves carry the AI last used over as Your AI', () => {
  applyState({meals: [], aiTab: 'claude'});
  eq(myAi, 'claude');
  applyState({meals: [], ai: 'chatgpt', aiTab: 'claude'});
  eq(myAi, 'chatgpt', 'the setting wins');
});

test('the Plan with AI switch is the same setting', () => {
  go('ai');
  [...main().querySelectorAll('.tab')].find(b => b.textContent === 'Claude').click();
  eq(myAi, 'claude');
  assert(main().textContent.includes('Start a new chat in Claude'), 'one-off button follows the setting');
  go('settings');
  assert([...main().querySelectorAll('.tab.active')].some(t => t.textContent === 'Claude'), 'Settings shows Claude');
});

test('prompts go straight to the AI app when it\'s installed', () => {
  opened = [];
  openMeal(1);
  reviseMeal();
  myAi = 'chatgpt';
  sendToAi();
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
  myAi = 'chatgpt';
  sendToAi();
  assert(opened[0].startsWith('https://chatgpt.com/?q='), opened[0]);
  eq(decodeURIComponent(opened[0].slice('https://chatgpt.com/?q='.length)), lastPrompt());
  reviseMeal();
  myAi = 'claude';
  sendToAi();
  eq(opened[1], 'https://claude.ai/', 'the whole meal is too long for a link');
  assert(lastPrompt().includes('mealkeeper_id'), 'still copied');
});

test('Ask AI about a recipe includes it as readable text', () => {
  openMeal(1);
  showRecipe(1);
  modal().querySelector('[onclick^="askAbout"]').click();
  assert(modal().textContent.includes('Ask about “Sausage & pepper rigatoni”'), modal().textContent);
  document.getElementById('ai-request').value = 'What can I use instead of heavy cream?';
  myAi = 'chatgpt';
  sendToAi();
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
  myAi = 'chatgpt';
  sendToAi();
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

test('dialogs move above the keyboard; the bottom nav does not', () => {
  let root = document.documentElement.style, bg = document.getElementById('modal-bg'), nav = document.querySelector('.mobile-nav');
  openImport();
  root.setProperty('--android-safe-bottom', '24px');
  root.setProperty('--android-ime-bottom', '300px');
  let dialog = getComputedStyle(bg).paddingBottom, navPad = getComputedStyle(nav).paddingBottom;
  root.setProperty('--android-ime-bottom', '0px');
  let closed = getComputedStyle(bg).paddingBottom;
  root.removeProperty('--android-safe-bottom');
  root.removeProperty('--android-ime-bottom');
  eq([dialog, navPad, closed], ['310px', '31px', '34px']);
});

// ---- Appearance ----

const bgOf = el => getComputedStyle(el).backgroundColor;

test('the app is Linen by default, even when the phone is in dark mode', () => {
  eq([document.documentElement.dataset.theme, getComputedStyle(document.documentElement).colorScheme], ['light', 'light']);
  eq(bgOf(document.body), 'rgb(243, 234, 219)');
});

test('Appearance switches to soft olive, tells Android, and is saved', () => {
  go('settings');
  [...main().querySelectorAll('.tab')].find(t => t.textContent === 'Dark').click();
  eq([appearance, document.documentElement.dataset.theme], ['dark', 'dark']);
  eq(bgOf(document.body), 'rgb(35, 42, 36)');
  eq(bridgeCalls('setAppearance').pop()[1], 'dark');
  eq(JSON.parse(localStorage.getItem(STORE_KEY)).appearance, 'dark');
  setAppearance('match');
  eq(getComputedStyle(document.documentElement).colorScheme, 'light dark');
  applyState({meals: [], appearance: 'purple'});
  eq(appearance, 'match', 'ignores unknown values');
});

test('the name uses the bundled script font', () => {
  let brand = getComputedStyle(document.querySelector('.brand'));
  assert(brand.fontFamily.includes('Satisfy'), brand.fontFamily);
  assert(getComputedStyle(document.querySelector('.brand-prompt')).fontFamily.includes('Space Mono'), 'Prompt in Space Mono');
  eq(document.querySelector('.brand').textContent.trim(), 'Prompt to Pan');
});


// ---- Chat with an API key (chat.js) ----

const lastAiRequest = () => bridgeCalls('aiRequest').pop();
const aiBody = () => lastAiRequest()[5];
const streamAi = events => window.onAiEvents(lastAiRequest()[1], events.map(e => JSON.stringify(e)));
const finishAi = (status = 200, body = null) => window.onAiDone(lastAiRequest()[1], status, body);

function connect(ai) {
  bridge.keys[ai] = true;
  refreshAiKeys();
  myAi = ai;
}

function say(text) {
  go('chat');
  document.getElementById('chat-input').value = text;
  sendFromComposer();
}

const TEST_MEAL = {
  mealkeeper_id: null, name: 'Lemon chicken supper', description: 'Bright and easy.', servings: 4, total_time: '1 hr',
  recipes: [{id: 'chicken', title: 'Lemon roast chicken', course: 'Main', servings: 4, prep_time_minutes: 10, cook_time_minutes: 50, total_time_minutes: 60,
    ingredients: [{name: 'Chicken thighs', quantity: 8, unit: null, notes: null}], instructions: ['Roast it with lemon.'], make_ahead_notes: null, source: null}],
  shopping_list: [{name: 'Chicken thighs', quantity: 8, unit: null, category: 'Meat', used_in: ['chicken']}],
  timeline: [{start_offset_minutes: 0, duration_minutes: 60, task: 'Roast the chicken', recipe_id: 'chicken', instructions: null}]
};

// A streamed Claude reply: a thinking block, some text, and optionally a save_meal call split over two deltas.
function claudeReply(text, meal, stop) {
  let ev = [{type: 'message_start', message: {model: 'claude-opus-5-5'}},
    {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
    {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'Planning.'}},
    {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'sig'}},
    {type: 'content_block_stop', index: 0},
    {type: 'content_block_start', index: 1, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text}},
    {type: 'content_block_stop', index: 1}];
  if (meal) {
    let json = typeof meal === 'string' ? meal : JSON.stringify(meal);
    ev.push({type: 'content_block_start', index: 2, content_block: {type: 'tool_use', id: 'toolu_1', name: 'save_meal', input: {}}},
      {type: 'content_block_delta', index: 2, delta: {type: 'input_json_delta', partial_json: json.slice(0, 15)}},
      {type: 'content_block_delta', index: 2, delta: {type: 'input_json_delta', partial_json: json.slice(15)}},
      {type: 'content_block_stop', index: 2});
  }
  ev.push({type: 'message_delta', delta: {stop_reason: stop || (meal ? 'tool_use' : 'end_turn')}}, {type: 'message_stop'});
  return ev;
}

function responsesReply(text, meal, id = 'resp_1') {
  let ev = [{type: 'response.created', response: {id}}, {type: 'response.output_text.delta', delta: text}];
  if (meal) ev.push({type: 'response.output_item.added', item: {type: 'function_call', call_id: 'call_1', name: 'save_meal', arguments: ''}},
    {type: 'response.output_item.done', item: {type: 'function_call', call_id: 'call_1', name: 'save_meal', arguments: JSON.stringify(meal)}});
  ev.push({type: 'response.completed', response: {id, status: 'completed'}});
  return ev;
}

test('without an API key, Plan with AI goes to the setup steps and Chat offers to connect', () => {
  planWithAi();
  eq(page, 'ai');
  assert(main().textContent.includes('Add API key'), 'AI page offers a key');
  go('chat');
  assert(main().textContent.includes('Connect ChatGPT to chat here'), main().textContent);
  assert(!document.getElementById('chat-input'), 'no message box without a key');
});

test('saving an API key checks it with the AI and picks the default model', () => {
  keyModal('claude');
  document.getElementById('ai-key').value = ' sk-ant-test ';
  saveAiKey('claude');
  eq(bridgeCalls('setAiKey')[0].slice(1), ['claude', ' sk-ant-test ']);
  let r = lastAiRequest();
  eq([r[2], r[3], r[4]], ['claude', 'GET', '/v1/models']);
  assert(modalOpen() && modal().textContent.includes('Checking'), 'shows it is checking');
  finishAi(200, JSON.stringify({data: [{id: 'claude-sonnet-5-5'}, {id: 'claude-opus-5-5'}, {id: 'claude-haiku-5-5'}]}));
  assert(!modalOpen(), 'dialog closes');
  assert(hasKey('claude'), 'connected');
  eq(aiModelLists.claude[0], 'claude-opus-5-5', 'default model first');
  eq(aiModel('claude'), 'claude-opus-5-5');
  go('settings');
  assert(main().textContent.includes('Connected with your Anthropic key'), 'settings shows it');
  eq(main().querySelector('select[aria-label="Claude model"]').options.length, 3);
});

test('a key the AI rejects is removed again', () => {
  keyModal('grok');
  document.getElementById('ai-key').value = 'xai-wrong';
  saveAiKey('grok');
  finishAi(400, '{"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}');
  eq(bridgeCalls('clearAiKey').length, 1);
  assert(!hasKey('grok'), 'not connected');
  assert(modalOpen() && modal().textContent.includes("didn't accept that key"), 'says why');
});

test('the OpenAI model list leaves out models that can\'t chat, and the chosen model is kept', () => {
  connect('chatgpt');
  aiModels.chatgpt = 'gpt-6-luna';
  loadModels('chatgpt');
  finishAi(200, JSON.stringify({data: ['gpt-6-luna', 'gpt-image-2.5-flare', 'text-embedding-3-large', 'gpt-6-sol', 'gpt-realtime-2.1', 'gpt-transcribe'].map(id => ({id}))}));
  eq(aiModelLists.chatgpt, ['gpt-6-sol', 'gpt-6-luna']);
  eq(aiModel('chatgpt'), 'gpt-6-luna', 'kept the user\'s choice');
});

test('Claude chat: the request, the streamed reply, and a saved meal going straight into the app', () => {
  connect('claude');
  let before = meals.length;
  say('Plan a lemony dinner');
  let r = lastAiRequest(), body = aiBody();
  eq([r[2], r[3], r[4], r[6]], ['claude', 'POST', '/v1/messages', 'server-side-fallback-2026-07-01']);
  eq(body.model, 'claude-opus-5-5');
  eq(body.stream, true);
  eq(body.fallbacks, 'default');
  eq(body.output_config, {effort: 'medium'});
  assert(!('temperature' in body) && !('thinking' in body), 'no sampling or thinking settings');
  eq(body.tools[0].name, 'save_meal');
  eq(body.tools[0].eager_input_streaming, true);
  assert(body.system.includes('save_meal') && body.system.includes(MEAL_RULES), 'system prompt');
  eq(body.messages, [{role: 'user', content: 'Plan a lemony dinner'}]);
  assert(main().textContent.includes('Thinking…'), 'shows it is thinking');
  streamAi(claudeReply('Here you go!', TEST_MEAL).slice(0, -3));
  assert(main().textContent.includes('Writing up the meal…'), 'says it is writing the meal');
  assert(main().textContent.includes('Here you go!'), 'streams text');
  streamAi(claudeReply('', TEST_MEAL).slice(-3));
  finishAi();
  eq(meals.length, before + 1);
  eq(meals[0].name, 'Lemon chicken supper');
  eq(selectedMeal, meals[0].id);
  let text = main().textContent;
  assert(text.includes('Added to your meals') && text.includes('Lemon chicken supper'), 'meal card');
  assert(!text.includes('recipes":') && !text.includes('mealkeeper'), 'no JSON shown');
  eq(chat.messages.length, 2);
  eq(chat.messages[1].content.map(b => b.type), ['thinking', 'text', 'tool_use']);
  eq(chat.messages[1].content[0], {type: 'thinking', thinking: 'Planning.', signature: 'sig'});
  eq(chat.messages[1].content[2].input.name, 'Lemon chicken supper');
  eq(chat.pending.length, 1);
  eq(chat.pending[0].tool_use_id, 'toolu_1');
  assert(chat.pending[0].content.includes(`"${meals[0].id}"`), 'tells the AI the meal id');
  main().querySelector('.meal-saved button').click();
  eq(page, 'meal');
});

test('the next message carries the tool result, and saving with the meal\'s id updates it', () => {
  connect('claude');
  say('Plan a lemony dinner');
  streamAi(claudeReply('Saved.', TEST_MEAL));
  finishAi();
  let count = meals.length, id = meals[0].id;
  say('Make it serve 6');
  let msgs = aiBody().messages;
  eq(msgs.length, 3);
  eq(msgs[2].content[0].type, 'tool_result');
  eq(msgs[2].content[1], {type: 'text', text: 'Make it serve 6'});
  streamAi(claudeReply('Updated it.', {...TEST_MEAL, mealkeeper_id: String(id), name: 'Lemon chicken for six', servings: 6}));
  finishAi();
  eq(meals.length, count, 'no copy added');
  eq(meals.find(m => m.id === id).name, 'Lemon chicken for six');
  assert(main().textContent.includes('Updated'), 'card says updated');
});

test('a new meal with the same name as a saved one is added, not swapped in', () => {
  connect('claude');
  let count = meals.length, name = meals[0].name;
  say('Plan it');
  streamAi(claudeReply('Done.', {...TEST_MEAL, name}));
  finishAi();
  eq(meals.length, count + 1);
});

test('Revise with AI, with a key, talks it through in the chat and updates the meal', () => {
  connect('claude');
  openMeal(1);
  let count = meals.length, name = currentMeal().name;
  reviseMeal();
  assert(modal().textContent.includes('answers here in the app'), modal().textContent);
  assert(!modal().textContent.includes('↗'), 'no outside link');
  document.getElementById('ai-request').value = 'Make it vegetarian';
  sendToAi();
  eq(page, 'chat');
  eq(bridgeCalls('sendToAiApp').length, 0, 'stays in the app');
  let prompt = aiBody().messages[0].content;
  assert(prompt.includes('"mealkeeper_id":"1"') && prompt.includes('save_meal') && !prompt.includes('Ready to copy'), prompt);
  let bubble = main().querySelector('.bubble.user');
  assert(bubble.textContent.includes('Make it vegetarian') && bubble.textContent.includes(name), 'shows the request and the meal');
  assert(!main().textContent.includes('mealkeeper_id'), 'not the JSON');
  streamAi(claudeReply('Done.', {...TEST_MEAL, mealkeeper_id: '1', name: 'Veggie Italian supper'}));
  finishAi();
  eq(meals.length, count);
  eq(meals.find(m => m.id === 1).name, 'Veggie Italian supper');
  handleBack();
  eq(page, 'meal', 'back returns to the meal');
});

test('Ask AI, with a key, answers in the chat with the recipe behind the scenes', () => {
  connect('chatgpt');
  openMeal(1);
  let r = currentMeal().recipes[0];
  askAbout('recipe', 0);
  document.getElementById('ai-request').value = 'Can I make it ahead?';
  sendToAi();
  eq(page, 'chat');
  let input = aiBody().input;
  assert(input[0].content.includes(r.title) && input[0].content.includes('Can I make it ahead?'), 'prompt has the recipe');
  assert(!main().textContent.includes('Ingredients:'), 'the chat shows just the question');
  assert(main().querySelector('.bubble.user').textContent.includes(r.title), 'and what it is about');
});

test('without a key, Revise and Ask still hand off to the AI app', () => {
  openMeal(1);
  reviseMeal();
  document.getElementById('ai-request').value = 'Make it vegetarian';
  sendToAi();
  eq(bridgeCalls('sendToAiApp').length, 1);
  assert(bridgeCalls('sendToAiApp')[0][2].includes('Ready to copy'), 'hand-off prompt');
  eq(bridgeCalls('aiRequest').length, 0);
});

test('a refusal or an error leaves the conversation as it was and offers to try again', () => {
  connect('claude');
  say('hello');
  streamAi([{type: 'message_delta', delta: {stop_reason: 'refusal'}}, {type: 'message_stop'}]);
  finishAi();
  eq(chat.items.length, 0);
  eq(chat.messages.length, 0);
  assert(main().textContent.includes('declined'), main().textContent);
  main().querySelector('.chat-error button').click();
  eq(aiBody().messages, [{role: 'user', content: 'hello'}], 'retried');
  finishAi(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
  assert(main().textContent.includes("didn't accept your API key"), main().textContent);
  main().querySelector('.chat-error button').click();
  finishAi(-1, 'timeout');
  assert(main().textContent.includes("Couldn't reach Claude"), main().textContent);
  main().querySelector('.chat-error button').click();
  finishAi(400, '{"type":"error","error":{"type":"invalid_request_error","message":"model: not found"}}');
  assert(main().textContent.includes('model: not found'), 'shows the API\'s message');
});

test('invalid meal data from the AI is reported back to it, not saved', () => {
  connect('claude');
  let count = meals.length;
  say('Plan it');
  streamAi(claudeReply('Saving.', '{"name": "Brok'));
  finishAi();
  eq(meals.length, count);
  eq(chat.pending[0].is_error, true);
  assert(chat.pending[0].content.includes('cut off'), chat.pending[0].content);
  eq(chat.messages[1].content[2].input, {}, 'history keeps a valid object');
});

test('after a server-side fallback, the declined model\'s blocks before the marker aren\'t sent back', () => {
  connect('claude');
  say('hello');
  streamAi([
    {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
    {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'old'}},
    {type: 'content_block_start', index: 1, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: 'Partial '}},
    {type: 'content_block_start', index: 2, content_block: {type: 'fallback', from: {model: 'claude-opus-5-5'}, to: {model: 'claude-opus-5'}}},
    {type: 'content_block_start', index: 3, content_block: {type: 'thinking', thinking: ''}},
    {type: 'content_block_delta', index: 3, delta: {type: 'signature_delta', signature: 'new'}},
    {type: 'content_block_start', index: 4, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index: 4, delta: {type: 'text_delta', text: 'answer.'}},
    {type: 'message_delta', delta: {stop_reason: 'end_turn'}}]);
  finishAi();
  eq(chat.messages[1].content.map(b => b.type + (b.signature ? ':' + b.signature : '')), ['text', 'thinking:new', 'text']);
  assert(main().textContent.includes('Partial answer.'), 'shows all the text');
});

test('ChatGPT chat uses the Responses API and continues from the last response', () => {
  connect('chatgpt');
  let before = meals.length;
  say('Plan a lemony dinner');
  let r = lastAiRequest(), body = aiBody();
  eq([r[2], r[4], r[6]], ['chatgpt', '/v1/responses', '']);
  eq(body.model, 'gpt-6-sol');
  eq(body.stream, true);
  assert(body.instructions.includes('save_meal'), 'instructions');
  eq([body.tools[0].type, body.tools[0].name, body.tools[0].strict], ['function', 'save_meal', true]);
  assert(!('previous_response_id' in body), 'first message starts fresh');
  eq(body.input, [{role: 'user', content: 'Plan a lemony dinner'}]);
  streamAi(responsesReply('Saving it now.', TEST_MEAL, 'resp_1'));
  finishAi();
  eq(meals.length, before + 1);
  eq(chat.responseId, 'resp_1');
  assert(main().textContent.includes('Saving it now.') && main().textContent.includes('Added to your meals'), 'reply and card');
  say('Thanks');
  body = aiBody();
  eq(body.previous_response_id, 'resp_1');
  eq(body.input[0].type, 'function_call_output');
  eq(body.input[0].call_id, 'call_1');
  eq(body.input[1], {role: 'user', content: 'Thanks'});
  streamAi([{type: 'response.created', response: {id: 'resp_2'}}, {type: 'response.failed', response: {id: 'resp_2', error: {message: 'server error'}}}]);
  finishAi();
  eq(chat.responseId, 'resp_1', 'a failed reply doesn\'t move the conversation on');
  eq(chat.pending.length, 1, 'and the tool result is sent again next time');
});

test('Grok uses xAI\'s Responses API, without OpenAI\'s strict mode', () => {
  connect('grok');
  say('hi');
  let r = lastAiRequest(), body = aiBody();
  eq([r[2], r[4]], ['grok', '/v1/responses']);
  eq(body.model, 'grok-4.7');
  assert(!('strict' in body.tools[0]), 'no strict');
  // xAI rejects instructions together with previous_response_id: the system prompt goes in the first input only.
  assert(!('instructions' in body), 'no instructions field');
  eq(body.input[0].role, 'system');
  assert(body.input[0].content.includes('save_meal'), 'system prompt');
  eq(body.input[1], {role: 'user', content: 'hi'});
  streamAi(responsesReply('Hello!', null, 'resp_1'));
  finishAi();
  say('Plan dinner');
  body = aiBody();
  eq(body.previous_response_id, 'resp_1');
  assert(!('instructions' in body), 'still no instructions');
  eq(body.input, [{role: 'user', content: 'Plan dinner'}]);
  streamAi([{type: 'response.created', response: {id: 'r'}}, {type: 'response.output_text.delta', delta: 'Hello!'}]);
  finishAi();
  assert(main().textContent.includes('was cut off'), 'a reply that never completed is an error');
});

test('stopping a reply cancels it and puts the message back in the box', () => {
  connect('claude');
  say('hello there');
  let id = lastAiRequest()[1];
  main().querySelector('.composer .send').click();
  eq(bridgeCalls('aiCancel')[0][1], id);
  eq(chat.items.length, 0);
  eq(document.getElementById('chat-input').value, 'hello there');
  window.onAiDone(id, -1, 'cancelled');
  assert(!chatError, 'a late finish is ignored');
});

test('the chat and chosen models are saved and come back after a restart', () => {
  connect('claude');
  aiModels.claude = 'claude-sonnet-5-5';
  say('hello');
  streamAi(claudeReply('Hi! What are we cooking?'));
  finishAi();
  let saved = JSON.parse(localStorage.getItem(STORE_KEY));
  chat = null;
  aiModels = {};
  applyState(saved);
  eq(chat.items.map(i => i.role), ['user', 'assistant']);
  eq(chat.messages.length, 2);
  eq(aiModel('claude'), 'claude-sonnet-5-5');
  go('chat');
  assert(main().textContent.includes('What are we cooking?'), 'shown again');
});

test('Send to pan asks the AI to save, and Responses API AIs must call save_meal', () => {
  connect('grok');
  say('Ideas for a salad?');
  assert(!main().querySelector('.chat-to-pan'), 'not while the AI is replying');
  streamAi(responsesReply('Try an apple-celery slaw.', null, 'resp_1'));
  finishAi();
  let before = meals.length;
  main().querySelector('.chat-to-pan').click();
  let body = aiBody();
  eq(body.tool_choice, 'required');
  assert(body.input[0].content.includes('save_meal'), 'asks for save_meal');
  assert(main().textContent.includes('Send it to the pan'), 'shown as the user\'s message');
  streamAi(responsesReply('Saved!', TEST_MEAL, 'resp_2'));
  finishAi();
  eq(meals.length, before + 1);
  assert(!main().querySelector('.chat-to-pan'), 'not under a saved meal');
  say('Thanks');
  assert(!('tool_choice' in aiBody()), 'ordinary messages leave it to the AI');
  finishAi(500, '{}');
  assert(!main().querySelector('.chat-to-pan'), 'not under an error');
});

test('Claude only gets asked to save: it can\'t be forced to use a tool while thinking', () => {
  connect('claude');
  say('hello');
  streamAi(claudeReply('Hi!'));
  finishAi();
  sendToPan();
  let body = aiBody();
  assert(!('tool_choice' in body), 'no tool_choice');
  assert(body.messages[2].content.includes('save_meal'), 'asks for save_meal');
});

test('Close asks first, then clears the chat and goes back', () => {
  connect('claude');
  go('meals');
  say('hello');
  streamAi(claudeReply('Hi!'));
  finishAi();
  main().querySelector('button[onclick="confirmCloseChat()"]').click();
  assert(modalOpen() && modal().textContent.includes('Close this chat?'), 'asks');
  closeModal();
  eq(chat.items.length, 2, 'cancel keeps it');
  confirmCloseChat();
  closeChat();
  eq(chat, null);
  eq(page, 'meals');
  assert(!modalOpen(), 'dialog closed');
  go('chat');
  assert(main().textContent.includes('Brainstorm a meal'), 'starts fresh');
});

test('Report on a reply opens an email with the reply in it', () => {
  connect('claude');
  say('hello');
  streamAi(claudeReply('Hi! What are we cooking?'));
  finishAi();
  opened = [];
  let buttons = main().querySelectorAll('.chat-report');
  eq(buttons.length, 1, 'only the AI reply has one');
  buttons[0].click();
  let url = opened[0];
  assert(url.startsWith('mailto:prompttopan.support@gmail.com?'), url);
  let body = decodeURIComponent(url.split('&body=')[1]);
  assert(body.includes('Claude (claude-opus-5-5)') && body.includes('Hi! What are we cooking?'), body);
  chat.items[1].text = 'x'.repeat(5000);
  opened = [];
  reportReply(1);
  assert(decodeURIComponent(opened[0]).length < 2000, 'a long reply is cut short');
});

test('chat replies get simple formatting and never raw markup', () => {
  let div = document.createElement('div');
  div.innerHTML = chatHtml('**Menu** for *two*\n- Soup\n- Bread <img src=x onerror="window.pwned=1">\n1. First\n```\n<b>code</b>\n```');
  eq(div.querySelector('strong').textContent, 'Menu');
  eq(div.querySelector('em').textContent, 'two');
  eq([...div.querySelectorAll('ul li')].map(li => li.textContent), ['Soup', 'Bread <img src=x onerror="window.pwned=1">']);
  eq(div.querySelectorAll('ol li').length, 1);
  eq(div.querySelector('pre').textContent, '<b>code</b>');
  assert(!div.querySelector('img, b'), 'escaped');
});

test('the meal schema meets OpenAI strict mode: closed objects with every field required', () => {
  let walk = (s, path) => {
    if (s.type === 'object') {
      eq(s.additionalProperties, false, path);
      eq(s.required.slice().sort(), Object.keys(s.properties).sort(), path);
      Object.entries(s.properties).forEach(([k, v]) => walk(v, `${path}.${k}`));
    }
    if (s.type === 'array') walk(s.items, `${path}[]`);
  };
  walk(MEAL_SCHEMA, 'meal');
  let meal = fromV1Meal(TEST_MEAL, 0);
  eq(meal.recipes[0].title, 'Lemon roast chicken', 'the app reads what the schema describes');
});

// ---- Report ----

reset();
let failed = results.filter(r => !r.ok);
results.forEach(r => console.log(`MKTEST ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' -- ' + r.error}`));
console.log(`MKTEST DONE ${results.length} tests, ${failed.length} failed`);
document.body.innerHTML = `<pre style="padding:16px;white-space:pre-wrap">${escapeHtml(results.map(r =>
  `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : '\n     ' + r.error}`).join('\n'))}\n\n${results.length} tests, ${failed.length} failed</pre>`;
