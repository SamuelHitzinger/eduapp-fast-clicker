package ch.students.ethclicker

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * Anonymous start-up diagnostics (beta): how each attempt to open EduApp ended, so a phone that never gets in shows up in
 * the numbers (tools/monitor.js) without anyone sending screenshots. Numbers and yes/no only, like the clicker's own
 * reports: the outcome, how long it took, the network error class, Android and WebView versions, and the kind of
 * connection (Wi-Fi, mobile, VPN). No names, logins, addresses or URLs. A report that can't be sent (no connection is
 * often the very problem) waits on the phone and goes with the next one; at most [KEEP] wait, each for at most a week.
 */
object StartReport {
    const val OK = 1            // EduApp answered and the clicker started
    const val LOGIN = 2         // EduApp answered: not logged in, ETH's login shown
    const val LOAD_ERROR = 3    // the page could not be loaded (net error below)
    const val NO_ANSWER = 4     // nothing within 30 s
    const val SCRIPT_FAILED = 5 // the page loaded but the clicker did not start in this WebView
    const val RENDERER_GONE = 6 // the page's process died

    private const val KEEP = 10
    private const val MAX_AGE_MS = 7 * 86_400_000L
    private val io = Executors.newSingleThreadExecutor()

    /** Chromium's numbers for the net::ERR_ names WebView reports (net/base/net_error_list.h); 0 = another one. */
    private val NET = mapOf(
        "ERR_FAILED" to -2, "ERR_ABORTED" to -3, "ERR_TIMED_OUT" to -7, "ERR_ACCESS_DENIED" to -10,
        "ERR_BLOCKED_BY_CLIENT" to -20, "ERR_NETWORK_CHANGED" to -21, "ERR_BLOCKED_BY_ADMINISTRATOR" to -22,
        "ERR_CONNECTION_CLOSED" to -100, "ERR_CONNECTION_RESET" to -101, "ERR_CONNECTION_REFUSED" to -102,
        "ERR_CONNECTION_ABORTED" to -103, "ERR_CONNECTION_FAILED" to -104, "ERR_NAME_NOT_RESOLVED" to -105,
        "ERR_INTERNET_DISCONNECTED" to -106, "ERR_SSL_PROTOCOL_ERROR" to -107, "ERR_ADDRESS_INVALID" to -108,
        "ERR_ADDRESS_UNREACHABLE" to -109, "ERR_TUNNEL_CONNECTION_FAILED" to -111, "ERR_SSL_VERSION_OR_CIPHER_MISMATCH" to -113,
        "ERR_CONNECTION_TIMED_OUT" to -118, "ERR_PROXY_CONNECTION_FAILED" to -130, "ERR_NAME_RESOLUTION_FAILED" to -137,
        "ERR_NETWORK_ACCESS_DENIED" to -138, "ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN" to -150, "ERR_CERT_COMMON_NAME_INVALID" to -200,
        "ERR_CERT_DATE_INVALID" to -201, "ERR_CERT_AUTHORITY_INVALID" to -202, "ERR_CERT_INVALID" to -207,
        "ERR_EMPTY_RESPONSE" to -324, "ERR_HTTP2_PROTOCOL_ERROR" to -337, "ERR_QUIC_PROTOCOL_ERROR" to -356,
        "ERR_CACHE_MISS" to -400,
    )

    fun netError(description: CharSequence?): Int =
        description?.toString()?.substringAfter("net::")?.trim()?.let { NET[it] } ?: 0

    /**
     * One attempt's outcome. [ms]: time since the attempt started; [errorCode]: WebViewClient.ERROR_*; [netError]: see [NET];
     * [attempt]: 1 for the first in this launch, then 2, 3 … after "Try again"; [pastVpn]: this try went past the VPN (MainActivity).
     */
    fun send(ctx: Context, outcome: Int, ms: Long, attempt: Int, webViewMajor: Int, errorCode: Int = 0, netError: Int = 0, pastVpn: Boolean = false, extra: JSONObject? = null) {
        val app = ctx.applicationContext
        val data = JSONObject()
            .put("outcome", outcome).put("ms", ms).put("attempt", attempt)
            .put("err", errorCode).put("net", netError)
            .put("sdk", Build.VERSION.SDK_INT).put("wv", webViewMajor).put("pastVpn", pastVpn)
        network(app, data)
        extra?.keys()?.forEach { data.put(it, extra.get(it)) }
        io.execute { deliver(app, data) }
    }

    /**
     * After a failed start: can the phone reach EduApp outside the web component? Blocking (call off the main thread).
     * Only yes/no and numbers come back, never an address: whether eduapp.ethz.ch resolves, whether it resolves to this
     * phone or the local network (an ad blocker or DNS filter), whether a proxy is set, and how a plain request to
     * the same small page went (an HTTP status, or which kind of error). The request carries no cookies or login.
     */
    fun probe(ctx: Context, url: String): JSONObject {
        val r = JSONObject()
        try {
            val a = InetAddress.getAllByName(URL(url).host)
            r.put("dnsOk", a.isNotEmpty()).put("dnsV6", a.any { it is Inet6Address })
                .put("dnsLocal", a.any { it.isLoopbackAddress || it.isAnyLocalAddress || it.isSiteLocalAddress || it.isLinkLocalAddress })
        } catch (_: Exception) { r.put("dnsOk", false) }
        r.put("proxy", !System.getProperty("http.proxyHost").isNullOrEmpty())
        try {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            r.put("netProxy", cm?.getLinkProperties(cm.activeNetwork)?.httpProxy != null)
        } catch (_: Exception) {}
        try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.useCaches = false
            c.connectTimeout = 8_000
            c.readTimeout = 8_000
            r.put("http", c.responseCode)                         // 401 (not logged in) or 302 means EduApp answered
            c.disconnect()
        } catch (e: Exception) {
            r.put("http", 0).put("httpErr", when (e) {
                is UnknownHostException -> 1; is ConnectException -> 2; is SocketTimeoutException -> 3; is SSLException -> 4
                is NoRouteToHostException -> 5; is SecurityException -> 7; else -> 6 })
        }
        return r
    }

    /** The kind of connection right now: yes/no only. */
    private fun network(ctx: Context, data: JSONObject) {
        try {
            val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
            val n = cm.activeNetwork
            val caps = n?.let { cm.getNetworkCapabilities(it) }
            data.put("online", caps != null)
            if (caps == null) return
            data.put("wifi", caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
                .put("cell", caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
                .put("vpn", caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
                .put("validated", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            if (Build.VERSION.SDK_INT >= 28) cm.getLinkProperties(n)?.let { data.put("privDns", it.isPrivateDnsActive) }
            data.put("saver", cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
        } catch (_: Exception) {}
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("start-report", Context.MODE_PRIVATE)

    private fun installId(ctx: Context): String {
        val p = prefs(ctx)
        p.getString("install", null)?.let { return it }
        val id = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        p.edit().putString("install", id).apply()
        return id
    }

    private fun reportUrl(ctx: Context): String? = try {
        ctx.assets.open("report-url.txt").bufferedReader().use { it.readText().trim() }.takeIf { it.startsWith("https://") }
    } catch (_: Exception) { null }

    /** Runs on [io]: sends this report and any that waited; what can't be sent waits for the next time. */
    private fun deliver(ctx: Context, data: JSONObject) {
        val url = reportUrl(ctx) ?: return
        val p = prefs(ctx)
        val now = System.currentTimeMillis()
        val queue = try { JSONArray(p.getString("queue", "[]")) } catch (_: Exception) { JSONArray() }
        queue.put(JSONObject().put("at", now).put("data", data))
        val version = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName } catch (_: Exception) { null } ?: return
        val install = installId(ctx)
        val left = JSONArray()
        var failed = false
        for (i in 0 until queue.length()) {
            val item = queue.optJSONObject(i) ?: continue
            val at = item.optLong("at")
            if (now - at > MAX_AGE_MS) continue
            val d = item.optJSONObject("data") ?: continue
            if (!failed) {
                d.put("age", (now - at) / 1000)                 // seconds it waited on the phone
                val body = JSONObject().put("install", install).put("platform", "android").put("version", version)
                    .put("kind", "start").put("data", d).toString()
                if (post(url, body)) continue
                failed = true
            }
            left.put(item)
        }
        val keep = JSONArray()
        for (i in maxOf(0, left.length() - KEEP) until left.length()) keep.put(left.get(i))
        p.edit().putString("queue", keep.toString()).apply()
    }

    private fun post(url: String, body: String): Boolean = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 10_000
        c.readTimeout = 10_000
        c.doOutput = true
        c.setRequestProperty("Content-Type", "text/plain")
        c.outputStream.use { it.write(body.toByteArray()) }
        val code = c.responseCode
        c.disconnect()
        code in 200..299 || code == 400 || code == 413          // 4xx: the relay won't take it, don't keep retrying
    } catch (_: Exception) { false }
}
