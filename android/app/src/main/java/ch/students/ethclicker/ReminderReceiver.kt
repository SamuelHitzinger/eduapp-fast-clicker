package ch.students.ethclicker

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Notifications for a question that opened while the app was in the background, and the one reminder after 20 s. */
object Alerts {
    const val CHANNEL = "clicker"
    private const val PREFS = "alerts"
    private const val REMINDER_MS = 20_000L
    private val PATTERN = longArrayOf(0, 150, 80, 150)

    fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun notify(ctx: Context, nid: Int, title: String, body: String) {
        if (!allowed(ctx)) return
        val open = PendingIntent.getActivity(ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_clicker)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setVibrate(PATTERN)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)      // lock screen: "Clicker" only, not the question
            .setPublicVersion(NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_stat_clicker)
                .setContentTitle("Clicker question open").build())
            .build()
        try { NotificationManagerCompat.from(ctx).notify(nid, n) } catch (_: SecurityException) {}
    }

    /** One reminder 20 s later, through the system alarm service (the app itself may be frozen by then). */
    fun scheduleReminder(ctx: Context, nid: Int, title: String, body: String) {
        val i = Intent(ctx, ReminderReceiver::class.java)
            .putExtra("nid", nid).putExtra("title", title).putExtra("body", body)
            .putExtra("at", System.currentTimeMillis())
        val pi = PendingIntent.getBroadcast(ctx, nid, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val at = SystemClock.elapsedRealtime() + REMINDER_MS
        // exact when the phone allows it (otherwise Android may deliver it a few minutes late)
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
        } catch (_: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
        }
    }

    /** The app is on screen: reminders scheduled before now are no longer needed. */
    fun markSeen(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("seenAt", System.currentTimeMillis()).apply()
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    fun seenSince(ctx: Context, at: Long) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("seenAt", 0) >= at
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val at = intent.getLongExtra("at", 0)
        if (Alerts.seenSince(context, at)) return               // the app was opened in the meantime
        Alerts.notify(context, intent.getIntExtra("nid", 1), "Reminder: " + (intent.getStringExtra("title") ?: ""), intent.getStringExtra("body") ?: "")
    }
}
