# luci-app-ledfancontrol

**简体中文** | [English](README.en.md)

一个用于 OpenWrt / ImmortalWrt 的 LuCI 应用，中文名**灯光与风扇**，英文名
**LED & Fan Control**，在「系统」菜单下统一控制**系统 RGB 指示灯**与**散热风扇**。

* 基于 LuCI 2（客户端 JavaScript），不含传统的 Lua CBI 视图。
* 界面为英文；简体中文由单独的 `luci-i18n-ledfancontrol-zh-cn` 语言包提供。
* 前端只负责改配置、重载服务、显示状态；真正驱动硬件的是**后端**。
* 后端有**两个**，装哪个用哪个：原厂闭源守护进程 `factory-pwm`，以及一个直接
  驱动内核 LED / hwmon / thermal 接口的通用后端。两者都不在时界面会明说找不到
  后端，而不是给一个存了也没用的表单。

## 安装

预编译包见 [Releases](https://github.com/Arthur97172/luci-app-ledfancontrol/releases)。

OpenWrt 24.10：

```sh
opkg install luci-app-ledfancontrol_*.ipk
# 中文界面需额外安装翻译包
opkg install luci-i18n-ledfancontrol-zh-cn_*.ipk
```

OpenWrt 25.12：

```sh
apk add --allow-untrusted luci-app-ledfancontrol-*.apk
# 中文界面需额外安装翻译包
apk add --allow-untrusted luci-i18n-ledfancontrol-zh-cn-*.apk
```

### 从源码编译

```sh
cd openwrt
./scripts/feeds update -a
./scripts/feeds install -a
git clone https://github.com/Arthur97172/luci-app-ledfancontrol.git package/luci-app-ledfancontrol
make menuconfig   # LuCI → Applications → luci-app-ledfancontrol
make package/luci-app-ledfancontrol/compile V=s
```

会同时产出 `luci-app-ledfancontrol` 与 `luci-i18n-ledfancontrol-zh-cn` 两个包。
同时支持 `.ipk`（opkg）与 `.apk`（apk-openssl，OpenWrt 25.12+）。

## 工作原理

本应用由五层组成：

| 组件 | 路径 | 作用 |
| --- | --- | --- |
| LuCI 视图 | `htdocs/luci-static/resources/view/ledfancontrol.js` | 渲染表单与实时状态；**不含任何硬件知识** |
| 后端描述符 | `htdocs/luci-static/resources/ledfancontrol/backend.js` | 描述「哪个后端、哪个配置、哪些选项、哪些灯效、什么调速范围」 |
| rpcd 插件 | `root/usr/libexec/rpcd/ledfancontrol` | 探测本机有哪个后端、枚举内核暴露了什么、并把状态文档经 ubus 转发出去 |
| 通用后端 | `root/usr/libexec/ledfancontrol-daemon` + `root/etc/init.d/ledfancontrol` | 驱动内核的 LED 类、hwmon 的 `pwm1`、thermal 的温区 |
| 原厂后端 | `/usr/bin/factory-pwm`、`/etc/init.d/factory-pwm` | 驱动 RGB 的裸 PWM 通道，以及风扇的 hwmon `pwm1` + GPIO 测速脚 |

前端**既不碰硬件，也不读文件系统**。它只做三件事：读写描述符指定的 UCI 配置；
在「保存并应用」时提交配置——提交触发 `reload_config`，进而触发 init 脚本声明的
procd 重载触发器（`service_triggers`），改动立即生效、无需重启；每 3 秒通过 ubus
调用 `ledfancontrol.status`，把返回的文档渲染成实时状态框。

### 两个后端

| | `factory-pwm` | `sysfs`（通用） |
| --- | --- | --- |
| 谁在驱动 | 原厂闭源二进制 | `ledfancontrol-daemon`（本包，POSIX shell） |
| 配置 | `/etc/config/factory_pwm` | `/etc/config/ledfancontrol` |
| 灯 | 裸写 `/sys/class/pwm/pwmchip0/pwm{0,1,2}` 的占空比 | 内核 LED 类：`trigger` / `brightness` / `multi_intensity` |
| 灯效 | 10 种，含呼吸、彩虹、原厂红蓝交替 | 常亮、闪烁（内核 `timer` 触发器） |
| 风扇 | 原厂 11 档多传感器温控表 | 线性曲线，端点可配；若内核已绑定 cooling map 则交给内核 |
| 转速 | 有，GPIO 测速脚 | 没有，报占空比 |
| 传感器 | Wi-Fi 0/1/2 + CPU 最高温 | 全部 thermal zone + hwmon 温度 |

**两者不会同时驱动同一路 PWM。** 原厂守护进程装了的时候拥有硬件，所以 rpcd 插件
探测时把 `factory-pwm` 排在前面，`/etc/init.d/ledfancontrol` 的 `start_service` 也
做同样的判断并拒绝启动。两处规则刻意保持一致，否则界面和硬件会对「谁在控制」有
不同看法。

### 为什么要拆出描述符

视图里**不允许**出现配置名、init 脚本名、状态文件路径、传感器键名、灯效词表、
转速区间或过温阈值——它们全部来自 `backend.js`，两个后端互不相同的配置项名字
（原厂 `led_mode` / `led_color`，通用 `mode` / `color`）也在其中。`factory-pwm`
的描述符是个常量，`sysfs` 的**不是**：哪些 LED 存在、哪个是彩色 LED、哪个 hwmon
是风扇、哪些温区可读全是主板的属性，所以它在页面加载时**按设备现场构建**
（`buildSysfs()`），原料来自 rpcd 插件的 `capabilities` 方法。

通用后端的 LED 设置还多一层：它们是**按灯存的**，不是整机一份。描述符里的
`ledKeyTemplate`（`'%s_%s'`）说明选项名由「灯名 + 普通选项名」拼成，视图据此把
「控制模式」「手动效果」「亮度」「手动颜色」四个字段绑到当前选中的那颗灯上——换一颗
灯，四个字段就换成那颗灯的值；保存一颗灯，其他灯的设置原样不动。原厂后端没有灯
可选（它自己独占 PWM 通道），不带这个字段，行为与以前完全一致。

启动时由 rpcd 插件探测本机后端：

| 探测结果 | 界面表现 |
| --- | --- |
| 找到 `factory-pwm` 或 `sysfs` | 正常的配置表单 + 实时状态 |
| 有后端，但本页没有对应的描述符 | 告知「本页版本不支持它」，**不显示**表单 |
| 什么都没找到 | 明确告知「未找到受支持的后端」，**不显示**表单 |

最后一行是刻意的：一个能保存、但保存的设置没有任何东西会去读的表单，比没有表单
更糟，因为它看起来像是生效了。

### 为什么探测放在设备端

内核 LED/PWM/hwmon/thermal 的编号各主板不同，而后端必须**枚举**它们；rpcd 的文件
ACL 是一份写死字面路径的清单，无法表达通配，所以枚举只能放在 rpcd 插件里——这样
无论后端要碰多少个文件，ACL 都只需一条对象授权，视图也彻底拿不到文件系统访问权。

## 通用后端（sysfs）

它驱动的是内核已经暴露出来的接口，而不是自己造一个 PWM 引擎：

* **灯**：`/sys/class/leds/<名字>/`——`trigger`、`brightness`、`delay_on/off`，
  彩色 LED 上还有 `multi_intensity`。通道顺序按 LED 自己报的 `multi_index`
  拼装（有的器件是「蓝绿红」而不是「红绿蓝」），不假设是 RGB。
* **风扇**：`/sys/class/hwmon/<n>/`——`pwm1` 与 `pwm1_enable`。
* **温度**：`/sys/class/thermal/thermal_zone*/temp` 以及 hwmon 的 `temp*_input`。
  被驱动标为故障的通道（`temp*_fault` 非零）会被**跳过**：没接的热敏二极管读数
  是量程顶端，当真会把风扇钉死在满速。

### hwmon 按名字匹配，绝不按序号

`/sys/class/hwmon/hwmonN` 的编号是**探测顺序**，同一台风扇这次开机是 `hwmon0`、
下次可能是 `hwmon2`，任何一个驱动探测失败都会让它后面所有设备整体挪位。按驱动
自报的名字匹配是唯一稳定的做法，所以配置里存的是名字（`pwmfan`），不是序号。

### 自动档优先交给内核

如果某个温区绑定了风扇 cooling device（`/sys/class/thermal/thermal_zone*/cdev*`），
守护进程就写 `pwm1_enable=2` 把风扇交给内核 thermal governor，自己不再插手——这样
拿到的是内核的迟滞与分档逻辑，而不是我们重新实现的。只有在没有这种绑定时（参考机
就是这样），才由守护进程的用户态曲线接管。

曲线：`min_temp` 及以下跑 `min_pwm`，到 `max_temp` 线性升到 100%，`overtemp`
及以上无条件满速。

### `min_pwm` 是两种模式共同的下限

手动模式的值若低于 `min_pwm`，会被抬到 `min_pwm`。风扇转太慢会堵转，有些风扇
一旦堵转就再也起不来，所以宁可违背设置也不停风扇。状态文档里报的是**实际写入**
的值，因此被抬高这件事是看得见的，不是静默的。

### 这个后端做不到什么

诚实地说：

* **没有呼吸、彩虹、原厂交替灯效。** 内核 LED 类不会渐变，`timer` 触发器只会
  方波闪烁。真正的呼吸需要软件按帧写占空比，那不是 shell 该干的事。
* **不碰裸 PWM 通道。** 参考机的 RGB 灯不是内核 LED，而是原厂守护进程直接写的
  `/sys/class/pwm/pwmchip0/pwm{0,1,2}`。通用后端不去抢这些通道——那正是
  「两个后端打架」的场景。**因此在参考机上，通用后端的灯那一半是空转的**；
  它的价值在别的板子上。
* **通常没有转速。** hwmon 的风扇设备大多不暴露 `fan1_input`；参考机的测速脚
  是一根裸 GPIO，内核的 pwm-fan 驱动并没有接它。所以报的是占空比百分比。

## 依赖

* `luci-base` —— 编译期依赖。
* **原厂后端**（`/usr/bin/factory-pwm`）—— 可选，不在官方 feed 里。装了就优先
  用它，没装就用通用后端。

两个后端都不引入任何新依赖：rpcd 插件与通用守护进程都是 POSIX shell，只用
`ubox` 的 `jshn.sh` 与 `/lib/functions.sh`（各版本的基础系统都自带），因此
软件包仍是 `Architecture: all`。

## UCI 配置

原厂后端读 `/etc/config/factory_pwm`：

```uci
config factory_led 'led'
	option led_mode 'auto'      # auto | manual | off
	option led_color 'blue'     # blue | red | green | yellow | purple | white
	option led_effect 'on'      # 见下表
	option brightness '100'     # 10..100，步进 10

config factory_fan 'fan'
	option fan_mode 'auto'      # auto | manual
	option min_rpm '1500'       # 自动模式下的最低转速
	option manual_rpm '2500'    # 手动模式下的目标转速
```

`led_mode` 为 `auto` 时，灯效跟随 WAN 连接状态、启动阶段与固件升级阶段，由后端与
`/etc/hotplug.d/iface/99-factory-pwm-led`、`/etc/diag.sh` 共同驱动。`led_color` 只在
会用到颜色的三种效果（常亮 / 闪烁 / 呼吸）下显示。

> 原厂后端的完整行为规格——每个配置项的取值、十种灯效、风扇温控表、状态文件与
> Socket 协议——见
> [`docs/reverse-engineering/factory-pwm.md`](docs/reverse-engineering/factory-pwm.md)。

> **配置名说明**：原厂后端的 UCI 配置仍然叫 `factory_pwm` 而不是 `ledfancontrol`，
> 因为后端二进制是按名字打开 `/etc/config/factory_pwm` 的；改名会让界面与守护进程
> 悄悄脱钩。

通用后端读 `/etc/config/ledfancontrol`：

```uci
config led 'led'
	option device 'blue:status'        # 当前驱动的那颗灯，空 = 不管灯

	option blue_status_mode 'off'      # 这颗灯自己的四项设置
	option blue_status_effect 'on'
	option blue_status_color 'blue'    # 仅当该 LED 支持 multi_intensity
	option blue_status_brightness '40'

	option green_status_mode 'auto'    # 另一颗灯，互不影响
	option green_status_brightness '100'

	option mode 'auto'                 # 旧的全局值，作为回退保留

config fan 'fan'
	option mode 'auto'          # auto | manual
	option hwmon 'pwmfan'       # 驱动自报的名字，不是 hwmon 序号
	option min_pwm '30'         # 下限，两种模式都生效
	option manual_pwm '60'      # 手动模式的目标
	option min_temp '50'        # 曲线起点
	option max_temp '90'        # 曲线满速点
	option overtemp '100'       # 应急满速
```

`device` 默认为空：守护进程于是什么都不碰，而不是去猜用户指的是哪颗灯。界面会把
内核实际有的名字列出来让用户选。

**LED 的设置按灯存。** 选项名是「灯名 + `_` + 选项名」，灯名先做一次转写：把
`[A-Za-z0-9_]` 以外的字符全部换成 `_`。这一步不是美观问题——libuci 的名字语法只
允许 `[A-Za-z0-9_]`，而本机内核给出的每一个灯名都带冒号或连字符：

| 灯名 | 选项前缀 |
| --- | --- |
| `blue:status` | `blue_status` |
| `green:lan-3` | `green_lan_3` |
| `mt76-phy0` | `mt76_phy0` |

**值不受限制**，所以 `option device 'blue:status'` 一直是可以的，只有**名字**
需要转写。守护进程用 `tr -c 'A-Za-z0-9_' '_'` 做同一件事，两边规则必须一致，
否则守护进程会去读一个界面从没写过的选项——表现就是设置被忽略。

读取顺序是三级回退：

1. `<灯名>_mode` —— 界面按灯写入的值；
2. `mode` —— 这次改动之前的全局值，仍然生效；
3. `auto` —— 内置默认。

所以旧配置不需要迁移，而一颗还没单独设置过的灯会**继承**全局值——界面显示
的和守护进程实际应用的因此是同一个值。

## 灯效（原厂后端）

| `led_effect` | 界面标签 | 说明 |
| --- | --- | --- |
| `on` | Solid on / 常亮 | 以所选颜色常亮 |
| `blink` | Blinking / 闪烁 | 所选颜色闪烁 |
| `breath` | Breathing / 呼吸 | 所选颜色呼吸 |
| `rainbow` | Rainbow fade / 彩虹渐变 | 色相循环渐变 |
| `alternate_blink` | Factory red/blue alternating blink | 原厂红蓝交替闪烁 |
| `alternate_breath` | Factory red/blue alternating breathing | 原厂红蓝交替呼吸 |
| `red_white_blink` | Factory red/white alternating blink | 原厂红白交替闪烁 |
| `red_2_blue` | Factory red to blue, red held longer | 原厂红到蓝，红色停留更久 |
| `red_1_blue` | Factory red to blue, equal timing | 原厂红到蓝，等时 |
| `blue_dim` | Factory dim blue | 原厂低亮蓝色 |

通用后端只提供其中的「常亮」与「闪烁」。

## 风扇

原厂后端：

* **自动**：使用原厂的多传感器温控表，读取 Wi-Fi 0/1/2 与 CPU 温度后决定转速，
  下限由 `min_rpm` 给出。
* **手动**：固定转速 `manual_rpm`；后端仍保留 108 °C 以上强制满速的保护。
* 转速区间 1500–4700 RPM，实测转速由 GPIO 测速脚读取。

通用后端：

* **自动**：线性曲线；若内核已绑定 cooling map 则改用 `pwm1_enable=2` 交给内核。
* **手动**：固定占空比，低于 `min_pwm` 会被抬高到 `min_pwm`。
* 报的是占空比百分比，不是转速。

界面上的「108 °C」「1500–4700 RPM」「50–90 °C」都来自描述符，不是写死在
文案里的常量。

> **注意**：原厂的 `fan_mode` 其实没有 `off` 这个可用取值——后端虽然会解析它，
> 但**什么也不做**。所以界面上不提供。

## 实时状态

两个后端约每秒到每两秒重写一次状态文档（`/tmp/factory-pwm-status.json` /
`/tmp/ledfancontrol-status.json`），由 rpcd 插件按当前生效的后端原样转发：

```json
{
  "updated": "2026-10-14T15:23:25Z",
  "led": "blue_on",
  "led_mode": "auto",
  "brightness_percent": 100,
  "thermal_state": 0,
  "fan_mode": "auto",
  "target_rpm": 1500,
  "measured_rpm": 2003,
  "fan_pwm_0_255": 77,
  "sensors": { "wifi0_c": 50, "wifi1_c": 59, "wifi2_c": 55, "cpu_max_c": 49 }
}
```

文档是**逐字节转发**的，没有解析后重建：jshn 没有 JSON 数字的概念，往返一趟
会把守护进程报的读数变成字符串。

**传感器是动态渲染的。** `sensors` 里的键由后端决定，而且都是 `omitempty` 的
——取不到的传感器直接不出现。界面渲染**实际存在的键**，不枚举
`wifi0_c/wifi1_c/wifi2_c`。描述符只负责给认得的键配一个人类可读的名字；
不认得的键照样显示，只是用它自己的键名。这样后端将来多出一个传感器，
界面不需要改。

**风扇那一行也是按字段拼的。** 原厂后端有转速就显示转速，通用后端没有转速
就显示占空比——给一个从不声称知道转速的后端渲染「0 RPM」，比不显示转速更糟。

**亮度报的是实际值，不是配置值。** `brightness_percent` 是 LED 当前**实际**亮度
占其自身最大值的百分比，由守护进程按真正写进 `brightness` 的数值换算。对
`max_brightness` 为 1 的指示灯（参考板上九颗里有八颗属于这种），配置 10% 与配置
100% 写下去是同一个亮度，所以那里会报 100%——把配置值原样回显只会显示一个没有
意义的数字，界面会声称一颗满亮的指示灯「亮度 40%」。这与风扇报实际写入的占空比
是同一条规则。

## 许可

GPL-3.0-only，见 [LICENSE](LICENSE)。
