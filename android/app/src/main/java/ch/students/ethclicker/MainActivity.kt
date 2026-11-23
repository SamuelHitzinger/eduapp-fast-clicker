package ch.students.ethclicker

import android.Manifest
import android.annotation.SuppressLint
import android.app.Dialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * ETH Clicker for Android: eduapp.ethz.ch in a WebView with the ETH Clicker script injected in focus mode,
 * the same script and hooks as the iPhone app (ios/FastClicker/ClickerViewController.swift). The login is
 * ETH's own page on eduapp.ethz.ch; this code never sees a password.
 */
class MainActivity : ComponentActivity() {
    companion object {
        /** A tiny same-origin page (JSON) instead of the 1 MB EduApp web app: the script replaces it. */
        const val START_URL = "https://eduapp.ethz.ch/web/gw/semesters/current"
        const val LOGIN_URL = "https://eduapp.ethz.ch/oauth2/start?rd=%2Fweb%2Fgw%2Fsemesters%2Fcurrent"
        const val ORIGIN = "https://eduapp.ethz.ch"
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var bridge = false
    private var needsLogin = false
    private var login: Dialog? = null
    private var inForeground = false
    private var destroyed = false
    private var nextNotificationId = (System.currentTimeMillis() / 1000 % 100_000).toInt()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)
        // The page starts below the status bar / camera cutout and above the navigation bar and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        applyTheme(isSystemDark())
        createChannel()

        CookieManager.getInstance().setAcceptCookie(true)  // keeps the ETH login between launches
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)                // the page's "Log in" button opens a window: shown as a dialog
            javaScriptCanOpenWindowsAutomatically = true
            setSupportZoom(false)
        }
        web.setBackgroundColor(if (isSystemDark()) Color.rgb(18, 18, 18) else Color.WHITE)

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Only the clicker page itself, in the top frame, may talk to the app.
            WebViewCompat.addWebMessageListener(web, "fcNative", setOf(ORIGIN)) { _, message, origin, isMainFrame, _ ->
                if (isMainFrame && origin.toString().trimEnd('/') == ORIGIN) handleMessage(message.data)
            }
            bridge = true
        }
        web.webViewClient = ClickerClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val popup = showLogin(null) ?: return false
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // From a question back to the list (or closing a zoomed picture); otherwise leave the app running.
                web.evaluateJavascript("(function(){var f=window.__fastClicker;return !!(f&&typeof f.back==='function'&&f.back())})()") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        if (savedInstanceState == null || !web.restoreState(savedInstanceState).let { it != null }) web.loadUrl(START_URL)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        inForeground = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)   // keep the screen on while the app is open
        Alerts.markSeen(this)                                              // back in the app: no reminders needed
        web.evaluateJavascript("window.dispatchEvent(new Event('online'))", null)   // check right away
    }

    override fun onPause() {
        super.onPause()
        inForeground = false
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        CookieManager.getInstance().flush()
        // The WebView is deliberately not paused: it keeps checking for as long as Android lets the app run.
    }

    override fun onDestroy() {
        destroyed = true
        login?.dismiss()
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- the injected script

    /** The tested ETH Clicker build (assets/fast-clicker.js) with the app's hooks; checked again inside the page. */
    private val injected: String by lazy {
        val core = assets.open("fast-clicker.js").bufferedReader().use { it.readText() }
        """
        (function () {
          if (window.top !== window || location.origin !== '$ORIGIN' || /^\/(keycloak|oauth2|mgmt)\//.test(location.pathname)) return;
          if (window.__fastClicker) return;
          var nat = typeof fcNative !== 'undefined' && fcNative && typeof fcNative.postMessage === 'function';
          var post = function (o) { try { fcNative.postMessage(JSON.stringify(o)); } catch (e) {} };
          window.__FC_MODE = 'focus';
          window.__FC_HOOKS = nat ? {
            nativeAlerts: true,
            noExit: true,
            onAlert: function (q) { post({ type: 'alert', id: String(q.id), title: String(q.title || ''), course: String(q.course || ''), round: !!q.round }); },
            onTheme: function (dark) { post({ type: 'theme', dark: !!dark }); }
          } : { noExit: true };
        $core
        })();
        """.trimIndent()
    }

    /** ETH's login form: no auto-capitalisation or autocorrect on the username. */
    private val loginFieldScript = """
        (function () {
          if (!/(^|\.)ethz\.ch${'$'}/.test(location.hostname)) return;
          document.querySelectorAll('input[name=username], input[type=email]').forEach(function (i) {
            i.setAttribute('autocapitalize', 'none'); i.setAttribute('autocorrect', 'off');
            i.setAttribute('spellcheck', 'false'); i.setAttribute('autocomplete', 'username');
          });
          document.querySelectorAll('input[type=password]').forEach(function (i) { i.setAttribute('autocomplete', 'current-password'); });
        })();
    """.trimIndent()

    private fun isEthHost(host: String?) = host?.lowercase()?.let { it == "ethz.ch" || it.endsWith(".ethz.ch") } == true

    private fun openOutside(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) {}
    }

    private inner class ClickerClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Links to other websites open in the browser; everything on ETH stays in the app.
            if (request.isForMainFrame && !isEthHost(request.url.host)) { openOutside(request.url); return true }
            return false
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { needsLogin = false }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame && errorResponse.statusCode == 401) needsLogin = true   // not logged in (or expired)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // Not logged in: only ETH's login (the clicker would start its own silent login next to it, and two
            // logins at once break ETH's check of the login request)
            if (needsLogin) { needsLogin = false; showLogin(LOGIN_URL); return }
            val uri = url?.let(Uri::parse)
            if (uri?.host == "eduapp.ethz.ch") view.evaluateJavascript(injected, null)
            view.evaluateJavascript(loginFieldScript, null)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            // No connection at launch: a small retry page instead of a blank screen.
            showNotice(view, "No connection to EduApp", "Check the Wi-Fi, then try again.", "Try again")
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            recreate()                                       // the page's process was killed: start fresh
            return true
        }
    }

    /** A small page of our own (no connection, not logged in) with one button that starts the clicker again. */
    private fun showNotice(view: WebView, heading: String, text: String, button: String) {
        val dark = isSystemDark()
        val bg = if (dark) "#121212" else "#fff"
        val fg = if (dark) "#eee" else "#333"
        val html = """
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="font:17px sans-serif;padding:40px 24px;background:$bg;color:$fg">
            <h2>$heading</h2><p>$text</p>
            <p><a href="$START_URL" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#08407e;color:#fff;text-decoration:none">$button</a></p></body>
        """.trimIndent()
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    // ---------------------------------------------------------------- login (ETH's own pages, in a dialog)

    @SuppressLint("SetJavaScriptEnabled")
    private fun showLogin(url: String?): WebView? {
        if (login != null) return null
        val popup = WebView(this)
        CookieManager.getInstance().setAcceptThirdPartyCookies(popup, true)
        popup.settings.javaScriptEnabled = true
        popup.settings.domStorageEnabled = true
        val dialog = Dialog(this, android.R.style.Theme_DeviceDefault_NoActionBar)
        val frame = FrameLayout(this)
        frame.setBackgroundColor(if (isSystemDark()) Color.rgb(18, 18, 18) else Color.WHITE)
        frame.addView(popup, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->      // the login form clear of bars and keyboard
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        dialog.setContentView(frame)
        var done = false
        var loggedIn = false
        fun finish() {
            if (done) return
            done = true
            dialog.dismiss()
        }
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // the login may pass through other sign-in pages (e.g. a second factor): those redirects stay here;
                // only a link the student taps to another website opens in the browser
                if (request.isForMainFrame && request.hasGesture() && !request.isRedirect && !isEthHost(request.url.host)) { openOutside(request.url); return true }
                return false
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                finish()                                         // its page was killed (memory): close, never crash
                return true
            }
            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript(loginFieldScript, null)
                val u = url?.let(Uri::parse)
                if (u?.host == "eduapp.ethz.ch" && u.path.orEmpty().startsWith("/web/gw/")) { loggedIn = true; finish() }   // logged in
            }
        }
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) { finish() }
        }
        dialog.setOnDismissListener {
            login = null
            CookieManager.getInstance().flush()
            frame.removeView(popup)
            popup.destroy()
            if (destroyed || isFinishing) return@setOnDismissListener
            when {
                url == null -> web.evaluateJavascript("window.dispatchEvent(new Event('online'))", null)   // the page's own button
                loggedIn -> web.loadUrl(START_URL)           // the app asked for the login: start the clicker
                else -> showNotice(web, "Not logged in", "Log in with your ETH account to see clicker questions.", "Log in")   // cancelled: no new dialog by itself
            }
        }
        login = dialog
        dialog.show()
        if (url != null) popup.loadUrl(url)
        return popup
    }

    // ---------------------------------------------------------------- messages from the page

    private fun handleMessage(data: String?) {
        val m = try { JSONObject(data ?: return) } catch (_: Exception) { return }
        when (m.optString("type")) {
            "alert" -> alert(m.optString("id").take(32), m.optString("title").take(200), m.optString("course").take(200), m.optBoolean("round"))
            "theme" -> applyTheme(m.optBoolean("dark"))
        }
    }

    private fun applyTheme(dark: Boolean) {
        val bg = if (dark) Color.rgb(33, 33, 33) else Color.WHITE
        root.setBackgroundColor(bg)                            // the strips behind the status and navigation bars
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    private fun isSystemDark() =
        (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    // ---------------------------------------------------------------- alerts

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val ch = NotificationChannel(Alerts.CHANNEL, "Clicker questions", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A clicker question opened or a new voting round started"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 150, 80, 150)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun vibrate() {
        val v: Vibrator? = if (Build.VERSION.SDK_INT >= 31) getSystemService(VibratorManager::class.java)?.defaultVibrator
            else legacyVibrator()
        try { v?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 150, 80, 150), -1)) } catch (_: Exception) {}
    }

    @Suppress("DEPRECATION")
    private fun legacyVibrator(): Vibrator? = getSystemService(VIBRATOR_SERVICE) as? Vibrator

    private fun alert(id: String, title: String, course: String, round: Boolean) {
        val heading = if (round) (if (title.isEmpty()) "New round: vote again" else "New round: vote again · $title")
            else (if (title.isEmpty()) "Clicker question open" else "Clicker open: $title")
        val body = if (round) (if (course.isEmpty()) "" else "$course · ") + "Your earlier answer does not count. Tap to answer."
            else (if (course.isEmpty()) "Tap to answer." else "$course · tap to answer.")
        if (inForeground) {
            val ringer = getSystemService(AudioManager::class.java)?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
            if (ringer != AudioManager.RINGER_MODE_SILENT) vibrate()
            if (ringer == AudioManager.RINGER_MODE_NORMAL) {
                try { RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play() } catch (_: Exception) {}
            }
            return
        }
        // In the background: a notification now and one reminder 20 s later (both cleared when the app is opened).
        if (!Alerts.allowed(this)) { vibrate(); return }        // notifications not allowed: vibrate at least
        val nid = nextNotificationId++
        Alerts.notify(this, nid, heading, body)
        Alerts.scheduleReminder(this, nid, heading, body)
    }
}
