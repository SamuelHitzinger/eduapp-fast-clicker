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
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
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
 * Clicker for Android: eduapp.ethz.ch in a WebView with the Clicker script injected in focus mode,
 * the same script and hooks as the iPhone app (ios/FastClicker/ClickerViewController.swift). The login is
 * ETH's own page on eduapp.ethz.ch; this code never sees a password.
 */
class MainActivity : ComponentActivity() {
    companion object {
        /** A tiny same-origin page (JSON) instead of the 1 MB EduApp web app: the script replaces it. */
        const val START_URL = "https://eduapp.ethz.ch/web/gw/semesters/current"
        const val LOGIN_URL = "https://eduapp.ethz.ch/oauth2/start?rd=%2Fweb%2Fgw%2Fsemesters%2Fcurrent"
        const val ORIGIN = "https://eduapp.ethz.ch"
        const val WEBVIEW_STORE = "https://play.google.com/store/apps/details?id=com.google.android.webview"
        const val NO_ANSWER_MS = 30_000L
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var bridge = false
    private var needsLogin = false
    private var login: Dialog? = null
    private var inForeground = false
    private var destroyed = false
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: LinearLayout                  // a native screen over the page: loading, no answer, start failure
    private lateinit var statusTitle: TextView
    private lateinit var statusText: TextView
    private lateinit var statusRetry: Button
    private lateinit var statusUpdate: Button
    private var attemptStart = 0L                               // when the current try to open EduApp began (0: none open)
    private var attempts = 0
    private var reports = 0
    private val noAnswer = Runnable {
        attemptDone(StartReport.NO_ANSWER)
        showStatus("EduApp doesn't answer", "Nothing arrived from eduapp.ethz.ch within 30 seconds. Check the internet connection (Wi-Fi or mobile data), then try again." +
            (if (oldWebView()) " This phone's web component is also out of date: please update it." else ""), retry = true, update = oldWebView())
    }
    private var nextNotificationId = (System.currentTimeMillis() / 1000 % 100_000).toInt()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        buildStatus()
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
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)   // the login is first-party (eduapp.ethz.ch)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false                         // nothing on the phone is reachable from the page
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
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
                if (!isUserGesture) return false                // only the student's own tap on "Log in" opens a window
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
        showStatus("Loading EduApp…", "", retry = false, update = false)
        handler.postDelayed(noAnswer, NO_ANSWER_MS)
        if (savedInstanceState == null || !web.restoreState(savedInstanceState).let { it != null }) web.loadUrl(START_URL)
    }

    // ---------------------------------------------------------------- status screen (native, so it shows even if the page can't)

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    /** Reports how the current try to open EduApp ended (anonymous numbers, see StartReport); at most 8 per launch. */
    private fun attemptDone(outcome: Int, errorCode: Int = 0, netError: Int = 0) {
        if (attemptStart == 0L) return
        val ms = System.currentTimeMillis() - attemptStart
        attemptStart = 0L
        if (reports++ < 8) StartReport.send(this, outcome, ms, attempts, webViewVersion().substringBefore('.').toIntOrNull() ?: 0, errorCode, netError)
    }

    private fun vpnOn() = try {
        val cm = getSystemService(ConnectivityManager::class.java)
        cm?.getNetworkCapabilities(cm.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    } catch (_: Exception) { false }

    private fun webViewVersion(): String = try { WebViewCompat.getCurrentWebViewPackage(this)?.versionName ?: "?" } catch (_: Exception) { "?" }

    /** Android System WebView older than Chrome 100 (2022): EduApp and the clicker may not work. */
    private fun oldWebView() = webViewVersion().substringBefore('.').toIntOrNull()?.let { it < 100 } == true

    private fun buildStatus() {
        val dark = isSystemDark()
        val fg = if (dark) Color.rgb(236, 236, 236) else Color.rgb(26, 26, 26)
        status = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            setBackgroundColor(if (dark) Color.rgb(18, 18, 18) else Color.WHITE)
            isClickable = true                                   // the page below gets no taps while this shows
        }
        statusTitle = TextView(this).apply { textSize = 20f; setTypeface(typeface, Typeface.BOLD); setTextColor(fg); gravity = Gravity.CENTER }
        statusText = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(12)) }
        statusRetry = Button(this).apply { text = "Try again"; setOnClickListener { retry() } }
        statusUpdate = Button(this).apply { text = "Update Android System WebView"; setOnClickListener { openOutside(Uri.parse(WEBVIEW_STORE)) } }
        val versions = TextView(this).apply {
            textSize = 12f; setTextColor(Color.GRAY); gravity = Gravity.CENTER; setPadding(0, dp(24), 0, 0)
            val app = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (_: Exception) { "?" }
            text = "ETH Clicker $app · Android ${Build.VERSION.RELEASE} · WebView ${webViewVersion()}"
        }
        for (v in listOf(statusTitle, statusText, statusRetry, statusUpdate, versions)) status.addView(v, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        root.addView(status, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    }

    private fun showStatus(title: String, text: String, retry: Boolean, update: Boolean) {
        statusTitle.text = title
        statusText.text = text
        statusText.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
        statusRetry.visibility = if (retry) View.VISIBLE else View.GONE
        statusUpdate.visibility = if (update) View.VISIBLE else View.GONE
        status.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        handler.removeCallbacks(noAnswer)
        status.visibility = View.GONE
    }

    private fun retry() {
        showStatus("Loading EduApp…", "", retry = false, update = false)
        handler.removeCallbacks(noAnswer)
        handler.postDelayed(noAnswer, NO_ANSWER_MS)
        web.loadUrl(START_URL)
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
        handler.removeCallbacksAndMessages(null)
        login?.dismiss()
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- the injected script

    /** The tested Clicker build (assets/fast-clicker.js) with the app's hooks; checked again inside the page. */
    private val injected: String by lazy {
        val core = assets.open("fast-clicker.js").bufferedReader().use { it.readText() }
        """
        (function () {
          if (window.top !== window || location.origin !== '$ORIGIN' || /^\/(keycloak|oauth2|mgmt)\//.test(location.pathname)) return 'skip';
          if (window.__fastClicker) return 'skip';
          var nat = typeof fcNative !== 'undefined' && fcNative && typeof fcNative.postMessage === 'function';
          var post = function (o) { try { fcNative.postMessage(JSON.stringify(o)); } catch (e) {} };
          window.__FC_MODE = 'focus';
          window.__FC_HOOKS = nat ? {
            nativeAlerts: true,
            noExit: true,
            onAlert: function (q) { post({ type: 'alert', id: String(q.id), title: String(q.title || ''), course: String(q.course || ''), round: !!q.round }); },
            onTheme: function (dark) { post({ type: 'theme', dark: !!dark }); },
            openUrl: function (u) { post({ type: 'open', url: String(u) }); }
          } : { noExit: true };
        $core
          return 'ok';
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

    /** Pages shown in the app: ETH's own, over https only. */
    private fun isEthPage(uri: Uri) = uri.scheme == "https" && isEthHost(uri.host)

    /** Only ordinary web links leave the app (to the browser); intent:, tel:, file: and the like are ignored. */
    private fun openOutside(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) } catch (_: ActivityNotFoundException) {}
    }

    /** Main-frame navigation rule for both web views: ETH pages stay, a tapped link elsewhere opens in the browser, anything else is blocked. */
    private fun keepInApp(request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame || isEthPage(request.url)) return true
        if (request.hasGesture() && !request.isRedirect) openOutside(request.url)
        return false
    }

    private inner class ClickerClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !keepInApp(request)

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            // not logged in (or expired); this can arrive before or after onPageStarted, so it is only reset once used
            if (request.isForMainFrame && errorResponse.statusCode == 401) needsLogin = true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url?.startsWith(START_URL) == true && attemptStart == 0L) { attemptStart = System.currentTimeMillis(); attempts++ }
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            hideStatus()                                         // something is on screen: ETH's page, the clicker or a notice
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // Not logged in: only ETH's login (the clicker would start its own silent login next to it, and two
            // logins at once break ETH's check of the login request)
            if (needsLogin) { needsLogin = false; attemptDone(StartReport.LOGIN); showLogin(LOGIN_URL); return }
            val uri = url?.let(Uri::parse)
            if (uri?.host == "eduapp.ethz.ch") view.evaluateJavascript(injected) { r ->
                // null: the script did not run (a syntax this WebView doesn't know, or an error at start)
                if (r == "\"ok\"") attemptDone(StartReport.OK)
                if (r == null || r == "null") attemptDone(StartReport.SCRIPT_FAILED)
                if (r == null || r == "null") showStatus("The clicker couldn't start", "This phone's web component (Android System WebView ${webViewVersion()}) may be out of date. Update it, then open ETH Clicker again.", retry = true, update = true)
            }
            view.evaluateJavascript(loginFieldScript, null)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            attemptDone(StartReport.LOAD_ERROR, error.errorCode, StartReport.netError(error.description))
            // No connection at launch: a small retry page instead of a blank screen.
            val vpn = if (vpnOn()) " A VPN is on (the key symbol at the top of the screen): turn it off, or let ETH Clicker through it, then try again." else ""
            showNotice(view, "No connection to EduApp", "Check the Wi-Fi or mobile data, then try again.$vpn (${error.description})", "Try again")
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            attemptDone(StartReport.RENDERER_GONE)
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
        CookieManager.getInstance().setAcceptThirdPartyCookies(popup, false)
        popup.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
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
            // the login runs only on ETH's own pages (https *.ethz.ch); a page elsewhere could imitate it, so it never loads here
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (keepInApp(request)) return false
                if (request.isForMainFrame) finish()              // not an ETH page: never shown here (a tapped link went to the browser)
                return true
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
            "open" -> openOutside(Uri.parse(m.optString("url")))     // a link in a question: the browser (http/https only)
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
