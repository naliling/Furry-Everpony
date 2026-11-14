package fe.local;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 极小的 JSON 编解码：只支持标准 JSON，数字统一用 Long（小数用 Double）。 */
public final class Json {
  private final String s;
  private int i;

  private Json(String s) { this.s = s; }

  public static Object parse(String text) {
    Json p = new Json(text);
    p.ws();
    Object v = p.value();
    p.ws();
    if (p.i < p.s.length()) throw new IllegalArgumentException("JSON 尾部有多余内容");
    return v;
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(Object v) {
    if (v instanceof Map) return (Map<String, Object>) v;
    return new LinkedHashMap<String, Object>();
  }

  @SuppressWarnings("unchecked")
  public static List<Object> arr(Object v) {
    if (v instanceof List) return (List<Object>) v;
    return new ArrayList<Object>();
  }

  public static String write(Object o) {
    StringBuilder b = new StringBuilder();
    writeTo(b, o);
    return b.toString();
  }

  private static void writeTo(StringBuilder b, Object o) {
    if (o == null) { b.append("null"); return; }
    if (o instanceof String) { str(b, (String) o); return; }
    if (o instanceof Boolean) { b.append(((Boolean) o) ? "true" : "false"); return; }
    if (o instanceof Number) {
      Number n = (Number) o;
      if (n instanceof Double || n instanceof Float) {
        double d = n.doubleValue();
        if (d == Math.rint(d) && Math.abs(d) < 1e15) b.append((long) d);
        else b.append(d);
      } else {
        b.append(n.longValue());
      }
      return;
    }
    if (o instanceof Map) {
      b.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
        if (!first) b.append(',');
        first = false;
        str(b, String.valueOf(e.getKey()));
        b.append(':');
        writeTo(b, e.getValue());
      }
      b.append('}');
      return;
    }
    if (o instanceof Iterable) {
      b.append('[');
      boolean first = true;
      for (Object v : (Iterable<?>) o) {
        if (!first) b.append(',');
        first = false;
        writeTo(b, v);
      }
      b.append(']');
      return;
    }
    str(b, String.valueOf(o));
  }

  private static void str(StringBuilder b, String s) {
    b.append('"');
    for (int k = 0; k < s.length(); k++) {
      char c = s.charAt(k);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
      }
    }
    b.append('"');
  }

  private void ws() {
    while (i < s.length()) {
      char c = s.charAt(i);
      if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
      else break;
    }
  }

  private Object value() {
    ws();
    if (i >= s.length()) throw new IllegalArgumentException("JSON 不完整");
    char c = s.charAt(i);
    if (c == '{') return object();
    if (c == '[') return array();
    if (c == '"') return string();
    if (c == 't') { expect("true"); return Boolean.TRUE; }
    if (c == 'f') { expect("false"); return Boolean.FALSE; }
    if (c == 'n') { expect("null"); return null; }
    return number();
  }

  private void expect(String lit) {
    if (!s.startsWith(lit, i)) throw new IllegalArgumentException("JSON 字面量不对");
    i += lit.length();
  }

  private Map<String, Object> object() {
    Map<String, Object> m = new LinkedHashMap<String, Object>();
    i++;
    ws();
    if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
    while (true) {
      ws();
      String k = string();
      ws();
      if (s.charAt(i) != ':') throw new IllegalArgumentException("JSON 缺少冒号");
      i++;
      m.put(k, value());
      ws();
      char c = s.charAt(i);
      if (c == ',') { i++; continue; }
      if (c == '}') { i++; return m; }
      throw new IllegalArgumentException("JSON 对象不完整");
    }
  }

  private List<Object> array() {
    List<Object> list = new ArrayList<Object>();
    i++;
    ws();
    if (i < s.length() && s.charAt(i) == ']') { i++; return list; }
    while (true) {
      list.add(value());
      ws();
      char c = s.charAt(i);
      if (c == ',') { i++; continue; }
      if (c == ']') { i++; return list; }
      throw new IllegalArgumentException("JSON 数组不完整");
    }
  }

  private String string() {
    if (s.charAt(i) != '"') throw new IllegalArgumentException("JSON 期望字符串");
    i++;
    StringBuilder b = new StringBuilder();
    while (i < s.length()) {
      char c = s.charAt(i++);
      if (c == '"') return b.toString();
      if (c != '\\') { b.append(c); continue; }
      char e = s.charAt(i++);
      switch (e) {
        case '"': b.append('"'); break;
        case '\\': b.append('\\'); break;
        case '/': b.append('/'); break;
        case 'b': b.append('\b'); break;
        case 'f': b.append('\f'); break;
        case 'n': b.append('\n'); break;
        case 'r': b.append('\r'); break;
        case 't': b.append('\t'); break;
        case 'u':
          b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
          i += 4;
          break;
        default: throw new IllegalArgumentException("JSON 转义不对");
      }
    }
    throw new IllegalArgumentException("JSON 字符串没有结束");
  }

  private Object number() {
    int start = i;
    if (i < s.length() && (s.charAt(i) == '-' || s.charAt(i) == '+')) i++;
    boolean dot = false;
    while (i < s.length()) {
      char c = s.charAt(i);
      if (c >= '0' && c <= '9') { i++; continue; }
      if (c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+') { if (c == '.') dot = true; i++; continue; }
      break;
    }
    String t = s.substring(start, i);
    if (t.isEmpty()) throw new IllegalArgumentException("JSON 数字不对");
    if (dot) return Double.parseDouble(t);
    return Long.parseLong(t);
  }
}
