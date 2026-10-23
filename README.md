# Mealkeeper Android Studio Project

This is a starter Android Studio project for the Mealkeeper recipe and meal-planning prototype.

## Open it

1. Extract `MealkeeperAndroid.zip`.
2. Open Android Studio.
3. Choose **Open** and select the extracted `MealkeeperAndroid` folder.
4. Allow Gradle sync to finish. If prompted, install Android SDK Platform 35 and use JDK 17.
5. Select an emulator or connected Android device and press **Run**.

The first Gradle sync needs internet access to download the Android Gradle Plugin and Kotlin plugin.

## Project structure

- `app/src/main/java/com/example/mealkeeper/MainActivity.kt` — Android Activity and WebView host.
- `app/src/main/assets/index.html` — Mealkeeper UI and prototype logic.
- `app/src/main/AndroidManifest.xml` — app declaration.
- `app/build.gradle.kts` — Android build configuration.

## Current behavior and limitations

- The existing responsive Mealkeeper interface is bundled locally; it does not need a network connection at runtime.
- The screen stays on (`FLAG_KEEP_SCREEN_ON`) while a cooking timeline or recipe is open; Settings can turn that off or keep the screen on all the time.
- The app draws edge-to-edge with transparent system bars and follows the system dark mode (`Theme.Mealkeeper` has a `values-night` variant, which is what the WebView's `prefers-color-scheme` follows). `MainActivity` passes the status- and navigation-bar heights to the page as `--android-safe-top` / `--android-safe-bottom`.
- The WebView only runs the bundled page; any other link opens in the browser. File and content access are off.
- Meal collections, shopping-list check marks, and the keep-awake setting are saved in the WebView's `localStorage` on the device. **Settings → Backup & restore** exports them to a JSON file (`mealkeeper-backup-v1`) through the Android file picker and restores them from one.
- Importing `mealkeeper-v1` JSON keeps each recipe's ingredients, instructions and times, plus the meal's shopping list and cooking timeline. If an export has no `shopping_list`, one is built by merging recipe ingredients with the same name and unit. Timeline `start_offset_minutes` count from when cooking starts; the app works back from the serving time the user picks.
- This is a WebView-based starter so you can begin working in Android Studio right away. You can gradually migrate screens to native Kotlin/Jetpack Compose later.

## Release builds

`assembleRelease` shrinks with R8 (the default rules keep the `@JavascriptInterface` bridge methods). Before publishing:

1. Replace `com.example.mealkeeper` as the `applicationId` (and ideally `namespace`). Changing it installs as a separate app, so data saved by the old ID won't carry over; export a backup first.
2. Add a `signingConfig` for release; the build currently produces `app-release-unsigned.apk`.

## Suggested next steps

1. Move storage from `localStorage` to Room (or IndexedDB) once the data model settles.
2. Define Kotlin data classes for meals, recipes, ingredients, and timeline steps.
3. Add tests for import parsing and shopping-list aggregation.
