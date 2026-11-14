package fe.local;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 手写的最小 HTTP/1.1 服务器：够用、无依赖、能在 Android 上跑。 */
public final class Http {
  public interface Handler {
    void handle(Req req, Res res) throws Exception;
  }

  public static final class Req {
    public String method = "";
    public String path = "";
    public String rawQuery = "";
    public final Map<String, String> query = new HashMap<String, String>();
    public final Map<String, String> headers = new HashMap<String, String>();
    public final Map<String, String> params = new HashMap<String, String>();
    public byte[] body = new byte[0];

    public String header(String name) {
      String v = headers.get(name.toLowerCase());
      return v == null ? "" : v;
    }

    public String bearer() {
      String h = header("authorization");
      if (h.startsWith("Bearer ")) return h.substring(7).trim();
      return "";
    }

    public String param(String k) {
      String v = params.get(k);
      return v == null ? "" : v;
    }

    public Map<String, Object> json() {
      if (body.length == 0) return new LinkedHashMap<String, Object>();
      try {
        return Json.obj(Json.parse(new String(body, StandardCharsets.UTF_8)));
      } catch (Exception e) {
        return new LinkedHashMap<String, Object>();
      }
    }

    public String queryValue(String k) {
      String v = query.get(k);
      return v == null ? "" : v;
    }
  }

  public static final class Res {
    public int status = 200;
    public final Map<String, String> headers = new LinkedHashMap<String, String>();
    public byte[] body = new byte[0];

    public void json(Object value) {
      body = Json.write(value).getBytes(StandardCharsets.UTF_8);
      headers.put("Content-Type", "application/json; charset=utf-8");
    }

    public void code(int c) { status = c; }

    public void error(int c, String message) {
      status = c;
      Map<String, Object> m = new LinkedHashMap<String, Object>();
      m.put("error", message);
      json(m);
    }

    public void bytes(byte[] data, String type) {
      body = data;
      headers.put("Content-Type", type);
    }
  }

  private static final class Route {
    final String method;
    final Pattern pattern;
    final Handler handler;
    final List<String> names = new ArrayList<String>();

    Route(String method, String path, Handler handler) {
      this.method = method;
      this.handler = handler;
      String p = path;
      if (p.equals("/uploads/*") || p.equals("/*")) {
        this.pattern = Pattern.compile("^" + Pattern.quote(p.substring(0, p.length() - 1)) + "(.*)$");
        names.add("g1");
      } else {
        StringBuilder re = new StringBuilder("^");
        Matcher m = Pattern.compile(":([A-Za-z_][A-Za-z0-9_]*)").matcher(p);
        int last = 0;
        while (m.find()) {
          re.append(Pattern.quote(p.substring(last, m.start())));
          re.append("([^/]+)");
          names.add(m.group(1));
          last = m.end();
        }
        re.append(Pattern.quote(p.substring(last)));
        re.append("$");
        this.pattern = Pattern.compile(re.toString());
      }
    }
  }

  /** 登录 token 只认小写十六进制、长度 16–64；不合规就当没有，绝不往网页里拼。 */
  private static final Pattern TOKEN_SHAPE = Pattern.compile("^[0-9a-f]{16,64}$");

  private final List<Route> routes = new ArrayList<Route>();
  private final File webRoot;
  /** 数据目录（webRoot 的父目录）：boot-token.txt 就放在这里。 */
  private final File dataDir;
  private final int port;
  private volatile boolean running;
  private ServerSocket server;

  public Http(int port, File webRoot) {
    this.port = port;
    this.webRoot = webRoot;
    this.dataDir = webRoot == null ? null : webRoot.getParentFile();
  }

  public void route(String method, String path, Handler handler) {
    routes.add(new Route(method, path, handler));
  }

  public int start() throws Exception {
    server = new ServerSocket(port);
    running = true;
    Thread t = new Thread(new Runnable() {
      public void run() {
        while (running) {
          try {
            final Socket sock = server.accept();
            Thread w = new Thread(new Runnable() {
              public void run() { serve(sock); }
            });
            w.setDaemon(true);
            w.start();
          } catch (Exception e) {
            if (!running) return;
          }
        }
      }
    });
    t.setDaemon(true);
    t.start();
    return server.getLocalPort();
  }

  public void stop() {
    running = false;
    try { if (server != null) server.close(); } catch (Exception e) { /* 忽略 */ }
  }

  private void serve(Socket sock) {
    try {
      sock.setSoTimeout(20000);
      InputStream in = new BufferedInputStream(sock.getInputStream());
      OutputStream out = sock.getOutputStream();

      String requestLine = readLine(in);
      if (requestLine == null || requestLine.isEmpty()) { sock.close(); return; }
      String[] parts = requestLine.split(" ");
      if (parts.length < 2) { sock.close(); return; }

      Req req = new Req();
      req.method = parts[0].toUpperCase();
      String target = parts[1];
      int qm = target.indexOf('?');
      if (qm >= 0) {
        req.rawQuery = target.substring(qm + 1);
        target = target.substring(0, qm);
      }
      req.path = decode(target);

      String line;
      int contentLength = 0;
      while ((line = readLine(in)) != null && !line.isEmpty()) {
        int c = line.indexOf(':');
        if (c > 0) {
          String k = line.substring(0, c).trim().toLowerCase();
          String v = line.substring(c + 1).trim();
          req.headers.put(k, v);
          if (k.equals("content-length")) {
            try { contentLength = Integer.parseInt(v); } catch (Exception e) { contentLength = 0; }
          }
        }
      }
      if (contentLength > 0) {
        byte[] buf = new byte[contentLength];
        int off = 0;
        while (off < contentLength) {
          int n = in.read(buf, off, contentLength - off);
          if (n <= 0) break;
          off += n;
        }
        req.body = buf;
      }
      if (!req.rawQuery.isEmpty()) {
        for (String pair : req.rawQuery.split("&")) {
          if (pair.isEmpty()) continue;
          int eq = pair.indexOf('=');
          String k = eq >= 0 ? pair.substring(0, eq) : pair;
          String v = eq >= 0 ? pair.substring(eq + 1) : "";
          req.query.put(decode(k), decode(v));
        }
      }

      Res res = new Res();
      boolean matched = false;
      for (Route r : routes) {
        if (!r.method.equals(req.method) && !r.method.equals("*")) continue;
        Matcher m = r.pattern.matcher(req.path);
        if (!m.matches()) continue;
        matched = true;
        for (int g = 1; g <= m.groupCount() && g <= r.names.size(); g++) {
          req.params.put(r.names.get(g - 1), decode(m.group(g)));
        }
        try {
          r.handler.handle(req, res);
        } catch (Exception e) {
          res.error(500, "服务出错了：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
        break;
      }
      if (!matched) res.error(404, "没有这个接口");

      write(out, res);
      sock.close();
    } catch (Exception e) {
      try { sock.close(); } catch (Exception ignore) { /* 忽略 */ }
    }
  }

  private void write(OutputStream out, Res res) throws Exception {
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ").append(res.status).append(' ').append(statusText(res.status)).append("\r\n");
    if (!res.headers.containsKey("Content-Type")) res.headers.put("Content-Type", "application/octet-stream");
    res.headers.put("Content-Length", String.valueOf(res.body.length));
    res.headers.put("Connection", "close");
    res.headers.put("Access-Control-Allow-Origin", "*");
    for (Map.Entry<String, String> e : res.headers.entrySet()) {
      head.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
    }
    head.append("\r\n");
    out.write(head.toString().getBytes(StandardCharsets.UTF_8));
    out.write(res.body);
    out.flush();
  }

  private static String statusText(int code) {
    switch (code) {
      case 200: return "OK";
      case 201: return "Created";
      case 400: return "Bad Request";
      case 401: return "Unauthorized";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 409: return "Conflict";
      case 413: return "Payload Too Large";
      case 500: return "Internal Server Error";
      default: return "OK";
    }
  }

  private static String readLine(InputStream in) throws Exception {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int c;
    while ((c = in.read()) >= 0) {
      if (c == '\n') break;
      if (c != '\r') buf.write(c);
    }
    if (c < 0 && buf.size() == 0) return null;
    return new String(buf.toByteArray(), StandardCharsets.UTF_8);
  }

  private static String decode(String s) {
    try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
  }

  /** 静态文件：给 WebView 提供打包在 App 里的网页。 */
  public void serveStatic(String path, Res res) {
    try {
      if (webRoot == null) { res.error(404, "没有网页资源"); return; }
      String rel = path;
      if (rel.startsWith("/")) rel = rel.substring(1);
      if (rel.isEmpty()) rel = "index.html";
      File f = new File(webRoot, rel);
      if (!f.exists() || f.isDirectory()) {
        if (!rel.contains(".")) f = new File(webRoot, "index.html");
        if (!f.exists()) { res.error(404, "没有这个文件"); return; }
      }
      FileInputStream in = new FileInputStream(f);
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      int n;
      while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
      in.close();
      byte[] data = buf.toByteArray();
      // 首页才注入登录态：端口换了 origin 就变了，localStorage 里的 token 读不到，这里补一次
      if (f.getName().equalsIgnoreCase("index.html")) data = injectBootToken(data);
      res.bytes(data, mimeOf(f.getName()));
    } catch (Exception e) {
      res.error(500, "读不了文件");
    }
  }

  /**
   * 把落盘的登录 token 塞进首页：在 </head> 前插一段 setItem。
   *
   * 手机端的登录 token 存在 localStorage，而 localStorage 按 origin 隔离（含端口）。
   * 端口一旦变了，新 origin 下 localStorage 是空的，网页就以为没登录过。
   * 服务端自己存着最近在用的 token，返回首页时补一次，用户就不用重新登录。
   */
  private byte[] injectBootToken(byte[] html) {
    String token = bootToken();
    if (token.isEmpty()) return html;
    String text = new String(html, StandardCharsets.UTF_8);
    int at = text.toLowerCase().indexOf("</head>");
    if (at < 0) return html;
    String script = "<script>try{localStorage.setItem('fe_token',\"" + token + "\")}catch(e){}</script>";
    String out = text.substring(0, at) + script + text.substring(at);
    return out.getBytes(StandardCharsets.UTF_8);
  }

  /** 读 dataDir/boot-token.txt；文件不存在或内容不合规都返回空串（不注入）。 */
  private String bootToken() {
    if (dataDir == null) return "";
    File f = new File(dataDir, "boot-token.txt");
    if (!f.exists()) return "";
    try {
      FileInputStream in = new FileInputStream(f);
      byte[] buf = new byte[(int) Math.min(4096, f.length() + 16)];
      int n = in.read(buf);
      in.close();
      if (n <= 0) return "";
      String t = new String(buf, 0, n, StandardCharsets.UTF_8).trim();
      return TOKEN_SHAPE.matcher(t).matches() ? t : "";
    } catch (Exception e) {
      return "";
    }
  }

  public static String mimeOf(String name) {
    String n = name.toLowerCase();
    if (n.endsWith(".html")) return "text/html; charset=utf-8";
    if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
    if (n.endsWith(".css")) return "text/css; charset=utf-8";
    if (n.endsWith(".json")) return "application/json; charset=utf-8";
    if (n.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
    if (n.endsWith(".svg")) return "image/svg+xml";
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
    if (n.endsWith(".webp")) return "image/webp";
    if (n.endsWith(".gif")) return "image/gif";
    if (n.endsWith(".ico")) return "image/x-icon";
    if (n.endsWith(".woff2")) return "font/woff2";
    return "application/octet-stream";
  }
}
