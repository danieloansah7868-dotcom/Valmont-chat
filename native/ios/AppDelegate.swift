import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = UIColor(red: 7 / 255, green: 20 / 255, blue: 40 / 255, alpha: 1)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
