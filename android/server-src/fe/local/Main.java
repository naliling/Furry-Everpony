package fe.local;

import java.io.File;

/** 手机端本地服务入口：Java 主函数启动，不需要 Node、不需要电脑。 */
public final class Main {
  private static Http http;

  public static synchronized int start(File dataDir, int port, String version) throws Exception {
    if (http != null) return port;
    if (!dataDir.exists()) dataDir.mkdirs();
    Store store = new Store(dataDir);
    File webRoot = new File(dataDir, "web");
    Api api = new Api(store, dataDir, version, port);
    Http server = new Http(port, webRoot);
    api.register(server);
    int real = server.start();
    http = server;
    return real;
  }

  public static synchronized void stop() {
    if (http != null) {
      http.stop();
      http = null;
    }
  }

  /** 命令行跑法：java fe.local.Main <端口> <数据目录> <版本号> */
  public static void main(String[] args) throws Exception {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : 7788;
    File dir = new File(args.length > 1 ? args[1] : "data");
    String version = args.length > 2 ? args[2] : "0.0.0";
    int real = start(dir, port, version);
    System.out.println("FE_LOCAL_SERVER_READY " + real);
    Thread.currentThread().join();
  }
}
