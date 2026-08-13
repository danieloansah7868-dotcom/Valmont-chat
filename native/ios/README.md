# VChat iOS shell

Apple requires a Mac, Xcode, and a paid Apple Developer account to install on a physical iPhone or ship on the App Store. This folder is the WebView source, not a finished `.ipa`.

1. On a Mac, create a new **App** project in Xcode (UIKit, Swift, storyboard optional).
2. Set the bundle id, for example `app.vchat.ios`.
3. Replace the generated app files with `AppDelegate.swift` and `ViewController.swift` from this folder.
4. Merge `Info.plist` keys (camera, microphone, local-network, ATS).
5. Set `VCHAT_SERVER_URL` in Info.plist to your live HTTPS origin.
6. Product → Archive, then upload through App Store Connect.

The WebView adds `VChatNative/1.0 iOS` to the user agent so the site hides the PWA install prompt.
