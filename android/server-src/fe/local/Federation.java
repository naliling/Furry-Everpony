package fe.local;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 实例互联：让手机和电脑两台设备互相找到、互加好友、互发消息。
 *
 * 协议与电脑版 server/federation.js 一一对应，两边可以直接对话：
 * 邀请码（FEINV1. 开头的 base64url）、握手、同意、投递、局域网 UDP 广播发现。
 */
public final class Federation {

  static final int DEFAULT_PORT = 7788;
  static final int DISCOVERY_PORT = 7799;
  static final long INVITE_TTL = 24L * 3600L * 1000L;
  static final int MAX_ATTEMPTS = 60;
  static final String INVITE_PREFIX = "FEINV1.";

  private static final Pattern NUMBER_RE = Pattern.compile("^[1-9][0-9]{4,11}$");
  private static final Pattern HOSTPORT_RE = Pattern.compile("^[A-Za-z0-9.\\-]+(:[0-9]{1,5})?$");
  private static final Pattern BRACKET_RE = Pattern.compile("^\\[[0-9a-fA-F:]+\\](:[0-9]{1,5})?$");
  private static final String[] KINDS = {"text", "image", "file", "voice", "forward", "merge"};
  private static final char[] B64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

  /** 收到对端投递的消息后的回调（手机上不跑 Bot，留着给以后用）。 */
  public interface DeliveredHook {
    void delivered(long convId, Map<String, Object> sender, long messageId, String body);
  }

  private final Api api;
  private final Store store;
  private final File dataDir;
  private final int port;
  private final String version;
  private final SecureRandom rnd = new SecureRandom();
  /** 局域网里发现的其它实例：instanceId -> {addr, port, version, lastSeen, numbers} */
  private final Map<String, Map<String, Object>> peers = new LinkedHashMap<String, Map<String, Object>>();
  private volatile boolean running;
  private Thread flushThread;
  private Thread udpThread;
  private DatagramSocket udpSocket;
  private volatile DeliveredHook deliveredHook;
  /** 跨网络兜底的中继客户端（没配地址时为 null 或 enabled()=false，功能照常走直连）。 */
  private volatile Relay relay;

  public Federation(Api api, Store store, File dataDir, int port, String version) {
    this.api = api;
    this.store = store;
    this.dataDir = dataDir;
    this.port = port;
    this.version = version;
  }

  public void setRelay(Relay client) {
    this.relay = client;
  }

  public Relay relayClient() {
    return relay;
  }

  public String version() {
    return version;
  }

  public void setDeliveredHook(DeliveredHook hook) {
    this.deliveredHook = hook;
  }

  /* ================= 基础工具 ================= */

  private static Map<String, Object> out() {
    return new LinkedHashMap<String, Object>();
  }

  private static Map<String, Object> err(int code, String message) {
    Map<String, Object> m = out();
    m.put("error", message);
    m.put("code", Integer.valueOf(code));
    return m;
  }

  private static String str(Object v) {
    if (v == null) return "";
    return String.valueOf(v);
  }

  private static long lng(Object v) {
    if (v instanceof Number) return ((Number) v).longValue();
    try {
      return Long.parseLong(String.valueOf(v));
    } catch (Exception e) {
      return 0L;
    }
  }

  private static String jsonStr(Map<String, Object> m, String key) {
    if (m == null) return "";
    Object v = m.get(key);
    return v == null ? "" : String.valueOf(v);
  }

  private static String hex(byte[] b) {
    StringBuilder sb = new StringBuilder(b.length * 2);
    for (int i = 0; i < b.length; i++) {
      int v = b[i] & 0xff;
      if (v < 16) sb.append('0');
      sb.append(Integer.toHexString(v));
    }
    return sb.toString();
  }

  private String randHex(int bytes) {
    byte[] b = new byte[bytes];
    rnd.nextBytes(b);
    return hex(b);
  }

  static String b64url(byte[] d) {
    StringBuilder sb = new StringBuilder();
    int i = 0;
    while (i < d.length) {
      int b0 = d[i++] & 0xff;
      int b1 = i < d.length ? d[i++] & 0xff : -1;
      int b2 = i < d.length ? d[i++] & 0xff : -1;
      sb.append(B64[b0 >> 2]);
      sb.append(B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : (b1 >> 4))]);
      if (b1 < 0) break;
      sb.append(B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : (b2 >> 6))]);
      if (b2 < 0) break;
      sb.append(B64[b2 & 63]);
    }
    return sb.toString();
  }

  static byte[] unb64url(String s) {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int bits = 0;
    int acc = 0;
    for (int i = 0; i < s.length(); i++) {
      int v = b64Index(s.charAt(i));
      if (v < 0) throw new IllegalArgumentException("邀请码里有不认识的字符");
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        buf.write((acc >> bits) & 0xff);
      }
    }
    return buf.toByteArray();
  }

  private static int b64Index(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
  }

  /** 把用户填的地址整理成 host:port；不合规返回空串。 */
  public static String normalizeAddr(String raw) {
    if (raw == null) return "";
    String s = raw.trim();
    if (s.regionMatches(true, 0, "http://", 0, 7)) s = s.substring(7);
    else if (s.regionMatches(true, 0, "https://", 0, 8)) s = s.substring(8);
    while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
    int slash = s.indexOf('/');
    if (slash >= 0) s = s.substring(0, slash);
    if (s.isEmpty()) return "";
    if (!HOSTPORT_RE.matcher(s).matches() && !BRACKET_RE.matcher(s).matches()) return "";
    if (!hasPort(s)) s = s + ":" + DEFAULT_PORT;
    return s;
  }

  private static boolean hasPort(String s) {
    int bracket = s.lastIndexOf(']');
    if (bracket >= 0) return s.indexOf(':', bracket) >= 0;
    return s.indexOf(':') >= 0;
  }

  /* ================= 本机地址 ================= */

  /** 局域网 IPv4 地址（手机连 Wi-Fi 后就是这一串）。 */
  public List<String> lanAddrs() {
    List<String> list = new ArrayList<String>();
    try {
      Enumeration<NetworkInterface> nics = NetworkInterface.getNetworkInterfaces();
      while (nics != null && nics.hasMoreElements()) {
        NetworkInterface nic = nics.nextElement();
        if (!nic.isUp() || nic.isLoopback()) continue;
        Enumeration<InetAddress> addrs = nic.getInetAddresses();
        while (addrs.hasMoreElements()) {
          InetAddress a = addrs.nextElement();
          if (!(a instanceof Inet4Address)) continue;
          if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
          String ip = a.getHostAddress();
          if (ip == null || ip.isEmpty()) continue;
          String url = "http://" + ip + ":" + port;
          if (!list.contains(url)) list.add(url);
        }
      }
    } catch (Exception e) {
      /* 拿不到网卡就当没有局域网地址，不影响其它功能 */
    }
    return list;
  }

  /** 公网 IPv6（家用宽带、手机流量大多有），跨网络互联靠它。 */
  public List<String> v6Addresses() {
    List<String> list = new ArrayList<String>();
    try {
      Enumeration<NetworkInterface> nics = NetworkInterface.getNetworkInterfaces();
      while (nics != null && nics.hasMoreElements()) {
        NetworkInterface nic = nics.nextElement();
        if (!nic.isUp() || nic.isLoopback()) continue;
        Enumeration<InetAddress> addrs = nic.getInetAddresses();
        while (addrs.hasMoreElements()) {
          InetAddress a = addrs.nextElement();
          if (!(a instanceof Inet6Address)) continue;
          if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
          String ip = a.getHostAddress();
          if (ip == null) continue;
          int pct = ip.indexOf('%');
          if (pct >= 0) ip = ip.substring(0, pct);
          String addr = normalizeAddr("[" + ip + "]:" + port);
          if (!addr.isEmpty() && !list.contains(addr)) list.add(addr);
        }
      }
    } catch (Exception e) {
      /* 忽略 */
    }
    return list;
  }

  public String publicAddr() {
    return metaGet("public_addr");
  }

  public void setPublicAddr(String raw) {
    String clean = normalizeAddr(raw);
    metaSet("public_addr", clean);
  }

  /** 自动通过：拿我邀请码/二维码来加我的人直接成为好友，不用我在界面上点同意（默认开） */
  public boolean autoAccept() {
    return !"0".equals(metaGet("auto_accept"));
  }

  public void setAutoAccept(boolean on) {
    metaSet("auto_accept", on ? "1" : "0");
  }

  public String instanceId() {
    String id = metaGet("instance_id");
    if (!id.isEmpty()) return id;
    id = randHex(16);
    metaSet("instance_id", id);
    return id;
  }

  String metaGet(String key) {
    Map<String, Object> row = api.findOne("instance_meta", "key", key);
    return row == null ? "" : api.strOf(row, "value");
  }

  void metaSet(String key, String value) {
    Map<String, Object> row = api.findOne("instance_meta", "key", key);
    if (row == null) {
      row = out();
      row.put("id", Long.valueOf(api.nextIdOf("instance_meta")));
      row.put("key", key);
      row.put("value", value);
      api.insertRow("instance_meta", row);
    } else {
      row.put("value", value);
    }
    api.saveAll();
  }

  /** 自己所有对外可用的地址：填的公网地址 > IPv6 > 局域网。 */
  public List<String> myAddresses() {
    List<String> list = new ArrayList<String>();
    String pa = normalizeAddr(publicAddr());
    if (!pa.isEmpty()) list.add(pa);
    for (String a : v6Addresses()) if (!list.contains(a)) list.add(a);
    for (String a : lanAddrs()) {
      String clean = normalizeAddr(a);
      if (!clean.isEmpty() && !list.contains(clean)) list.add(clean);
    }
    return list;
  }

  public Map<String, Object> info() {
    Map<String, Object> m = out();
    m.put("instanceId", instanceId());
    m.put("version", version);
    m.put("port", Integer.valueOf(port));
    m.put("boundToLan", Boolean.TRUE);
    m.put("lanUrls", new ArrayList<Object>(lanAddrs()));
    m.put("publicAddr", publicAddr());
    m.put("publicV6", new ArrayList<Object>(v6Addresses()));
    m.put("myAddresses", new ArrayList<Object>(myAddresses()));
    m.put("autoAccept", Boolean.valueOf(autoAccept()));
    m.put("local", Boolean.TRUE);
    if (relay != null) m.put("relay", relay.status());
    return m;
  }

  /* ================= 邀请码 ================= */

  public Map<String, Object> makeInvite(Map<String, Object> me) {
    List<Object> list = new ArrayList<Object>();
    String pa = normalizeAddr(publicAddr());
    if (!pa.isEmpty()) list.add(pa);
    for (String a : v6Addresses()) if (!list.contains(a)) list.add(a);
    for (String a : lanAddrs()) {
      String clean = normalizeAddr(a);
      if (!clean.isEmpty() && !list.contains(clean)) list.add(clean);
    }
    String relayUrl = relay != null && relay.enabled() ? relay.url() : "";
    if (list.isEmpty() && relayUrl.isEmpty()) return null;
    Map<String, Object> payload = out();
    payload.put("v", Integer.valueOf(1));
    payload.put("a", list);
    payload.put("n", api.strOf(me, "number"));
    payload.put("k", api.strOf(me, "nickname"));
    payload.put("e", Long.valueOf(System.currentTimeMillis() + INVITE_TTL));
    payload.put("i", instanceId());
    if (!relayUrl.isEmpty()) payload.put("r", relayUrl);
    String json = Json.write(payload);
    Map<String, Object> res = out();
    res.put("code", INVITE_PREFIX + b64url(json.getBytes(StandardCharsets.UTF_8)));
    res.put("expiresAt", payload.get("e"));
    res.put("addrs", list);
    res.put("instanceId", instanceId());
    res.put("relay", relayUrl);
    return res;
  }

  public Map<String, Object> parseInvite(String code) {
    String s = code == null ? "" : code.trim();
    if (!s.startsWith(INVITE_PREFIX)) {
      return err(400, "这不是邀请码（应该以 FEINV1. 开头）");
    }
    Map<String, Object> obj;
    try {
      String body = s.substring(INVITE_PREFIX.length());
      obj = Json.obj(Json.parse(new String(unb64url(body), StandardCharsets.UTF_8)));
    } catch (Exception e) {
      return err(400, "邀请码不完整，让对方重新复制一次");
    }
    if (lng(obj.get("v")) != 1L) {
      return err(400, "这个邀请码的版本不认识，让对方升级后再生成");
    }
    long expiresAt = lng(obj.get("e"));
    if (expiresAt > 0 && expiresAt < System.currentTimeMillis()) {
      return err(400, "邀请码已经过期了，让对方重新生成一个");
    }
    String number = jsonStr(obj, "n").trim();
    if (!NUMBER_RE.matcher(number).matches()) {
      return err(400, "邀请码里的号码不对，可能复制时漏了字符");
    }
    List<Object> addrs = new ArrayList<Object>();
    for (Object o : Json.arr(obj.get("a"))) {
      String clean = normalizeAddr(str(o));
      if (!clean.isEmpty() && !addrs.contains(clean)) addrs.add(clean);
    }
    String instanceId = jsonStr(obj, "i").trim();
    String relayUrl = Relay.normalizeUrl(jsonStr(obj, "r"));
    if (addrs.isEmpty() && (instanceId.isEmpty() || relayUrl.isEmpty())) {
      return err(400, "邀请码里没有可用的地址");
    }
    Map<String, Object> res = out();
    res.put("number", number);
    res.put("nickname", jsonStr(obj, "k"));
    res.put("addrs", addrs);
    res.put("expiresAt", Long.valueOf(expiresAt));
    res.put("instanceId", instanceId);
    res.put("relay", relayUrl);
    return res;
  }

  /* ================= 访问对端 ================= */

  static final class PeerResult {
    boolean ok;
    int status;
    Map<String, Object> body = new LinkedHashMap<String, Object>();
    String error = "";
  }

  PeerResult callPeer(String addr, String path, String method, Object body, Map<String, String> headers,
      int timeoutMs) {
    PeerResult r = new PeerResult();
    String clean = normalizeAddr(addr);
    if (clean.isEmpty()) {
      r.error = "地址格式不对";
      return r;
    }
    HttpURLConnection conn = null;
    try {
      URL url = new URL("http://" + clean + path);
      conn = (HttpURLConnection) url.openConnection();
      conn.setRequestMethod(method);
      conn.setConnectTimeout(timeoutMs);
      conn.setReadTimeout(timeoutMs);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      conn.setRequestProperty("Accept", "application/json");
      if (headers != null) {
        for (Map.Entry<String, String> e : headers.entrySet()) {
          conn.setRequestProperty(e.getKey(), e.getValue());
        }
      }
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
      String text = readAll(in);
      r.status = status;
      r.ok = status >= 200 && status < 300;
      if (!text.trim().isEmpty()) {
        try {
          r.body = Json.obj(Json.parse(text));
        } catch (Exception e) {
          r.body = new LinkedHashMap<String, Object>();
        }
      }
      return r;
    } catch (SocketTimeoutException e) {
      r.status = 0;
      r.error = "超时";
      return r;
    } catch (Exception e) {
      r.status = 0;
      r.error = "连不上";
      return r;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  private static String readAll(InputStream in) throws Exception {
    if (in == null) return "";
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    byte[] chunk = new byte[4096];
    int n;
    while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
    in.close();
    return new String(buf.toByteArray(), StandardCharsets.UTF_8);
  }

  /* ================= 远端账号 ================= */

  private boolean hasPending(long fromId, long toId) {
    for (Map<String, Object> r : store.rows("friend_requests")) {
      if (lng(r.get("from_id")) == fromId && lng(r.get("to_id")) == toId
          && "pending".equals(str(r.get("status")))) return true;
    }
    return false;
  }

  /** 本地是否已经有这个号码的账号（含远端镜像）。 */
  private Map<String, Object> localAccount(String number) {
    return api.accountByNumberOf(number);
  }

  /**
   * 给远端号码建/更新一个本地镜像账号（type=remote）。
   * 号码被本地真人占用时返回 null（冲突）。
   */
  private Map<String, Object> upsertRemote(String number, String nickname, String avatar, String addr,
      String instance) {
    Map<String, Object> acc = localAccount(number);
    if (acc != null && !"remote".equals(str(acc.get("type")))) return null;
    if (acc == null) {
      acc = out();
      acc.put("id", Long.valueOf(api.nextIdOf("accounts")));
      acc.put("number", number);
      acc.put("type", "remote");
      acc.put("nickname", nickname.isEmpty() ? number : nickname);
      acc.put("bio", "");
      acc.put("password_hash", "");
      acc.put("created_at", Long.valueOf(System.currentTimeMillis()));
      acc.put("avatar", avatar);
      acc.put("card_bg", "");
      acc.put("photos", "[]");
      acc.put("status", "");
      acc.put("owner_id", Long.valueOf(0));
      acc.put("is_public", Long.valueOf(0));
      api.insertRow("accounts", acc);
    } else {
      if (!nickname.isEmpty()) acc.put("nickname", nickname);
      if (!avatar.isEmpty()) acc.put("avatar", avatar);
    }
    if (!addr.isEmpty()) acc.put("remote_addr", addr);
    if (!instance.isEmpty()) acc.put("remote_instance", instance);
    if (!acc.containsKey("remote_secret")) acc.put("remote_secret", "");
    api.saveAll();
    return acc;
  }

  private Map<String, Object> remoteByNumber(String number) {
    Map<String, Object> acc = localAccount(number);
    if (acc == null || !"remote".equals(str(acc.get("type")))) return null;
    return acc;
  }

  private Map<String, Object> accountBrief(Map<String, Object> acc, boolean remote, String addr) {
    Map<String, Object> m = out();
    m.put("number", api.strOf(acc, "number"));
    m.put("nickname", api.strOf(acc, "nickname"));
    m.put("avatar", api.strOf(acc, "avatar"));
    m.put("bio", api.strOf(acc, "bio"));
    m.put("type", api.strOf(acc, "type"));
    m.put("remote", Boolean.valueOf(remote));
    m.put("addr", addr);
    return m;
  }

  /* ================= 查号 / 发申请 ================= */

  public Map<String, Object> lookup(Map<String, Object> me, String addr, String number) {
    String clean = normalizeAddr(addr);
    long meId = api.numOf(me, "id");
    if (clean.isEmpty()) {
      Map<String, Object> acc = localAccount(number);
      if (acc == null) return err(404, "没有这个号码");
      Map<String, Object> res = out();
      res.put("account", accountBrief(acc, false, ""));
      res.put("isFriend", Boolean.valueOf(api.friendsOf(meId, api.idOf(acc))));
      res.put("hasPending", Boolean.valueOf(hasPending(meId, api.idOf(acc))));
      return res;
    }
    PeerResult r = callPeer(clean, "/api/federation/profile?number=" + number, "GET", null, null, 6000);
    if (!r.ok) {
      String msg = r.status == 404 ? jsonStr(r.body, "error") : "";
      return err(404, msg.isEmpty() ? "对方实例连不上" : msg);
    }
    Map<String, Object> acc = Json.obj(r.body.get("account"));
    Map<String, Object> mirror = localAccount(number);
    boolean isFriend = false;
    boolean pending = false;
    if (mirror != null && "remote".equals(str(mirror.get("type")))) {
      isFriend = api.friendsOf(meId, api.idOf(mirror));
      pending = hasPending(meId, api.idOf(mirror));
    }
    Map<String, Object> res = out();
    res.put("account", accountBrief(acc, true, clean));
    res.put("isFriend", Boolean.valueOf(isFriend));
    res.put("hasPending", Boolean.valueOf(pending));
    res.put("instanceId", jsonStr(r.body, "instanceId"));
    return res;
  }

  public Map<String, Object> sendRequest(Map<String, Object> me, String addr, String number, String message) {
    return sendRequest(me, addr, number, message, "");
  }

  /**
   * 发好友申请：先直连；直连不通但知道对方实例 ID 且配了中继时，交给中继排队，
   * 对方上线后自己来拉（发送方不用一直在线，对方也不用有公网地址）。
   */
  public Map<String, Object> sendRequest(Map<String, Object> me, String addr, String number, String message,
      String knownInstance) {
    String clean = normalizeAddr(addr);
    String known = knownInstance == null ? "" : knownInstance.trim();
    if (known.isEmpty()) {
      Map<String, Object> mirror = remoteByNumber(number);
      if (mirror != null) known = api.strOf(mirror, "remote_instance");
    }
    boolean relayReady = relay != null && relay.enabled() && !known.isEmpty();
    if (clean.isEmpty() && !relayReady) return err(400, "实例地址格式不对");
    if (api.strOf(me, "number").equals(number)) return err(400, "不能加自己");
    List<String> mine = myAddresses();
    Map<String, Object> body = out();
    body.put("from_instance", instanceId());
    body.put("from_addr", mine.isEmpty() ? "" : mine.get(0));
    body.put("from_addrs", new ArrayList<Object>(mine));
    body.put("from_number", api.strOf(me, "number"));
    body.put("from_nickname", api.strOf(me, "nickname"));
    body.put("from_avatar", api.strOf(me, "avatar"));
    body.put("to_number", number);
    body.put("message", message == null ? "" : message);
    PeerResult r = null;
    if (!clean.isEmpty()) {
      r = callPeer(clean, "/api/federation/handshake", "POST", body, null, 8000);
      if (r.ok) {
        Map<String, Object> res = out();
        res.put("ok", Boolean.TRUE);
        res.put("pending", Boolean.TRUE);
        if (Boolean.TRUE.equals(r.body.get("already"))) {
          res.put("already", Boolean.TRUE);
        }
        if (Boolean.TRUE.equals(r.body.get("friend"))) {
          res.put("friend", Boolean.TRUE);
        }
        return res;
      }
      String msg = jsonStr(r.body, "error");
      if (r.status == 404) return err(404, msg.isEmpty() ? "对方没有这个号码" : msg);
      if (r.status == 409) return err(409, msg.isEmpty() ? "这个号码在本实例已被占用" : msg);
      if (r.status == 429) return err(429, "对方实例太忙，稍后再试");
    }
    if (relayReady) {
      Map<String, Object> sent = relay.send(known, "handshake", body);
      if (Boolean.TRUE.equals(sent.get("ok"))) {
        Map<String, Object> res = out();
        res.put("ok", Boolean.TRUE);
        res.put("pending", Boolean.TRUE);
        res.put("via", "relay");
        res.put("queued", Boolean.TRUE);
        res.put("online", sent.get("online"));
        return res;
      }
      return err(502, "直连和中继都没发出去（" + str(sent.get("error")) + "）");
    }
    String msg = r == null ? "" : jsonStr(r.body, "error");
    if (r != null && r.status == 0) {
      return err(502, "对方实例连不上（" + (r.error.isEmpty() ? "网络不通" : r.error) + "）");
    }
    if (r == null) return err(502, "对方实例连不上");
    return err(r.status, msg.isEmpty() ? "对方实例拒绝了这次申请" : msg);
  }

  /* ================= 对端调过来的接口 ================= */

  public Map<String, Object> handleHandshake(Map<String, Object> body) {
    String toNumber = jsonStr(body, "to_number").trim();
    String fromNumber = jsonStr(body, "from_number").trim();
    if (!NUMBER_RE.matcher(toNumber).matches() || !NUMBER_RE.matcher(fromNumber).matches()) {
      return err(400, "号码格式不对");
    }
    Map<String, Object> target = localAccount(toNumber);
    String targetType = target == null ? "" : str(target.get("type"));
    if (target == null || !("user".equals(targetType) || "bot".equals(targetType))) {
      return err(404, "没有这个号码");
    }
    if (fromNumber.equals(toNumber)) return err(400, "不能加自己");
    String addr = normalizeAddr(jsonStr(body, "from_addr"));
    if (addr.isEmpty()) addr = normalizeAddr(jsonStr(body, "from_addr_hint"));
    Map<String, Object> mirror = upsertRemote(fromNumber, jsonStr(body, "from_nickname"),
        jsonStr(body, "from_avatar"), addr, jsonStr(body, "from_instance"));
    if (mirror == null) return err(409, "这个号码在本实例已被占用");
    Map<String, Object> res = out();
    long targetId = api.idOf(target);
    long mirrorId = api.idOf(mirror);
    if (api.friendsOf(targetId, mirrorId)) {
      /* 已经是好友也要补发一次回执：对方可能重装/换实例/上次回执丢了，只回「已经是好友」它永远补不上 */
      Map<String, Object> again = notifyAccepted(mirror, target);
      res.put("ok", Boolean.TRUE);
      res.put("already", Boolean.TRUE);
      res.put("friend", Boolean.valueOf(Boolean.TRUE.equals(again.get("ok"))));
      return res;
    }
    if (hasPending(mirrorId, targetId)) {
      res.put("ok", Boolean.TRUE);
      res.put("pending", Boolean.TRUE);
      return res;
    }
    /* 自动通过：对方拿我的邀请码/二维码来加，就不用再等我在手机上点「同意」 */
    if (autoAccept()) {
      Map<String, Object> acc = notifyAccepted(mirror, target);
      if (Boolean.TRUE.equals(acc.get("ok"))) {
        res.put("ok", Boolean.TRUE);
        res.put("friend", Boolean.TRUE);
        res.put("auto", Boolean.TRUE);
        return res;
      }
    }
    Map<String, Object> row = out();
    row.put("id", Long.valueOf(api.nextIdOf("friend_requests")));
    row.put("from_id", Long.valueOf(mirrorId));
    row.put("to_id", Long.valueOf(targetId));
    String msg = jsonStr(body, "message").trim();
    if (msg.length() > 120) msg = msg.substring(0, 120);
    row.put("message", msg);
    row.put("status", "pending");
    row.put("created_at", Long.valueOf(System.currentTimeMillis()));
    api.insertRow("friend_requests", row);
    api.saveAll();
    res.put("ok", Boolean.TRUE);
    res.put("pending", Boolean.TRUE);
    return res;
  }

  /** 我同意了对方的好友申请：先让对方那边也建立好友，再落本地，避免单边好友。 */
  public Map<String, Object> notifyAccepted(Map<String, Object> mirror, Map<String, Object> me) {
    String addr = normalizeAddr(api.strOf(mirror, "remote_addr"));
    String known = api.strOf(mirror, "remote_instance");
    boolean relayReady = relay != null && relay.enabled() && !known.isEmpty();
    if (addr.isEmpty() && !relayReady) {
      Map<String, Object> m = out();
      m.put("ok", Boolean.FALSE);
      m.put("error", "缺少对方实例地址");
      return m;
    }
    String secret = randHex(24);
    List<String> mine = myAddresses();
    Map<String, Object> body = out();
    body.put("instance_id", instanceId());
    body.put("secret", secret);
    body.put("from_number", api.strOf(me, "number"));
    body.put("to_number", api.strOf(mirror, "number"));
    body.put("nickname", api.strOf(me, "nickname"));
    body.put("avatar", api.strOf(me, "avatar"));
    body.put("addr", mine.isEmpty() ? "" : mine.get(0));
    PeerResult r = addr.isEmpty() ? null : callPeer(addr, "/api/federation/accept", "POST", body, null, 8000);
    if (r == null || !r.ok) {
      if (relayReady) {
        Map<String, Object> sent = relay.send(known, "accept", body);
        if (Boolean.TRUE.equals(sent.get("ok"))) {
          mirror.put("remote_secret", secret);
          api.saveAll();
          api.makeFriendsOf(api.numOf(me, "id"), api.idOf(mirror));
          Map<String, Object> m = out();
          m.put("ok", Boolean.TRUE);
          m.put("via", "relay");
          m.put("queued", Boolean.TRUE);
          return m;
        }
      }
      Map<String, Object> m = out();
      m.put("ok", Boolean.FALSE);
      String msg = r == null ? "" : jsonStr(r.body, "error");
      if (msg.isEmpty()) msg = "对方实例没连上，好友还没建立成功";
      m.put("error", msg);
      return m;
    }
    mirror.put("remote_secret", secret);
    if (!mine.isEmpty()) mirror.put("remote_addr", mine.isEmpty() ? addr : api.strOf(mirror, "remote_addr"));
    api.saveAll();
    api.makeFriendsOf(api.numOf(me, "id"), api.idOf(mirror));
    Map<String, Object> m = out();
    m.put("ok", Boolean.TRUE);
    return m;
  }

  /** 对端同意了申请：保存密钥、建立好友关系。 */
  public Map<String, Object> handleAccept(Map<String, Object> body) {
    String fromNumber = jsonStr(body, "from_number").trim();
    String secret = jsonStr(body, "secret").trim();
    if (fromNumber.isEmpty() || secret.isEmpty()) return err(400, "参数不全");
    String toNumber = jsonStr(body, "to_number").trim();
    Map<String, Object> me = localAccount(toNumber);
    if (me == null) return err(404, "没有这个号码");
    String addr = normalizeAddr(jsonStr(body, "addr"));
    Map<String, Object> mirror = upsertRemote(fromNumber, jsonStr(body, "nickname"),
        jsonStr(body, "avatar"), addr, jsonStr(body, "instance_id"));
    if (mirror == null) return err(409, "这个号码在本实例已被占用");
    mirror.put("remote_secret", secret);
    api.saveAll();
    long meId = api.idOf(me);
    long mirrorId = api.idOf(mirror);
    api.makeFriendsOf(meId, mirrorId);
    for (Map<String, Object> r : store.rows("friend_requests")) {
      if (lng(r.get("from_id")) == mirrorId && lng(r.get("to_id")) == meId
          && "pending".equals(str(r.get("status")))) {
        r.put("status", "accepted");
      }
    }
    api.saveAll();
    Map<String, Object> res = out();
    res.put("ok", Boolean.TRUE);
    return res;
  }

  /** 对端投递消息过来：落库到对应会话。 */
  public Map<String, Object> handleDeliver(Map<String, String> headers, Map<String, Object> body) {
    String fromNumber = jsonStr(body, "from_number").trim();
    String toNumber = jsonStr(body, "to_number").trim();
    String secret = headers == null ? "" : headers.get("x-fe-secret");
    String instance = headers == null ? "" : headers.get("x-fe-instance");
    if (secret == null) secret = "";
    if (instance == null) instance = "";
    Map<String, Object> mirror = remoteByNumber(fromNumber);
    if (mirror == null) return err(403, "不认识的实例");
    String expect = api.strOf(mirror, "remote_secret");
    if (expect.isEmpty() || !constantTimeEquals(expect, secret)) return err(403, "密钥不对");
    String expectInstance = api.strOf(mirror, "remote_instance");
    if (!expectInstance.isEmpty() && !expectInstance.equals(instance)) return err(403, "实例身份不匹配");
    Map<String, Object> target = localAccount(toNumber);
    if (target == null) return err(404, "没有这个号码");
    Map<String, Object> msg = Json.obj(body.get("message"));
    String kind = jsonStr(msg, "kind");
    boolean kindOk = false;
    for (int i = 0; i < KINDS.length; i++) if (KINDS[i].equals(kind)) kindOk = true;
    if (!kindOk) kind = "text";
    String text = jsonStr(msg, "body");
    if (text.isEmpty()) return err(400, "空消息");
    String meta = jsonStr(msg, "meta");
    long createdAt = lng(msg.get("created_at"));
    if (createdAt <= 0) createdAt = System.currentTimeMillis();
    long convId = api.dmOf(api.idOf(target), api.idOf(mirror));
    Map<String, Object> data = out();
    data.put("body", text);
    data.put("kind", kind);
    data.put("replyTo", Long.valueOf(0));
    data.put("meta", meta);
    Map<String, Object> res = api.insertMsg(mirror, convId, data);
    if (res.containsKey("error")) return err(400, jsonStr(res, "error"));
    long id = api.numOf(res, "id");
    if (deliveredHook != null) {
      try {
        deliveredHook.delivered(convId, mirror, id, text);
      } catch (Exception e) {
        /* 回调失败不影响消息本身 */
      }
    }
    Map<String, Object> ok = out();
    ok.put("ok", Boolean.TRUE);
    ok.put("id", Long.valueOf(id));
    ok.put("conversationId", Long.valueOf(convId));
    return ok;
  }

  private static boolean constantTimeEquals(String a, String b) {
    byte[] x = a.getBytes(StandardCharsets.UTF_8);
    byte[] y = b.getBytes(StandardCharsets.UTF_8);
    if (x.length != y.length) return false;
    try {
      return MessageDigest.isEqual(x, y);
    } catch (Exception e) {
      return false;
    }
  }

  /* ================= 投递队列 ================= */

  /** 给远端好友发消息：先进本地库（界面立刻可见），再进队列由后台重试补投。 */
  public boolean enqueue(long convId, Map<String, Object> me, Map<String, Object> peer, Map<String, Object> msg) {
    String addr = normalizeAddr(api.strOf(peer, "remote_addr"));
    String secret = api.strOf(peer, "remote_secret");
    String known = api.strOf(peer, "remote_instance");
    boolean relayReady = relay != null && relay.enabled() && !known.isEmpty();
    if (secret.isEmpty()) return false;
    if (addr.isEmpty() && !relayReady) return false;
    Map<String, Object> payload = out();
    payload.put("kind", str(msg.get("kind")));
    payload.put("body", str(msg.get("body")));
    payload.put("meta", str(msg.get("meta")));
    payload.put("created_at", Long.valueOf(lng(msg.get("created_at"))));
    Map<String, Object> row = out();
    row.put("id", Long.valueOf(api.nextIdOf("federation_outbox")));
    row.put("conv_id", Long.valueOf(convId));
    row.put("from_number", api.strOf(me, "number"));
    row.put("to_number", api.strOf(peer, "number"));
    row.put("to_addr", addr);
    row.put("to_secret", secret);
    row.put("payload", Json.write(payload));
    row.put("attempts", Long.valueOf(0));
    row.put("next_at", Long.valueOf(System.currentTimeMillis()));
    row.put("created_at", Long.valueOf(System.currentTimeMillis()));
    row.put("last_error", "");
    api.insertRow("federation_outbox", row);
    api.saveAll();
    return true;
  }

  /** 队列里到点的一条条发出去；失败退避重试，超次数放弃。 */
  public int flushOnce() {
    long now = System.currentTimeMillis();
    List<Map<String, Object>> due = new ArrayList<Map<String, Object>>();
    for (Map<String, Object> row : store.rows("federation_outbox")) {
      if (lng(row.get("next_at")) <= now) due.add(row);
      if (due.size() >= 20) break;
    }
    int sent = 0;
    for (Map<String, Object> row : due) {
      Map<String, Object> body = out();
      body.put("from_number", api.strOf(row, "from_number"));
      body.put("to_number", api.strOf(row, "to_number"));
      Map<String, Object> payload;
      try {
        payload = Json.obj(Json.parse(api.strOf(row, "payload")));
      } catch (Exception e) {
        payload = out();
      }
      body.put("message", payload);
      Map<String, String> headers = new LinkedHashMap<String, String>();
      headers.put("x-fe-instance", instanceId());
      headers.put("x-fe-secret", api.strOf(row, "to_secret"));
      String toAddr = api.strOf(row, "to_addr");
      PeerResult r = toAddr.isEmpty() ? null
          : callPeer(toAddr, "/api/federation/deliver", "POST", body, headers, 8000);
      if (r != null && r.ok) {
        api.deleteRow("federation_outbox", row);
        sent++;
        continue;
      }
      /* 直连不通：知道对方实例 ID 且有中继就交给中继排队 */
      Map<String, Object> peerMirror = remoteByNumber(api.strOf(row, "to_number"));
      String viaInstance = peerMirror == null ? "" : api.strOf(peerMirror, "remote_instance");
      if (relay != null && relay.enabled() && !viaInstance.isEmpty()) {
        Map<String, Object> relayPayload = out();
        relayPayload.put("from_number", api.strOf(row, "from_number"));
        relayPayload.put("to_number", api.strOf(row, "to_number"));
        relayPayload.put("message", payload);
        relayPayload.put("secret", api.strOf(row, "to_secret"));
        relayPayload.put("instance", instanceId());
        Map<String, Object> relayOut = relay.send(viaInstance, "deliver", relayPayload);
        if (Boolean.TRUE.equals(relayOut.get("ok"))) {
          api.deleteRow("federation_outbox", row);
          sent++;
          continue;
        }
      }
      long attempts = lng(row.get("attempts")) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        api.deleteRow("federation_outbox", row);
        continue;
      }
      long delay = 5000L * (1L << Math.min(attempts, 6L));
      if (delay > 300000L) delay = 300000L;
      row.put("attempts", Long.valueOf(attempts));
      row.put("next_at", Long.valueOf(System.currentTimeMillis() + delay));
      String msg = r == null ? "" : jsonStr(r.body, "error");
      if (msg.isEmpty()) msg = r == null || r.error.isEmpty() ? "直连不通" : r.error;
      if (msg.length() > 200) msg = msg.substring(0, 200);
      row.put("last_error", msg);
    }
    if (!due.isEmpty()) api.saveAll();
    return sent;
  }

  /* ================= 中继进来的事件 ================= */

  /** 中继拉下来的事件按类型分派：握手申请、同意回执、消息投递。 */
  public Map<String, Object> handleRelayEvent(String kind, Map<String, Object> payload, String fromInstance) {
    Map<String, Object> body = payload == null ? out() : payload;
    if ("handshake".equals(kind)) return handleHandshake(body);
    if ("accept".equals(kind)) return handleAccept(body);
    if ("deliver".equals(kind)) {
      Map<String, String> headers = new LinkedHashMap<String, String>();
      headers.put("x-fe-secret", jsonStr(body, "secret"));
      String inst = jsonStr(body, "instance");
      headers.put("x-fe-instance", inst.isEmpty() ? (fromInstance == null ? "" : fromInstance) : inst);
      return handleDeliver(headers, body);
    }
    return err(400, "不认识的中继事件：" + kind);
  }

  /* ================= 局域网发现 ================= */

  public Map<String, Object> nearby() {
    long now = System.currentTimeMillis();
    List<Object> list = new ArrayList<Object>();
    List<String> ids = new ArrayList<String>(peers.keySet());
    for (String id : ids) {
      Map<String, Object> p = peers.get(id);
      long lastSeen = lng(p.get("lastSeen"));
      if (now - lastSeen > 60000L) continue;
      Map<String, Object> m = out();
      m.put("instanceId", id);
      m.put("addr", p.get("addr"));
      m.put("port", p.get("port"));
      m.put("version", p.get("version"));
      m.put("lastSeen", Long.valueOf(lastSeen));
      m.put("numbers", p.get("numbers") == null ? new ArrayList<Object>() : p.get("numbers"));
      list.add(m);
    }
    Map<String, Object> res = out();
    res.put("instances", list);
    return res;
  }

  private void rememberPeer(String instanceId, String host, int peerPort, String peerVersion) {
    if (instanceId.isEmpty() || instanceId.equals(instanceId())) return;
    String addr = host + ":" + peerPort;
    Map<String, Object> p = peers.get(instanceId);
    boolean fresh = p == null;
    if (p == null) {
      p = out();
      p.put("numbers", new ArrayList<Object>());
      peers.put(instanceId, p);
    }
    p.put("addr", addr);
    p.put("port", Integer.valueOf(peerPort));
    p.put("version", peerVersion);
    p.put("lastSeen", Long.valueOf(System.currentTimeMillis()));
    if (fresh) refreshPeerNumbers(instanceId, addr);
  }

  private void refreshPeerNumbers(final String instanceId, final String addr) {
    Thread t = new Thread(new Runnable() {
      public void run() {
        PeerResult r = callPeer(addr, "/api/federation/directory", "GET", null, null, 4000);
        if (!r.ok) return;
        Map<String, Object> p = peers.get(instanceId);
        if (p == null) return;
        List<Object> numbers = new ArrayList<Object>();
        for (Object o : Json.arr(r.body.get("numbers"))) {
          Map<String, Object> item = Json.obj(o);
          Map<String, Object> m = out();
          m.put("number", jsonStr(item, "number"));
          m.put("nickname", jsonStr(item, "nickname"));
          m.put("avatar", jsonStr(item, "avatar"));
          m.put("type", jsonStr(item, "type"));
          numbers.add(m);
        }
        p.put("numbers", numbers);
      }
    });
    t.setDaemon(true);
    t.start();
  }

  public void start() {
    if (running) return;
    running = true;
    flushThread = new Thread(new Runnable() {
      public void run() {
        while (running) {
          try {
            flushOnce();
          } catch (Exception e) {
            /* 队列出错不致命，下一轮再来 */
          }
          try {
            Thread.sleep(4000L);
          } catch (InterruptedException e) {
            return;
          }
        }
      }
    });
    flushThread.setDaemon(true);
    flushThread.start();
    startDiscovery();
  }

  private void startDiscovery() {
    try {
      udpSocket = new DatagramSocket(DISCOVERY_PORT);
      udpSocket.setBroadcast(true);
      udpSocket.setReuseAddress(true);
    } catch (Exception e) {
      /* 端口被占用（比如电脑版也在同一台机器上）：放弃发现，靠邀请码/地址直连 */
      udpSocket = null;
      return;
    }
    udpThread = new Thread(new Runnable() {
      public void run() {
        byte[] buf = new byte[1024];
        while (running) {
          try {
            DatagramPacket pkt = new DatagramPacket(buf, buf.length);
            udpSocket.receive(pkt);
            String text = new String(pkt.getData(), 0, pkt.getLength(), StandardCharsets.UTF_8);
            Map<String, Object> m = Json.obj(Json.parse(text));
            if (lng(m.get("fe")) != 1L) continue;
            int peerPort = (int) lng(m.get("port"));
            if (peerPort <= 0) peerPort = DEFAULT_PORT;
            String host = pkt.getAddress().getHostAddress();
            rememberPeer(jsonStr(m, "instanceId"), host, peerPort, jsonStr(m, "version"));
          } catch (Exception e) {
            if (!running) return;
          }
        }
      }
    });
    udpThread.setDaemon(true);
    udpThread.start();
    Thread beacon = new Thread(new Runnable() {
      public void run() {
        while (running) {
          try {
            Map<String, Object> m = out();
            m.put("fe", Integer.valueOf(1));
            m.put("instanceId", instanceId());
            m.put("version", version);
            m.put("port", Integer.valueOf(port));
            byte[] data = Json.write(m).getBytes(StandardCharsets.UTF_8);
            DatagramPacket pkt = new DatagramPacket(data, data.length,
                InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT);
            udpSocket.send(pkt);
          } catch (Exception e) {
            /* 广播失败就算了，下一轮再发 */
          }
          try {
            Thread.sleep(5000L);
          } catch (InterruptedException e) {
            return;
          }
        }
      }
    });
    beacon.setDaemon(true);
    beacon.start();
  }

  public void stop() {
    running = false;
    try {
      if (udpSocket != null) udpSocket.close();
    } catch (Exception e) {
      /* 忽略 */
    }
  }

  /* ================= 目录 / 资料 / Bot 列表 ================= */

  public Map<String, Object> directory() {
    List<Object> numbers = new ArrayList<Object>();
    for (Map<String, Object> a : store.rows("accounts")) {
      String type = str(a.get("type"));
      if (!"user".equals(type) && !"bot".equals(type)) continue;
      Map<String, Object> m = out();
      m.put("number", api.strOf(a, "number"));
      m.put("nickname", api.strOf(a, "nickname"));
      m.put("avatar", api.strOf(a, "avatar"));
      m.put("type", type);
      numbers.add(m);
    }
    Map<String, Object> res = out();
    res.put("instanceId", instanceId());
    res.put("version", version);
    res.put("numbers", numbers);
    return res;
  }

  public Map<String, Object> profile(String number) {
    if (!NUMBER_RE.matcher(number).matches()) return err(400, "号码格式不对");
    Map<String, Object> acc = localAccount(number);
    if (acc == null) return err(404, "对方没有这个号码");
    String type = str(acc.get("type"));
    if (!"user".equals(type) && !"bot".equals(type)) return err(404, "对方没有这个号码");
    Map<String, Object> res = out();
    res.put("account", accountBrief(acc, false, ""));
    res.put("instanceId", instanceId());
    res.put("version", version);
    return res;
  }

  /** 本实例公开的 Bot（跨实例 Bot 广场用）。 */
  public Map<String, Object> publicBots() {
    List<Object> bots = new ArrayList<Object>();
    for (Map<String, Object> a : store.rows("accounts")) {
      if (!"bot".equals(str(a.get("type")))) continue;
      if (lng(a.get("is_public")) == 0) continue;
      Map<String, Object> m = out();
      m.put("number", api.strOf(a, "number"));
      m.put("nickname", api.strOf(a, "nickname"));
      m.put("bio", api.strOf(a, "bio"));
      m.put("avatar", api.strOf(a, "avatar"));
      m.put("type", "bot");
      bots.add(m);
    }
    Map<String, Object> res = out();
    res.put("instanceId", instanceId());
    res.put("version", version);
    res.put("bots", bots);
    return res;
  }

  /**
   * 收集别的实例上的 Bot：已加过的远端好友所在实例 + 局域网里发现的实例。
   * Bot 广场要把这些合并进来，用户才能看到电脑上的 Bot。
   */
  public List<Map<String, Object>> remoteBots() {
    List<String> addrs = new ArrayList<String>();
    for (Map<String, Object> a : store.rows("accounts")) {
      if (!"remote".equals(str(a.get("type")))) continue;
      String addr = normalizeAddr(str(a.get("remote_addr")));
      if (!addr.isEmpty() && !addrs.contains(addr)) addrs.add(addr);
    }
    for (Map<String, Object> p : peers.values()) {
      String addr = normalizeAddr(str(p.get("addr")));
      if (!addr.isEmpty() && !addrs.contains(addr)) addrs.add(addr);
    }
    List<Map<String, Object>> outList = new ArrayList<Map<String, Object>>();
    for (String addr : addrs) {
      PeerResult r = callPeer(addr, "/api/federation/bots", "GET", null, null, 5000);
      if (!r.ok) continue;
      String instance = jsonStr(r.body, "instanceId");
      for (Object o : Json.arr(r.body.get("bots"))) {
        Map<String, Object> b = Json.obj(o);
        Map<String, Object> m = out();
        m.put("number", jsonStr(b, "number"));
        m.put("nickname", jsonStr(b, "nickname"));
        m.put("bio", jsonStr(b, "bio"));
        m.put("avatar", jsonStr(b, "avatar"));
        m.put("type", "bot");
        m.put("remote", Boolean.TRUE);
        m.put("addr", addr);
        m.put("instance", instance.isEmpty() ? addr : instance);
        outList.add(m);
      }
    }
    return outList;
  }

  /* ================= 路由 ================= */

  public void register(final Http http) {
    // 对端调用（不需要登录态，靠实例身份与密钥校验）
    http.route("GET", "/api/federation/directory", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        res.json(directory());
      }
    });

    http.route("GET", "/api/federation/profile", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = profile(req.queryValue("number").trim());
        if (out.containsKey("error")) {
          res.error((int) lng(out.get("code")) == 0 ? 400 : (int) lng(out.get("code")),
              jsonStr(out, "error"));
          return;
        }
        res.json(out);
      }
    });

    http.route("GET", "/api/federation/bots", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        res.json(publicBots());
      }
    });

    http.route("POST", "/api/federation/handshake", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = handleHandshake(req.json());
        if (out.containsKey("error")) {
          int code = (int) lng(out.get("code"));
          res.error(code == 0 ? 400 : code, jsonStr(out, "error"));
          return;
        }
        res.json(out);
      }
    });

    http.route("POST", "/api/federation/accept", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = handleAccept(req.json());
        if (out.containsKey("error")) {
          int code = (int) lng(out.get("code"));
          res.error(code == 0 ? 400 : code, jsonStr(out, "error"));
          return;
        }
        res.json(out);
      }
    });

    http.route("POST", "/api/federation/deliver", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = handleDeliver(req.headers, req.json());
        if (out.containsKey("error")) {
          int code = (int) lng(out.get("code"));
          res.error(code == 0 ? 400 : code, jsonStr(out, "error"));
          return;
        }
        res.json(out);
      }
    });

    // 本机用户调用
    http.route("GET", "/api/federation/info", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        res.json(info());
      }
    });

    http.route("GET", "/api/federation/invite", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> invite = makeInvite(me);
        if (invite == null) {
          res.error(409, "这台设备还没有可以被外部连上的地址：先连上 Wi-Fi，或者在设置里填好公网地址或 DDNS");
          return;
        }
        Map<String, Object> out = out();
        out.put("ok", Boolean.TRUE);
        out.putAll(invite);
        out.put("publicV6", new ArrayList<Object>(v6Addresses()));
        out.put("boundToLan", Boolean.TRUE);
        res.json(out);
      }
    });

    // 手机端接受邀请码：直接帮用户把好友申请发出去，少一步操作
    http.route("POST", "/api/federation/invite/accept", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> body = req.json();
        String code = str(body.get("code")).trim();
        if (code.length() < 8 || code.length() > 4000) {
          res.error(400, "邀请码长度不对，可能复制少了");
          return;
        }
        Map<String, Object> parsed = parseInvite(code);
        if (parsed.containsKey("error")) {
          res.error((int) lng(parsed.get("code")), jsonStr(parsed, "error"));
          return;
        }
        String number = jsonStr(parsed, "number");
        if (number.equals(api.strOf(me, "number"))) {
          res.error(400, "这是你自己的邀请码");
          return;
        }
        String peerInstance = jsonStr(parsed, "instanceId");
        Map<String, Object> last = null;
        int tried = 0;
        for (Object o : Json.arr(parsed.get("addrs"))) {
          String addr = str(o);
          tried++;
          Map<String, Object> found = lookup(me, addr, number);
          if (!found.containsKey("error")) {
            Map<String, Object> out = out();
            out.putAll(found);
            out.put("addr", addr);
            out.put("tried", Integer.valueOf(tried));
            out.put("nickname", jsonStr(parsed, "nickname"));
            // 自动发申请：用户不用再点一次
            Map<String, Object> reqOut = sendRequest(me, addr, number, "通过邀请码添加", peerInstance);
            if (reqOut.containsKey("error")) {
              out.put("requested", Boolean.FALSE);
              out.put("requestError", jsonStr(reqOut, "error"));
            } else {
              out.put("requested", Boolean.TRUE);
              if (Boolean.TRUE.equals(reqOut.get("friend"))) out.put("friend", Boolean.TRUE);
              if (reqOut.get("via") != null) {
                out.put("via", reqOut.get("via"));
                out.put("queued", Boolean.TRUE);
              }
            }
            res.json(out);
            return;
          }
          last = found;
        }
        /* 一个地址都不通：有中继就直接排进中继队列，对方上线自动收到 */
        if (relay != null && relay.enabled() && !peerInstance.isEmpty()) {
          Map<String, Object> reqOut = sendRequest(me, "", number, "通过邀请码添加", peerInstance);
          if (!reqOut.containsKey("error")) {
            Map<String, Object> out = out();
            out.put("ok", Boolean.TRUE);
            out.put("requested", Boolean.TRUE);
            out.put("via", "relay");
            out.put("queued", Boolean.TRUE);
            out.put("tried", Integer.valueOf(tried));
            out.put("nickname", jsonStr(parsed, "nickname"));
            out.put("number", number);
            res.json(out);
            return;
          }
        }
        String msg = last == null ? "连不上对方的实例" : jsonStr(last, "error");
        res.error(404, msg + "（试了 " + tried + " 个地址都不通：对方可能没有公网 IPv6，或者光猫/路由器把入站拦了；想让对方不在同一网络也能加，就在设置里配一台中继）");
      }
    });

    http.route("PATCH", "/api/federation/settings", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> body = req.json();
        if (body.get("autoAccept") != null) {
          setAutoAccept(Boolean.TRUE.equals(body.get("autoAccept")) || "true".equals(String.valueOf(body.get("autoAccept"))));
        }
        if (body.get("publicAddr") != null) {
          String raw = str(body.get("publicAddr")).trim();
          if (!raw.isEmpty() && normalizeAddr(raw).isEmpty()) {
            res.error(400, "地址格式不对，示例：1.2.3.4:7788");
            return;
          }
          setPublicAddr(raw);
        }
        Map<String, Object> out = out();
        out.put("ok", Boolean.TRUE);
        out.put("publicAddr", publicAddr());
        out.put("autoAccept", Boolean.valueOf(autoAccept()));
        res.json(out);
      }
    });

    /* 登录页用：不需要登录就能看到同一 Wi-Fi 下有哪些服务器，手机端不用手打 IP */
    http.route("GET", "/api/discover/lan", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = out();
        List<Object> list = new ArrayList<Object>();
        Map<String, Object> nb = nearby();
        Object raw = nb.get("instances");
        if (raw instanceof List) {
          for (Object o : (List<?>) raw) {
            Map<String, Object> p = Json.obj(o);
            Map<String, Object> m = out();
            m.put("addr", p.get("addr"));
            m.put("version", p.get("version"));
            m.put("lastSeen", p.get("lastSeen"));
            Object nums = p.get("numbers");
            m.put("people", Integer.valueOf(nums instanceof List ? ((List<?>) nums).size() : 0));
            list.add(m);
          }
        }
        out.put("instances", list);
        res.json(out);
      }
    });

    http.route("GET", "/api/federation/nearby", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        res.json(nearby());
      }
    });

    http.route("POST", "/api/federation/lookup", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> body = req.json();
        String number = str(body.get("number")).trim();
        if (!NUMBER_RE.matcher(number).matches()) {
          res.error(400, "号码格式不对");
          return;
        }
        Map<String, Object> out = lookup(me, str(body.get("addr")), number);
        if (out.containsKey("error")) {
          int code = (int) lng(out.get("code"));
          res.error(code == 0 ? 400 : code, jsonStr(out, "error"));
          return;
        }
        res.json(out);
      }
    });

    http.route("POST", "/api/federation/request", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = api.requireMeOf(req, res);
        if (me == null) return;
        Map<String, Object> body = req.json();
        String addr = str(body.get("addr")).trim();
        String number = str(body.get("number")).trim();
        String instanceId = str(body.get("instanceId")).trim();
        if (addr.isEmpty() && instanceId.isEmpty()) {
          res.error(400, "跨实例加好友要填对方的实例地址");
          return;
        }
        if (!NUMBER_RE.matcher(number).matches()) {
          res.error(400, "号码格式不对");
          return;
        }
        Map<String, Object> out = sendRequest(me, addr, number, str(body.get("message")), instanceId);
        if (out.containsKey("error")) {
          int code = (int) lng(out.get("code"));
          res.error(code == 0 ? 400 : code, jsonStr(out, "error"));
          return;
        }
        res.json(out);
      }
    });
  }
}
