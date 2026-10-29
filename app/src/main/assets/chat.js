// In-app chat with Claude, ChatGPT or Grok through the user's own API key (Settings → AI accounts).
// MainActivity keeps the keys and makes the HTTPS calls (AiApi.kt); this file builds each request, reads the streamed
// reply and keeps the conversation. When the AI calls save_meal, the meal goes straight into the app: no JSON to copy.
// Loaded before app.js, so it only uses app.js's functions and constants when called, never at load time.

// Claude uses Anthropic's Messages API; ChatGPT and Grok use the Responses API (OpenAI's, which xAI also offers).
// model is the default until the user picks one from the account's model list.
const AI_APIS = {
  claude: {provider: 'Anthropic', format: 'messages', model: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…'},
  chatgpt: {provider: 'OpenAI', format: 'responses', model: 'gpt-6-sol', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…'},
  grok: {provider: 'xAI', format: 'responses', model: 'grok-4.7', keyUrl: 'https://console.x.ai/', keyHint: 'xai-…'}
};

// Which models from an account's /v1/models list can chat (OpenAI's list includes speech, image and embedding models).
const CHAT_MODELS = {
  claude: id => /^claude-/.test(id),
  chatgpt: id => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|live|transcribe|tts|image|search|embedding|moderation|instruct|cyber|daybreak|rosalind)/.test(id),
  grok: id => /^grok-/.test(id) && !/(image|imagine|vision|video)/.test(id)
};

// Claude models that take output_config.effort, and those with a server-side fallback when a safety classifier
// declines (fallbacks: "default", which needs the beta header).
const CLAUDE_EFFORT = /^claude-(opus-5|sonnet-5|fable-5|haiku-5)/;
const CLAUDE_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5-1)/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Where Report sends a reply (see reportReply), and how much of the reply goes in the email.
const REPORT_EMAIL = 'prompttopan.support@gmail.com';
const REPORT_MAX = 1500;

const CHAT_STARTERS = ['Plan a cozy Sunday dinner for 4', 'What can I make with chicken thighs and leeks?', 'A quick vegetarian weeknight meal', 'Help me plan a dinner party menu'];

let aiKeys = {},         // which AIs have a key saved (the keys themselves stay in MainActivity)
  aiModels = {},         // the model chosen for each AI (saved)
  aiModelLists = {},     // models each account offers, loaded when its key is saved (saved)
  chat = null,           // the conversation (saved); see newChat()
  chatTurn = null,       // the reply being streamed
  chatError = null,      // {text, retry}: shown under the conversation until the next send
  chatDraft = '';        // what's in the message box, kept across re-renders

function chatSystem() {
  return `You're the cooking assistant inside Prompt to Pan, an Android app where people plan meals with you and then cook from the recipes, shopping list and timeline. The user is on their phone, so keep replies short and conversational: a few sentences or a short list, no tables. Help them brainstorm and refine meals, and answer cooking questions.

When the user settles on a meal, or asks you to save it, add it or "send it to the pan", call save_meal with the complete meal. Don't paste the meal as JSON or write out the full recipes first: the app shows the saved meal itself. A short sentence before the call is fine.

To change a meal that's already saved, call save_meal with its mealkeeper_id so the app updates it instead of adding a copy.

Meal rules:
${MEAL_RULES}`;
}

// ---- The save_meal tool ----

const nullable = type => ({type: [type, 'null']});

// One meal in the mealkeeper-v1 format (see EXPORT_FORMAT in app.js). Every field is required, with null for
// unknowns, which OpenAI's strict mode needs; the app cleans whatever arrives anyway (fromV1Meal).
const MEAL_SCHEMA = (() => {
  let object = props => ({type: 'object', additionalProperties: false, required: Object.keys(props), properties: props});
  return object({
    mealkeeper_id: {...nullable('string'), description: 'The id of the saved meal being changed, or null for a new meal'},
    name: {type: 'string'},
    description: {type: 'string'},
    servings: nullable('number'),
    total_time: {type: 'string', description: 'e.g. "1 hr 15 min"'},
    recipes: {type: 'array', items: object({
      id: {type: 'string', description: 'Short id, e.g. "roast-chicken"'},
      title: {type: 'string'},
      course: {type: 'string', description: 'e.g. Starter, Main, Side, Dessert'},
      servings: nullable('number'),
      prep_time_minutes: nullable('number'),
      cook_time_minutes: nullable('number'),
      total_time_minutes: nullable('number'),
      ingredients: {type: 'array', items: object({name: {type: 'string'}, quantity: nullable('number'), unit: nullable('string'), notes: nullable('string')})},
      instructions: {type: 'array', items: {type: 'string'}},
      make_ahead_notes: nullable('string'),
      source: nullable('string')
    })},
    shopping_list: {type: 'array', items: object({
      name: {type: 'string'}, quantity: nullable('number'), unit: nullable('string'),
      category: {type: 'string', description: 'Store section, e.g. Produce'},
      used_in: {type: 'array', items: {type: 'string'}, description: 'Recipe ids'}
    })},
    timeline: {type: 'array', items: object({
      start_offset_minutes: {type: 'number', description: 'Minutes after cooking starts'},
      duration_minutes: nullable('number'),
      task: {type: 'string'},
      recipe_id: nullable('string'),
      instructions: nullable('string')
    })}
  });
})();

const SAVE_MEAL = {
  name: 'save_meal',
  description: 'Saves a complete meal (its recipes, shopping list and cooking timeline) to the user\'s Prompt to Pan app, or updates a saved meal when mealkeeper_id is set.'
};

// Claude streams the tool's input as it's written (eager_input_streaming), so the app validates it itself.
function claudeTool() {
  return {...SAVE_MEAL, input_schema: MEAL_SCHEMA, eager_input_streaming: true};
}

function responsesTool(ai) {
  return {type: 'function', ...SAVE_MEAL, parameters: MEAL_SCHEMA, ...(ai === 'chatgpt' ? {strict: true} : {})};
}

// Adds the meal, or updates the one with the same mealkeeper_id (only the id: a new meal that happens to share a
// name with a saved one is added, not swapped in silently). Returns the text the AI gets back.
function saveMealFromAi(input) {
  let v1 = obj(input);
  if (!str(v1.name).trim() || !arr(v1.recipes).length) return {error: 'Not saved: the meal needs a name and at least one recipe. Call save_meal again with the complete meal.'};
  let fresh = fromV1Meal(v1, 0), id = num(v1.mealkeeper_id), target = id !== null && meals.find(m => m.id === id);
  if (target) {
    updateMeal(target, fresh, v1);
    bringToFront(target);
  } else {
    meals.unshift(fresh);
  }
  let meal = target || fresh;
  selectedMeal = meal.id;
  chat.items.push({role: 'meal', id: meal.id, name: meal.name, updated: !!target});
  saveState();
  notify(`${target ? 'Updated' : 'Added'} “${meal.name}”`);
  return {text: `Saved "${meal.name}" in the app${target ? ', replacing the earlier version' : ''}. Its mealkeeper_id is "${meal.id}"; use it with save_meal to change this meal.`};
}

function runTool(name, input) {
  if (name !== 'save_meal') return {error: `There's no tool called ${name}.`};
  if (input === undefined) return {error: 'Not saved: the meal data was cut off or wasn\'t valid JSON. Call save_meal again.'};
  return saveMealFromAi(input);
}

// ---- Calls through MainActivity ----

const aiCalls = {};
let aiCallCount = 0;

function hasApi() {
  return !!(window.MealkeeperAndroid && window.MealkeeperAndroid.aiRequest);
}

function hasKey(ai) {
  return hasApi() && !!aiKeys[ai];
}

function hasAnyKey() {
  return Object.keys(AI_APIS).some(hasKey);
}

// API keys stay encrypted on this phone (AiApi.kt), so backups leave them out; saving and restoring a backup say so.
const KEYS_NOT_BACKED_UP = 'Your AI API keys aren\'t in backups: they\'re locked to this phone. After a reinstall or on a new phone you\'ll add them again, so keep a copy of each key somewhere safe, like a password manager.';

function refreshAiKeys() {
  try {
    aiKeys = hasApi() ? JSON.parse(window.MealkeeperAndroid.aiKeys()) || {} : {};
  } catch (e) {
    aiKeys = {};
  }
}

function aiModel(ai) {
  return aiModels[ai] || AI_APIS[ai].model;
}

// onEvents gets each batch of streamed events (parsed); onDone(status, body) runs once at the end (see AiApi.kt).
function aiCall(ai, method, path, body, beta, onEvents, onDone) {
  let id = `ai${++aiCallCount}-${Date.now()}`;
  aiCalls[id] = {onEvents, onDone};
  window.MealkeeperAndroid.aiRequest(id, ai, method, path, body ? JSON.stringify(body) : '', beta || '');
  return id;
}

function cancelAiCall(id) {
  delete aiCalls[id];
  if (hasApi()) window.MealkeeperAndroid.aiCancel(id);
}

window.onAiEvents = function(id, events) {
  let call = aiCalls[id];
  if (!call || !call.onEvents) return;
  call.onEvents(events.map(e => {
    try {
      return JSON.parse(e)
    } catch (x) {
      return null
    }
  }).filter(Boolean));
};

window.onAiDone = function(id, status, body) {
  let call = aiCalls[id];
  if (!call) return;
  delete aiCalls[id];
  call.onDone(status, body);
};

function apiErrorMessage(ai, status, body) {
  let name = AI_GUIDES[ai].name, detail = '';
  try {
    let e = obj(JSON.parse(body)).error;
    detail = typeof e === 'string' ? e : str(obj(e).message)
  } catch (x) {}
  if (status === 0) return `Add your ${name} API key first (Settings → AI accounts).`;
  if (status === -1) return `Couldn't reach ${name}. Check your internet connection and try again.`;
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))) return `${name} didn't accept your API key. Check it in Settings → AI accounts.`;
  if (status === 429) return `${name} says you've hit a rate or spending limit. ${detail}`.trim();
  if (status === 529 || status === 503) return `${name} is busy right now. Try again in a moment.`;
  return `${name} returned an error (${status}). ${detail}`.trim();
}

// ---- API keys and models ----

function keyModal(ai) {
  let api = AI_APIS[ai], name = AI_GUIDES[ai].name;
  openModal(`<div class="eyebrow">CONNECT ${name.toUpperCase()}</div><h2>Add your ${name} API key</h2><p class="subhead">Chat with ${name} right here: meals it plans go straight into the app. Use goes on your ${api.provider} API account, which is separate from a ${name} app subscription.</p><button class="text-btn" onclick="openUrl('${api.keyUrl}')">Get a key from ${api.provider} ↗</button><input id="ai-key" class="field" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${api.keyHint}" style="margin-top:12px"><p id="ai-key-status" class="muted small" style="margin:10px 0 0">The key is stored encrypted on this phone and isn't included in backups.</p><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary" onclick="saveAiKey('${ai}')">Save key</button></div>`);
  setTimeout(() => document.getElementById('ai-key') && document.getElementById('ai-key').focus(), 50);
}

function saveAiKey(ai) {
  let field = document.getElementById('ai-key'), status = document.getElementById('ai-key-status'), name = AI_GUIDES[ai].name;
  if (!field || !field.value.trim()) return;
  if (!window.MealkeeperAndroid.setAiKey(ai, field.value)) {
    status.textContent = 'That doesn\'t look like an API key.';
    return;
  }
  aiKeys[ai] = true;
  status.textContent = `Checking the key with ${name}…`;
  loadModels(ai, code => {
    // The check is a plain GET, so a 400 means the key too (xAI answers a bad key with 400, not 401).
    if (code === 400 || code === 401 || code === 403) {
      window.MealkeeperAndroid.clearAiKey(ai);
      aiKeys[ai] = false;
      if (document.getElementById('ai-key-status')) document.getElementById('ai-key-status').textContent = `${name} didn't accept that key. Check that you copied all of it.`;
      return;
    }
    closeModal();
    render();
    notify(code === 200 ? `${name} is connected` : `Key saved, but ${name} couldn't be reached to check it.`);
  });
}

function confirmRemoveKey(ai) {
  let name = AI_GUIDES[ai].name;
  openModal(`<div class="eyebrow">AI ACCOUNTS</div><h2>Remove your ${name} key?</h2><p class="subhead">Chat with ${name} stops working here until you add a key again. Your meals and chats stay.</p><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary danger-fill" onclick="removeAiKey('${ai}')">Remove key</button></div>`);
}

function removeAiKey(ai) {
  window.MealkeeperAndroid.clearAiKey(ai);
  aiKeys[ai] = false;
  closeModal();
  render();
  notify(`${AI_GUIDES[ai].name} key removed`);
}

// Loads the models the account offers; keeps the user's choice if it's still offered, else picks the default.
function loadModels(ai, done) {
  aiCall(ai, 'GET', '/v1/models', null, '', null, (status, body) => {
    let ids = [];
    if (status === 200) try {
      ids = arr(obj(JSON.parse(body)).data).map(m => str(obj(m).id)).filter(CHAT_MODELS[ai])
    } catch (e) {}
    if (ids.length) {
      let preferred = AI_APIS[ai].model;
      ids.sort((a, b) => (b === preferred) - (a === preferred) || b.localeCompare(a, undefined, {numeric: true}));
      aiModelLists[ai] = ids;
      if (!ids.includes(aiModel(ai))) aiModels[ai] = ids[0];
      saveState();
    }
    if (done) done(status);
  });
}

function setAiModel(ai, model) {
  aiModels[ai] = model;
  saveState();
  notify(`${AI_GUIDES[ai].name} will use ${model}`);
}

// Settings panel: one row per AI.
function aiAccountsPanel() {
  if (!hasApi()) return '';
  let rows = Object.keys(AI_APIS).map(ai => {
    let name = AI_GUIDES[ai].name, models = aiModelLists[ai] || [aiModel(ai)];
    if (!hasKey(ai)) return `<div class="spread" style="flex-wrap:nowrap"><div><strong>${name}</strong><div class="muted small" style="margin-top:4px">Not connected</div></div><button class="secondary" onclick="keyModal('${ai}')">Add key</button></div>`;
    return `<div class="spread" style="flex-wrap:nowrap"><div><strong>${name}</strong><div class="muted small" style="margin-top:4px">Connected with your ${AI_APIS[ai].provider} key</div></div><button class="outline danger" onclick="confirmRemoveKey('${ai}')">Remove</button></div><select class="field" style="margin-top:10px" aria-label="${name} model" onchange="setAiModel('${ai}', this.value)">${models.map(m => `<option value="${escapeHtml(m)}" ${m === aiModel(ai) ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select>`;
  }).join('<div class="divider"></div>');
  return `<div class="panel"><div class="row"><div class="recipe-icon">⚿</div><div style="flex:1"><strong>AI accounts</strong><div class="muted small" style="margin-top:4px">Chat with your AI inside Prompt to Pan using your own API key. You pay the provider for what you use; app subscriptions like ChatGPT Plus or Claude Pro don't include it.</div></div></div><div class="divider"></div>${rows}</div>`;
}

// ---- The conversation ----

// messages: Claude's conversation in Messages API form. responseId: where a Responses API conversation left off
// (the provider keeps the history). pending: results of the AI's tool calls, sent along with the next message.
function newChat(ai) {
  if (chatTurn) stopChat();
  chat = {ai, items: [], messages: [], responseId: null, pending: []};
  chatError = null;
}

// Ends the conversation (meals it saved stay) and goes back to where the user came from.
function confirmCloseChat() {
  openModal(`<div class="eyebrow">CHAT</div><h2>Close this chat?</h2><p class="subhead">The conversation is cleared from the app. Meals it saved stay in your meals.</p><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary" onclick="closeChat()">Close chat</button></div>`);
}

function closeChat() {
  closeModal();
  if (chatTurn) stopChat();
  chat = null;
  chatError = null;
  chatDraft = '';
  handleBack();
}

// Send to pan: asks the AI to save the meal now. The AIs sometimes say they're saving without calling save_meal,
// so on the Responses API the call is required. Claude can't be made to call a tool while it's thinking, so it only
// gets the request.
function sendToPan() {
  if (!chat || chatTurn) return;
  sendChat('Send it to the pan', 'Save the meal we\'ve settled on to the app now: call save_meal with the complete meal. If we haven\'t settled on one, save your best version of what we\'ve talked about.', '', true);
}

// Starts a conversation from Ask AI or Revise with AI: the chat shows `text`, the AI also gets `prompt`.
function startChat(text, prompt, about) {
  newChat(myAi);
  go('chat');
  sendChat(text, prompt, about);
}

function planWithAi() {
  go(hasKey(myAi) ? 'chat' : 'ai');
}

function sendFromComposer() {
  let field = document.getElementById('chat-input'),
    text = (field ? field.value : chatDraft).trim();
  if (!text || chatTurn) return;
  chatDraft = '';
  if (!chat || !hasKey(chat.ai)) newChat(myAi);
  sendChat(text, text);
}

function sendChat(text, prompt, about, mustSave) {
  let ai = chat.ai, api = AI_APIS[ai], model = aiModel(ai), path, body;
  chatError = null;
  if (voiceState === 'listening') endVoice();
  chat.items.push({role: 'user', text, about: about || ''});
  let turn = {ai, format: api.format, text: '', blocks: [], calls: [], stop: null, error: null, writing: false, retry: {text, prompt, about, mustSave}};
  if (api.format === 'messages') {
    turn.message = {role: 'user', content: chat.pending.length ? [...chat.pending, {type: 'text', text: prompt}] : prompt};
    path = '/v1/messages';
    body = {model, max_tokens: 64000, stream: true, system: chatSystem(), tools: [claudeTool()], messages: chat.messages.concat([turn.message]), cache_control: {type: 'ephemeral'}};
    if (CLAUDE_EFFORT.test(model)) body.output_config = {effort: 'medium'};
    if (CLAUDE_FALLBACK.test(model)) body.fallbacks = 'default';
  } else {
    path = '/v1/responses';
    body = {model, stream: true, store: true, tools: [responsesTool(ai)], input: chat.pending.concat([{role: 'user', content: prompt}])};
    if (chat.responseId) body.previous_response_id = chat.responseId;
    if (mustSave) body.tool_choice = 'required';
    // OpenAI doesn't carry instructions over to the next response, so they're sent every time. xAI rejects
    // instructions alongside previous_response_id, so Grok gets them once, as a system message kept in the history.
    if (ai !== 'grok') body.instructions = chatSystem();
    else if (!chat.responseId) body.input.unshift({role: 'system', content: chatSystem()});
  }
  chatTurn = turn;
  turn.id = aiCall(ai, 'POST', path, body, body.fallbacks ? FALLBACK_BETA : '', events => {
    events.forEach(e => (api.format === 'messages' ? readMessagesEvent : readResponsesEvent)(turn, e));
    showLiveReply();
  }, (status, text) => finishTurn(turn, status, text));
  render();
}

// Anthropic Messages API stream: rebuilds the content blocks (thinking blocks are sent back unchanged next turn).
function readMessagesEvent(t, e) {
  let b = t.blocks[e.index], d = obj(e.delta);
  switch (e.type) {
    case 'content_block_start':
      t.blocks[e.index] = {...e.content_block};
      if (e.content_block.type === 'tool_use') {
        t.blocks[e.index].json = '';
        t.writing = true;
      }
      break;
    case 'content_block_delta':
      if (!b) break;
      if (d.type === 'text_delta') {
        b.text = (b.text || '') + d.text;
        t.text += d.text;
      } else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
      else if (d.type === 'input_json_delta') b.json += d.partial_json;
      break;
    case 'content_block_stop':
      if (b && b.type === 'tool_use') {
        try {
          b.input = b.json ? JSON.parse(b.json) : {}
        } catch (x) {
          b.input = undefined
        }
        delete b.json;
      }
      break;
    case 'message_delta':
      if (d.stop_reason) t.stop = d.stop_reason;
      break;
    case 'error':
      t.error = str(obj(e.error).message) || 'error';
  }
}

// Responses API stream (OpenAI and xAI).
function readResponsesEvent(t, e) {
  switch (e.type) {
    case 'response.output_text.delta':
      t.text += str(e.delta);
      break;
    case 'response.output_item.added':
      if (obj(e.item).type === 'function_call') t.writing = true;
      break;
    case 'response.output_item.done':
      if (obj(e.item).type === 'function_call') t.calls.push(e.item);
      break;
    case 'response.completed':
    case 'response.incomplete':
      t.responseId = str(obj(e.response).id);
      t.stop = e.type === 'response.completed' ? 'done' : str(obj(obj(e.response).incomplete_details).reason) || 'incomplete';
      break;
    case 'response.failed':
      t.error = str(obj(obj(e.response).error).message) || 'the request failed';
      break;
    case 'error':
      t.error = str(e.message || obj(e.error).message) || 'error';
  }
}

function turnProblem(t, status, body) {
  let name = AI_GUIDES[t.ai].name;
  if (status < 200 || status > 299) return apiErrorMessage(t.ai, status, body);
  if (t.error) return `${name} had a problem: ${t.error}`;
  if (t.stop === 'refusal') return `${name} declined to answer that. Try asking another way.`;
  if (t.stop === 'max_tokens' || t.stop === 'max_output_tokens') return 'The reply got too long and was cut off. Try asking for less at once.';
  if (t.format === 'messages' ? !t.stop : t.stop !== 'done') return `The reply from ${name} was cut off. Try again.`;
  return '';
}

function finishTurn(t, status, body) {
  if (chatTurn !== t) return;
  chatTurn = null;
  let problem = turnProblem(t, status, body), before = chat.items.length;
  if (t.format === 'messages') {
    let content = claudeContent(t.blocks);
    if (!problem && !content.length) problem = `${AI_GUIDES[t.ai].name} didn't reply. Try again.`;
    if (problem) return failTurn(t, problem);
    if (t.text.trim()) chat.items.push({role: 'assistant', text: t.text.trim()});
    chat.messages.push(t.message, {role: 'assistant', content});
    chat.pending = t.blocks.filter(b => b && b.type === 'tool_use' && content.some(c => c.id === b.id)).map(b => {
      let r = runTool(b.name, b.input);
      return {type: 'tool_result', tool_use_id: b.id, content: r.error || r.text, ...(r.error ? {is_error: true} : {})};
    });
  } else {
    if (problem) return failTurn(t, problem);
    if (t.text.trim()) chat.items.push({role: 'assistant', text: t.text.trim()});
    chat.responseId = t.responseId;
    chat.pending = t.calls.map(c => {
      let input;
      try {
        input = JSON.parse(c.arguments)
      } catch (e) {}
      let r = runTool(c.name, input);
      return {type: 'function_call_output', call_id: c.call_id, output: r.error || r.text};
    });
  }
  if (voiceOn) readAloud(chat.items.slice(before));
  render();
}

// The assistant's turn as it's sent back next time. After a server-side fallback, blocks the declined model wrote
// before the last fallback marker can't be replayed, except its text; the marker itself is dropped.
function claudeContent(blocks) {
  let boundary = blocks.map(b => b && b.type).lastIndexOf('fallback');
  return blocks.filter((b, i) => b && (i > boundary || b.type === 'text')).map(b => {
    if (b.type === 'text') return b.text ? {type: 'text', text: b.text} : null;
    if (b.type === 'thinking') return {type: 'thinking', thinking: b.thinking || '', signature: b.signature || ''};
    if (b.type === 'redacted_thinking') return {type: 'redacted_thinking', data: b.data};
    // Input that didn't parse is reported by runTool (see finishTurn); the history still needs an object.
    if (b.type === 'tool_use') return {type: 'tool_use', id: b.id, name: b.name, input: b.input === undefined ? {} : b.input};
    return null;
  }).filter(Boolean);
}

// A failed turn leaves the conversation as it was; the message can be sent again.
function failTurn(t, text) {
  let i = chat.items.length - 1;
  if (chat.items[i] && chat.items[i].role === 'user') chat.items.splice(i, 1);
  chatError = {text, retry: t.retry};
  endVoice();
  render();
}

function retryChat() {
  if (!chatError || chatTurn) return;
  let r = chatError.retry;
  sendChat(r.text, r.prompt, r.about, r.mustSave);
}

function stopChat() {
  let t = chatTurn;
  if (!t) return;
  chatTurn = null;
  cancelAiCall(t.id);
  let i = chat.items.length - 1;
  if (chat.items[i] && chat.items[i].role === 'user') chat.items.splice(i, 1);
  if (t.retry.text === t.retry.prompt) chatDraft = t.retry.text;
  if (page === 'chat') render();
}

// ---- Voice ----

// Talking instead of typing (Android only; see Voice.kt). The mic starts voice mode: what the user says is sent
// when they stop talking, the reply is read aloud, and then the mic opens again, so the conversation goes on
// hands-free. It ends with Stop, a pause with nothing said, or leaving the chat. The screen stays on meanwhile
// (see syncAwake in app.js).
let voiceOn = false,
  voiceState = '',       // 'listening' or 'speaking'
  voiceDraft = '',       // what was in the message box when the mic opened; what's heard is added to it
  canTalk = null;        // whether the phone has a speech recognizer (checked once)

const VOICE_ERRORS = {
  silence: 'Didn\'t hear anything. Tap the mic to talk.',
  denied: 'Prompt to Pan needs the microphone to hear you. You can allow it in Settings → Apps → Prompt to Pan → Permissions.',
  network: 'Couldn\'t reach the speech recognizer. Check your connection, or type instead.'
};

function hasVoice() {
  if (canTalk === null) canTalk = hasApi() && !!window.MealkeeperAndroid.voiceAvailable && window.MealkeeperAndroid.voiceAvailable();
  return canTalk;
}

// The mic button: opens the mic, cuts in on a reply being read out, or (while listening) sends what's been said.
function tapMic() {
  if (voiceState === 'listening') window.MealkeeperAndroid.voiceFinishListening();
  else startListening();
}

function startListening() {
  if (chatTurn || page !== 'chat') return endVoice();
  voiceOn = true;
  voiceState = 'listening';
  voiceDraft = chatDraft.trim();
  window.MealkeeperAndroid.voiceListen();
  render();
}

// Leaves voice mode; the caller re-renders.
function endVoice() {
  if (!voiceOn) return;
  voiceOn = false;
  voiceState = '';
  window.MealkeeperAndroid.voiceStop();
}

// The composer's Stop button: ends the reply being written and voice mode.
function stopTalking() {
  endVoice();
  if (chatTurn) stopChat();
  else render();
}

// Voice mode ends when the user leaves the chat.
function syncVoice() {
  if (voiceOn && page !== 'chat') endVoice();
}

// What's read out for a finished turn: the reply as plain text, and any meals it saved.
function readAloud(items) {
  let text = items.map(i => i.role === 'assistant' ? spokenText(i.text) : i.role === 'meal' ? `${i.updated ? 'Updated' : 'Added'} ${i.name}${i.updated ? '' : ' to your meals'}.` : '').filter(Boolean).join('\n');
  if (!text) return startListening();
  voiceState = 'speaking';
  window.MealkeeperAndroid.voiceSpeak(text);
}

function spokenText(text) {
  return text.replace(/```[\s\S]*?(```|$)/g, '').replace(/^\s*#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/[*`]/g, '');
}

function sizeComposer(field) {
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, 140)}px`;
}

// Events from Voice.kt (see the comment there).
window.onVoice = function(event, text) {
  if (!voiceOn) return;
  if (event === 'partial') {
    chatDraft = [voiceDraft, text].filter(Boolean).join(' ');
    let field = document.getElementById('chat-input');
    if (field) {
      field.value = chatDraft;
      sizeComposer(field);
    }
  } else if (event === 'result') {
    let message = [voiceDraft, text].filter(Boolean).join(' ');
    voiceState = '';
    if (chatTurn) return;
    chatDraft = '';
    if (!chat || !hasKey(chat.ai)) newChat(myAi);
    sendChat(message, message);
  } else if (event === 'spoken') {
    if (voiceState === 'speaking') startListening();
  } else if (event === 'error' || event === 'stopped') {
    voiceOn = false;
    voiceState = '';
    if (event === 'error') notify(VOICE_ERRORS[text] || 'Couldn\'t use the microphone. Try again.', text === 'denied' ? 6000 : 3500);
    if (page === 'chat') render();
  }
};

const MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function composerHtml(name) {
  let placeholder = voiceState === 'listening' ? 'Listening…' : voiceState === 'speaking' ? 'Reading it out… tap the mic to cut in' : `Message ${name}`,
    mic = hasVoice() && !chatTurn ? `<button class="outline send mic${voiceState === 'listening' ? ' listening' : ''}" aria-label="${voiceState === 'listening' ? 'Done talking' : 'Talk'}" onclick="tapMic()">${MIC_ICON}</button>` : '',
    action = chatTurn || voiceOn ? `<button class="primary send" aria-label="Stop" onclick="stopTalking()">■</button>` : `<button class="primary send" aria-label="Send" onclick="sendFromComposer()">➤</button>`;
  return `<div class="composer"><textarea id="chat-input" class="field" rows="1" placeholder="${escapeHtml(placeholder)}" oninput="chatDraft=this.value;sizeComposer(this)">${escapeHtml(chatDraft)}</textarea>${mic}${action}</div>`;
}

// ---- Chat screen ----

// A little Markdown: paragraphs, **bold**, *italic*, `code`, headings and lists. Everything is escaped first.
function chatHtml(text) {
  let out = [], list = null, code = null,
    inline = s => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>').replace(/`([^`]+)`/g, '<code>$1</code>'),
    closeList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map(x => `<li>${x}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
  for (let line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) {
        out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
        code = null;
      } else {
        closeList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    let m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/);
    if (m) {
      let tag = m[1] ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        closeList();
        list = {tag, items: []};
      }
      list.items.push(inline(m[2]));
      continue;
    }
    closeList();
    if ((m = line.match(/^#{1,6}\s+(.*)/))) out.push(`<p><strong>${inline(m[1])}</strong></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (code) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
  closeList();
  return out.join('');
}

// Google Play's AI-generated content policy asks for a way to report offensive replies from inside the app. Report
// opens an email with the reply in it; mailto links have length limits, so a long reply is cut short.
function reportReply(i) {
  let item = chat && chat.items[i];
  if (!item || item.role !== 'assistant') return;
  let reply = item.text.length > REPORT_MAX ? `${item.text.slice(0, REPORT_MAX)}…` : item.text,
    body = `What's wrong with this reply?\n\n\n---\nAI: ${AI_GUIDES[chat.ai].name} (${aiModel(chat.ai)})\nReply:\n${reply}`;
  openUrl(`mailto:${REPORT_EMAIL}?subject=${encodeURIComponent('Report an AI reply')}&body=${encodeURIComponent(body)}`);
}

function chatItemHtml(item, i) {
  if (item.role === 'user') return `<div class="bubble user">${item.about ? `<div class="bubble-about">✧ ${escapeHtml(item.about)}</div>` : ''}${escapeHtml(item.text)}</div>`;
  if (item.role === 'assistant') return `<div class="bubble ai">${chatHtml(item.text)}</div><button class="text-btn chat-report" onclick="reportReply(${i})">Report</button>`;
  let m = meals.find(x => x.id === item.id);
  let changed = keeperChanges(m).length,
    keeperNote = changed ? `<div class="divider"></div><div class="spread" style="flex-wrap:nowrap"><span class="muted small">★ ${changed === 1 ? 'A keeper' : `${changed} keepers`} changed in this version</span><button class="outline" onclick="offerKeeperUpdates(${m.id})">Review</button></div>` : '';
  return `<div class="panel meal-saved"><div class="row"><div class="recipe-icon">✓</div><div style="flex:1;min-width:0"><strong>${item.updated ? 'Updated' : 'Added to your meals'}</strong><div class="muted small" style="margin-top:4px">${escapeHtml(m ? m.name : item.name)}${m ? ` · ${m.recipes.length} recipes` : ' (since deleted)'}</div></div>${m ? `<button class="secondary" onclick="openMeal(${m.id})">Open</button>` : ''}</div>${keeperNote}</div>`;
}

function liveReplyHtml() {
  let t = chatTurn;
  if (!t) return '';
  let status = t.writing ? 'Writing up the meal…' : t.text ? '' : 'Thinking…';
  return `${t.text ? `<div class="bubble ai">${chatHtml(t.text)}</div>` : ''}${status ? `<div class="chat-status"><span class="dots"><i></i><i></i><i></i></span>${status}</div>` : ''}`;
}

function showLiveReply() {
  let live = document.getElementById('chat-live');
  if (!live) return;
  let atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  live.innerHTML = liveReplyHtml();
  if (atEnd) scrollChatToEnd();
}

function scrollChatToEnd() {
  window.scrollTo(0, document.body.scrollHeight);
}

function chatPage() {
  let ai = chat ? chat.ai : myAi, name = AI_GUIDES[ai].name;
  if (!hasApi()) return `<div class="eyebrow">CHAT</div><h1 class="headline">Chat with your AI</h1><div class="panel"><strong>Continue in ${name}</strong><p class="muted small" style="line-height:1.5;margin:6px 0 12px">This web version opens ${name} in a separate tab. Bring a meal back with Import recipes. In-app API-key chat is available in the Android app.</p><div class="actions"><button class="primary" onclick="openAi('${ai}')">Open ${name} ↗</button><button class="secondary" onclick="go('ai')">Plan with AI</button></div></div>`;
  let head = `<div class="spread" style="align-items:flex-start;flex-wrap:nowrap"><div><div class="eyebrow">CHAT WITH ${name.toUpperCase()}</div><h1 class="headline">Plan it here</h1></div>${chat && chat.items.length ? `<button class="outline" onclick="confirmCloseChat()">✕ Close</button>` : ''}</div>`;
  if (!hasKey(ai)) return `${head}<div class="panel"><strong>Connect ${name} to chat here</strong><p class="muted small" style="line-height:1.5;margin:6px 0 12px">With your own ${AI_APIS[ai].provider} API key, ${name} plans meals right in Prompt to Pan and they land in your meals, no copying. Or keep using the ${name} app: see Plan with AI.</p><div class="actions"><button class="primary" onclick="keyModal('${ai}')">Add API key</button><button class="secondary" onclick="go('ai')">Plan with AI</button></div></div>`;
  let items = chat ? chat.items : [],
    intro = items.length || chatTurn ? '' : `<p class="subhead">Brainstorm a meal with ${name}. When it's right, say “save it” and it goes straight into your meals.</p><div class="actions" style="margin-bottom:18px">${CHAT_STARTERS.map(s => `<button class="outline chip" onclick="chatDraft=this.textContent;sendFromComposer()">${escapeHtml(s)}</button>`).join('')}</div>`,
    last = items[items.length - 1],
    toPan = last && last.role === 'assistant' && !chatTurn && !chatError ? `<button class="secondary chat-to-pan" onclick="sendToPan()">Send to pan →</button>` : '',
    error = chatError ? `<div class="chat-error"><div>${escapeHtml(chatError.text)}</div><button class="text-btn" onclick="retryChat()">Try again</button></div>` : '';
  return `${head}${intro}<div class="chat-log">${items.map(chatItemHtml).join('')}<div id="chat-live">${liveReplyHtml()}</div>${error}${toPan}</div>
${composerHtml(name)}`;
}

// ---- Saved state ----

function chatState() {
  return {aiModels, aiModelLists, chat};
}

function applyChatState(s) {
  if (s.aiModels && typeof s.aiModels === 'object') Object.keys(AI_APIS).forEach(ai => {
    if (str(s.aiModels[ai])) aiModels[ai] = s.aiModels[ai]
  });
  if (s.aiModelLists && typeof s.aiModelLists === 'object') Object.keys(AI_APIS).forEach(ai => {
    if (Array.isArray(s.aiModelLists[ai])) aiModelLists[ai] = s.aiModelLists[ai].map(str).filter(Boolean)
  });
  let c = obj(s.chat);
  if (c.ai in AI_APIS) chat = {
    ai: c.ai,
    items: arr(c.items).map(obj).filter(x => ['user', 'assistant', 'meal'].includes(x.role)),
    messages: arr(c.messages),
    responseId: str(c.responseId) || null,
    pending: arr(c.pending)
  };
}

refreshAiKeys();
