import UIKit
import WebKit
import AudioToolbox
import UserNotifications

/// Main screen: eduapp.ethz.ch with the ETH Clicker script injected in focus mode.
/// The script draws the whole clicker section itself (list, question pages, results).
final class ClickerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// A tiny same-origin page (129 bytes of JSON) instead of the 1 MB EduApp web app: the script replaces it.
    private static let startURL = URL(string: "https://eduapp.ethz.ch/web/gw/semesters/current")!
    private static let loginURL = URL(string: "https://eduapp.ethz.ch/oauth2/start?rd=%2Fweb%2Fgw%2Fsemesters%2Fcurrent")!

    private var webView: WKWebView!
    private var needsLogin = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()                 // keeps the ETH login between launches
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true

        let controller = WKUserContentController()
        controller.add(WeakScriptMessageHandler(self), name: "fc")
        if let script = Self.injectedScript() {
            controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        controller.addUserScript(Self.loginFieldScript)
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToReload(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        self.webView = webView

        // The page starts below the status bar / Dynamic Island, so its own header bar always stays visible.
        let container = UIView()
        container.backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: Self.startURL))
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: - Injected script

    /// The tested ETH Clicker build (Resources/fast-clicker.js) wrapped with the app's hooks.
    /// It does not run in the login sheet (window.opener) or on ETH's login pages.
    private static func injectedScript() -> String? {
        guard let url = Bundle.main.url(forResource: "fast-clicker", withExtension: "js"),
              let core = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return """
        (function () {
          if (window.opener || location.hostname !== 'eduapp.ethz.ch' || /^\\/(keycloak|oauth2|mgmt)\\//.test(location.pathname)) return;
          window.__FC_MODE = 'focus';
          window.__FC_HOOKS = {
            nativeAlerts: true,
            noExit: true,
            onAlert: function (q) {
              try { window.webkit.messageHandlers.fc.postMessage({ type: 'alert', id: String(q.id), title: q.title, course: q.course, round: !!q.round }); } catch (e) {}
            },
            onTheme: function (dark) {
              try { window.webkit.messageHandlers.fc.postMessage({ type: 'theme', dark: !!dark }); } catch (e) {}
            }
          };
        \(core)
        })();
        """
    }

    /// ETH's login form does not switch off iOS auto-capitalisation/autocorrect on the username field,
    /// so "abc" could silently become "Abc" or a dictionary word. Turn both off on ETH's login pages.
    static let loginFieldScript = WKUserScript(source: """
        (function () {
          if (!/(^|\\.)ethz\\.ch$/.test(location.hostname)) return;
          document.querySelectorAll('input[name=username], input[type=email]').forEach(function (i) {
            i.setAttribute('autocapitalize', 'none'); i.setAttribute('autocorrect', 'off');
            i.setAttribute('spellcheck', 'false'); i.setAttribute('autocomplete', 'username');
          });
          document.querySelectorAll('input[type=password]').forEach(function (i) { i.setAttribute('autocomplete', 'current-password'); });
        })();
        """, injectionTime: .atDocumentEnd, forMainFrameOnly: false)

    // MARK: - Messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the clicker page itself may talk to the app (not ETH's login pages or anything inside a frame).
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "eduapp.ethz.ch",
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "alert": handleAlert(body)
        case "theme": handleTheme(body)
        default: break
        }
    }

    /// The page switched between light and dark: colour the strip behind the status bar like the page's header.
    private func handleTheme(_ body: [String: Any]) {
        let dark = body["dark"] as? Bool ?? false
        view.window?.overrideUserInterfaceStyle = dark ? .dark : .light
        view.backgroundColor = dark ? UIColor(red: 33 / 255, green: 33 / 255, blue: 33 / 255, alpha: 1) : .white
    }


    private func handleAlert(_ body: [String: Any]) {
        let title = body["title"] as? String ?? ""
        let course = body["course"] as? String ?? ""
        let id = body["id"] as? String ?? UUID().uuidString
        let round = body["round"] as? Bool ?? false               // the lecturer restarted voting: vote again

        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        AudioServicesPlayAlertSound(SystemSoundID(1007))      // tri-tone; vibrates instead when the phone is on silent

        if UIApplication.shared.applicationState != .active {
            let content = UNMutableNotificationContent()
            if round {
                content.title = title.isEmpty ? "New round: vote again" : "New round: vote again · \(title)"
                content.body = (course.isEmpty ? "" : "\(course) · ") + "Your earlier answer does not count. Tap to answer."
            } else {
                content.title = title.isEmpty ? "Clicker question open" : "Clicker open: \(title)"
                content.body = course.isEmpty ? "Tap to answer." : "\(course) · tap to answer."
            }
            content.sound = .default
            let center = UNUserNotificationCenter.current()
            center.add(UNNotificationRequest(identifier: "clicker-\(id)", content: content, trigger: nil))
            // Still not back after 20 s: remind once (cancelled as soon as the app is opened).
            let reminder = content.mutableCopy() as! UNMutableNotificationContent
            reminder.title = "Reminder: " + content.title
            center.add(UNNotificationRequest(identifier: "clicker-reminder-\(id)", content: reminder,
                                             trigger: UNTimeIntervalNotificationTrigger(timeInterval: 20, repeats: false)))
        }
    }

    // MARK: - App lifecycle

    @objc private func didBecomeActive() {
        UIApplication.shared.isIdleTimerDisabled = true      // keep the screen on while the app is open
        endBackgroundTask()
        let center = UNUserNotificationCenter.current()     // back in the app: reminders are no longer needed
        center.getPendingNotificationRequests { requests in
            let ids = requests.map(\.identifier).filter { $0.hasPrefix("clicker-reminder-") }
            if !ids.isEmpty { center.removePendingNotificationRequests(withIdentifiers: ids) }
        }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('online'))", completionHandler: nil) // check right away
    }

    @objc private func didEnterBackground() {
        UIApplication.shared.isIdleTimerDisabled = false
        // iOS lets an app finish work briefly after it leaves the screen; ask for that time.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "clicker-check") { [weak self] in
            self?.endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Pulling down checks for questions right away. It only restarts the page when the clicker is not running
    /// (e.g. the "No connection" page): a restart throws away a check in progress and costs seconds.
    @objc private func pullToReload(_ sender: UIRefreshControl) {
        let js = "(function(){var f=window.__fastClicker;if(f&&typeof f.checkNow==='function'){f.checkNow();return true}return false})()"
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self = self else { return }
            if (result as? Bool) == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { sender.endRefreshing() }
            } else {
                self.webView.load(URLRequest(url: Self.startURL))
            }
        }
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Links to other websites open in Safari; everything on ETH stays in the app.
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
           let host = url.host, !(host == "ethz.ch" || host.hasSuffix(".ethz.ch")) {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, http.statusCode == 401 {
            needsLogin = true                                    // not logged in yet (or the session expired)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        if needsLogin {
            needsLogin = false
            presentLogin()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain, nsError.code != NSURLErrorCancelled else { return }
        // No connection at launch: show a small retry page instead of a blank screen.
        let html = """
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font:17px -apple-system,sans-serif;padding:40px 24px;color:#333">
        <h2>No connection to EduApp</h2><p>Check the Wi-Fi, then pull down to try again.</p></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// Kills of the web content process (memory pressure in the background) would leave a blank page.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: Self.startURL))
    }

    // MARK: - Login

    private func presentLogin() {
        guard presentedViewController == nil else { return }
        let sheet = LoginViewController(configuration: nil) { [weak self] in
            guard let self = self else { return }
            self.webView.load(URLRequest(url: Self.startURL))
        }
        sheet.load(Self.loginURL)
        present(UINavigationController(rootViewController: sheet), animated: true)
    }

    /// The page's own "Log in" button opens a window: show it as a sheet that closes itself after login.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard presentedViewController == nil else { return nil }
        let sheet = LoginViewController(configuration: configuration) { [weak self] in
            self?.webView.evaluateJavaScript("window.dispatchEvent(new Event('online'))", completionHandler: nil)
        }
        present(UINavigationController(rootViewController: sheet), animated: true)
        return sheet.webView                                     // WebKit loads the request into it
    }

    func webViewDidClose(_ webView: WKWebView) {}
}

/// ETH login in a sheet. It shares the cookie store with the main screen and closes itself when the login
/// lands back on the EduApp API.
final class LoginViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let onDone: () -> Void
    private var finished = false

    init(configuration: WKWebViewConfiguration?, onDone: @escaping () -> Void) {
        let config: WKWebViewConfiguration
        if let configuration = configuration {
            config = configuration
        } else {
            config = WKWebViewConfiguration()
            config.websiteDataStore = .default()
            config.userContentController.addUserScript(ClickerViewController.loginFieldScript)
        }
        webView = WKWebView(frame: .zero, configuration: config)
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        title = "ETH login"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() { view = webView }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
    }

    func load(_ url: URL) { webView.load(URLRequest(url: url)) }

    @objc private func cancelTapped() { finish() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url, url.host == "eduapp.ethz.ch", url.path.hasPrefix("/web/gw/") {
            finish()                                             // logged in: back to the clicker
        }
    }

    func webViewDidClose(_ webView: WKWebView) { finish() }

    private func finish() {
        guard !finished else { return }
        finished = true
        dismiss(animated: true) { [onDone] in onDone() }
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with the view controller.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
