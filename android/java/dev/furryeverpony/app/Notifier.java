package dev.furryeverpony.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * 原生通知。
 *
 * WebView 里没有 Notification API，网页里的 new Notification 由 SHIM 转到
 * feAndroid.notify()，最终落到这里：一条系统通知 + 点开回到应用。
 */
final class Notifier {
    static final String CHANNEL = "fe_messages";
    private static int nextId = 1000;

    private Notifier() {}

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL, "消息通知", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("好友消息、群消息和通知中心的提醒");
            ch.enableVibration(true);
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        } catch (Throwable ignored) {
        }
    }

    static boolean allowed(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    static void post(Context ctx, String title, String body) {
        if (ctx == null) return;
        try {
            if (!allowed(ctx)) return;
            ensureChannel(ctx);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            Intent it = new Intent(ctx, MainActivity.class);
            it.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, it, flags);

            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(ctx, CHANNEL);
            else b = new Notification.Builder(ctx);
            b.setContentTitle(title == null || title.isEmpty() ? "Furry Everpony" : title)
                    .setContentText(body == null ? "" : body)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true);
            if (Build.VERSION.SDK_INT >= 21) b.setColor(0xFF7C5CFF);
            Notification n = b.build();
            nm.notify(nextId++, n);
            if (nextId > 3000) nextId = 1000;
        } catch (Throwable ignored) {
        }
    }

    static void clear(Context ctx) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancelAll();
        } catch (Throwable ignored) {
        }
    }
}
