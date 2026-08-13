import UIKit
import WebKit

final class ViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 7 / 255, green: 20 / 255, blue: 40 / 255, alpha: 1)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.customUserAgent = (webView.value(forKey: "userAgent") as? String ?? "") + " VChatNative/1.0 iOS"
        view.addSubview(webView)

        guard let url = URL(string: serverUrl()) else { return }
        webView.load(URLRequest(url: url))
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }

    private func serverUrl() -> String {
        if let baked = Bundle.main.object(forInfoDictionaryKey: "VCHAT_SERVER_URL") as? String,
           let url = URL(string: baked),
           let scheme = url.scheme,
           ["http", "https"].contains(scheme),
           url.host != nil {
            return baked
        }
        return "http://127.0.0.1:3000"
    }
}
