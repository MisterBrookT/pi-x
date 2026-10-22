import SwiftUI
import WebKit

// Dev-only shell for the For you timeline mockup. It loads the sim dev server, which serves the page from
// plugins/remote with live reload and injects the hub token, so no token is ever compiled into the app.
@main
struct PixTimeline: App {
    var body: some Scene { WindowGroup { TimelineView().ignoresSafeArea() } }
}

struct TimelineView: UIViewRepresentable {
    let url = URL(string: ProcessInfo.processInfo.environment["PIX_TIMELINE_URL"] ?? "http://127.0.0.1:8790/timeline")!
    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.957, green: 0.937, blue: 0.894, alpha: 1)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.load(URLRequest(url: url))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {}
}
