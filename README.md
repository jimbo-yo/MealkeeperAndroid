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
- The **Keep screen awake** setting is connected to Android's `FLAG_KEEP_SCREEN_ON`.
- Meal collections, shopping-list check marks, and the keep-awake setting are saved in the WebView's `localStorage` on the device. **Settings → Backup & restore** exports them to a JSON file (`mealkeeper-backup-v1`) through the Android file picker and restores them from one. The shopping list and cooking timeline themselves are still demo data.
- The prototype's import flow can add simplified meal/recipe entries from the sample `mealkeeper-v1` JSON. Full ingredient, instruction, shopping-list, and timeline parsing still needs implementation.
- This is a WebView-based starter so you can begin working in Android Studio right away. You can gradually migrate screens to native Kotlin/Jetpack Compose later.

## Suggested next steps

1. Move storage from `localStorage` to Room (or IndexedDB) once the data model settles.
2. Define Kotlin data classes for meals, recipes, ingredients, and timeline steps.
3. Validate and fully parse `mealkeeper-v1` JSON on import.
4. Generate the combined shopping list from recipe ingredients.
5. Add JSON export and backup/restore.
6. Add tests for import parsing and shopping-list aggregation.
