# TTS MCP profiles

此目录保存可由 `desktop-char.config.json -> ttsMcp.profile` 选择的 TTS Provider Profile。
Profile 名只能使用小写字母、数字、点、下划线和连字符，且不能包含路径片段。

- `local.json`：仓库内参考 Provider，由 DesktopChar 托管进程。
- `qwen.json`：连接 `127.0.0.1:8766/mcp` 的跨设备 external Profile，不包含本机启动路径。
- `*.local.json`：设备专属 Profile，默认由 Git 忽略。可复制现有 Profile 后补充绝对路径、
  环境变量或本机音色，并用包含 `.local` 的文件名选择它，例如 `qwen.local`。

可提交的 Profile 不得包含用户目录、盘符绑定、密钥或仓库外工具的绝对路径。
