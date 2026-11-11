import UIKit
import UserNotifications

/// Fast Clicker: a clicker-only shell around ETH EduApp.
/// The app shows eduapp.ethz.ch in a web view (so ETH's own login and session cookies are used, and the
/// password never touches this code) and runs the tested Fast Clicker script there in focus mode.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ClickerViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    /// While the app is open it plays its own sound and vibration, so no banner is shown on top.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
