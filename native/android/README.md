# VChat Android app

This is a real Android application: its own icon, no Chrome address bar, camera/mic prompts, and a back button. It loads your hosted VChat site in a full-screen WebView and identifies itself as `VChatNative/1.0 Android`.

## Build an APK

1. Install [Android Studio](https://developer.android.com/studio).
2. Open this `native/android` folder.
3. Copy `local.properties.example` to `local.properties` and set:
   - `sdk.dir` to your Android SDK path
   - `vchat.server.url` to your live HTTPS origin, for example `https://chat.example.com`
4. If you skip the URL, the first launch asks for it. Store builds should bake the URL in.
5. **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

Command line, after the SDK is installed:

```bash
cp local.properties.example local.properties
# edit sdk.dir and vchat.server.url
./gradlew assembleDebug
```

There is no Gradle wrapper binary in git. Android Studio creates `gradlew` the first time you open the project.

## Play Store

You need a Google Play developer account, a signed release AAB, a privacy policy URL, and screenshots. This repository cannot publish the listing for you.

Cloud messages are navy. SMS messages are orange. SMS still goes through Twilio on the server — this APK does not become the phone Messages app.
