using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// 只用 .NET 4.0 就有的东西：System.dll 里的 DeflateStream + 手写 ZIP 解析。
// 不能用 System.IO.Compression.ZipArchive —— 那是 .NET 4.5 才加的，
// 只有 .NET 4.0 的机器（例如 Win7）会报「未能加载文件或程序集 System.IO.Compression」。

[assembly: System.Reflection.AssemblyTitle("Furry Everpony")]
[assembly: System.Reflection.AssemblyProduct("Furry Everpony")]
[assembly: System.Reflection.AssemblyDescription("Furry Everpony 启动器（自解压）")]
[assembly: System.Reflection.AssemblyCompany("Furry Everpony")]
[assembly: System.Reflection.AssemblyCopyright("Furry Everpony")]
[assembly: System.Reflection.AssemblyVersion("2026.11.16.0")]
[assembly: System.Reflection.AssemblyFileVersion("2026.11.16.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("2026.11.16.0.10.16")]

namespace FeSfx {
  // 把整包里的某一段当成独立流来读
  sealed class SubStream : Stream {
    readonly Stream b; readonly long start; readonly long len; long pos;
    public SubStream(Stream baseStream, long offset, long length) { b = baseStream; start = offset; len = length; pos = 0; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return len; } }
    public override long Position { get { return pos; } set { pos = value; } }
    public override int Read(byte[] buffer, int offset, int count) {
      long remain = len - pos;
      if (remain <= 0) return 0;
      if (count > remain) count = (int)remain;
      lock (b) {
        b.Seek(start + pos, SeekOrigin.Begin);
        int n = b.Read(buffer, offset, count);
        pos += n;
        return n;
      }
    }
    public override long Seek(long offset, SeekOrigin origin) {
      long np = origin == SeekOrigin.Begin ? offset : (origin == SeekOrigin.Current ? pos + offset : len + offset);
      if (np < 0) np = 0;
      if (np > len) np = len;
      pos = np;
      return pos;
    }
    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
  }

  // ZIP 中央目录里的一条记录
  sealed class ZipEntryInfo {
    public string Name;
    public long LocalOffset;
    public long CompressedSize;
    public long UncompressedSize;
    public int Method;
    public bool IsDir;
  }

  static class ZipReader {
    const uint EOCD_SIG = 0x06054b50;
    const uint CEN_SIG = 0x02014b50;
    const uint LOC_SIG = 0x04034b50;

    static void ReadExact(Stream s, byte[] buf, int count) {
      int got = 0;
      while (got < count) {
        int n = s.Read(buf, got, count - got);
        if (n <= 0) throw new Exception("文件意外结束（想读 " + count + " 字节，只读到 " + got + "）");
        got += n;
      }
    }

    public static List<ZipEntryInfo> ReadCentral(Stream fs) {
      long len = fs.Length;
      int tailLen = (int)Math.Min(len, 66000);
      byte[] tail = new byte[tailLen];
      fs.Seek(len - tailLen, SeekOrigin.Begin);
      ReadExact(fs, tail, tailLen);

      int eocd = -1;
      for (int i = tailLen - 22; i >= 0; i--) {
        if (BitConverter.ToUInt32(tail, i) == EOCD_SIG) { eocd = i; break; }
      }
      if (eocd < 0) throw new Exception("不是有效的 ZIP（找不到中央目录结尾）");

      int count = BitConverter.ToUInt16(tail, eocd + 10);
      uint cdSize = BitConverter.ToUInt32(tail, eocd + 12);
      uint cdOffset = BitConverter.ToUInt32(tail, eocd + 16);
      if (count == 0xFFFF || cdOffset == 0xFFFFFFFF) throw new Exception("暂不支持 ZIP64 格式的安装包");

      var list = new List<ZipEntryInfo>(count);
      fs.Seek(cdOffset, SeekOrigin.Begin);
      byte[] hdr = new byte[46];
      for (int i = 0; i < count; i++) {
        ReadExact(fs, hdr, 46);
        if (BitConverter.ToUInt32(hdr, 0) != CEN_SIG) throw new Exception("中央目录第 " + (i + 1) + " 条记录损坏");
        var e = new ZipEntryInfo();
        e.Method = BitConverter.ToUInt16(hdr, 10);
        e.CompressedSize = BitConverter.ToUInt32(hdr, 20);
        e.UncompressedSize = BitConverter.ToUInt32(hdr, 24);
        int nameLen = BitConverter.ToUInt16(hdr, 28);
        int extraLen = BitConverter.ToUInt16(hdr, 30);
        int commentLen = BitConverter.ToUInt16(hdr, 32);
        e.LocalOffset = BitConverter.ToUInt32(hdr, 42);
        byte[] nb = new byte[nameLen];
        if (nameLen > 0) ReadExact(fs, nb, nameLen);
        e.Name = Encoding.UTF8.GetString(nb);
        e.IsDir = e.Name.EndsWith("/");
        if (extraLen + commentLen > 0) {
          byte[] skip = new byte[extraLen + commentLen];
          ReadExact(fs, skip, skip.Length);
        }
        list.Add(e);
      }
      return list;
    }

    // 数据区起点：本地头之后
    public static long DataStart(Stream fs, ZipEntryInfo e) {
      fs.Seek(e.LocalOffset, SeekOrigin.Begin);
      byte[] h = new byte[30];
      ReadExact(fs, h, 30);
      if (BitConverter.ToUInt32(h, 0) != LOC_SIG) throw new Exception("本地文件头损坏：" + e.Name);
      int nameLen = BitConverter.ToUInt16(h, 26);
      int extraLen = BitConverter.ToUInt16(h, 28);
      return e.LocalOffset + 30 + nameLen + extraLen;
    }

    public static void ExtractTo(Stream fs, ZipEntryInfo e, string target) {
      long start = DataStart(fs, e);
      using (var raw = new SubStream(fs, start, e.CompressedSize)) {
        Stream src = raw;
        if (e.Method == 8) src = new DeflateStream(raw, CompressionMode.Decompress);
        else if (e.Method != 0) throw new Exception("不支持的压缩方式 " + e.Method + "：" + e.Name);
        using (src) {
          using (var dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 81920)) {
            byte[] buf = new byte[81920];
            long written = 0;
            while (true) {
              int n = src.Read(buf, 0, buf.Length);
              if (n <= 0) break;
              dst.Write(buf, 0, n);
              written += n;
            }
            if (e.UncompressedSize > 0 && written != e.UncompressedSize) {
              throw new Exception("解出来的大小不对：" + e.Name + " 期望 " + e.UncompressedSize + " 实际 " + written);
            }
          }
        }
      }
    }
  }

  sealed class ProgressForm : Form {
    readonly ProgressBar bar; readonly Label lbl;
    public ProgressForm() {
      Text = "Furry Everpony";
      FormBorderStyle = FormBorderStyle.FixedDialog;
      StartPosition = FormStartPosition.CenterScreen;
      MaximizeBox = false; MinimizeBox = false; ControlBox = false;
      ClientSize = new Size(440, 116);
      BackColor = Color.FromArgb(250, 252, 255);
      try { Font = new Font("Microsoft YaHei UI", 9F); } catch { }
      lbl = new Label();
      lbl.Text = "第一次启动，正在展开程序文件…";
      lbl.Left = 18; lbl.Top = 18; lbl.Width = 404; lbl.Height = 22;
      lbl.ForeColor = Color.FromArgb(30, 40, 60);
      bar = new ProgressBar();
      bar.Left = 18; bar.Top = 50; bar.Width = 404; bar.Height = 18;
      bar.Minimum = 0; bar.Maximum = 100;
      Controls.Add(lbl); Controls.Add(bar);
    }
    public void SetProgress(int pct, string msg) {
      if (pct < 0) pct = 0; if (pct > 100) pct = 100;
      bar.Value = pct; lbl.Text = msg;
    }
    public void WaitThread(Thread th) {
      var timer = new System.Windows.Forms.Timer();
      timer.Interval = 120;
      timer.Tick += delegate { if (!th.IsAlive) { timer.Stop(); Close(); } };
      timer.Start();
      Application.Run(this);
    }
  }

  static class Program {
    static readonly string LogPath = Path.Combine(Path.GetTempPath(), "fe-sfx.log");
    public static void Log(string s) {
      string line = DateTime.Now.ToString("HH:mm:ss.fff ") + s + Environment.NewLine;
      try { File.AppendAllText(LogPath, line, Encoding.UTF8); } catch { }
      try { File.AppendAllText(Path.Combine(Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName), "fe-sfx.log"), line, Encoding.UTF8); } catch { }
    }
    const string Magic = "FESFX001";
    const string Version = "2026.11.16.0.10.16";
    const string AppExe = "Furry Everpony.exe";

    [STAThread]
    // Environment.OSVersion 在没写清单的程序里会把 Win10 报成 6.2，只能查注册表构建号
    static int WindowsBuild() {
      try {
        object v = Microsoft.Win32.Registry.GetValue(
          @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuild", null);
        if (v == null) return 0;
        int n;
        return int.TryParse(Convert.ToString(v), out n) ? n : 0;
      } catch { return 0; }
    }

    static string WindowsName(int build) {
      if (build >= 22000) return "11";
      if (build >= 10240) return "10";
      if (build >= 9600) return "8.1";
      if (build >= 9200) return "8";
      if (build >= 7600) return "7";
      return "旧版本";
    }

    static void Main(string[] args) {
      try {
        Log("== 启动器开始 TEMP=" + Path.GetTempPath() + " CWD=" + Environment.CurrentDirectory);
        Log("运行时=" + Environment.Version + " 系统=" + Environment.OSVersion);
        string self = Process.GetCurrentProcess().MainModule.FileName;
        Log("self=" + self);
        int build = WindowsBuild();
        Log("系统构建=" + build + "（Windows " + WindowsName(build) + "）");
        if (build > 0 && build < 10240) {
          // 老系统上应用本体（Chromium 内核）跑不起来，与其解包 370MB 再报一串 DLL 错误，不如直接说清楚
          MessageBox.Show(
            "这个版本需要 Windows 10 或更高版本（64 位）。" + Environment.NewLine + Environment.NewLine +
            "当前系统是 Windows " + WindowsName(build) + "（构建号 " + build + "），界面用的是 Chromium 内核，在它上面跑不起来。"
              + Environment.NewLine + Environment.NewLine +
            "可以这样做：" + Environment.NewLine +
            "1）换一台 Windows 10 / 11 的电脑，双击同一个 exe 就能用；" + Environment.NewLine +
            "2）或者手机装 FurryEverpony.apk，连到已经在跑的那台电脑。",
            "Furry Everpony", MessageBoxButtons.OK, MessageBoxIcon.Warning);
          return;
        }
        string root = PickRoot(self);
        string dir = Path.Combine(root, "app-" + Version);
        string exe = Path.Combine(dir, AppExe);
        Log("目标目录=" + dir + " 已解包=" + File.Exists(exe));
        if (!File.Exists(exe)) {
          Directory.CreateDirectory(root);
          string tmp = Path.Combine(root, "app-" + Version + ".tmp");
          if (Directory.Exists(tmp)) { try { Directory.Delete(tmp, true); } catch { } }
          Log("开始解包到 " + tmp);
          Extract(self, tmp);
          Log("解包完成");
          if (Directory.Exists(dir)) { try { Directory.Delete(dir, true); } catch { } }
          Directory.Move(tmp, dir);
        }
        var psi = new ProcessStartInfo(exe);
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = true;
        if (args != null && args.Length > 0) psi.Arguments = string.Join(" ", args);
        Process.Start(psi);
        Log("已启动 " + exe);
        var cleanup = new Thread(delegate () { CleanupOld(root, dir); });
        cleanup.IsBackground = false;  // 前台线程：进程要等清理做完才退出
        cleanup.Start();
      } catch (Exception ex) {
        Log("错误: " + ex.ToString());
        MessageBox.Show("启动失败：" + Environment.NewLine + ex.Message, "Furry Everpony", MessageBoxButtons.OK, MessageBoxIcon.Error);
      }
    }

    // 更新后把上一版解包目录删掉，避免每次升级多占 370MB
    static void CleanupOld(string root, string keep) {
      try {
        foreach (string d in Directory.GetDirectories(root, "app-*")) {
          if (string.Equals(Path.GetFullPath(d), Path.GetFullPath(keep), StringComparison.OrdinalIgnoreCase)) continue;
          try { Directory.Delete(d, true); Log("已清理旧版本目录 " + d); }
          catch (Exception ex) { Log("旧版本目录清理失败 " + d + " : " + ex.Message); }
        }
      } catch (Exception ex) { Log("清理旧版本目录出错: " + ex.Message); }
    }

    static string PickRoot(string self) {
      string[] cands = new string[] {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FurryEverpony"),
        Path.Combine(Path.GetDirectoryName(self), "FurryEverpony-data")
      };
      foreach (string c in cands) {
        try { Directory.CreateDirectory(c); Log("根目录可用: " + c); return c; }
        catch (Exception ex) { Log("根目录不可用 " + c + " : " + ex.Message); }
      }
      throw new Exception("找不到可写的解包目录");
    }

    static void Extract(string self, string dest) {
      using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        long len = fs.Length;
        if (len < 64) throw new Exception("文件太小，不像是安装包");
        fs.Seek(-16, SeekOrigin.End);
        byte[] tail = new byte[16];
        ReadExact(fs, tail, 16);
        long payloadLen = BitConverter.ToInt64(tail, 0);
        string magic = Encoding.ASCII.GetString(tail, 8, 8);
        Log("载荷长度=" + payloadLen);
        if (magic != Magic) throw new Exception("包尾标记不对（" + magic + "）");
        long start = len - 16 - payloadLen;
        if (start < 0 || payloadLen <= 0) throw new Exception("载荷长度不对");
        Log("载荷起点=" + start);

        using (var sub = new SubStream(fs, start, payloadLen)) {
          List<ZipEntryInfo> entries = ZipReader.ReadCentral(sub);
          Log("条目数=" + entries.Count);
          var form = new ProgressForm();
          form.Show();
          form.Refresh();
          Exception err = null;
          var th = new Thread(delegate () {
            try {
              int total = entries.Count;
              int i = 0;
              foreach (ZipEntryInfo e in entries) {
                i++;
                string rel = e.Name.Replace('/', '\\');
                string target = Path.Combine(dest, rel);
                if (e.IsDir) {
                  Directory.CreateDirectory(target);
                } else {
                  string d = Path.GetDirectoryName(target);
                  if (!string.IsNullOrEmpty(d)) Directory.CreateDirectory(d);
                  ZipReader.ExtractTo(sub, e, target);
                }
                if (i % 25 == 0 || i == total) {
                  int pct = total == 0 ? 100 : (int)(i * 100L / total);
                  string msg = "正在准备 " + i + " / " + total + " 个文件";
                  try { form.BeginInvoke((Action)delegate { form.SetProgress(pct, msg); }); } catch { }
                }
              }
            } catch (Exception ex) { err = ex; }
          });
          th.IsBackground = true;
          th.Start();
          form.WaitThread(th);
          form.Close();
          if (err != null) throw new Exception("解包失败：" + err.Message);
        }
      }
    }

    static void ReadExact(Stream s, byte[] buf, int count) {
      int got = 0;
      while (got < count) {
        int n = s.Read(buf, got, count - got);
        if (n <= 0) throw new Exception("文件意外结束（想读 " + count + " 字节，只读到 " + got + "）");
        got += n;
      }
    }
  }
}
