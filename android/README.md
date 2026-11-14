# Furry Everpony 手机端（APK）

这是一个**瘦客户端**：界面本身由电脑上的服务端提供，APK 只负责
找到服务器、把 WebView 指过去，并补上手机端缺的能力。
所以服务端升级不用重装 APK，APK 只在你改客户端壳本身时才需要重新打包。

## 它做了什么

- 首次打开是服务器地址页：手填 `192.168.1.108:7788` 或点「搜索局域网里的服务器」自动扫 /24 网段
- 连上后进入完整界面（跟电脑端同一套前端，手机断点自动生效）
- 服务器地址记在 SharedPreferences，下次打开直接连
- 在界面里连按两次返回键 → 回到地址页，可以换服务器
- 网页里的外链用系统浏览器打开，站内跳转留在 WebView
- 文件上传（图片/文件/语音选择）走系统文件选择器
- 补了三个「HTTP 局域网不是安全上下文」的缺口：
  - `navigator.clipboard` → 桥到 Android 剪贴板（`window.feAndroid.copy()`）
  - `crypto.randomUUID` → 用 `getRandomValues` 兜底实现
  - `navigator.serviceWorker` → 补空实现，避免注册时抛异常

## 目录

```
android/
  AndroidManifest.xml            包名 dev.furryeverpony.app，minSdk 24 / targetSdk 34
  res/                           图标（矢量）、主题、网络安全配置（允许明文 HTTP）
  java/dev/furryeverpony/app/
    MainActivity.java            地址页 + WebView + 文件选择 + 返回键 + 剪贴板桥
    Discovery.java               局域网 /24 扫描（并发探 /api/health）
    ServerStore.java             地址规范化与持久化
  build-apk.mjs                  构建脚本（aapt2 → javac → d8 → zipalign → apksigner）
  keystore/fe-release.jks        签名密钥（口令 furryeverpony，别名 fe）——必须保留
  dist/                          构建产物
```

## 构建

```bash
# 需要 ../.tools/android/{jdk-17*,sdk}，SDK 里要有 build-tools;34.0.0 与 platforms;android-34
node android/build-apk.mjs
```

不用 Gradle、不用 Android Studio、不联网下载依赖：脚本直接调 SDK 里的
`aapt2`（编资源）、`javac`（编 Java）、`d8`（转 dex）、`zipalign`、`apksigner`。

版本号跟 `package.json` 走；`versionCode` = 100000 + 主*10000 + 次*100 + 修，
保证每次发布单调递增（否则覆盖安装会失败）。

产物同时复制到 `dist-apk/FurryEverpony-<版本>.apk`。

## 安装

1. 电脑端「设置 → 允许手机访问」打开，记下显示的局域网地址
2. 手机连同一个 Wi-Fi
3. 传 apk 到手机安装（首次需允许「安装未知来源应用」）
4. 打开 App → 填地址或点扫描 → 连接

## 已知限制

- 走的是 HTTP 明文局域网：不做 TLS，因为自托管场景下证书没法签。APK 已放开
  cleartext，浏览器（PWA）也能用同样地址访问
- 手机端录音（`getUserMedia`）在 http 下拿不到麦克风权限，这是 Chromium 的
  安全上下文限制，不是壳的问题；要语音消息得等 TLS 或改用原生录音
- 没有推送：手机 App 关掉后收不到通知，需要保持前台或用系统级推送（未做）
