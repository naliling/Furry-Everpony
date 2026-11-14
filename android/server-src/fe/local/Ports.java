package fe.local;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 本机服务端口的选择顺序。
 *
 * 手机端的登录 token 存在网页 localStorage 里，而 localStorage 按 origin 隔离（含端口）。
 * 如果每次启动都从固定端口往后试，一旦端口漂移，网页就换了个 origin，token 读不到，
 * 表现就是「把 App 从最近任务划掉再打开又要重新登录」。
 * 所以把上次成功的端口排到第一位，尽量让端口稳定；只有它真的绑不上才往后换。
 */
public final class Ports {
  private Ports() {}

  /** 上次成功的端口（在 [first, first+tries) 内）排第一，其余按 first 起递增补齐，去重。 */
  public static int[] order(int lastPort, int first, int tries) {
    int n = tries < 1 ? 1 : tries;
    Set<Integer> set = new LinkedHashSet<Integer>();
    if (lastPort >= first && lastPort < first + n) set.add(Integer.valueOf(lastPort));
    for (int i = 0; i < n; i++) set.add(Integer.valueOf(first + i));
    int[] out = new int[set.size()];
    int k = 0;
    for (Integer v : set) out[k++] = v.intValue();
    return out;
  }

  /** 命令行：java fe.local.Ports <上次端口> <起始端口> <尝试个数>，打印尝试顺序，给测试用。 */
  public static void main(String[] args) {
    int last = args.length > 0 ? Integer.parseInt(args[0]) : 0;
    int first = args.length > 1 ? Integer.parseInt(args[1]) : 7788;
    int tries = args.length > 2 ? Integer.parseInt(args[2]) : 12;
    int[] o = order(last, first, tries);
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < o.length; i++) {
      if (i > 0) sb.append(',');
      sb.append(o[i]);
    }
    System.out.println("PORT_ORDER " + sb.toString());
  }
}
