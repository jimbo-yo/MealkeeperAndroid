# Prompt to Pan

Prompt to Pan is the cooking side of planning meals with AI: brainstorm a meal with Claude, ChatGPT or Grok, either in the app's own chat (with your API key) or in the AI's app, and cook from its recipes, shopping list and timeline.

The app was originally called Mealkeeper. Internal names (the `mealkeeper-v1` format and `mealkeeper_id`, storage keys, the `MealkeeperAndroid` JavaScript bridge, `Theme.Mealkeeper`) keep that name so saved data, backups and earlier AI exports still work. The app ID and Kotlin package are `com.jimboyo.prompttopan`; builds from before the rename used `com.example.mealkeeper` and install as a separate app, so move meals across with a backup.

## Open it

1. Extract `MealkeeperAndroid.zip`.
2. Open Android Studio.
3. Choose **Open** and select the extracted `MealkeeperAndroid` folder.
4. Allow Gradle sync to finish. If prompted, install Android SDK Platform 36 and use JDK 17.
5. Select an emulator or connected Android device and press **Run**.

The first Gradle sync needs internet access to download the Android Gradle Plugin and Kotlin plugin.

## Project structure

- `app/src/main/java/com/jimboyo/prompttopan/MainActivity.kt` — Android Activity: hosts the WebView, edge-to-edge insets, the `MealkeeperAndroid` JavaScript bridge (keep-awake, sharing, backup files) and the back button.
- `app/src/main/java/com/jimboyo/prompttopan/AiApi.kt` — the user's AI API keys (encrypted with the Android Keystore, left out of backups) and the HTTPS calls that use them.
- `app/src/main/assets/` — the app's UI, loaded from `file:///android_asset/index.html`:
  - `index.html` — page shell (top bar, bottom nav, modal, toast).
  - `app.css` — styles (phone layout; light and dark).
  - `app.js` — app logic, grouped into sections: state, helpers, meal data and import, saving and backups, navigation, screens, actions.
  - `chat.js` — the in-app chat with Claude, ChatGPT or Grok, and the `save_meal` tool that puts meals straight into the app.
  - `demo-data.js` — demo meals for first launch and the example `mealkeeper-v1` export used in the AI prompt.
- `app/src/main/res/` — theme (with a night variant) and the adaptive launcher icon.
- `app/src/test/web/` — browser tests for `app.js`, plus a fake Android bridge.
- `scripts/run-web-tests.sh` — runs those tests in headless Firefox.

## Tests

```
scripts/run-web-tests.sh          # prints PASS/FAIL per test; exits non-zero on failure
scripts/run-web-tests.sh --keep   # also keeps the test page so you can open it in a browser to debug
```

The tests load the real `index.html` with `fake-android.js` before `app.js` and `tests.js` after it. They need Firefox installed. You can also open the page in a browser without Android: the app falls back to browser features (downloads, file picker, clipboard) where the bridge is missing.

## Current behavior and limitations

- The interface is bundled locally. The only network use is the in-app chat, and only after the user adds an API key.
- **Set alarm** on the timeline opens the Clock app's new-alarm screen (`AlarmClock.ACTION_SET_ALARM`) filled in for when cooking starts, labelled with the meal.
- The screen stays on (`FLAG_KEEP_SCREEN_ON`) while a cooking timeline or recipe is open; Settings can turn that off or keep the screen on all the time.
- The app draws edge-to-edge with transparent system bars. **Settings → Appearance** chooses Light (linen, the default), Dark (soft olive) or Match phone: the page sets `data-theme` on `<html>` and its colours come from the theme variables at the top of `app.css`; `MainActivity` matches the system bar icons and window background. It passes the status-bar, navigation-bar and keyboard heights to the page as `--android-safe-top`, `--android-safe-bottom` and `--android-ime-bottom`.
- The app name is set in Space Mono Bold ("Prompt", with a blinking cursor; SIL OFL 1.1) and Satisfy ("to Pan"; Apache 2.0), both bundled in `assets/fonts/`.
- The WebView only runs the bundled page; any other link opens in the browser. File and content access are off.
- Meal collections, shopping-list check marks, and the keep-awake setting are saved in the WebView's `localStorage` on the device. **Settings → Backup & restore** exports them to a JSON file (`mealkeeper-backup-v1`) through the Android file picker and restores them from one.
- Importing `mealkeeper-v1` JSON keeps each recipe's ingredients, instructions and times, plus the meal's shopping list and cooking timeline. If an export has no `shopping_list`, one is built by merging recipe ingredients with the same name and unit. Timeline `start_offset_minutes` count from when cooking starts; the app works back from the serving time the user picks.
- **Plan with AI** gives ChatGPT and Claude standing project instructions (`AI_SETUP_INSTRUCTIONS` in `app.js`): the user brainstorms normally, then says "send it to the pan" to get one JSON code block. When the app comes back to the front with a newly copied export, `MainActivity` hands it to the page, which offers to import it (Settings can turn this off).
- **Revise with AI** sends a meal (with its `mealkeeper_id`) and a request to a new chat; when the reply comes back, the import offers to update that meal, keeping the serving time and check marks on items still listed. **Ask AI** on a recipe or timeline step sends it as readable text with a question. On Android, prompts are shared straight to the ChatGPT or Claude app (`sendToAiApp` in `MainActivity`), which opens a new chat with the prompt in the message box; without the app, a web chat opens instead.
- **Chat** talks to the AI directly with the user's own API key (**Settings → AI accounts**). Claude uses Anthropic's Messages API (default model `claude-opus-5-5`, with `fallbacks: "default"`); ChatGPT and Grok use the Responses API at OpenAI and xAI (defaults `gpt-6-sol` and `grok-4.7`; the model list comes from each account's `/v1/models`). `chat.js` builds the requests and reads the streamed replies; `AiApi.kt` adds the key and streams the server-sent events back to the page, so keys never reach the WebView. The AI gets a `save_meal` tool whose input is one `mealkeeper-v1` meal: when it calls it, the meal is added (or, with a `mealkeeper_id`, updated) without the user seeing any JSON. With a key, **Revise with AI** and **Ask AI** answer in this chat instead of opening the AI's app. **Send to pan** asks the AI to save the meal now (ChatGPT and Grok must call `save_meal`); **Report** on a reply emails it to prompttopan.support@gmail.com, as Google Play's AI-generated content policy requires; **Close** clears the conversation.
- This is a WebView-based starter so you can begin working in Android Studio right away. You can gradually migrate screens to native Kotlin/Jetpack Compose later.

## Release builds

Release builds shrink with R8 (the default rules keep the `@JavascriptInterface` bridge methods) and are signed with the Play upload key when `keystore.properties` exists in the project root:

```properties
storeFile=/home/you/keystores/prompttopan-upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

That file and the keystore stay out of git. Back them up together: losing the upload key means asking Google to reset it. Without the file, release builds come out unsigned.

For each Play upload, raise `versionCode` in `app/build.gradle.kts` (and `versionName` if you like), then run `./gradlew bundleRelease` and upload `app/build/outputs/bundle/release/app-release.aab`.

The store listing text, Play Console form answers and graphics are in `store/`. The privacy policy is `docs/privacy.html`, served by GitHub Pages.

## Suggested next steps

1. Move storage from `localStorage` to Room (or IndexedDB) once the data model settles.
2. Define Kotlin data classes for meals, recipes, ingredients, and timeline steps.

## License

MIT; see `LICENSE`. The bundled fonts keep their own licenses: Satisfy under the Apache License 2.0 (`app/src/main/assets/fonts/Satisfy-LICENSE.txt`) and Space Mono under the SIL Open Font License 1.1 (`app/src/main/assets/fonts/SpaceMono-OFL.txt`).
