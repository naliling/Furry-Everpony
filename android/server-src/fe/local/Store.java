package fe.local;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机本地数据库：一个 JSON 文件装全部表。
 * 个人聊天的数据量很小，这样实现最简单，也没有原生依赖；写入走「临时文件 + 原子改名」，断电不会写坏。
 */
public final class Store {
  private final File file;
  private final Map<String, Object> root;
  private boolean dirty;

  public Store(File dir) {
    if (!dir.exists()) dir.mkdirs();
    this.file = new File(dir, "local-db.json");
    this.root = load();
  }

  private Map<String, Object> load() {
    if (!file.exists()) return new LinkedHashMap<String, Object>();
    try {
      InputStream in = new FileInputStream(file);
      byte[] buf = new byte[(int) file.length()];
      int off = 0;
      while (off < buf.length) {
        int n = in.read(buf, off, buf.length - off);
        if (n <= 0) break;
        off += n;
      }
      in.close();
      String text = new String(buf, 0, off, StandardCharsets.UTF_8);
      if (text.trim().isEmpty()) return new LinkedHashMap<String, Object>();
      return Json.obj(Json.parse(text));
    } catch (Exception e) {
      // 文件坏了就当空库，至少能启动
      return new LinkedHashMap<String, Object>();
    }
  }

  public synchronized List<Object> table(String name) {
    Object v = root.get(name);
    if (!(v instanceof List)) {
      List<Object> list = new ArrayList<Object>();
      root.put(name, list);
      return list;
    }
    return Json.arr(v);
  }

  public synchronized List<Map<String, Object>> rows(String name) {
    List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
    for (Object o : table(name)) out.add(Json.obj(o));
    return out;
  }

  public synchronized void markDirty() {
    dirty = true;
  }

  public synchronized void save() {
    if (!dirty) return;
    try {
      File tmp = new File(file.getParentFile(), file.getName() + ".tmp");
      FileOutputStream out = new FileOutputStream(tmp);
      Writer w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
      w.write(Json.write(root));
      w.flush();
      w.close();
      if (file.exists()) file.delete();
      tmp.renameTo(file);
      dirty = false;
    } catch (Exception e) {
      // 存盘失败不影响本次请求
    }
  }

  public synchronized long nextId(String table) {
    long max = 0;
    for (Map<String, Object> r : rows(table)) {
      Object id = r.get("id");
      if (id instanceof Number && ((Number) id).longValue() > max) max = ((Number) id).longValue();
    }
    return max + 1;
  }
}
