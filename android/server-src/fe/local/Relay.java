package fe.local;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 中继客户端：两台设备不在同一个网络、又都没有公网地址时，经一台公网中继服务器转发
 * 好友申请、同意回执和消息。中继只按实例 ID 转存原样 payload，不解析内容。
 *
 * 和电脑端 server/relay-client.js 是同一套协议：
 *   POST /api/relay/register  {instanceId, secret, addr, version}
 *   POST /api/relay/heartbeat {instanceId, secret}
 *   POST /api/relay/send      {from, secret, to, kind, payload}
 *   GET  /api/relay/pull?instanceId&secret&since&limit -> {events:[{id,from,kind,payload,at}], next, more}
 *   POST /api/relay/ack       {instanceId, secret, ids}
 */
public final class Relay {

  /* 轮询间隔：正式包 8 秒拉一次；联调测试用 -Dfe.relay.pull.ms=500 调快 */
  static final long PULL_MS = longProp("fe.relay.pull.ms", 8000L);
  static final long HEARTBEAT_MS = longProp("fe.relay.heartbeat.ms", 60000L);
  static final int TIMEOUT = 12000;

  private static long longProp(String key, long def) {
    try {
      String v = System.getProperty(key);
      if (v == null || v.trim().isEmpty()) return def;
      long n = Long.parseLong(v.trim());
      return n > 0 ? n : def;
    } catch (Exception e) {
      return def;
    }
  }

  private final Federation fed;
  private final SecureRandom rnd = new SecureRandom();
  private volatile boolean running;
  private volatile int generation;
  private volatile boolean registered;
  private volatile String lastError = "";
  private Thread loop;

  public Relay(Federation fed) {
    this.fed = fed;
  }

  /* ================= 地址 / 密钥 ================= */

  /** 中继地址整理：没写协议就按 http://，去掉结尾斜杠；不合规返回空串。 */
  public static String normalizeUrl(String raw) {
    if (raw == null) return "";
    String s = raw.trim();
    if (s.isEmpty()) return "";
    if (!s.regionMatches(true, 0, "http://", 0, 7) && !s.regionMatches(true, 0, "https://", 0, 8)) {
      s = "http://" + s;
    }
    while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
    try {
      URL u = new URL(s);
      String host = u.getHost();
      if (host == null || host.isEmpty()) return "";
      if (!"http".equals(u.getProtocol()) && !"https".equals(u.getProtocol())) return "";
      return s;
    } catch (Exception e) {
      return "";
    }
  }

  public String url() {
    return normalizeUrl(fed.metaGet("relay_url"));
  }

  public void setUrl(String raw) {
    fed.metaSet("relay_url", normalizeUrl(raw));
  }

  public boolean enabled() {
    return !url().isEmpty();
  }

  public String secret() {
    String s = fed.metaGet("relay_secret");
    if (s != null && s.length() >= 16) return s;
    byte[] b = new byte[24];
    rnd.nextBytes(b);
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < b.length; i++) {
      int v = b[i] & 0xff;
      if (v < 16) sb.append('0');
      sb.append(Integer.toHexString(v));
    }
    s = sb.toString();
    fed.metaSet("relay_secret", s);
    return s;
  }

  private long cursor() {
    try {
      return Long.parseLong(fed.metaGet("relay_cursor"));
    } catch (Exception e) {
      return 0L;
    }
  }

  private void setCursor(long v) {
    fed.metaSet("relay_cursor", String.valueOf(v));
  }

  /* ================= HTTP ================= */

  static final class Res {
    boolean ok;
    int status;
    String error = "";
    Map<String, Object> body = new LinkedHashMap<String, Object>();
  }

  private Res request(String path, String method, Object body) {
    Res r = new Res();
    String base = url();
    if (base.isEmpty()) {
      r.error = "还没配中继地址";
      return r;
    }
    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(base + path).openConnection();
      conn.setRequestMethod(method);
      conn.setConnectTimeout(TIMEOUT);
      conn.setReadTimeout(TIMEOUT);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      conn.setRequestProperty("Accept", "application/json");
      if (body != null) {
        conn.setDoOutput(true);
        byte[] data = Json.write(body).getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(data.length);
        OutputStream os = conn.getOutputStream();
        os.write(data);
        os.flush();
        os.close();
      }
      int status = conn.getResponseCode();
      InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      if (in != null) {
        byte[] chunk = new byte[4096];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
      }
      String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);
      r.status = status;
      r.ok = status >= 200 && status < 300;
      if (!text.trim().isEmpty()) {
        try {
          r.body = Json.obj(Json.parse(text));
        } catch (Exception e) {
          r.body = new LinkedHashMap<String, Object>();
        }
      }
      if (!r.ok) {
        String msg = str(r.body.get("error"));
        r.error = msg.isEmpty() ? ("中继返回 " + status) : msg;
      }
      return r;
    } catch (Exception e) {
      r.status = 0;
      r.error = "连不上中继";
      return r;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  private static String str(Object v) {
    return v == null ? "" : String.valueOf(v);
  }

  private static String enc(String s) {
    try {
      return URLEncoder.encode(s == null ? "" : s, "UTF-8");
    } catch (Exception e) {
      return "";
    }
  }

  /* ================= 协议动作 ================= */

  public Map<String, Object> register() {
    Map<String, Object> body = new LinkedHashMap<String, Object>();
    body.put("instanceId", fed.instanceId());
    body.put("secret", secret());
    List<String> mine = fed.myAddresses();
    body.put("addr", mine.isEmpty() ? "" : mine.get(0));
    body.put("version", fed.version());
    Res r = request("/api/relay/register", "POST", body);
    registered = r.ok;
    if (!r.ok) lastError = r.error;
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("ok", Boolean.valueOf(r.ok));
    out.put("error", r.error);
    out.put("queued", r.body.get("queued"));
    return out;
  }

  public Map<String, Object> heartbeat() {
    Map<String, Object> body = new LinkedHashMap<String, Object>();
    body.put("instanceId", fed.instanceId());
    body.put("secret", secret());
    Res r = request("/api/relay/heartbeat", "POST", body);
    if (!r.ok) lastError = r.error;
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("ok", Boolean.valueOf(r.ok));
    out.put("error", r.error);
    return out;
  }

  /** 交给中继转发一条事件；对方离线也会存着，等它上线来拉。 */
  public Map<String, Object> send(String toInstance, String kind, Object payload) {
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    String to = toInstance == null ? "" : toInstance.trim();
    if (to.isEmpty()) {
      out.put("ok", Boolean.FALSE);
      out.put("error", "不知道对方实例 ID");
      return out;
    }
    if (!enabled()) {
      out.put("ok", Boolean.FALSE);
      out.put("error", "还没配中继地址");
      return out;
    }
    Map<String, Object> body = new LinkedHashMap<String, Object>();
    body.put("from", fed.instanceId());
    body.put("secret", secret());
    body.put("to", to);
    body.put("kind", kind);
    body.put("payload", payload == null ? new LinkedHashMap<String, Object>() : payload);
    Res r = request("/api/relay/send", "POST", body);
    if (!r.ok) lastError = r.error;
    out.put("ok", Boolean.valueOf(r.ok));
    out.put("error", r.error);
    out.put("id", r.body.get("id"));
    out.put("online", r.body.get("online"));
    return out;
  }

  /** 拉一轮事件并逐条交给联邦层处理；处理成功才回执，失败的留到下一轮。 */
  public int pullOnce() {
    if (!enabled()) return 0;
    String q = "/api/relay/pull?instanceId=" + enc(fed.instanceId()) + "&secret=" + enc(secret())
        + "&since=" + cursor() + "&limit=50";
    Res r = request(q, "GET", null);
    if (!r.ok) {
      lastError = r.error;
      return 0;
    }
    List<Object> events = Json.arr(r.body.get("events"));
    if (events == null || events.isEmpty()) {
      registered = true;
      return 0;
    }
    List<Object> ackIds = new ArrayList<Object>();
    int handled = 0;
    for (Object o : events) {
      Map<String, Object> ev = Json.obj(o);
      long id = 0L;
      try {
        id = Long.parseLong(str(ev.get("id")));
      } catch (Exception e) {
        id = 0L;
      }
      String kind = str(ev.get("kind"));
      String from = str(ev.get("from"));
      Map<String, Object> payload = Json.obj(ev.get("payload"));
      Map<String, Object> res;
      try {
        res = fed.handleRelayEvent(kind, payload, from);
      } catch (Exception e) {
        res = new LinkedHashMap<String, Object>();
        res.put("error", "处理中继事件出错：" + e.getMessage());
      }
      if (res != null && res.containsKey("error")) {
        lastError = str(res.get("error"));
        break;
      }
      ackIds.add(Long.valueOf(id));
      handled++;
      if (id > 0) setCursor(id);
    }
    if (!ackIds.isEmpty()) {
      Map<String, Object> body = new LinkedHashMap<String, Object>();
      body.put("instanceId", fed.instanceId());
      body.put("secret", secret());
      body.put("ids", ackIds);
      Res ack = request("/api/relay/ack", "POST", body);
      if (!ack.ok) lastError = ack.error;
    }
    return handled;
  }

  /* ================= 后台线程 ================= */

  public void start() {
    if (running && loop != null) return;
    running = true;
    final int gen = ++generation;
    Thread self = new Thread(new Runnable() {
      public void run() {
        long nextPull = 0L;
        long nextBeat = 0L;
        boolean first = true;
        while (running && generation == gen) {
          try {
            if (enabled()) {
              long now = System.currentTimeMillis();
              if (first) {
                register();
                first = false;
                nextBeat = now + HEARTBEAT_MS;
                nextPull = now;
              }
              if (now >= nextBeat) {
                heartbeat();
                nextBeat = now + HEARTBEAT_MS;
              }
              if (now >= nextPull) {
                pullOnce();
                nextPull = now + PULL_MS;
              }
            } else {
              first = true;
            }
          } catch (Exception e) {
            lastError = e.getMessage() == null ? "中继轮询出错" : e.getMessage();
          }
          try {
            Thread.sleep(1000L);
          } catch (InterruptedException e) {
            return;
          }
        }
      }
    });
    self.setDaemon(true);
    loop = self;
    self.start();
  }

  public void stop() {
    running = false;
    generation++;
    loop = null;
  }

  public Map<String, Object> status() {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("url", url());
    m.put("enabled", Boolean.valueOf(enabled()));
    m.put("running", Boolean.valueOf(running));
    m.put("registered", Boolean.valueOf(registered));
    m.put("instanceId", fed.instanceId());
    m.put("cursor", Long.valueOf(cursor()));
    m.put("lastError", lastError == null ? "" : lastError);
    return m;
  }
}
