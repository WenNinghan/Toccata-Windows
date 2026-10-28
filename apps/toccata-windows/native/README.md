# Windows Raw Input helper

`raw_input_helper.c` 是随桌面应用按需启动的 Windows 本地采集子进程；隐藏的顶层窗口接收键盘 Raw Input，监听不抑制系统输入。它不保存文件、不联网、不翻译字符，退出后不保留事件。启动即注册后台输入；上层负责向用户展示采集状态并控制进程生命周期。Windows 的 Fn 是否产生事件取决于硬件，此 helper 不会虚构或推断 Fn/语音事件。

## 构建与状态机自测

```powershell
gcc -std=c11 -Wall -Wextra -Werror -O2 raw_input_helper.c -o raw_input_helper.exe -luser32
.\raw_input_helper.exe --self-test
```

自测直接调用纯状态转换逻辑以及 UTF-8/JSON 编码检查，不接收实际键盘输入。还应在 Windows 实际安装环境分别测试后台、设备断连、睡眠唤醒和普通按键，不能用自测结果替代这些场景。

## 子进程协议

用管道启动可执行文件，Windows UI 宿主设置 `windowsHide`，持续读取 UTF-8 stdout 行和 stderr；不要把标准输出记录到日志。注册成功后输出 `{"type":"ready","protocol":1}`。启动失败时仅向 stderr 输出诊断并以非零状态退出，不会输出 ready。每次消息以换行结束并立即刷新。

按键行示例（数值为示例）：

```json
{"type":"key","event_id":1,"scan":30,"ext":0,"vkey":65,"device":"10049","kind":"down","ts_ms":1790000000000,"hold_ms":null,"app":"notepad.exe","exe_path":"C:\\Example\\notepad.exe"}
{"type":"key","event_id":2,"scan":30,"ext":0,"vkey":65,"device":"10049","kind":"up","ts_ms":1790000000100,"hold_ms":100,"app":"notepad.exe","exe_path":"C:\\Example\\notepad.exe"}
```

- `event_id` 在当前进程内递增，进程重启后从 1 重新开始。上层持久化或去重须加上每次启动生成的实例 ID，不能单独用 `event_id`，也不能只凭毫秒时间和键码判断是否同一事件。
- `scan` 是 Windows 扫描码；`ext` 是原始 E0/E1 标志（分别为 2 和 4，可为 0）；`vkey` 是虚拟键码。它们不是 macOS CGKeyCode，不允许作为同一键码空间无标记混存。`scan=0` 的按键以 `vkey` 辅助区分，不能宣称可准确识别物理位置。
- `device` 是本次运行中的临时设备句柄十六进制字符串；不要作为永久硬件标识，也不要假设跨次启动稳定。
- `ts_ms` 是 Unix 毫秒时间；`hold_ms` 只在匹配成功的 up 上给出，使用单调时钟。孤立 up 的 `hold_ms` 为 null。每个设备上同一扫描码和扩展标志的重复 down 被过滤。
- `app` 是发生事件时查询到的前台进程可执行文件名，获取失败为 null；`exe_path` 是同一进程的绝对路径 UTF-8 字符串，获取或严格 UTF-8 转换失败为 null。不收集窗口标题。前台切换和安全桌面等情况需要实际测试。
- `exe_path` 含用户本机路径，只能经匿名管道短暂传给主进程用于本机身份计算和获取图标；宿主不得将它写日志、数据库、发送 renderer、联网或导出。helper 不写磁盘或日志。使用 keyed digest 作为持久化身份并不是加密，泄露密钥后的路径猜测风险仍存在。
- 设备移除时输出 `{"type":"reset","reason":"device_removed","device":"..."}`；睡眠时输出 `{"type":"reset","reason":"suspend","device":null}`。上层应清除相应的实时按住状态，避免长按时间无限增长；历史孤立 down 按上层的短窗口规则处理。设备重新出现时从新事件开始。
- 达到按住状态容量时输出 `{"type":"warning","reason":"held_key_capacity"}`。此类丢失应显示采集异常，不能当作完整数据。

向 stdin 写入 `quit\n` 或 `{"cmd":"quit"}\n`、或关闭 stdin，helper 会退出；主进程异常退出使管道关闭时亦会退出。关闭窗口或退出应用之前，宿主应优先正常关闭 stdin 并等待子进程退出。
