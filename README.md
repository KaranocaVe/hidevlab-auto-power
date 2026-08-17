# HiDevLab 自动开机 / 抢卡助手

这是一个面向 `https://hidevlab.huawei.com/online-develop` 的 Tampermonkey 用户脚本。它通过页面上的可见按钮操作开发环境，不调用隐藏接口，也不绕过验证码或服务端限流。

## 一键安装

已安装 Tampermonkey 的 Edge 用户可以直接打开下面的地址：

[安装 / 更新用户脚本](https://raw.githubusercontent.com/KaranocaVe/hidevlab-auto-power/main/hidevlab-auto-power.user.js)

如果点击后没有出现安装页面：

1. 打开 Tampermonkey 控制面板。
2. 进入“实用工具”或“Utilities”。
3. 在“从 URL 安装 / Install from URL”中粘贴：

   ```text
   https://raw.githubusercontent.com/KaranocaVe/hidevlab-auto-power/main/hidevlab-auto-power.user.js
   ```

4. 确认安装，回到 HiDevLab 在线开发页面并刷新。

普通的 GitHub `blob` 页面不是安装地址，应该使用上面的 `raw.githubusercontent.com` 地址。

## 功能

- 自动识别当前页面中的开发环境，显示名称、规格描述和实时状态。
- 通过复选框选择目标环境，支持“全选已关机”和“清空选择”。
- 按页面流程循环操作：`开机 → 确认 → 关闭“资源调度中” → 重新开机`。
- 识别“运行中”“已开机”“已启动”等成功状态后发送浏览器通知，并可自动停止。
- 显示本轮尝试次数。
- 日志摘要会合并连续重复消息；点击“查看完整日志”可查看本次页面会话保留的全部日志，最多 2000 条。
- 运行时可启用 Screen Wake Lock，尽量降低标签页休眠概率。
- 面板标题栏支持拖动，支持收起/展开，并保存面板位置和折叠状态。
- 设置通过 Tampermonkey 的本地存储保存，不上传到第三方服务。

## 使用方式

1. 打开 HiDevLab 在线开发页面。
2. 在面板中勾选要尝试的开发环境。
3. 确认“自动点击确认开机”是否开启。
4. 建议保持“运行时尽量防止标签页休眠”开启。
5. 点击“开始抢卡”；成功后会通知并按设置停止。
6. 需要中断时点击“停止”。

“检查间隔(ms)”控制普通轮询频率；“关闭后重试(ms)”控制关闭资源调度提示后重新点击开机前的等待时间。未选择目标时，脚本不会提交开机请求。

## 防休眠说明

脚本优先使用浏览器的 Screen Wake Lock，并在页面回到前台时重新申请。Wake Lock 受 Edge 版本、系统节电策略、浏览器权限和页面是否被彻底冻结影响；它只能尽量降低休眠概率，不能突破操作系统的强制冻结策略。

## 隐私与安全

- 只在 HiDevLab 页面上查找并点击可见的“开机”“确定”“关闭”按钮。
- 不读取密码、Cookie、Token 或其他浏览器凭据。
- 不调用隐藏 API，不上传日志，不绕过验证码和限流。
- 使用前请确认所选环境和卡时配额，避免误启动不需要的环境。

## 开源许可

本项目以 [MIT License](./LICENSE) 发布。

本项目与华为及 HiDevLab 官方没有隶属或授权关系。
