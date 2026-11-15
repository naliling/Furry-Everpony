package fe.local;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** 手机端内置服务端的业务实现：接口路径与返回结构跟电脑端保持一致。 */
public final class Api {
  private final Store store;
  private final File dataDir;
  private final String version;
  private final int port;
  private final SecureRandom rnd = new SecureRandom();
  private final Map<String, long[]> typing = new LinkedHashMap<String, long[]>();
  /** 实例互联：邀请码、跨实例好友、消息投递。 */
  private Federation fed;
  /** 跨网络中继：两端都不在同一网络、也没有公网地址时兜底转发。 */
  private Relay relay;

  public Api(Store store, File dataDir, String version, int port) {
    this.store = store;
    this.dataDir = dataDir;
    this.version = version;
    this.port = port;
  }

  /* ================= 开机登录态（dataDir/boot-token.txt） ================= */

  /** token 只认小写十六进制、长度 16–64：写进网页脚本之前必须先过这一关。 */
  private static final Pattern TOKEN_SHAPE = Pattern.compile("^[0-9a-f]{16,64}$");

  /** 落盘 token 的内存副本，省得每个请求都去读一次文件。 */
  private String bootTokenMemo;

  private File bootTokenFile() {
    return new File(dataDir, "boot-token.txt");
  }

  /** 读落盘的登录 token（原样内容，已去首尾空白）；文件不存在就是空串。 */
  String readBootToken() {
    if (bootTokenMemo != null) return bootTokenMemo;
    File f = bootTokenFile();
    if (!f.exists()) { bootTokenMemo = ""; return bootTokenMemo; }
    try {
      FileInputStream in = new FileInputStream(f);
      byte[] buf = new byte[(int) Math.min(4096, f.length() + 16)];
      int n = in.read(buf);
      in.close();
      bootTokenMemo = n <= 0 ? "" : new String(buf, 0, n, StandardCharsets.UTF_8).trim();
      return bootTokenMemo;
    } catch (Exception e) {
      bootTokenMemo = "";
      return bootTokenMemo;
    }
  }

  /** 把登录 token 落到 dataDir/boot-token.txt（纯文本、UTF-8、无换行）；传空串就删掉。 */
  boolean writeBootToken(String token) {
    File f = bootTokenFile();
    try {
      if (token == null || token.trim().isEmpty()) {
        if (f.exists()) f.delete();
        bootTokenMemo = "";
        return true;
      }
      String t = token.trim();
      FileOutputStream out = new FileOutputStream(f);
      out.write(t.getBytes(StandardCharsets.UTF_8));
      out.flush();
      out.close();
      bootTokenMemo = t;
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  /**
   * 带着有效 token 的请求，说明这就是用户此刻真正在用的登录态。
   * 跟落盘的不一样就同步一次，重开 App 时注入的永远是最后在用的那个 token，
   * 不会因为换了账号或者端口漂移就退回登录页。
   */
  private void rememberBootToken(String token) {
    if (token == null || token.isEmpty() || !TOKEN_SHAPE.matcher(token).matches()) return;
    if (token.equals(readBootToken())) return;
    writeBootToken(token);
  }

  /* ================= 基础工具 ================= */

  private static String str(Map<String, Object> r, String k) {
    Object v = r.get(k);
    return v == null ? "" : String.valueOf(v);
  }

  private static long num(Map<String, Object> r, String k) {
    Object v = r.get(k);
    if (v instanceof Number) return ((Number) v).longValue();
    if (v instanceof String) {
      try { return Long.parseLong((String) v); } catch (Exception e) { return 0; }
    }
    return 0;
  }

  private static boolean bool(Map<String, Object> r, String k) {
    Object v = r.get(k);
    if (v instanceof Boolean) return (Boolean) v;
    if (v instanceof Number) return ((Number) v).longValue() != 0;
    return false;
  }

  private Map<String, Object> one(String table, String field, Object value) {
    for (Map<String, Object> r : store.rows(table)) {
      Object v = r.get(field);
      if (value == null) { if (v == null) return r; continue; }
      if (v instanceof Number && value instanceof Number) {
        if (((Number) v).longValue() == ((Number) value).longValue()) return r;
      } else if (String.valueOf(v).equals(String.valueOf(value))) {
        return r;
      }
    }
    return null;
  }

  private List<Map<String, Object>> where(String table, String field, Object value) {
    List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
    for (Map<String, Object> r : store.rows(table)) {
      Object v = r.get(field);
      if (v instanceof Number && value instanceof Number) {
        if (((Number) v).longValue() == ((Number) value).longValue()) out.add(r);
      } else if (String.valueOf(v).equals(String.valueOf(value))) {
        out.add(r);
      }
    }
    return out;
  }

  private void put(String table, Map<String, Object> row) {
    store.table(table).add(row);
    store.markDirty();
  }

  private void remove(String table, Map<String, Object> row) {
    List<Object> list = store.table(table);
    for (int i = 0; i < list.size(); i++) {
      if (list.get(i) == row) { list.remove(i); store.markDirty(); return; }
    }
  }

  private Map<String, Object> account(long id) {
    return one("accounts", "id", id);
  }

  private Map<String, Object> accountByNumber(String number) {
    return one("accounts", "number", number);
  }

  private Map<String, Object> byToken(String token) {
    if (token == null || token.isEmpty()) return null;
    Map<String, Object> s = one("sessions", "token", token);
    if (s == null) return null;
    rememberBootToken(token);
    s.put("last_seen", System.currentTimeMillis());
    store.markDirty();
    return account(num(s, "account_id"));
  }

  private Map<String, Object> requireMe(Http.Req req, Http.Res res) {
    Map<String, Object> me = byToken(req.bearer());
    if (me == null) { res.error(401, "请先登录"); return null; }
    return me;
  }

  private Map<String, Object> presenceOf(long accId) {
    Map<String, Object> acc = account(accId);
    long last = 0;
    for (Map<String, Object> s : where("sessions", "account_id", accId)) {
      long v = num(s, "last_seen");
      if (v > last) last = v;
    }
    String status = acc == null ? "offline" : str(acc, "status");
    if ("invisible".equals(status)) {
      Map<String, Object> m = new LinkedHashMap<String, Object>();
      m.put("online", Boolean.FALSE);
      m.put("status", "offline");
      m.put("last_seen", last);
      return m;
    }
    boolean online = last > System.currentTimeMillis() - 90000L;
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("online", Boolean.valueOf(online));
    m.put("status", online ? ("away".equals(status) ? "away" : "online") : "offline");
    m.put("last_seen", last);
    return m;
  }

  private List<Object> parsePhotos(String json) {
    try {
      if (json == null || json.trim().isEmpty()) return new ArrayList<Object>();
      return Json.arr(Json.parse(json));
    } catch (Exception e) {
      return new ArrayList<Object>();
    }
  }

  private static String hex(byte[] b) {
    StringBuilder sb = new StringBuilder();
    for (byte x : b) sb.append(String.format("%02x", x));
    return sb.toString();
  }

  private String hashPassword(String password) {
    try {
      byte[] salt = new byte[16];
      rnd.nextBytes(salt);
      int iter = 12000;
      PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iter, 256);
      SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
      byte[] key = f.generateSecret(spec).getEncoded();
      return "pbkdf2$" + iter + "$" + hex(salt) + "$" + hex(key);
    } catch (Exception e) {
      try {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return "sha256$" + hex(md.digest(password.getBytes("UTF-8")));
      } catch (Exception e2) {
        return "plain$" + password;
      }
    }
  }

  private boolean verifyPassword(String password, String stored) {
    if (stored == null || stored.isEmpty()) return false;
    try {
      String[] parts = stored.split("\\$");
      if (parts[0].equals("pbkdf2")) {
        int iter = Integer.parseInt(parts[1]);
        byte[] salt = unhex(parts[2]);
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iter, 256);
        byte[] key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        return hex(key).equals(parts[3]);
      }
      if (parts[0].equals("sha256")) {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return hex(md.digest(password.getBytes("UTF-8"))).equals(parts[1]);
      }
      if (parts[0].equals("plain")) return parts[1].equals(password);
    } catch (Exception e) {
      return false;
    }
    return false;
  }

  private static byte[] unhex(String s) {
    byte[] out = new byte[s.length() / 2];
    for (int i = 0; i < out.length; i++) {
      out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  private String issueSession(long accountId) {
    byte[] b = new byte[24];
    rnd.nextBytes(b);
    String token = hex(b);
    Map<String, Object> s = new LinkedHashMap<String, Object>();
    long now = System.currentTimeMillis();
    s.put("token", token);
    s.put("account_id", accountId);
    s.put("created_at", now);
    s.put("last_seen", now);
    put("sessions", s);
    // 新签发的 session 立刻落盘：只标脏不存盘的话，杀掉 App 再打开 token 就变成无效的，
    // 跟端口有没有变无关，一样会被踢回登录页。
    store.save();
    return token;
  }

  /* ================= 好友关系 ================= */

  private boolean areFriends(long a, long b) {
    for (Map<String, Object> f : where("friendships", "a_id", a)) {
      if (num(f, "b_id") == b) return true;
    }
    return false;
  }

  private boolean isBlocked(long a, long b) {
    for (Map<String, Object> f : where("blocks", "a_id", a)) {
      if (num(f, "b_id") == b) return true;
    }
    return false;
  }

  private void makeFriends(long a, long b) {
    if (areFriends(a, b)) return;
    Map<String, Object> f = new LinkedHashMap<String, Object>();
    f.put("a_id", a);
    f.put("b_id", b);
    f.put("created_at", System.currentTimeMillis());
    f.put("remark", "");
    f.put("group_id", 0);
    f.put("special", 0);
    put("friendships", f);
    Map<String, Object> g = new LinkedHashMap<String, Object>();
    g.put("a_id", b);
    g.put("b_id", a);
    g.put("created_at", System.currentTimeMillis());
    g.put("remark", "");
    g.put("group_id", 0);
    g.put("special", 0);
    put("friendships", g);
  }

  private Map<String, Object> friendRow(long a, long b) {
    for (Map<String, Object> f : where("friendships", "a_id", a)) {
      if (num(f, "b_id") == b) return f;
    }
    return null;
  }

  /* ================= 会话与消息 ================= */

  private Map<String, Object> conv(long id) {
    return one("conversations", "id", id);
  }

  private Map<String, Object> member(long convId, long accId) {
    for (Map<String, Object> m : where("members", "conversation_id", convId)) {
      if (num(m, "account_id") == accId) return m;
    }
    return null;
  }

  private boolean memberOf(long convId, long accId) {
    return member(convId, accId) != null;
  }

  private Map<String, Object> peerOf(long convId, long meId) {
    for (Map<String, Object> m : where("members", "conversation_id", convId)) {
      if (num(m, "account_id") != meId) {
        Map<String, Object> a = account(num(m, "account_id"));
        if (a == null) continue;
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("id", num(a, "id"));
        out.put("number", str(a, "number"));
        out.put("nickname", str(a, "nickname"));
        out.put("avatar", str(a, "avatar"));
        out.put("type", str(a, "type"));
        return out;
      }
    }
    return null;
  }

  private Map<String, Object> convGroup(long convId) {
    for (Map<String, Object> g : store.rows("groups")) {
      if (num(g, "conversation_id") == convId) return g;
    }
    return null;
  }

  private Map<String, Object> groupBrief(Map<String, Object> g) {
    if (g == null) return null;
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("id", num(g, "id"));
    out.put("number", str(g, "number"));
    out.put("name", str(g, "name"));
    out.put("owner_id", num(g, "owner_id"));
    out.put("announcement", str(g, "announcement"));
    out.put("mute_all", num(g, "mute_all"));
    out.put("conversationId", num(g, "conversation_id"));
    return out;
  }

  private long getOrCreateDm(long a, long b) {
    for (Map<String, Object> c : store.rows("conversations")) {
      if (!"dm".equals(str(c, "kind"))) continue;
      long id = num(c, "id");
      boolean hasA = false, hasB = false;
      for (Map<String, Object> m : where("members", "conversation_id", id)) {
        if (num(m, "account_id") == a) hasA = true;
        if (num(m, "account_id") == b) hasB = true;
      }
      if (hasA && hasB) return id;
    }
    Map<String, Object> c = new LinkedHashMap<String, Object>();
    long cid = store.nextId("conversations");
    c.put("id", cid);
    c.put("kind", "dm");
    c.put("created_at", System.currentTimeMillis());
    put("conversations", c);
    addMember(cid, a);
    addMember(cid, b);
    return cid;
  }

  private void addMember(long convId, long accId) {
    if (memberOf(convId, accId)) return;
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("conversation_id", convId);
    m.put("account_id", accId);
    m.put("last_read_id", 0);
    m.put("pinned", 0);
    m.put("muted", 0);
    put("members", m);
  }

  private String displayOf(String kind, String body, Map<String, Object> meta) {
    if ("image".equals(kind)) return "[图片]";
    if ("voice".equals(kind)) return "[语音]";
    if ("file".equals(kind)) return "[文件] " + (meta == null ? "" : str(meta, "name"));
    if ("merge".equals(kind)) return "[聊天记录]";
    if ("forward".equals(kind)) return "[聊天记录]";
    return body;
  }

  private Map<String, Object> readMeta(String raw) {
    try {
      if (raw == null || raw.trim().isEmpty()) return null;
      return Json.obj(Json.parse(raw));
    } catch (Exception e) {
      return null;
    }
  }

  private List<Object> reactionsFor(long messageId, long meId) {
    Map<String, long[]> counts = new LinkedHashMap<String, long[]>();
    for (Map<String, Object> r : where("reactions", "message_id", messageId)) {
      String emoji = str(r, "emoji");
      long[] c = counts.get(emoji);
      if (c == null) { c = new long[] { 0, 0 }; counts.put(emoji, c); }
      c[0]++;
      if (num(r, "account_id") == meId) c[1] = 1;
    }
    List<Object> out = new ArrayList<Object>();
    for (Map.Entry<String, long[]> e : counts.entrySet()) {
      Map<String, Object> m = new LinkedHashMap<String, Object>();
      m.put("emoji", e.getKey());
      m.put("count", e.getValue()[0]);
      m.put("mine", e.getValue()[1] != 0);
      out.add(m);
    }
    return out;
  }

  private Map<String, Object> serializeMessage(Map<String, Object> m, long meId, boolean isGroup) {
    long senderId = num(m, "sender_id");
    Map<String, Object> sender = account(senderId);
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("id", num(m, "id"));
    out.put("mine", senderId == meId);
    out.put("body", str(m, "body"));
    out.put("kind", str(m, "kind"));
    out.put("recalled", bool(m, "recalled"));
    out.put("created_at", num(m, "created_at"));
    long replyId = num(m, "reply_to_id");
    if (replyId > 0) {
      Map<String, Object> r = one("messages", "id", replyId);
      if (r != null) {
        Map<String, Object> rm = new LinkedHashMap<String, Object>();
        Map<String, Object> ra = account(num(r, "sender_id"));
        rm.put("id", num(r, "id"));
        rm.put("number", ra == null ? "" : str(ra, "number"));
        rm.put("nickname", ra == null ? "" : str(ra, "nickname"));
        rm.put("kind", str(r, "kind"));
        String body = str(r, "body");
        rm.put("body", body.length() > 120 ? body.substring(0, 120) : body);
        out.put("reply", rm);
      } else {
        out.put("reply", null);
      }
    } else {
      out.put("reply", null);
    }
    out.put("reactions", reactionsFor(num(m, "id"), meId));
    Map<String, Object> meta = readMeta(str(m, "meta"));
    if (meta != null && !bool(m, "recalled") && !str(m, "body").isEmpty()) out.put("meta", meta);
    if (isGroup && sender != null) {
      Map<String, Object> s = new LinkedHashMap<String, Object>();
      s.put("number", str(sender, "number"));
      s.put("nickname", str(sender, "nickname"));
      s.put("avatar", str(sender, "avatar"));
      out.put("sender", s);
    }
    return out;
  }

  private List<Object> serializeMessages(List<Map<String, Object>> rows, long meId, boolean isGroup) {
    List<Object> out = new ArrayList<Object>();
    for (Map<String, Object> r : rows) {
      boolean deletedByMe = false;
      for (Map<String, Object> d : where("deletions", "message_id", num(r, "id"))) {
        if (num(d, "account_id") == meId) deletedByMe = true;
      }
      if (deletedByMe) continue;
      out.add(serializeMessage(r, meId, isGroup));
    }
    return out;
  }

  private List<Object> typingList(long convId, long meId) {
    List<Object> out = new ArrayList<Object>();
    long now = System.currentTimeMillis();
    synchronized (typing) {
      long[] stamp = typing.get(convId + ":" + meId);
      if (stamp != null && now - stamp[0] > 6000) typing.remove(convId + ":" + meId);
      for (Map.Entry<String, long[]> e : typing.entrySet()) {
        String[] k = e.getKey().split(":");
        if (Long.parseLong(k[0]) != convId) continue;
        if (Long.parseLong(k[1]) == meId) continue;
        if (now - e.getValue()[0] > 6000) continue;
        Map<String, Object> a = account(Long.parseLong(k[1]));
        if (a == null) continue;
        Map<String, Object> item = new LinkedHashMap<String, Object>();
        item.put("number", str(a, "number"));
        item.put("nickname", str(a, "nickname"));
        item.put("avatar", str(a, "avatar"));
        out.add(item);
      }
    }
    return out;
  }

  /* ================= 消息写入 ================= */

  private Map<String, Object> parseInput(Map<String, Object> body) {
    String kind = body.get("kind") == null ? "text" : String.valueOf(body.get("kind"));
    List<String> kinds = Arrays.asList("text", "image", "file", "voice", "forward", "merge");
    if (!kinds.contains(kind)) return err("消息类型不对");
    Object rawBody = body.get("body");
    if (!(rawBody instanceof String)) return err("消息内容不能为空");
    String text = (String) rawBody;
    if (text.isEmpty() || text.length() > 2500000) return err("消息内容不能为空");
    if ("text".equals(kind) && text.length() > 4000) return err("一条消息最多 4000 字");
    if (("file".equals(kind) || "voice".equals(kind)) && !text.startsWith("/uploads/")) {
      return err("文件和语音必须先上传");
    }
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("kind", kind);
    out.put("body", text);
    Object meta = body.get("meta");
    out.put("meta", meta == null ? "" : Json.write(meta));
    Object replyTo = body.get("replyTo");
    out.put("replyTo", replyTo instanceof Number ? ((Number) replyTo).longValue() : 0L);
    return out;
  }

  private Map<String, Object> err(int status, String message) {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("error", message);
    m.put("status", Integer.valueOf(status));
    return m;
  }

  private static int outStatus(Map<String, Object> out) {
    Object s = out.get("status");
    return s instanceof Number ? ((Number) s).intValue() : 400;
  }

  private Map<String, Object> err(String message) {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("error", message);
    return m;
  }

  private Map<String, Object> insertMessage(Map<String, Object> me, long convId, Map<String, Object> data) {
    long meId = num(me, "id");
    Map<String, Object> c = conv(convId);
    Map<String, Object> g = c == null ? null : convGroup(convId);
    if (g != null) {
      Map<String, Object> gm = null;
      for (Map<String, Object> x : where("group_members", "group_id", num(g, "id"))) {
        if (num(x, "account_id") == meId) gm = x;
      }
      String role = gm == null ? "member" : str(gm, "role");
      boolean manager = "owner".equals(role) || "admin".equals(role);
      if (num(g, "mute_all") != 0 && !manager) return err(403, "全员禁言中，只有群主和管理员能发言");
      if (gm != null && num(gm, "mute_until") > System.currentTimeMillis()) return err(403, "你被禁言了，暂时不能发言");
    } else {
      Map<String, Object> peer = peerOf(convId, meId);
      if (peer != null && isBlocked(num(peer, "id"), meId)) return err(403, "对方已把你拉黑");
    }
    long replyTo = ((Number) data.get("replyTo")).longValue();
    if (replyTo > 0) {
      Map<String, Object> r = one("messages", "id", replyTo);
      if (r == null || num(r, "conversation_id") != convId) return err(400, "回复的消息不在这里");
    }
    Map<String, Object> row = new LinkedHashMap<String, Object>();
    long id = store.nextId("messages");
    row.put("id", id);
    row.put("conversation_id", convId);
    row.put("sender_id", meId);
    row.put("body", data.get("body"));
    row.put("kind", data.get("kind"));
    row.put("recalled", 0);
    row.put("reply_to_id", replyTo);
    row.put("meta", data.get("meta"));
    row.put("created_at", System.currentTimeMillis());
    put("messages", row);
    Map<String, Object> m = member(convId, meId);
    if (m != null) { m.put("last_read_id", id); store.markDirty(); }
    // 对方在别的实例上：先落本地库（界面立刻可见），再进投递队列，由后台重试补投
    if (g == null) {
      Map<String, Object> peerBrief = peerOf(convId, meId);
      if (peerBrief != null && "remote".equals(str(peerBrief, "type"))) {
        Map<String, Object> full = account(num(peerBrief, "id"));
        if (full != null) {
          Map<String, Object> msg = new LinkedHashMap<String, Object>();
          msg.put("kind", data.get("kind"));
          msg.put("body", data.get("body"));
          msg.put("meta", data.get("meta") == null ? "" : data.get("meta"));
          msg.put("created_at", Long.valueOf(System.currentTimeMillis()));
          fed.enqueue(convId, me, full, msg);
        }
      }
    }
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("id", id);
    return out;
  }

  private Map<String, Object> messageRow(long id) {
    return one("messages", "id", id);
  }

  private boolean messageAccess(Http.Req req, Http.Res res, long id) {
    Map<String, Object> me = requireMe(req, res);
    if (me == null) return false;
    Map<String, Object> row = messageRow(id);
    if (row == null) { res.error(404, "没有这条消息"); return false; }
    if (!memberOf(num(row, "conversation_id"), num(me, "id"))) { res.error(403, "不在这个会话里"); return false; }
    return true;
  }

  /* ================= 路由注册 ================= */

  public void register(final Http http) {
    new Groups(this, store, dataDir).register(http);
    fed = new Federation(this, store, dataDir, port, version);
    relay = new Relay(fed);
    fed.setRelay(relay);
    fed.register(http);
    fed.start();
    relay.start();

    http.route("GET", "/api/health", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("version", version);
        m.put("local", Boolean.TRUE);
        res.json(m);
      }
    });

    // 网页登录成功后把 token 报给本机服务端存一份，重开 App 时由 index.html 注入回 localStorage。
    // 本机回环端口，只有本机进程能访问，所以这里不要求登录。
    http.route("POST", "/api/native/token", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        String token = str(req.json(), "token").trim();
        boolean ok = writeBootToken(token);
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.valueOf(ok));
        res.json(out);
      }
    });

    http.route("GET", "/api/native/token", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("token", readBootToken());
        res.json(out);
      }
    });

    http.route("GET", "/api/number/:number/available", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        String n = req.param("number");
        if (!validNumber(n)) { res.error(400, "号码必须是 5–12 位数字，且不能以 0 开头"); return; }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("number", n);
        m.put("available", Boolean.valueOf(accountByNumber(n) == null));
        res.json(m);
      }
    });

    http.route("POST", "/api/register", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> b = req.json();
        String n = String.valueOf(b.get("number") == null ? "" : b.get("number"));
        String pwd = String.valueOf(b.get("password") == null ? "" : b.get("password"));
        String nick = String.valueOf(b.get("nickname") == null ? "" : b.get("nickname"));
        if (!validNumber(n)) { res.error(400, "号码必须是 5–12 位数字，且不能以 0 开头"); return; }
        if (pwd.length() < 8 || pwd.length() > 128) { res.error(400, "密码至少 8 位"); return; }
        if (nick.trim().isEmpty() || nick.length() > 24) { res.error(400, "昵称 1–24 个字"); return; }
        if (accountByNumber(n) != null) { res.error(409, "这个号码已经被用了"); return; }
        Map<String, Object> a = new LinkedHashMap<String, Object>();
        long id = store.nextId("accounts");
        a.put("id", id);
        a.put("number", n);
        a.put("type", "user");
        a.put("nickname", nick);
        a.put("bio", "");
        a.put("password_hash", hashPassword(pwd));
        a.put("created_at", System.currentTimeMillis());
        a.put("avatar", "");
        a.put("card_bg", "");
        a.put("photos", "[]");
        a.put("status", "online");
        a.put("owner_id", 0);
        a.put("is_public", 0);
        put("accounts", a);
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("token", issueSession(id));
        out.put("account", briefAccount(a));
        res.json(out);
      }
    });

    http.route("POST", "/api/login", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> b = req.json();
        String n = String.valueOf(b.get("number") == null ? "" : b.get("number"));
        String pwd = String.valueOf(b.get("password") == null ? "" : b.get("password"));
        Map<String, Object> a = accountByNumber(n);
        if (a == null || !verifyPassword(pwd, str(a, "password_hash"))) {
          res.error(401, "号码或密码不对");
          return;
        }
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("token", issueSession(num(a, "id")));
        out.put("account", briefAccount(a));
        res.json(out);
      }
    });

    http.route("GET", "/api/me", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> a = account(num(me, "id"));
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("account", fullAccount(a, true));
        res.json(out);
      }
    });

    http.route("PATCH", "/api/me", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> b = req.json();
        Map<String, Object> a = account(num(me, "id"));
        if (b.containsKey("nickname")) {
          String nick = String.valueOf(b.get("nickname")).trim();
          if (nick.isEmpty() || nick.length() > 24) { res.error(400, "昵称 1–24 个字"); return; }
          a.put("nickname", nick);
        }
        if (b.containsKey("bio")) a.put("bio", String.valueOf(b.get("bio")));
        if (b.containsKey("status")) {
          String st = String.valueOf(b.get("status"));
          if (!Arrays.asList("online", "away", "busy", "invisible").contains(st)) { res.error(400, "状态不对"); return; }
          a.put("status", st);
        }
        if (b.containsKey("avatar")) a.put("avatar", String.valueOf(b.get("avatar")));
        if (b.containsKey("cardBg")) a.put("card_bg", String.valueOf(b.get("cardBg")));
        if (b.containsKey("photos")) a.put("photos", Json.write(b.get("photos")));
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("account", fullAccount(a, false));
        res.json(out);
      }
    });

    http.route("POST", "/api/me/password", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> b = req.json();
        String oldPwd = String.valueOf(b.get("oldPassword") == null ? "" : b.get("oldPassword"));
        String newPwd = String.valueOf(b.get("newPassword") == null ? "" : b.get("newPassword"));
        if (newPwd.length() < 8 || newPwd.length() > 128) { res.error(400, "新密码至少 8 位"); return; }
        if (!verifyPassword(oldPwd, str(me, "password_hash"))) { res.error(403, "原密码不对"); return; }
        me.put("password_hash", hashPassword(newPwd));
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/logout", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> s = one("sessions", "token", req.bearer());
        if (s != null) remove("sessions", s);
        store.save();
        // 退出登录就把开机 token 一起清掉，免得下次启动又自动登回去
        writeBootToken("");
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/users/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> t = accountByNumber(req.param("number"));
        if (t == null) { res.error(404, "没有这个号码"); return; }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("account", fullAccount(t, true));
        out.put("isSelf", Boolean.valueOf(num(t, "id") == num(me, "id")));
        out.put("isFriend", Boolean.valueOf(areFriends(num(me, "id"), num(t, "id"))));
        out.put("isBlocked", Boolean.valueOf(isBlocked(num(me, "id"), num(t, "id"))));
        out.put("hasPendingToMe", Boolean.FALSE);
        res.json(out);
      }
    });

    registerFriends(http);
    registerConversations(http);
    registerMessages(http);
    registerMisc(http);
  }

  private boolean validNumber(String n) {
    return n != null && n.matches("^[1-9][0-9]{4,11}$");
  }

  private Map<String, Object> briefAccount(Map<String, Object> a) {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    m.put("id", num(a, "id"));
    m.put("number", str(a, "number"));
    m.put("nickname", str(a, "nickname"));
    m.put("type", str(a, "type"));
    m.put("bio", str(a, "bio"));
    m.put("avatar", str(a, "avatar"));
    return m;
  }

  private Map<String, Object> fullAccount(Map<String, Object> a, boolean withPresence) {
    Map<String, Object> m = briefAccount(a);
    m.put("card_bg", str(a, "card_bg"));
    m.put("photos", parsePhotos(str(a, "photos")));
    m.put("status", str(a, "status"));
    m.put("created_at", num(a, "created_at"));
    m.put("owner_id", num(a, "owner_id"));
    if (withPresence) {
      Map<String, Object> p = presenceOf(num(a, "id"));
      m.put("online", p.get("online"));
      m.put("last_seen", p.get("last_seen"));
    }
    return m;
  }

  /* ================= 好友接口 ================= */

  private void registerFriends(final Http http) {
    http.route("GET", "/api/friends", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        List<Map<String, Object>> rows = where("friendships", "a_id", meId);
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> f : rows) {
          Map<String, Object> a = account(num(f, "b_id"));
          if (a == null) continue;
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("id", num(a, "id"));
          item.put("number", str(a, "number"));
          item.put("type", str(a, "type"));
          item.put("nickname", str(a, "nickname"));
          item.put("bio", str(a, "bio"));
          item.put("avatar", str(a, "avatar"));
          item.put("status", str(a, "status"));
          item.put("remark", str(f, "remark"));
          item.put("special", Boolean.valueOf(num(f, "special") != 0));
          item.put("group_id", num(f, "group_id"));
          item.put("remote", Boolean.valueOf("remote".equals(str(a, "type"))));
          item.put("addr", str(a, "remote_addr"));
          Map<String, Object> p = presenceOf(num(a, "id"));
          item.put("online", p.get("online"));
          item.put("last_seen", p.get("last_seen"));
          out.add(item);
        }
        Collections.sort(out, new Comparator<Object>() {
          @SuppressWarnings("unchecked")
          public int compare(Object x, Object y) {
            Map<String, Object> a = (Map<String, Object>) x;
            Map<String, Object> b = (Map<String, Object>) y;
            boolean sa = Boolean.TRUE.equals(a.get("special"));
            boolean sb = Boolean.TRUE.equals(b.get("special"));
            if (sa != sb) return sa ? -1 : 1;
            return String.valueOf(a.get("nickname")).compareTo(String.valueOf(b.get("nickname")));
          }
        });
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("friends", out);
        res.json(m);
      }
    });

    http.route("GET", "/api/friend-groups", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> g : where("friend_groups", "account_id", meId)) {
          long gid = num(g, "id");
          int count = 0;
          for (Map<String, Object> f : where("friendships", "a_id", meId)) {
            if (num(f, "group_id") == gid) count++;
          }
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("id", gid);
          item.put("name", str(g, "name"));
          item.put("sort_order", num(g, "sort_order"));
          item.put("count", count);
          out.add(item);
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("groups", out);
        res.json(m);
      }
    });

    http.route("POST", "/api/friend-groups", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        String name = String.valueOf(req.json().get("name") == null ? "" : req.json().get("name")).trim();
        if (name.isEmpty() || name.length() > 16) { res.error(400, "分组名 1–16 个字"); return; }
        Map<String, Object> g = new LinkedHashMap<String, Object>();
        long id = store.nextId("friend_groups");
        g.put("id", id);
        g.put("account_id", num(me, "id"));
        g.put("name", name);
        g.put("sort_order", 0);
        g.put("created_at", System.currentTimeMillis());
        put("friend_groups", g);
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Map<String, Object> item = new LinkedHashMap<String, Object>();
        item.put("id", id);
        item.put("name", name);
        item.put("sort_order", 0);
        item.put("count", 0);
        out.put("group", item);
        res.json(out);
      }
    });

    http.route("PATCH", "/api/friend-groups/:id", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> g = one("friend_groups", "id", Long.parseLong(req.param("id")));
        if (g == null || num(g, "account_id") != num(me, "id")) { res.error(404, "没有这个分组"); return; }
        String name = String.valueOf(req.json().get("name") == null ? "" : req.json().get("name")).trim();
        if (!name.isEmpty()) g.put("name", name);
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("DELETE", "/api/friend-groups/:id", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> g = one("friend_groups", "id", Long.parseLong(req.param("id")));
        if (g == null || num(g, "account_id") != num(me, "id")) { res.error(404, "没有这个分组"); return; }
        long gid = num(g, "id");
        remove("friend_groups", g);
        for (Map<String, Object> f : where("friendships", "a_id", num(me, "id"))) {
          if (num(f, "group_id") == gid) { f.put("group_id", 0); store.markDirty(); }
        }
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/friends/requests", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        List<Object> incoming = new ArrayList<Object>();
        List<Object> outgoing = new ArrayList<Object>();
        for (Map<String, Object> r : store.rows("friend_requests")) {
          if (!"pending".equals(str(r, "status"))) continue;
          if (num(r, "to_id") == meId) {
            Map<String, Object> a = account(num(r, "from_id"));
            if (a == null) continue;
            Map<String, Object> item = new LinkedHashMap<String, Object>();
            item.put("id", num(r, "id"));
            item.put("message", str(r, "message"));
            item.put("created_at", num(r, "created_at"));
            item.put("number", str(a, "number"));
            item.put("nickname", str(a, "nickname"));
            item.put("bio", str(a, "bio"));
            item.put("avatar", str(a, "avatar"));
            incoming.add(item);
          } else if (num(r, "from_id") == meId) {
            Map<String, Object> a = account(num(r, "to_id"));
            if (a == null) continue;
            Map<String, Object> item = new LinkedHashMap<String, Object>();
            item.put("id", num(r, "id"));
            item.put("message", str(r, "message"));
            item.put("created_at", num(r, "created_at"));
            item.put("number", str(a, "number"));
            item.put("nickname", str(a, "nickname"));
            item.put("bio", str(a, "bio"));
            item.put("avatar", str(a, "avatar"));
            outgoing.add(item);
          }
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("incoming", incoming);
        m.put("outgoing", outgoing);
        m.put("botIncoming", new ArrayList<Object>());
        res.json(m);
      }
    });

    http.route("POST", "/api/friends/request", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> b = req.json();
        String number = String.valueOf(b.get("number") == null ? "" : b.get("number"));
        String message = String.valueOf(b.get("message") == null ? "" : b.get("message"));
        Map<String, Object> t = accountByNumber(number);
        if (t == null) {
          // 本实例没有这个号码：带了实例地址就走跨实例握手
          String addr = String.valueOf(b.get("addr") == null ? "" : b.get("addr")).trim();
          if (!addr.isEmpty()) {
            Map<String, Object> fedOut = fed.sendRequest(me, addr, number, message);
            if (fedOut.containsKey("error")) {
              long code = num(fedOut, "code");
              res.error(code == 0 ? 400 : (int) code, String.valueOf(fedOut.get("error")));
              return;
            }
            res.json(fedOut);
            return;
          }
          res.error(404, "没有这个号码");
          return;
        }
        long meId = num(me, "id");
        long tid = num(t, "id");
        if (tid == meId) { res.error(400, "不能加自己"); return; }
        if (areFriends(meId, tid)) { res.error(409, "你们已经是好友了"); return; }
        for (Map<String, Object> r : store.rows("friend_requests")) {
          if ("pending".equals(str(r, "status")) && num(r, "from_id") == meId && num(r, "to_id") == tid) {
            res.error(409, "已经发过申请了，等对方处理");
            return;
          }
        }
        Map<String, Object> row = new LinkedHashMap<String, Object>();
        row.put("id", store.nextId("friend_requests"));
        row.put("from_id", meId);
        row.put("to_id", tid);
        row.put("message", message);
        row.put("status", "pending");
        row.put("created_at", System.currentTimeMillis());
        put("friend_requests", row);
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("status", "pending");
        res.json(out);
      }
    });

    http.route("POST", "/api/friends/accept", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        resolveFriend(req, res, true);
      }
    });

    http.route("POST", "/api/friends/reject", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        resolveFriend(req, res, false);
      }
    });

    http.route("DELETE", "/api/friends/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> t = accountByNumber(req.param("number"));
        if (t == null) { res.error(404, "没有这个号码"); return; }
        long meId = num(me, "id");
        long tid = num(t, "id");
        Map<String, Object> f1 = friendRow(meId, tid);
        if (f1 != null) remove("friendships", f1);
        Map<String, Object> f2 = friendRow(tid, meId);
        if (f2 != null) remove("friendships", f2);
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("PATCH", "/api/friends/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> t = accountByNumber(req.param("number"));
        if (t == null) { res.error(404, "没有这个号码"); return; }
        Map<String, Object> f = friendRow(num(me, "id"), num(t, "id"));
        if (f == null) { res.error(404, "还不是好友"); return; }
        Map<String, Object> b = req.json();
        if (b.containsKey("remark")) f.put("remark", String.valueOf(b.get("remark")));
        if (b.containsKey("special")) f.put("special", Boolean.TRUE.equals(b.get("special")) ? 1 : 0);
        if (b.containsKey("groupId")) {
          long gid = b.get("groupId") instanceof Number ? ((Number) b.get("groupId")).longValue() : 0;
          if (gid != 0) {
            Map<String, Object> g = one("friend_groups", "id", gid);
            if (g == null || num(g, "account_id") != num(me, "id")) { res.error(404, "没有这个分组"); return; }
          }
          f.put("group_id", gid);
        }
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/blocks", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> b : where("blocks", "a_id", num(me, "id"))) {
          Map<String, Object> a = account(num(b, "b_id"));
          if (a == null) continue;
          out.add(briefAccount(a));
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("blocks", out);
        res.json(m);
      }
    });

    http.route("POST", "/api/blocks/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> t = accountByNumber(req.param("number"));
        if (t == null) { res.error(404, "没有这个号码"); return; }
        if (!isBlocked(num(me, "id"), num(t, "id"))) {
          Map<String, Object> row = new LinkedHashMap<String, Object>();
          row.put("a_id", num(me, "id"));
          row.put("b_id", num(t, "id"));
          row.put("created_at", System.currentTimeMillis());
          put("blocks", row);
          store.save();
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("DELETE", "/api/blocks/:number", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> t = accountByNumber(req.param("number"));
        if (t == null) { res.error(404, "没有这个号码"); return; }
        for (Map<String, Object> b : where("blocks", "a_id", num(me, "id"))) {
          if (num(b, "b_id") == num(t, "id")) { remove("blocks", b); break; }
        }
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });
  }

  private void resolveFriend(Http.Req req, Http.Res res, boolean accept) {
    Map<String, Object> me = requireMe(req, res);
    if (me == null) return;
    Map<String, Object> b = req.json();
    Map<String, Object> row = null;
    if (b.get("requestId") instanceof Number) {
      row = one("friend_requests", "id", ((Number) b.get("requestId")).longValue());
    } else {
      String number = String.valueOf(b.get("number") == null ? "" : b.get("number"));
      Map<String, Object> from = accountByNumber(number);
      /* 也可以指定 bot：别人想加我的 Bot，由我这个主人代审批 */
      Map<String, Object> toAcc = me;
      if (b.get("bot") != null) {
        Map<String, Object> bot = accountByNumber(String.valueOf(b.get("bot")));
        if (bot != null && "bot".equals(str(bot, "type")) && num(bot, "owner_id") == num(me, "id")) toAcc = bot;
      }
      if (from != null) {
        for (Map<String, Object> r : store.rows("friend_requests")) {
          if (num(r, "from_id") == num(from, "id") && num(r, "to_id") == num(toAcc, "id")
              && "pending".equals(str(r, "status"))) row = r;
        }
      }
    }
    if (row == null) { res.error(404, "没有这条申请"); return; }
    /* 接收方可能是我，也可能是我的 Bot（别人加我的 Bot 由我代审批）——
       以前只认 to_id == 我，导致这类申请点同意/拒绝一律报「这不是发给你的申请」，列表里却一直挂着。 */
    Map<String, Object> target = account(num(row, "to_id"));
    boolean mine = num(row, "to_id") == num(me, "id")
        || (target != null && "bot".equals(str(target, "type")) && num(target, "owner_id") == num(me, "id"));
    if (!mine) { res.error(403, "这不是发给你的申请"); return; }
    if (!"pending".equals(str(row, "status"))) { res.error(409, "这条申请已经处理过了"); return; }
    if (accept) {
      Map<String, Object> from = account(num(row, "from_id"));
      if (from != null && "remote".equals(str(from, "type"))) {
        // 跨实例：先让对方实例那边也建立好友，成功了再落本地，避免单边好友
        Map<String, Object> r = fed.notifyAccepted(from, me);
        if (!Boolean.TRUE.equals(r.get("ok"))) {
          Object e = r.get("error");
          res.error(502, e == null ? "对方实例没连上" : String.valueOf(e));
          return;
        }
        row.put("status", "accepted");
        store.markDirty();
        store.save();
        Map<String, Object> ok = new LinkedHashMap<String, Object>();
        ok.put("ok", Boolean.TRUE);
        ok.put("status", "accepted");
        ok.put("remote", Boolean.TRUE);
        res.json(ok);
        return;
      }
      makeFriends(num(row, "from_id"), num(row, "to_id"));
      row.put("status", "accepted");
    } else {
      row.put("status", "rejected");
    }
    store.markDirty();
    store.save();
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("ok", Boolean.TRUE);
    out.put("status", accept ? "accepted" : "rejected");
    res.json(out);
  }

  /* ================= 会话接口 ================= */

  private void registerConversations(final Http http) {
    http.route("GET", "/api/conversations", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        List<Object> list = new ArrayList<Object>();
        for (Map<String, Object> m : where("members", "account_id", meId)) {
          long convId = num(m, "conversation_id");
          Map<String, Object> c = conv(convId);
          if (c == null) continue;
          long lastRead = num(m, "last_read_id");
          Map<String, Object> last = null;
          for (Map<String, Object> msg : where("messages", "conversation_id", convId)) {
            if (last == null || num(msg, "id") > num(last, "id")) last = msg;
          }
          int unread = 0;
          long lastId = 0;
          if (last != null) {
            lastId = num(last, "id");
            for (Map<String, Object> msg : where("messages", "conversation_id", convId)) {
              if (num(msg, "id") > lastRead && num(msg, "sender_id") != meId) unread++;
            }
          }
          long peerRead = 0;
          for (Map<String, Object> pm : where("members", "conversation_id", convId)) {
            if (num(pm, "account_id") != meId && num(pm, "last_read_id") > peerRead) peerRead = num(pm, "last_read_id");
          }
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("id", convId);
          item.put("kind", str(c, "kind"));
          Map<String, Object> peer = "dm".equals(str(c, "kind")) ? peerOf(convId, meId) : null;
          if (peer != null) {
            Map<String, Object> p = presenceOf(num(peer, "id"));
            peer.put("online", p.get("online"));
            peer.put("status", p.get("status"));
            peer.put("last_seen", p.get("last_seen"));
          }
          item.put("peer", peer);
          item.put("group", "group".equals(str(c, "kind")) ? groupBrief(convGroup(convId)) : null);
          if (last != null) {
            Map<String, Object> l = new LinkedHashMap<String, Object>();
            l.put("id", num(last, "id"));
            l.put("body", bool(last, "recalled") ? "" : str(last, "body"));
            l.put("kind", str(last, "kind"));
            l.put("preview", bool(last, "recalled") ? "[已撤回]" : displayOf(str(last, "kind"), str(last, "body"), readMeta(str(last, "meta"))));
            l.put("mine", num(last, "sender_id") == meId);
            l.put("created_at", num(last, "created_at"));
            item.put("last", l);
          } else {
            item.put("last", null);
          }
          item.put("unread", unread);
          item.put("pinned", Boolean.valueOf(num(m, "pinned") != 0));
          item.put("muted", Boolean.valueOf(num(m, "muted") != 0));
          item.put("peerRead", peerRead);
          item.put("_sort", lastId);
          list.add(item);
        }
        Collections.sort(list, new Comparator<Object>() {
          @SuppressWarnings("unchecked")
          public int compare(Object x, Object y) {
            Map<String, Object> a = (Map<String, Object>) x;
            Map<String, Object> b = (Map<String, Object>) y;
            boolean pa = Boolean.TRUE.equals(a.get("pinned"));
            boolean pb = Boolean.TRUE.equals(b.get("pinned"));
            if (pa != pb) return pa ? -1 : 1;
            return Long.compare(((Number) b.get("_sort")).longValue(), ((Number) a.get("_sort")).longValue());
          }
        });
        for (Object o : list) Json.obj(o).remove("_sort");
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("conversations", list);
        res.json(out);
      }
    });

    http.route("POST", "/api/conversations/:id/mute", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long convId = Long.parseLong(req.param("id"));
        Map<String, Object> m = member(convId, num(me, "id"));
        if (m == null) { res.error(403, "不在这个会话里"); return; }
        m.put("muted", Boolean.TRUE.equals(req.json().get("muted")) ? 1 : 0);
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/conversations/:id/pin", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long convId = Long.parseLong(req.param("id"));
        Map<String, Object> m = member(convId, num(me, "id"));
        if (m == null) { res.error(403, "不在这个会话里"); return; }
        m.put("pinned", Boolean.TRUE.equals(req.json().get("pinned")) ? 1 : 0);
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/conversations/:id/read", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long convId = Long.parseLong(req.param("id"));
        Map<String, Object> m = member(convId, num(me, "id"));
        if (m == null) { res.error(403, "不在这个会话里"); return; }
        long lastId = 0;
        for (Map<String, Object> msg : where("messages", "conversation_id", convId)) {
          if (num(msg, "id") > lastId) lastId = num(msg, "id");
        }
        m.put("last_read_id", lastId);
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/conversations/:id/typing", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long convId = Long.parseLong(req.param("id"));
        if (!memberOf(convId, num(me, "id"))) { res.error(403, "不在这个会话里"); return; }
        boolean off = Boolean.FALSE.equals(req.json().get("typing"));
        synchronized (typing) {
          if (off) typing.remove(convId + ":" + num(me, "id"));
          else typing.put(convId + ":" + num(me, "id"), new long[] { System.currentTimeMillis() });
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/dm", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        String number = String.valueOf(req.json().get("number") == null ? "" : req.json().get("number"));
        Map<String, Object> t = accountByNumber(number);
        if (t == null) { res.error(404, "没有这个号码"); return; }
        if (num(t, "id") == num(me, "id")) { res.error(400, "不能和自己聊"); return; }
        if (!areFriends(num(me, "id"), num(t, "id"))) { res.error(403, "还不是好友，先加好友"); return; }
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("conversationId", getOrCreateDm(num(me, "id"), num(t, "id")));
        res.json(out);
      }
    });

    http.route("GET", "/api/conversations/:id/messages", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long convId = Long.parseLong(req.param("id"));
        long meId = num(me, "id");
        if (!memberOf(convId, meId)) { res.error(403, "不在这个会话里"); return; }
        long after = 0;
        try { after = Long.parseLong(req.queryValue("after")); } catch (Exception e) { after = 0; }
        Map<String, Object> c = conv(convId);
        boolean isGroup = c != null && "group".equals(str(c, "kind"));
        Map<String, Object> g = isGroup ? convGroup(convId) : null;
        List<Map<String, Object>> rows = new ArrayList<Map<String, Object>>();
        for (Map<String, Object> msg : where("messages", "conversation_id", convId)) {
          if (num(msg, "id") > after) rows.add(msg);
        }
        Collections.sort(rows, new Comparator<Map<String, Object>>() {
          public int compare(Map<String, Object> a, Map<String, Object> b) {
            return Long.compare(num(a, "id"), num(b, "id"));
          }
        });
        if (rows.size() > 200) rows = rows.subList(rows.size() - 200, rows.size());
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("messages", serializeMessages(rows, meId, isGroup));
        out.put("typing", typingList(convId, meId));
        out.put("group", g == null ? null : groupBrief(g));
        out.put("announcement", g == null ? "" : str(g, "announcement"));
        res.json(out);
      }
    });

    http.route("POST", "/api/conversations/:id/messages", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long convId = Long.parseLong(req.param("id"));
        if (!memberOf(convId, num(me, "id"))) { res.error(403, "不在这个会话里"); return; }
        Map<String, Object> data = parseInput(req.json());
        if (data.containsKey("error")) { res.error(400, String.valueOf(data.get("error"))); return; }
        Map<String, Object> out = insertMessage(me, convId, data);
        if (out.containsKey("error")) { res.error(outStatus(out), String.valueOf(out.get("error"))); return; }
        store.save();
        Map<String, Object> c = conv(convId);
        boolean isGroup = c != null && "group".equals(str(c, "kind"));
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("ok", Boolean.TRUE);
        payload.put("message", serializeMessage(messageRow(((Number) out.get("id")).longValue()), num(me, "id"), isGroup));
        res.json(payload);
      }
    });

    http.route("POST", "/api/messages", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> b = req.json();
        String to = String.valueOf(b.get("to") == null ? "" : b.get("to"));
        Map<String, Object> t = accountByNumber(to);
        if (t == null) { res.error(404, "没有这个号码"); return; }
        if (num(t, "id") == num(me, "id")) { res.error(400, "不能给自己发"); return; }
        if (!areFriends(num(me, "id"), num(t, "id"))) { res.error(403, "还不是好友，先加好友"); return; }
        Map<String, Object> data = parseInput(b);
        if (data.containsKey("error")) { res.error(400, String.valueOf(data.get("error"))); return; }
        long convId = getOrCreateDm(num(me, "id"), num(t, "id"));
        Map<String, Object> out = insertMessage(me, convId, data);
        if (out.containsKey("error")) { res.error(outStatus(out), String.valueOf(out.get("error"))); return; }
        store.save();
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("ok", Boolean.TRUE);
        payload.put("conversationId", convId);
        payload.put("message", serializeMessage(messageRow(((Number) out.get("id")).longValue()), num(me, "id"), false));
        res.json(payload);
      }
    });
  }

  /* ================= 消息动作 ================= */

  private void registerMessages(final Http http) {
    http.route("POST", "/api/messages/:id/recall", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long id = Long.parseLong(req.param("id"));
        Map<String, Object> row = messageRow(id);
        if (row == null) { res.error(404, "没有这条消息"); return; }
        if (num(row, "sender_id") != num(me, "id")) { res.error(403, "只能撤回自己的消息"); return; }
        if (System.currentTimeMillis() - num(row, "created_at") > 120000L) { res.error(400, "超过两分钟了，撤不回了"); return; }
        row.put("recalled", 1);
        row.put("body", "");
        row.put("meta", "");
        row.put("reply_to_id", 0);
        store.markDirty();
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("POST", "/api/messages/:id/reactions", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long id = Long.parseLong(req.param("id"));
        Map<String, Object> row = messageRow(id);
        if (row == null) { res.error(404, "没有这条消息"); return; }
        long meId = num(me, "id");
        if (!memberOf(num(row, "conversation_id"), meId)) { res.error(403, "不在这个会话里"); return; }
        String emoji = String.valueOf(req.json().get("emoji") == null ? "" : req.json().get("emoji"));
        if (emoji.isEmpty() || emoji.length() > 8) { res.error(400, "表情不对"); return; }
        Map<String, Object> exist = null;
        for (Map<String, Object> r : where("reactions", "message_id", id)) {
          if (num(r, "account_id") == meId && str(r, "emoji").equals(emoji)) exist = r;
        }
        if (exist != null) {
          remove("reactions", exist);
        } else {
          int kinds = 0;
          List<String> seen = new ArrayList<String>();
          for (Map<String, Object> r : where("reactions", "message_id", id)) {
            if (!seen.contains(str(r, "emoji"))) { seen.add(str(r, "emoji")); kinds++; }
          }
          if (kinds >= 20) { res.error(400, "一条消息最多 20 种表情"); return; }
          Map<String, Object> r = new LinkedHashMap<String, Object>();
          r.put("message_id", id);
          r.put("account_id", meId);
          r.put("emoji", emoji);
          r.put("created_at", System.currentTimeMillis());
          put("reactions", r);
        }
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("reactions", reactionsFor(id, meId));
        res.json(out);
      }
    });

    http.route("POST", "/api/messages/:id/delete", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long id = Long.parseLong(req.param("id"));
        Map<String, Object> row = messageRow(id);
        if (row == null) { res.error(404, "没有这条消息"); return; }
        long meId = num(me, "id");
        if (!memberOf(num(row, "conversation_id"), meId)) { res.error(403, "不在这个会话里"); return; }
        boolean exists = false;
        for (Map<String, Object> d : where("deletions", "message_id", id)) {
          if (num(d, "account_id") == meId) exists = true;
        }
        if (!exists) {
          Map<String, Object> d = new LinkedHashMap<String, Object>();
          d.put("message_id", id);
          d.put("account_id", meId);
          d.put("created_at", System.currentTimeMillis());
          put("deletions", d);
          store.save();
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/favorites", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> f : where("favorites", "account_id", meId)) {
          Map<String, Object> msg = messageRow(num(f, "message_id"));
          if (msg == null) continue;
          Map<String, Object> conv = conv(num(msg, "conversation_id"));
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("saved_at", num(f, "created_at"));
          item.put("message", serializeMessage(msg, meId, false));
          Map<String, Object> cb = new LinkedHashMap<String, Object>();
          if (conv != null && "group".equals(str(conv, "kind"))) {
            Map<String, Object> g = convGroup(num(conv, "id"));
            Map<String, Object> gg = new LinkedHashMap<String, Object>();
            gg.put("number", g == null ? "" : str(g, "number"));
            gg.put("name", g == null ? "" : str(g, "name"));
            cb.put("kind", "group");
            cb.put("group", gg);
          } else {
            Map<String, Object> peer = peerOf(num(msg, "conversation_id"), meId);
            Map<String, Object> pp = new LinkedHashMap<String, Object>();
            pp.put("number", peer == null ? "" : str(peer, "number"));
            pp.put("nickname", peer == null ? "" : str(peer, "nickname"));
            pp.put("avatar", peer == null ? "" : str(peer, "avatar"));
            cb.put("kind", "dm");
            cb.put("peer", pp);
          }
          item.put("conversation", cb);
          out.add(item);
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("favorites", out);
        res.json(m);
      }
    });

    http.route("POST", "/api/messages/:id/favorite", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long id = Long.parseLong(req.param("id"));
        Map<String, Object> row = messageRow(id);
        if (row == null) { res.error(404, "没有这条消息"); return; }
        long meId = num(me, "id");
        boolean exists = false;
        for (Map<String, Object> f : where("favorites", "account_id", meId)) {
          if (num(f, "message_id") == id) exists = true;
        }
        if (!exists) {
          Map<String, Object> f = new LinkedHashMap<String, Object>();
          f.put("id", store.nextId("favorites"));
          f.put("account_id", meId);
          f.put("message_id", id);
          f.put("created_at", System.currentTimeMillis());
          put("favorites", f);
          store.save();
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("favorited", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("DELETE", "/api/messages/:id/favorite", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long id = Long.parseLong(req.param("id"));
        long meId = num(me, "id");
        for (Map<String, Object> f : where("favorites", "account_id", meId)) {
          if (num(f, "message_id") == id) { remove("favorites", f); break; }
        }
        store.save();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("favorited", Boolean.FALSE);
        res.json(out);
      }
    });

    http.route("POST", "/api/messages/:id/forward", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long id = Long.parseLong(req.param("id"));
        Map<String, Object> src = messageRow(id);
        if (src == null) { res.error(404, "没有这条消息"); return; }
        long meId = num(me, "id");
        if (!memberOf(num(src, "conversation_id"), meId)) { res.error(403, "不在这个会话里"); return; }
        long convId = req.json().get("conversationId") instanceof Number
            ? ((Number) req.json().get("conversationId")).longValue() : 0;
        if (convId == 0 || !memberOf(convId, meId)) { res.error(403, "不在这个会话里"); return; }
        Map<String, Object> sender = account(num(src, "sender_id"));
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("kind", "forward");
        data.put("body", str(src, "body"));
        data.put("replyTo", 0L);
        Map<String, Object> meta = new LinkedHashMap<String, Object>();
        Map<String, Object> from = new LinkedHashMap<String, Object>();
        from.put("number", sender == null ? "" : str(sender, "number"));
        from.put("nickname", sender == null ? "" : str(sender, "nickname"));
        meta.put("from", from);
        meta.put("kind", str(src, "kind"));
        data.put("meta", Json.write(meta));
        Map<String, Object> out = insertMessage(me, convId, data);
        if (out.containsKey("error")) { res.error(outStatus(out), String.valueOf(out.get("error"))); return; }
        store.save();
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("ok", Boolean.TRUE);
        payload.put("message", serializeMessage(messageRow(((Number) out.get("id")).longValue()), meId, false));
        res.json(payload);
      }
    });

    http.route("POST", "/api/conversations/:id/forward-merge", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        long srcConv = Long.parseLong(req.param("id"));
        if (!memberOf(srcConv, meId)) { res.error(403, "不在这个会话里"); return; }
        Map<String, Object> body = req.json();
        Object idsRaw = body.get("messageIds");
        long targetConv = body.get("conversationId") instanceof Number
            ? ((Number) body.get("conversationId")).longValue() : 0;
        if (!(idsRaw instanceof List) || targetConv == 0) { res.error(400, "参数不对"); return; }
        List<?> ids = (List<?>) idsRaw;
        if (ids.isEmpty() || ids.size() > 50) { res.error(400, "参数不对"); return; }
        if (!memberOf(targetConv, meId)) { res.error(403, "不在目标会话里"); return; }
        List<Object> items = new ArrayList<Object>();
        for (Object o : ids) {
          if (!(o instanceof Number)) continue;
          Map<String, Object> m = one("messages", "id", ((Number) o).longValue());
          if (m == null) continue;
          if (num(m, "conversation_id") != srcConv) continue;
          Map<String, Object> sender = account(num(m, "sender_id"));
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("number", sender == null ? "" : str(sender, "number"));
          item.put("nickname", sender == null ? "" : str(sender, "nickname"));
          item.put("kind", str(m, "kind"));
          String b = str(m, "body");
          item.put("body", bool(m, "recalled") ? "" : (b.length() > 500 ? b.substring(0, 500) : b));
          item.put("created_at", num(m, "created_at"));
          items.add(item);
        }
        if (items.isEmpty()) { res.error(400, "没有可转发的消息"); return; }
        Map<String, Object> meta = new LinkedHashMap<String, Object>();
        meta.put("title", "聊天记录");
        meta.put("count", items.size());
        meta.put("items", items);
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("kind", "merge");
        data.put("body", "[聊天记录] " + items.size() + " 条");
        data.put("replyTo", 0L);
        data.put("meta", Json.write(meta));
        Map<String, Object> out = insertMessage(me, targetConv, data);
        if (out.containsKey("error")) { res.error(outStatus(out), String.valueOf(out.get("error"))); return; }
        store.save();
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("ok", Boolean.TRUE);
        payload.put("message", serializeMessage(messageRow(((Number) out.get("id")).longValue()), meId, false));
        res.json(payload);
      }
    });

    http.route("GET", "/api/messages/search", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        String q = req.queryValue("q");
        if (q == null || q.trim().isEmpty()) { res.error(400, "请输入搜索词"); return; }
        String key = q.toLowerCase();
        long meId = num(me, "id");
        List<Object> out = new ArrayList<Object>();
        for (Map<String, Object> m : store.rows("messages")) {
          if (!memberOf(num(m, "conversation_id"), meId)) continue;
          if (bool(m, "recalled")) continue;
          if (str(m, "body").toLowerCase().indexOf(key) < 0) continue;
          Map<String, Object> item = serializeMessage(m, meId, false);
          item.put("conversationId", num(m, "conversation_id"));
          out.add(item);
        }
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("messages", out);
        res.json(payload);
      }
    });
  }

  /* ================= 其它 ================= */

  private void registerMisc(final Http http) {
    http.route("GET", "/api/notifications", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        long meId = num(me, "id");
        List<Map<String, Object>> items = new ArrayList<Map<String, Object>>();
        for (Map<String, Object> r : store.rows("friend_requests")) {
          if (num(r, "to_id") != meId || !"pending".equals(str(r, "status"))) continue;
          Map<String, Object> a = account(num(r, "from_id"));
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("type", "friend_request");
          item.put("requestId", num(r, "id"));
          item.put("created_at", num(r, "created_at"));
          Map<String, Object> from = new LinkedHashMap<String, Object>();
          from.put("number", a == null ? "" : str(a, "number"));
          from.put("nickname", a == null ? "" : str(a, "nickname"));
          from.put("avatar", a == null ? "" : str(a, "avatar"));
          from.put("type", a == null ? "user" : str(a, "type"));
          item.put("from", from);
          item.put("message", str(r, "message"));
          items.add(item);
        }
        for (Map<String, Object> r : store.rows("group_requests")) {
          if (num(r, "to_id") != meId || !"pending".equals(str(r, "status"))) continue;
          Map<String, Object> g = one("groups", "id", num(r, "group_id"));
          Map<String, Object> a = account(num(r, "from_id"));
          if (g == null) continue;
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("type", "group_invite");
          item.put("requestId", num(r, "id"));
          item.put("created_at", num(r, "created_at"));
          Map<String, Object> gg = new LinkedHashMap<String, Object>();
          gg.put("number", str(g, "number"));
          gg.put("name", str(g, "name"));
          item.put("group", gg);
          Map<String, Object> from = new LinkedHashMap<String, Object>();
          from.put("number", a == null ? "" : str(a, "number"));
          from.put("nickname", a == null ? "" : str(a, "nickname"));
          from.put("avatar", a == null ? "" : str(a, "avatar"));
          item.put("from", from);
          items.add(item);
        }
        for (Map<String, Object> g : store.rows("groups")) {
          long gid = num(g, "id");
          Map<String, Object> gm = null;
          for (Map<String, Object> x : where("group_members", "group_id", gid)) {
            if (num(x, "account_id") == meId) gm = x;
          }
          if (gm == null) continue;
          if (str(g, "announcement").isEmpty()) continue;
          if (num(g, "announcement_updated_at") <= num(gm, "announcement_read_at")) continue;
          Map<String, Object> item = new LinkedHashMap<String, Object>();
          item.put("type", "announcement");
          item.put("created_at", num(g, "announcement_updated_at"));
          Map<String, Object> gg = new LinkedHashMap<String, Object>();
          gg.put("number", str(g, "number"));
          gg.put("name", str(g, "name"));
          item.put("group", gg);
          item.put("announcement", str(g, "announcement"));
          items.add(item);
        }
        Collections.sort(items, new Comparator<Map<String, Object>>() {
          public int compare(Map<String, Object> a, Map<String, Object> b) {
            return Long.compare(num(b, "created_at"), num(a, "created_at"));
          }
        });
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("count", items.size());
        out.put("items", items);
        res.json(out);
      }
    });

    http.route("GET", "/api/relay/status", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        if (relay == null) {
          out.put("enabled", Boolean.FALSE);
          out.put("url", "");
          res.json(out);
          return;
        }
        out.putAll(relay.status());
        res.json(out);
      }
    });

    http.route("PATCH", "/api/relay/settings", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        if (relay == null) {
          res.error(500, "中继模块没起来，重开一次 App 试试");
          return;
        }
        Map<String, Object> body = req.json();
        String raw = str(body, "url").trim();
        if (!raw.isEmpty() && Relay.normalizeUrl(raw).isEmpty()) {
          res.error(400, "中继地址格式不对，示例：https://relay.example.com:7800");
          return;
        }
        relay.setUrl(raw);
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        if (raw.isEmpty()) {
          relay.stop();
          out.putAll(relay.status());
          res.json(out);
          return;
        }
        relay.start();
        Map<String, Object> reg = relay.register();
        out.putAll(relay.status());
        out.put("registerError", reg.get("error"));
        res.json(out);
      }
    });

    http.route("GET", "/api/server-info", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Map<String, Object> fedInfo = fed.info();
        out.put("version", version);
        out.put("port", port);
        out.put("host", "0.0.0.0");
        out.put("boundToLan", Boolean.TRUE);
        out.put("lanUrls", fedInfo.get("lanUrls"));
        out.put("lanNames", new ArrayList<Object>());
        out.put("publicV6", fedInfo.get("publicV6"));
        out.put("instanceId", fedInfo.get("instanceId"));
        out.put("publicAddr", fedInfo.get("publicAddr"));
        out.put("myAddresses", fedInfo.get("myAddresses"));
        out.put("webReady", Boolean.TRUE);
        out.put("local", Boolean.TRUE);
        res.json(out);
      }
    });

    http.route("GET", "/api/apk/info", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("available", Boolean.FALSE);
        out.put("version", version);
        out.put("message", "手机端自己就是服务端，不需要再下载安装包");
        res.json(out);
      }
    });

    // 手机版不跑 Bot：前端 Bot 广场会请求这几个接口，给空列表而不是报错
    http.route("GET", "/api/bots", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("bots", new ArrayList<Object>());
        out.put("note", "手机版不跑 Bot，Bot 请在电脑版使用");
        res.json(out);
      }
    });

    http.route("GET", "/api/bots/public", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        String q = req.queryValue("q").trim().toLowerCase();
        long meId = num(me, "id");
        List<Object> bots = new ArrayList<Object>();
        // 手机自己不跑 Bot，但别的实例（电脑版）上公开的 Bot 要能看到、能加
        for (Map<String, Object> b : fed.remoteBots()) {
          String number = str(b, "number");
          String nickname = str(b, "nickname");
          if (!q.isEmpty() && !number.toLowerCase().contains(q) && !nickname.toLowerCase().contains(q)) continue;
          Map<String, Object> item = new LinkedHashMap<String, Object>(b);
          Map<String, Object> local = accountByNumber(number);
          item.put("added", Boolean.valueOf(local != null));
          item.put("isFriend", Boolean.valueOf(local != null && areFriends(meId, num(local, "id"))));
          item.put("isMine", Boolean.FALSE);
          bots.add(item);
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("total", bots.size());
        out.put("bots", bots);
        out.put("note", bots.isEmpty()
            ? "暂时没发现别的实例上的 Bot：先和电脑版互加好友，或让两台设备连同一个 Wi-Fi"
            : "");
        res.json(out);
      }
    });

    http.route("POST", "/api/bots", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        res.error(400, "手机版不创建 Bot：Bot 要有一台一直开着的电脑跑接入服务，请在电脑版创建");
      }
    });

    http.route("GET", "/api/astrbot/platforms", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("platforms", new ArrayList<Object>());
        res.json(out);
      }
    });

    http.route("POST", "/api/upload", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) throws Exception {
        Map<String, Object> me = requireMe(req, res);
        if (me == null) return;
        if (req.body.length == 0) { res.error(400, "没有收到文件"); return; }
        if (req.body.length > 25 * 1024 * 1024) { res.error(413, "文件不能超过 25MB"); return; }
        String name = req.queryValue("name");
        if (name == null || name.isEmpty()) name = "file";
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        if (name.length() > 80) name = name.substring(0, 80);
        String ext = "bin";
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) ext = name.substring(dot + 1).toLowerCase();
        File dir = new File(dataDir, "uploads");
        if (!dir.exists()) dir.mkdirs();
        String stored = System.currentTimeMillis() + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16) + "." + ext;
        FileOutputStream out = new FileOutputStream(new File(dir, stored));
        out.write(req.body);
        out.close();
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("ok", Boolean.TRUE);
        payload.put("url", "/uploads/" + stored);
        payload.put("name", name);
        payload.put("size", req.body.length);
        payload.put("mime", Http.mimeOf(stored));
        res.json(payload);
      }
    });

    http.route("GET", "/uploads/*", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) throws Exception {
        String rest = req.param("g1");
        int slash = rest.lastIndexOf('/');
        String name = slash >= 0 ? rest.substring(slash + 1) : rest;
        if (name.isEmpty() || name.startsWith(".")) { res.error(404, "没有这个文件"); return; }
        File f = new File(new File(dataDir, "uploads"), name);
        if (!f.exists() || f.isDirectory()) { res.error(404, "没有这个文件"); return; }
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        res.headers.put("Cache-Control", "public, max-age=86400");
        res.bytes(buf.toByteArray(), Http.mimeOf(name));
      }
    });

    http.route("GET", "/*", new Http.Handler() {
      public void handle(Http.Req req, Http.Res res) {
        if (req.path.startsWith("/api/")) { res.error(404, "没有这个接口"); return; }
        http.serveStatic(req.path, res);
      }
    });
  }

  /* 给 Groups 用的包内访问器 */
  Store store() { return store; }
  Map<String, Object> accountOf(long id) { return account(id); }
  Map<String, Object> accountByNumberOf(String number) { return accountByNumber(number); }
  Map<String, Object> convOf(long id) { return conv(id); }
  Map<String, Object> memberOfConv(long convId, long accId) { return member(convId, accId); }
  void addMemberTo(long convId, long accId) { addMember(convId, accId); }
  Map<String, Object> convGroupOf(long convId) { return convGroup(convId); }
  Map<String, Object> groupBriefOf(Map<String, Object> g) { return groupBrief(g); }
  Map<String, Object> requireMeOf(Http.Req req, Http.Res res) { return requireMe(req, res); }
  Map<String, Object> presenceMap(long accId) { return presenceOf(accId); }
  long idOf(Map<String, Object> row) { return num(row, "id"); }
  String strOf(Map<String, Object> row, String k) { return str(row, k); }
  long numOf(Map<String, Object> row, String k) { return num(row, k); }
  boolean boolOf(Map<String, Object> row, String k) { return bool(row, k); }
  Map<String, Object> findOne(String table, String field, Object value) { return one(table, field, value); }
  List<Map<String, Object>> findAll(String table, String field, Object value) { return where(table, field, value); }
  List<Map<String, Object>> allRows(String table) { return store.rows(table); }
  void insertRow(String table, Map<String, Object> row) { put(table, row); }
  void deleteRow(String table, Map<String, Object> row) { remove(table, row); }
  void saveAll() { store.save(); }
  long nextIdOf(String table) { return store.nextId(table); }
  Map<String, Object> serializeMsg(Map<String, Object> m, long meId, boolean isGroup) { return serializeMessage(m, meId, isGroup); }
  Map<String, Object> insertMsg(Map<String, Object> me, long convId, Map<String, Object> data) { return insertMessage(me, convId, data); }
  Map<String, Object> messageById(long id) { return messageRow(id); }
  boolean memberCheck(long convId, long accId) { return memberOf(convId, accId); }
  String versionOf() { return version; }
  Map<String, Object> errMap(String message) { return err(message); }
  Map<String, Object> readMetaOf(String raw) { return readMeta(raw); }
  boolean friendsOf(long a, long b) { return areFriends(a, b); }
  void makeFriendsOf(long a, long b) { makeFriends(a, b); }
  long dmOf(long a, long b) { return getOrCreateDm(a, b); }
  Federation fedOf() { return fed; }
}
