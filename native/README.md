# VChat native shells

These folders wrap the existing VChat web client in a **real application window**. They are not a rewrite in Kotlin/Swift, and they are not a PWA “Add to Home Screen” shortcut.

| Folder | What you get |
| --- | --- |
| `android/` | Android Studio project → APK / Play Store AAB |
| `desktop/` | Electron window → Windows / macOS / Linux installer |
| `ios/` | UIKit WebView sources to drop into an Xcode app |

Set the server URL to the same HTTPS origin people already use in a browser. Cookies, Socket.IO, and uploads then work without a second API.

**Cloud bubbles are navy. SMS bubbles are orange.**

See `public/native-app.html` (also served at `/native-app.html`) for the short user-facing guide.
