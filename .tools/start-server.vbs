' Everony 服务端开机自启：无窗口调用 launch-server.mjs（它再 spawn 出常驻服务端并立刻退出）
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony\.tools\node-v22.23.5-win-x64\node.exe"" ""C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony\.tools\launch-server.mjs""", 0, False
