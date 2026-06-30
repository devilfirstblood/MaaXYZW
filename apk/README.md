# apk

配套工具 APK。

## GameWxQRlogin-xyzw.apk

咸鱼之王微信扫码登录工具（基于 [GameWxQRlogin](https://github.com/Willh92/GameWxQRlogin) 编译，已内置「咸鱼之王」游戏配置）。

用于在模拟器/设备上做咸鱼之王的微信扫码代登录：打开游戏点微信登录跳转后，用本 App 生成二维码分享给对方扫码授权，实现代登录。多账号自动化时用来切换/登录账号。

- 包名：`com.willh.wz`
- 咸鱼之王微信 APPID：`wxfb0d5667e5cb1c44`（从咸鱼之王 APK 的 `assets/jsb-adapter/game-defines.js` 的 `gt.APPID` 提取，原项目远程列表不含此游戏）
- 安装：`adb install apk/GameWxQRlogin-xyzw.apk`
- 打开后右上角菜单选「咸鱼之王」（已置顶），即可生成扫码登录二维码

> 注：本 APK 为 debug 包，仅供配套自动化使用。源工程不在本仓库内。
