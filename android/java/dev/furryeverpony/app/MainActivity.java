package dev.furryeverpony.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import fe.local.Main;
import fe.local.Ports;

/**
 * Furry Everpony 手机端。
 *
 * 手机自己就是服务端：启动时在本机开一个 HTTP 服务（fe.local），
 * 账号、好友、消息、群全部存在手机里，WebView 直接打开 http://127.0.0.1:端口。
 * 不需要电脑在线，不需要填地址，不需要同一个 Wi-Fi。
 *
 * 首次启动会把打包在 assets/web 里的界面文件解压到 filesDir/web，之后按版本号判断要不要重解压。
 * 通知走原生 NotificationManager：网页里的 new Notification 被 SHIM 接管，
 * 另外钩住会话列表轮询，后台时用未读数弹系统通知。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_NOTIF = 1002;
    private static final int PORT_FIRST = 7788;
    private static final int PORT_TRIES = 12;
    /** 首选端口绑不上时（常见于上一个进程还没放掉端口），同一端口再试几次，别急着漂到下一个。 */
    private static final int PORT_RETRY_TIMES = 3;
    private static final int PORT_RETRY_SLEEP_MS = 200;
    private static final String PREFS = "fe_prefs";
    private static final String KEY_SERVER = "server_base";
    /** 上次成功监听的端口：重开 App 先试它，端口不变网页的登录态就还在。 */
    private static final String KEY_LAST_PORT = "last_port";

    private static final int C_BG = Color.parseColor("#060910");
    private static final int C_PANEL = Color.parseColor("#0F1522");
    private static final int C_BRAND = Color.parseColor("#7C5CFF");
    private static final int C_ACCENT = Color.parseColor("#39C7FF");
    private static final int C_TEXT = Color.parseColor("#E8ECF6");
    private static final int C_MUTED = Color.parseColor("#8A94AB");
    private static final int C_LINE = Color.parseColor("#23304A");

    /**
     * WebView 里 127.0.0.1 虽然算安全上下文，但不同系统版本仍然可能缺能力，
     * 这里统一补齐，并接管通知与未读提醒。
     */
    private static final String SHIM = "\n(function(){try{\nvar A=window.feAndroid||null;\nif(!(window.crypto&&crypto.randomUUID)){var g=function(){var a=new Uint8Array(16);\n(window.crypto||window.msCrypto).getRandomValues(a);a[6]=a[6]&15|64;a[8]=a[8]&63|128;\nvar s='';for(var i=0;i<16;i++){s+=('0'+a[i].toString(16)).slice(-2);}\nreturn s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);};\ntry{crypto.randomUUID=g;}catch(e){}}\nif(!navigator.clipboard){var w=function(t){try{window.feAndroid.copy(String(t));}catch(e){}\nreturn Promise.resolve();};try{Object.defineProperty(navigator,'clipboard',{value:{writeText:w,\nreadText:function(){return Promise.resolve('');}},configurable:true});}catch(e){}}\nif(!('serviceWorker' in navigator)){try{Object.defineProperty(navigator,'serviceWorker',{value:{\nregister:function(){return Promise.resolve(null);},getRegistrations:function(){return Promise.resolve([]);},\nready:new Promise(function(){})},configurable:true});}catch(e){}}\ntry{\nif(A&&(!window.Notification||!window.Notification.__fe)){\nvar N=function(title,opt){opt=opt||{};try{A.notify(String(title||'Furry Everpony'),String(opt.body||''));}catch(e){}\nthis.title=title;this.body=opt.body;this.onclick=null;};\nN.permission='granted';\nN.requestPermission=function(cb){try{if(typeof cb==='function')cb('granted');}catch(e){}\nreturn Promise.resolve('granted');};\nN.__fe=1;\ntry{window.Notification=N;}catch(e){}\n}\n}catch(e){}\ntry{\nif(window.fetch&&!window.fetch.__fe){\nvar of=window.fetch,last=0;\nvar onList=function(text){\ntry{\nvar d=JSON.parse(text),arr=d&&d.conversations;if(!arr||!arr.length)return;\nvar total=0,best=null;\nfor(var i=0;i<arr.length;i++){var c=arr[i]||{},u=c.unread?c.unread:0;total+=u;\nif(u>0&&(!best||u>best.u))best={u:u,c:c};}\nvar doc=window.document;\nif(total>last&&doc&&doc.hidden&&best&&A){\nvar c2=best.c,peer=c2.peer||{},grp=c2.group||{},lm=c2.last||{};\nvar name=peer.nickname||peer.number||grp.name||'新消息';\nvar body=lm.preview||lm.body||('你收到 '+best.u+' 条新消息');\ntry{A.notify(String(name),String(body));}catch(e){}\n}\nlast=total;\n}catch(e){}\n};\nvar wrap=function(){var self=this,args=arguments;\nreturn of.apply(self,args).then(function(res){\ntry{var u=args&&args[0],s=typeof u==='string'?u:(u&&u.url)||'';\nif(s.indexOf('/api/conversations')>=0&&res&&res.clone){res.clone().text().then(onList,function(){});}\n}catch(e){}\nreturn res;});\n};\nwrap.__fe=1;\ntry{window.fetch=wrap;}catch(e){}\n}\n}catch(e){}\n}catch(e){}})();\n";

    private FrameLayout root;
    private WebView web;
    private ScrollView splash;
    private TextView splashTitle;
    private TextView splashSub;
    private ProgressBar splashBar;
    private LinearLayout errorBox;
    private TextView errorText;
    private ValueCallback<Uri[]> pendingFiles;
    private long lastBackAt;
    private int backSeq;
    private boolean webShown;
    private String currentBase = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Notifier.ensureChannel(this);
        buildUi();
        askNotificationPermission();
        String saved = prefs().getString(KEY_SERVER, "");
        if (!saved.isEmpty()) {
            startRemote(saved);
        } else {
            startLocalServer();
        }
    }

    // ---------------------------------------------------------------- 本机服务

    /** 解压界面文件 + 起本机 HTTP 服务，成功后直接进界面。 */
    private void startLocalServer() {
        showSplash("正在启动…", "第一次启动要准备界面文件，之后秒开");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String failText = null;
                int port = 0;
                try {
                    unpackWeb();
                    port = bootServer();
                } catch (Throwable t) {
                    failText = String.valueOf(t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
                }
                final int okPort = port;
                final String err = failText;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (okPort > 0) {
                            openWeb("http://127.0.0.1:" + okPort + "/");
                        } else {
                            showError("本机服务没起来\n" + (err == null ? "未知原因" : err));
                        }
                    }
                });
            }
        }).start();
    }

    /**
     * 起本机服务。端口顺序由 fe.local.Ports 给出：上次成功的端口排第一，其余按 7788 起依次补。
     *
     * 为什么这么在意端口：网页把登录 token 存在 localStorage，而 localStorage 按 origin 隔离，
     * 端口一换 origin 就变，token 读不到，用户就会被迫重新登录。
     * 所以首选端口绑不上时先原地重试几次（上一个进程可能还没放掉端口），实在不行才换下一个。
     */
    private int bootServer() throws Exception {
        Exception last = null;
        int[] order = Ports.order(prefs().getInt(KEY_LAST_PORT, 0), PORT_FIRST, PORT_TRIES);
        for (int i = 0; i < order.length; i++) {
            int tries = i == 0 ? PORT_RETRY_TIMES : 1;
            for (int attempt = 0; attempt < tries; attempt++) {
                try {
                    int real = Main.start(getFilesDir(), order[i], BuildInfo.VERSION);
                    prefs().edit().putInt(KEY_LAST_PORT, real).apply();
                    return real;
                } catch (Exception e) {
                    last = e;
                    if (attempt + 1 < tries) {
                        try {
                            Thread.sleep(PORT_RETRY_SLEEP_MS);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                        }
                    }
                }
            }
        }
        throw last == null ? new IllegalStateException("端口全被占用") : last;
    }

    /** 把 assets/web 解压到 filesDir/web；版本没变就跳过。 */
    private void unpackWeb() throws Exception {
        File dir = new File(getFilesDir(), "web");
        File stamp = new File(dir, ".version");
        if (stamp.exists() && new File(dir, "index.html").exists()) {
            try {
                String have = readSmall(stamp);
                if (BuildInfo.VERSION.equals(have.trim())) return;
            } catch (Throwable ignored) {
            }
        }
        deleteTree(dir);
        if (!dir.mkdirs() && !dir.exists()) throw new java.io.IOException("建不了 " + dir);
        copyAsset("web", dir);
        writeSmall(stamp, BuildInfo.VERSION);
    }

    private void copyAsset(String from, File to) throws Exception {
        AssetManager am = getAssets();
        String[] kids = am.list(from);
        if (kids == null || kids.length == 0) {
            InputStream in = am.open(from);
            OutputStream out = new FileOutputStream(to);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            out.close();
            return;
        }
        if (!to.exists() && !to.mkdirs() && !to.exists()) throw new java.io.IOException("建不了 " + to);
        for (String kid : kids) copyAsset(from + "/" + kid, new File(to, kid));
    }

    private static String readSmall(File f) throws Exception {
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        byte[] buf = new byte[(int) Math.min(4096, f.length() + 16)];
        int n = in.read(buf);
        in.close();
        return n <= 0 ? "" : new String(buf, 0, n, "UTF-8");
    }

    private static void writeSmall(File f, String text) throws Exception {
        FileOutputStream out = new FileOutputStream(f);
        out.write(text.getBytes("UTF-8"));
        out.close();
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    // ---------------------------------------------------------------- 基础工具

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private GradientDrawable box(int fill, int stroke, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radiusDp));
        if (stroke != 0) d.setStroke(dp(1), stroke);
        return d;
    }

    private TextView label(String s, int sizeSp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sizeSp);
        t.setTextColor(color);
        return t;
    }

    private Button button(String text, int fill, int stroke, int color) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTextColor(color);
        b.setBackground(box(fill, stroke, 14));
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(16), 0, dp(16), 0);
        return b;
    }

    private LinearLayout.LayoutParams wrap(int topDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(topDp);
        return p;
    }

    private LinearLayout.LayoutParams fixed(int heightDp, int topDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(heightDp));
        p.topMargin = dp(topDp);
        return p;
    }

    // ---------------------------------------------------------------- 界面

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(C_BG);

        web = new WebView(this);
        web.setBackgroundColor(C_BG);
        web.setVisibility(View.GONE);
        web.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWeb();
        root.addView(web);

        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorBox = buildError();
        root.addView(errorBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        try {
            getWindow().setStatusBarColor(C_BG);
            getWindow().setNavigationBarColor(C_BG);
        } catch (Throwable ignored) {
        }
    }

    private ScrollView buildSplash() {
        ScrollView sc = new ScrollView(this);
        sc.setFillViewport(true);
        sc.setBackgroundColor(C_BG);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(28), dp(96), dp(28), dp(36));
        sc.addView(col, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout logo = new FrameLayout(this);
        GradientDrawable ring = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{C_BRAND, C_ACCENT});
        ring.setShape(GradientDrawable.OVAL);
        logo.setBackground(ring);
        TextView mark = label("FE", 26, Color.WHITE);
        mark.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        mark.setGravity(Gravity.CENTER);
        logo.addView(mark, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        col.addView(logo, new LinearLayout.LayoutParams(dp(78), dp(78)));

        TextView name = label("Furry Everpony", 24, C_TEXT);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        col.addView(name, wrap(18));

        col.addView(label("独立即时通讯 · 数据都在手机里", 13, C_MUTED), wrap(6));

        splashTitle = label("正在启动…", 15, C_TEXT);
        splashTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        splashTitle.setGravity(Gravity.CENTER);
        col.addView(splashTitle, wrap(30));

        splashSub = label("", 12, C_MUTED);
        splashSub.setGravity(Gravity.CENTER);
        splashSub.setLineSpacing(dp(3), 1f);
        col.addView(splashSub, wrap(8));

        splashBar = new ProgressBar(this);
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(dp(28), dp(28));
        pbLp.topMargin = dp(22);
        col.addView(splashBar, pbLp);

        TextView foot = label("不连电脑也能用：注册、加好友、聊天、群聊都在本机。", 12, Color.parseColor("#5C6784"));
        foot.setGravity(Gravity.CENTER);
        col.addView(foot, wrap(30));

        Button join = button("连接电脑或朋友的实例", C_PANEL, C_LINE, C_TEXT);
        join.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askServer();
            }
        });
        col.addView(join, fixed(46, 18));

        return sc;
    }

    private LinearLayout buildError() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setBackgroundColor(C_BG);
        box.setPadding(dp(28), dp(130), dp(28), dp(36));
        box.setVisibility(View.GONE);

        errorText = label("启动失败", 16, C_TEXT);
        errorText.setGravity(Gravity.CENTER);
        errorText.setLineSpacing(dp(4), 1f);
        box.addView(errorText, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button retry = button("重试", C_BRAND, 0, Color.WHITE);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errorBox.setVisibility(View.GONE);
                startLocalServer();
            }
        });
        box.addView(retry, fixed(50, 26));

        Button other = button("连接别的实例", C_PANEL, C_LINE, C_TEXT);
        other.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askServer();
            }
        });
        box.addView(other, fixed(46, 10));

        Button local = button("回到本机模式", C_PANEL, C_LINE, C_TEXT);
        local.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                prefs().edit().remove(KEY_SERVER).apply();
                startLocalServer();
            }
        });
        box.addView(local, fixed(46, 10));

        Button quit = button("退出应用", C_PANEL, C_LINE, C_TEXT);
        quit.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        box.addView(quit, fixed(46, 10));

        return box;
    }

    private void configureWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " FurryEverponyApp/3.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "feAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(SHIM, null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showError("界面没加载出来\n" + error.getDescription() + "\n点重试重新启动本机服务。");
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (request != null && request.isForMainFrame() && response != null && response.getStatusCode() >= 500) {
                    showError("本机服务出错了（HTTP " + response.getStatusCode() + "）");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = cb;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    pendingFiles = null;
                    return false;
                }
            }
        });
    }

    private boolean handleUrl(String url) {
        if (url == null) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) {
            if (!currentBase.isEmpty() && url.startsWith(currentBase)) return false;
            if (url.startsWith("http://127.0.0.1")) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Throwable ignored) {
            }
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- 状态切换

    private void openWeb(String url) {
        currentBase = url;
        webShown = true;
        errorBox.setVisibility(View.GONE);
        splash.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        Notifier.clear(this);
        web.loadUrl(url);
    }

    private void showSplash(String title, String sub) {
        splash.setVisibility(View.VISIBLE);
        errorBox.setVisibility(View.GONE);
        web.setVisibility(View.GONE);
        splashBar.setVisibility(View.VISIBLE);
        splashTitle.setText(title == null ? "" : title);
        splashSub.setText(sub == null ? "" : sub);
    }

    private void showError(String message) {
        errorText.setText(message == null ? "启动失败" : message);
        errorBox.setVisibility(View.VISIBLE);
        splash.setVisibility(View.GONE);
        web.setVisibility(View.GONE);
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
        } catch (Throwable ignored) {
        }
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    protected void onResume() {
        super.onResume();
        if (webShown) Notifier.clear(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Notifier.clear(this);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFiles != null) {
                Uri[] out = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        out = new Uri[n];
                        for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        out = new Uri[]{data.getData()};
                    }
                }
                pendingFiles.onReceiveValue(out);
                pendingFiles = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (errorBox.getVisibility() == View.VISIBLE) {
            errorBox.setVisibility(View.GONE);
            startLocalServer();
            return;
        }
        if (webShown) {
            // 先让网页关掉最上层浮层（抽屉/弹窗），页面不处理再按浏览器历史退
            final int seq = ++backSeq;
            web.evaluateJavascript("(window.__feBack && window.__feBack()) ? '1' : '0'", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (seq != backSeq) return;
                    if (value != null && value.contains("1")) return;
                    fallbackBack();
                }
            });
            return;
        }
        super.onBackPressed();
    }

    /** 网页没有消费返回键时的兜底：先退浏览器历史，再两次返回退到后台 */
    private void fallbackBack() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            moveTaskToBack(true);
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次退到后台", Toast.LENGTH_SHORT).show();
    }

    // ---------------------------------------------------------------- 连接别的实例

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** 把「192.168.1.108」「192.168.1.108:7788」「http://host:port/」统一成 http://host:port */
    private static String normalizeBase(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        String rest = s.substring(s.indexOf("://") + 3);
        int slash = rest.indexOf('/');
        if (slash >= 0) rest = rest.substring(0, slash);
        if (rest.indexOf(':') < 0) s = s + ":" + PORT_FIRST;
        return s;
    }

    /** 连到别人的实例（电脑版或另一台手机）。只有连同一个实例，号码才互通。 */
    private void startRemote(final String base) {
        showSplash("正在连接…", base);
        new Thread(new Runnable() {
            @Override
            public void run() {
                String problem = null;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/health").openConnection();
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(6000);
                    int code = c.getResponseCode();
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    String text = in == null ? "" : readAllText(in);
                    c.disconnect();
                    if (code != 200 || !text.contains("version")) {
                        problem = "对方回的不是正常的服务（HTTP " + code + "）";
                    }
                } catch (Throwable t) {
                    problem = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                }
                final String err = problem;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (err == null) {
                            openWeb(base + "/");
                        } else {
                            showError("连不上 " + base + "\n" + err + "\n\n确认那台电脑开着，地址是「我的 → 关于」里显示的那个；也可以换回本机模式。");
                        }
                    }
                });
            }
        }).start();
    }

    private void askServer() {
        final EditText input = new EditText(this);
        input.setHint("192.168.1.108:7788");
        input.setTextColor(C_TEXT);
        input.setHintTextColor(C_MUTED);
        String saved = prefs().getString(KEY_SERVER, "");
        if (!saved.isEmpty()) input.setText(saved);
        new AlertDialog.Builder(this)
                .setTitle("连接别的实例")
                .setMessage("填电脑版「我的 → 关于」里显示的地址。连到同一个实例，号码才互通。")
                .setView(input)
                .setPositiveButton("连接", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        String base = normalizeBase(input.getText().toString());
                        if (base.isEmpty()) return;
                        prefs().edit().putString(KEY_SERVER, base).apply();
                        startRemote(base);
                    }
                })
                .setNeutralButton("回到本机模式", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        prefs().edit().remove(KEY_SERVER).apply();
                        startLocalServer();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private static String readAllText(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return new String(buf.toByteArray(), "UTF-8");
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("feAndroid");
            web.destroy();
        }
        super.onDestroy();
    }

    /** 给网页用的原生桥：WebView 里浏览器能力不全，缺的都从这里补。 */
    private class Bridge {
        @JavascriptInterface
        public void copy(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("furry-everpony", text));
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String version() {
            return BuildInfo.VERSION;
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            Notifier.post(MainActivity.this, title, body);
        }

        @JavascriptInterface
        public void toast(String text) {
            final String t = text == null ? "" : text;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, t, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public String server() {
            return currentBase;
        }

        /** 网页设置页用：打开「连接别的实例」对话框 */
        @JavascriptInterface
        public void switchServer() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    askServer();
                }
            });
        }

        /** true 表示当前是「连到别人实例」模式，false 是本机模式 */
        @JavascriptInterface
        public boolean remoteMode() {
            return !prefs().getString(KEY_SERVER, "").isEmpty();
        }
    }
}
