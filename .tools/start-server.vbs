' Everony 开机自启：无窗口启动「后台服务端」与「外网隧道」两个常驻进程
' launch-server.mjs / launch-tunnel.mjs 都只负责 spawn 出常驻进程然后立刻退出
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony\.tools\node-v22.23.5-win-x64\node.exe"" ""C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony\.tools\launch-server.mjs""", 0, False
sh.Run """C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony\.tools\node-v22.23.5-win-x64\node.exe"" ""C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony\.tools\launch-tunnel.mjs""", 0, False
