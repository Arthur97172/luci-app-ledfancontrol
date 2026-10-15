# `factory-pwm` 行为规格 / Behaviour specification

本文档是 `/usr/bin/factory-pwm`（闭源 aarch64 Go 二进制，4.2.2-r1）的**行为规格**，
由反汇编得出，并在真机上逐条验证。前端 `ledfancontrol.js` 里的每一个默认值、
每一个枚举、每一个状态名，都以本文档为依据。

This document is the **behaviour specification** of `/usr/bin/factory-pwm`, a
closed-source aarch64 Go binary (4.2.2-r1), recovered by disassembly and
verified point-by-point against the live device. Every default, enum and state
name in the frontend traces back to something in here.

## 0. 分析方法 / How this was recovered

二进制是 stripped 的，但 Go 把自己的符号表留在了 `pclntab` 里。解析
go1.18+ 的 `pclntab` 布局（magic `0xFFFFFFF1`）即可恢复全部 **3028 个函数**
的 name → address 映射，`textStart = 0x11000`。工具在
`/home/arthur/claude/_router_dump/`（`gofuncs.py` / `ann.py` / `dump.py`），
不属于本仓库。

The binary is stripped, but Go keeps its own symbol table inside `pclntab`.
Parsing the go1.18+ layout (magic `0xFFFFFFF1`) recovers all **3028 functions**,
`textStart = 0x11000`. Every claim below cites the function and address it came
from, so it can be re-checked.

验证方式 / Verification: 真机 `/tmp/factory-pwm-status.json`、`uci show factory_pwm`、
`factory-pwm probe` 三者的输出与反汇编推导逐项吻合。

## 1. 函数表 / Function map

```
0x119150 0x119300 main.map.init.0              颜色表初始化
0x1194e0 0x119fa0 main.loadConfig              UCI -> 内存
0x119fa0 0x11a020 main.readInt
0x11a020 0x11a3a0 main.initPWMChannel
0x11a3a0 0x11a500 main.setLED                  写三路 duty_cycle
0x11a500 0x11a820 main.rainbowColor
0x11a820 0x11b430 main.renderLED               状态名 -> 亮度 -> setLED
0x11b430 0x11b570 main.findFanPath             hwmon 扫描
0x11b570 0x11b700 main.dutyForRPM              RPM -> duty_ns -> 0..255
0x11b700 0x11b820 main.wifiTemp
0x11b820 0x11b940 main.cpuMaxTemp
0x11b940 0x11b9e0 main.optionalTemp
0x11b9e0 0x11baa0 main.readSensors
0x11baa0 0x11bcf0 main.nextState               热控状态机
0x11bcf0 0x11be60 main.gpioNumber
0x11be60 0x11c2a0 main.measureRPM
0x11c5c0 0x11c6b0 main.writeStatus
0x11c6b0 0x11cae0 main.(*controller).reloadConfig
0x11cae0 0x11cd70 main.(*controller).fanLoop
0x11cd70 0x11d1e0 main.(*controller).fanLoop.func1
0x11d2c0 0x11d4e0 main.(*controller).ledLoop
0x11d550 0x11daf0 main.(*controller).socketLoop
0x11db50 0x11df00 main.runDaemon
0x11e070 0x11e1a0 main.sendCommand
0x11e200 0x11e540 main.probe
0x11e540 0x11eb90 main.main
```

## 2. UCI 配置 / Configuration

配置节类型（**不是**普通的 `config` 节）:

```
factory_pwm.led=factory_led
factory_pwm.fan=factory_fan
```

| 节 | 选项 | 取值 | 越界处理 |
| --- | --- | --- | --- |
| `factory_led` | `led_mode` | `auto` `manual` `off` | 其他 → `auto` |
| | `led_color` | 见 §3 | 未知 → `blue` |
| | `led_effect` | 见 §4 | 未知 → 与颜色拼接 |
| | `brightness` | 10 … 100 | 钳制到 10 … 100 |
| `factory_fan` | `fan_mode` | `auto` `manual` `off` | 其他 → `auto` |
| | `min_rpm` | 1500 … 4700 | 钳制 |
| | `manual_rpm` | 1500 … 4700 | 钳制 |

读取方式是 `uci -q show factory_pwm`（`main.loadConfig`，0x1194e0）。
默认值由 `main.loadConfig` 里的立即数给出，与
`/etc/config/factory_pwm` 的出厂内容一致。

**重要更正 / Correction.** 早期的一份分析笔记称 `led_mode` 只识别
`auto` / `off`，其余一律当 `auto`。**这是错的。** `main.loadConfig`
在 0x119d2c–0x119da8 依次比较长度 4 / 6 / 3 并逐字节比对
`"auto"`（0x6f74_7561）、`"manual"`（0x6d_616e_75 + `"al"`）、
`"off"`（`"of"` + `'f'`），三者**都保留原值**；只有都不匹配时才回落到
`0x160ac1` 处的字面量 `"auto"`。`main.(*controller).reloadConfig`
在 0x11c814–0x11ca7c 有一段完整的 `led_mode == "manual"` 分支。
`led_mode=manual` 是**真实生效**的。

## 3. 颜色表 / Colour table

`main.map.init.0`（0x119150–0x119300）逐条 `mapassign` 建出
`map[string][3]int64`，值是三路 PWM 的 `duty_cycle`（纳秒，周期 40000 ns）：

| 键 | R | G | B | 备注 |
| --- | --- | --- | --- | --- |
| `off` | 0 | 0 | 0 | |
| `red` | 15840 | 0 | 0 | |
| `green` | 0 | 2800 | 0 | 绿色效率高，占空比明显低 |
| `blue` | 0 | 0 | 15840 | **查表失败的回落值** |
| `yellow` | 4752 | 3000 | 0 | |
| `purple` | 15840 | 0 | 15840 | |
| `white` | 9504 | 9504 | 9504 | |
| `blue_dim` | 0 | 0 | 7812 | |

通道映射：`pwm0` = 红，`pwm1` = 绿，`pwm2` = 蓝
（`main.setLED` 0x11a3a0 循环写 `/sys/class/pwm/pwmchip0/pwm%d/duty_cycle`，
路径由 0x165532 的 23 字节前缀与 0x163502 的 16 字节 `pwm%d/duty_cycle`
拼接而成）。

`main.renderLED` 只对 `off` / `red` / `blue` / `white` / `blue_dim`
五个键发查表指令；`green` / `yellow` / `purple` 由
`main.rainbowColor`（0x11a500）使用，序列为
`red, yellow, green, green, blue, blue, purple, red`。

## 4. 状态名 / State names

LED 的内部状态是一个**字符串**，形如 `<颜色>_<效果>`。`main.renderLED`
先剥掉后缀 `_on`（0x160a1e，长 3）、`_blink`（0x160e2c，长 6）、
`_breath`（0x161092，长 7），剩下的部分当颜色名查表；`rainbow` 与
`blue_dim` 在函数入口就被单独处理（0x11a848、0x11aa88）。

### 4.1 `led_mode` 如何决定状态名 / How `led_mode` picks the state

`main.(*controller).reloadConfig`（0x11c6b0）：

| `led_mode` | 得到的 `led` 状态 |
| --- | --- |
| `off` | 常量 `all_off`（0x161099，长 7）——0x11c7e4 |
| `manual` | 见 §4.2 |
| `auto`（及其他） | 拷贝 `autoState`（0x11ca58） |

`autoState` 由外部命令写入，词汇表来自厂商脚本（见 §5）。

### 4.2 `manual` 的拼接规则 / Manual composition

分支在 0x11c814–0x11ca7c。先取 `led_effect`：

* 效果属于**自足效果集**（忽略颜色，状态名 = 效果名原样）：
  `rainbow`、`blue_dim`、`red_1_blue`、`red_2_blue`、`red_white_blink`、
  `alternate_blink`、`alternate_breath`
* 其他效果（`on`、`blink`、`breath`，以及任何未知值）：
  状态名 = `led_color + "_" + led_effect`
  （0x11ca14 处 `runtime.concatstring3(nil, color, "_", effect)`，
  分隔符 `"_"` 是 0x198338 处的 1 字节常量）

即：`blue` + `on` → `blue_on`；`blue` + `breath` → `blue_breath`；
而 `blue` + `rainbow` → `rainbow`（颜色被忽略）。

### 4.3 效果表 / Effects

| 效果 | 长 | 行为 |
| --- | --- | --- |
| `on` | 2 | 常亮 |
| `blink` | 5 | 闪烁，周期 1000 ms，前半亮后半灭 |
| `breath` | 6 | 呼吸，周期 2000 ms |
| `rainbow` | 7 | 八段彩虹渐变 |
| `blue_dim` | 8 | 常亮，蓝 7812 ns（暗） |
| `red_1_blue` | 10 | 厂测红蓝交替，红占时更长 |
| `red_2_blue` | 10 | 厂测红蓝交替，等时 |
| `red_white_blink` | 15 | 厂测红白交替闪 |
| `alternate_blink` | 15 | 厂测红蓝交替闪 |
| `alternate_breath` | 16 | 厂测红蓝交替呼吸 |

**闪烁周期 / Blink period.** 0x11ab1c 用 `strings.Index(state, "blink")`
判断；命中后，若状态名恰为 `blue_blink`（长 10，0x11ab3c）则周期 500 ms，
否则 1000 ms（0x11ab74 / 0x11ab80）。相位：`phase = now mod period`，
`phase < period/2` → 全亮，否则全灭（0x11abe8）。

**呼吸 / Breath.** `0.08 + 0.92 * (0.5 - 0.5*cos(2π * (now mod 2000)/2000))`。
常量 `0.92` @0x198358、`2π` @0x198360、`2000` @0x198388。

**亮度 / Brightness.** `brightness_percent` 除以 100.0（@0x198370）
得到 0..1 的系数，`main.setLED` 对每路取
`clamp(round(duty * scale), 0, 40000)`（0x11a3ec–0x11a480）。

## 5. 自动状态词汇 / Automatic state vocabulary

`autoState` 由外部通过 socket 写入。厂商脚本给出的取值：

| 来源 | 状态 |
| --- | --- |
| `hotplug.d/iface/99-factory-pwm-led` WAN ifup | `blue_on` |
| 同上 WAN ifdown | `red_blink` |
| `diag.sh` preinit | `blue_blink` |
| `diag.sh` failsafe | `red_blink` |
| `diag.sh` preinit_regular | `blue_breath` |
| `diag.sh` upgrade | `alternate_breath` |
| `diag.sh` done | `blue_on` |
| `led_ctl` error | `red_on` |
| `led_ctl` internet connecting | `blue_blink_1s` |

**已知缺陷 / Known defect.** `blue_blink_1s` 的后缀既不是 `_on` 也不是
`_blink`，`main.renderLED` 剥不掉它，于是整体被当成颜色名查表 → 查不到 →
回落 `blue`，效果也丢了。二进制里**没有** `_1s` 这个字面量。
因此 `led_ctl internet connecting` 实际上退化成常亮蓝。新前端不复刻这一条。

## 6. 风扇 / Fan

### 6.1 转速 → 占空比 / RPM → duty

`main.dutyForRPM`（0x11b570）分段线性插值，两张表各 8 项：

```
RPM   [1500, 2000, 2500, 3000, 3500, 4000, 4500, 4700]   @0x2721C0
duty  [12000,16000,20000,24000,28000,32000,36000,40000]  @0x272180  (ns)
```

`pwm = round(duty_ns * 255 / 40000)`，常量 `255.0` @0x198378、
`40000.0` @0x198390。边界：`rpm <= 0` → 0；`rpm > 4700` → 255。

真机验证：`target_rpm = 1500` → `duty = 12000` → `77`，与
`/tmp/factory-pwm-status.json` 的 `fan_pwm_0_255: 77` 一致。

### 6.2 风扇路径 / Fan path

`main.findFanPath`（0x11b430）通配 `/sys/class/hwmon/hwmon*`，读每个目录下的
`name`，取值为 `pwmfan` 的那个，用它的 `pwm1`。写入前先把
`pwm1_enable` 置 `1`（`fanLoop.func1` 引用 `pwmfan hwmon path not found`、
`_enable`、`1`）。真机：`/sys/class/hwmon/hwmon0/pwm1`。

### 6.3 热控状态机 / Thermal state machine

`main.nextState`（0x11baa0），11 个状态，目标转速：

```
rpmByState[11] = [1500, 2550, 2900, 3150, 3500, 3850, 4700, 4700, 4700, 4700, 4700]
                                                              @0x272900
```

升档阈值行 1..10，列 `[wifi0, wifi1, wifi2, cpu_max, iot]`（@0x274b80 起）：

| 状态 | wifi0 | wifi1 | wifi2 | cpu_max | iot |
| --- | --- | --- | --- | --- | --- |
| 1 | 91 | 91 | 91 | 95 | 95 |
| 2 | 93 | 93 | 93 | 92 | 92 |
| 3 | 94 | 94 | 94 | 89 | 89 |
| 4 | 97 | 97 | 97 | 97 | 97 |
| 5 | 99 | 99 | 99 | 99 | 99 |
| 6 | 108 | 108 | 108 | 108 | 108 |
| 7 | 113 | 113 | 113 | 113 | 113 |
| 8 | 116 | 116 | 116 | 116 | 116 |
| 9 | 119 | 119 | 119 | 119 | 119 |
| 10 | 120 | 120 | 120 | 120 | 120 |

降档阈值行（迟滞）：

| 状态 | wifi0 | wifi1 | wifi2 | cpu_max | iot |
| --- | --- | --- | --- | --- | --- |
| 1 | 62 | 62 | 62 | 75 | 75 |
| 2 | 89 | 89 | 89 | 77 | 77 |
| 3 | 90 | 90 | 90 | 78 | 78 |
| 4 | 93 | 93 | 93 | 93 | 93 |
| 5 | 95 | 95 | 95 | 95 | 95 |
| 6 | 104 | 104 | 104 | 104 | 104 |
| 7 | 109 | 109 | 109 | 109 | 109 |
| 8 | 112 | 112 | 112 | 112 | 112 |
| 9 | 115 | 115 | 115 | 115 | 115 |
| 10 | 116 | 116 | 116 | 116 | 116 |

规则：

* 任一传感器 ≥ 本档升档阈值 → 升档
* 全部传感器 < 本档降档阈值 → 降档
* 状态 6 是**第一个 4700 RPM 状态**，也是**第一个忽略 `manual_rpm` 的状态**
* 状态 6 的进/出阈值是 108 / 104 °C，即 4 °C 迟滞
* 所有传感器都取不到（全 nil）→ 强制状态 10

### 6.4 `min_rpm` / `manual_rpm`

* `min_rpm` 是自动档目标转速的**下限**：`target = max(rpmByState[s], min_rpm)`
* `manual_rpm` 只在状态 < 6 时生效，状态 ≥ 6 强制 4700
* `fan_mode=off` 会被解析，但**实际是 no-op**

## 7. 传感器 / Sensors

`main.readSensors`（0x11b9e0）依次调用：

| 函数 | 来源 | 说明 |
| --- | --- | --- |
| `main.wifiTemp("wifi0"/"wifi1"/"wifi2")` | `/usr/sbin/thermaltool -i <name> -get` | 正则 `(?i)sensor temperature:\s*(-?[0-9]+)` |
| `main.cpuMaxTemp` | `/sys/class/thermal/thermal_zone*/temp` | 通配取最大；初始 `-1000`；值 > 1000 则除以 1000 |
| `main.optionalTemp("/tmp/iot_temperature")` | 该文件 | `readInt`，值 > 1000 则除以 1000 |

除以 1000 用的是 Go 的有符号除法优化：
`smulh` + 魔数 `0x4189374BC6A7EF9E`（= 52881784.832）+ `asr #8`。

**通用性要点 / Portability note.** 这三条路径都是**硬编码**的：
`thermaltool` 是 Qualcomm QSDK 的专有工具，`/tmp/iot_temperature` 是厂商
自己写的文件。在别的硬件上这三个传感器全部取不到 → 全 nil → 强制状态 10
（4700 RPM 满转）。这正是新版前端要做运行时探测的原因。

## 8. 状态文件 / Status file

`main.writeStatus`（0x11c5c0）写 `/tmp/factory-pwm-status.json`。
字段来自结构体 tag（在 rodata 里逐条提取）：

```json
{
  "updated": "2026-10-14T23:30:05Z",
  "led": "blue_on",
  "led_mode": "auto",
  "brightness_percent": 100,
  "thermal_state": 0,
  "fan_mode": "auto",
  "target_rpm": 1500,
  "measured_rpm": 2010,
  "fan_pwm_0_255": 77,
  "sensors": {
    "wifi0_c": 51, "wifi1_c": 59, "wifi2_c": 55, "cpu_max_c": 49
  }
}
```

* `led` 是**字符串**，不是对象
* `sensors` 的键：`wifi0_c` `wifi1_c` `wifi2_c` `cpu_max_c` `iot_c`
  以及 `errors`，全部 `omitempty`
* `measured_rpm` 也是 `omitempty`
* 上面这份是真机实抓，不是构造的

## 9. Socket 协议 / Socket protocol

* `AF_UNIX` + `SOCK_DGRAM`，路径 `/var/run/factory-pwm.sock`
* 权限 `0660`，接收缓冲区 128 字节，读超时 1 秒
* **即发即忘**，没有任何回复
* 报文格式：`<verb> <arg>`，例如 `auto blue_on`、`led red_blink`
  （`main.sendCommand` 0x11e070、`main.(*controller).socketLoop` 0x11d550）

## 10. 命令行 / CLI

`main.main`（0x11e540）分发：

```
usage: factory-pwm led STATE      # 设置手动状态
       factory-pwm auto STATE     # 设置自动状态（hotplug / diag 用）
       factory-pwm reload         # 重读 UCI
       factory-pwm probe          # 诊断：探测硬件，输出 JSON
       factory-pwm status         # 打印状态 JSON
       factory-pwm daemon         # 前台运行
```

`main.probe`（0x11e200）输出：

```json
{
  "fan_path": "/sys/class/hwmon/hwmon0/pwm1",
  "fan_pwm_0_255": 77,
  "measured_rpm": 2003,
  "pwm_chip": "/sys/class/pwm/pwmchip0",
  "sensors": { "wifi0_c": 51, "wifi1_c": 59, "wifi2_c": 55, "cpu_max_c": 49 }
}
```

`fan_path` 与 `pwm_chip` 同时是 `loadConfig` 接受的 UCI 选项
（覆盖自动探测结果）——这是二进制**已经内置**的通用化钩子。

## 11. 转速计 / Tachometer

`main.measureRPM`（0x11be60）：

* GPIO 号硬编码为 **40**
* 以 500 µs 间隔轮询 **2 秒**
* `rpm = round(pulses * 60 / (4 * secs))`，常量 `60` @0x198368

## 12. 并发模型 / Concurrency

三个 goroutine，共享一把互斥锁（`main.(*controller).fanLoop` /
`ledLoop` / `socketLoop`）：

| 循环 | 周期 |
| --- | --- |
| `fanLoop` | 30 s（风扇 + 热控） |
| 转速计 | 5 s |
| `ledLoop` | 50 ms |

没有信号处理，没有 PID 文件。服务由 procd 通过 `/etc/init.d/factory-pwm`
拉起。

## 13. 对通用化的影响 / Consequences for a generic frontend

1. **`led_mode` / `fan_mode` 的枚举是可信的** —— `auto` `manual` `off`，
   其中 `manual` 真实生效（见 §2 的更正）。
2. **颜色与效果名是稳定契约** —— 前端只传名字，RGB 数学在守护进程里。
3. **`fan_mode=off` 是 no-op** —— 前端不应把它当作真正的关闭。
4. **传感器键名是硬编码的** —— `wifi0_c/wifi1_c/wifi2_c/cpu_max_c`，
   换硬件就全空。前端必须按状态文件里**实际出现的键**渲染，不能枚举。
5. **`probe` 是最好的探测入口** —— 它一次给出 `fan_path`、`pwm_chip`
   和传感器读数，比前端自己去 glob sysfs 更可靠。
6. **108 °C / 4700 RPM 这些数字要从前端里拿掉** —— 它们是这张表的产物，
   不是通用常量。
