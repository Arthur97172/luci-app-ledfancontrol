# luci-app-ledfancontrol

[简体中文](README.md) | **English**

A LuCI app for OpenWrt / ImmortalWrt, called **LED & Fan Control** in English and
**灯光与风扇** in Simplified Chinese, that controls the **system RGB LED** and
the **cooling fan** from a single page under the *System* menu.

* Based on LuCI 2 (client-side JavaScript); there is no Lua CBI view.
* The interface is English; Simplified Chinese ships in the separate
  `luci-i18n-ledfancontrol-zh-cn` package.
* The frontend only edits configuration, reloads the service and displays
  status. The hardware is driven by a **backend**.
* There are **two** backends, and whichever is installed is the one used: the
  vendor's closed-source `factory-pwm` daemon, and a generic one that drives the
  kernel's own LED, hwmon and thermal interfaces. With neither present the page
  says so, rather than offering a form that saves nothing.

## How it works

The app has five parts:

| Component | Path | Role |
| --- | --- | --- |
| LuCI view | `htdocs/luci-static/resources/view/ledfancontrol.js` | Renders the form and the live status; contains **no hardware knowledge** |
| Backend descriptor | `htdocs/luci-static/resources/ledfancontrol/backend.js` | Describes "which backend, which config, which options, which effects, what speed range" |
| rpcd plugin | `root/usr/libexec/rpcd/ledfancontrol` | Probes for a usable backend, enumerates what the kernel exposes, and relays the status document over ubus |
| Generic backend | `root/usr/libexec/ledfancontrol-daemon` + `root/etc/init.d/ledfancontrol` | Drives the kernel's LED class, the fan's hwmon `pwm1` and the thermal zones |
| Vendor backend | `/usr/bin/factory-pwm`, `/etc/init.d/factory-pwm` | Drives the RGB LED's raw PWM channels and the fan's hwmon `pwm1` plus GPIO tachometer |

The frontend **never touches the hardware**, and it does not read the
filesystem either. It does three things:

1. reads and writes the UCI configuration named by the descriptor;
2. on *Save & Apply*, commits it, which runs `reload_config` and so fires the
   procd reload trigger each init script declares (`service_triggers`), making
   the change take effect without a reboot;
3. every 3 seconds calls `ledfancontrol.status` over ubus and renders the
   document that comes back.

### The two backends

| | `factory-pwm` | `sysfs` (generic) |
| --- | --- | --- |
| Driven by | the vendor's closed-source binary | `ledfancontrol-daemon` (this package, POSIX shell) |
| Configuration | `/etc/config/factory_pwm` | `/etc/config/ledfancontrol` |
| Lighting | writes the duty cycle of `/sys/class/pwm/pwmchip0/pwm{0,1,2}` directly | the kernel LED class: `trigger` / `brightness` / `multi_intensity` |
| Effects | ten, including breathing, rainbow and the factory red/blue alternation | solid on, blinking (the kernel `timer` trigger) |
| Fan | the vendor's 11-state multi-sensor thermal table | a linear curve with configurable endpoints, or the kernel's own governor where a cooling map is bound |
| Speed | yes, from a GPIO tachometer | no; duty cycle is reported instead |
| Sensors | Wi-Fi 0/1/2 and the CPU maximum | every thermal zone plus hwmon temperatures |

**The two never drive the same PWM channel.** The vendor daemon owns the
hardware when it is installed, so the rpcd plugin puts `factory-pwm` first when
it probes and `/etc/init.d/ledfancontrol` applies the same test in
`start_service` before starting the generic daemon. The two rules are kept
identical on purpose: if they ever disagreed, the page and the hardware would
have different ideas about who is in charge.

### Why the descriptor is split out

The view is **not allowed** to name the config, the init script, the status
source, the sensor keys, the effect vocabulary, the speed range or the
over-temperature trip point — all of it comes from `backend.js`. Adding a third
backend therefore means adding a descriptor, not editing the view.

`factory-pwm`'s descriptor is a constant. `sysfs`'s is **not**: which LEDs
exist, whether one of them can mix colours, which hwmon device is the fan and
which thermal zones are readable are all properties of the board, so it is
*built* per device at page load (`buildSysfs()` in `backend.js`), out of the
rpcd plugin's `capabilities` method.

At load time the view asks the device which backends exist:

| Probe result | What the page shows |
| --- | --- |
| `factory-pwm` or `sysfs` found | the normal form plus the live status |
| a backend this page has no descriptor for | "this version of the page has no support for it" |
| nothing at all | "no supported backend was found", and **no form** |

The last row is deliberate: a form that saves settings nothing will ever read is
worse than no form, because it looks like it worked.

### Why the probe lives on the device

The probe, the capability enumeration and the status relay sit in an rpcd plugin
rather than in the view, because a backend that drives the kernel's own
LED/PWM/hwmon/thermal classes has to *enumerate* them —
`/sys/class/thermal/thermal_zone*`, `/sys/class/hwmon/hwmon*`,
`/sys/class/leds/*` — and the zone and hwmon indices differ from board to board.
rpcd's file ACL is a fixed list of literal paths and cannot express a glob, so no
static ACL could grant the view access to "whatever thermal zones this board
happens to have".

Doing it in the plugin keeps the ACL to a single object grant no matter how many
files a backend ends up touching, and it removes the page's filesystem access
entirely: the page can no longer ask for a file at all, only for this object.

> **About the configuration name**: the vendor backend's UCI configuration is
> still called `factory_pwm` rather than `ledfancontrol`, because the backend
> binary opens `/etc/config/factory_pwm` by name. Renaming it would silently
> detach the UI from the daemon.

## The generic (sysfs) backend

It drives the interfaces the kernel already publishes rather than building a PWM
engine of its own:

* **LED**: `/sys/class/leds/<name>/` — `trigger`, `brightness`, `delay_on/off`
  and, on multicolour LEDs, `multi_intensity`. The channel order is taken from
  the LED's own `multi_index` (some parts are "blue green red" rather than "red
  green blue") instead of being assumed to be RGB.
* **Fan**: `/sys/class/hwmon/<n>/` — `pwm1` and `pwm1_enable`.
* **Thermal**: `/sys/class/thermal/thermal_zone*/temp` and hwmon `temp*_input`.

### hwmon devices are matched by name, never by index

`/sys/class/hwmon/hwmonN` is numbered in **probe order**: the same fan is
`hwmon0` on one boot and `hwmon2` on the next, and a single driver failing to
probe shifts every later device by one.

The vendor's own `/etc/init.d/bootcount` walks into exactly this trap — it
hardcodes `/sys/devices/platform/soc/78ba000.i2c/i2c-0/0-002f/hwmon/hwmon0/pwm1`,
a path that does not exist on the reference board at all. Matching on the name
the driver reports is the only stable handle, so the configuration stores the
name (`pwmfan`) rather than an index.

### Automatic mode prefers the kernel

If some thermal zone binds a fan cooling device
(`/sys/class/thermal/thermal_zone*/cdev*`), the daemon writes `pwm1_enable=2`
and hands the fan to the kernel's thermal governor, then stops touching it. That
gets the kernel's hysteresis and step logic rather than a reimplementation of
it. Only where there is no such binding — which is the case on the reference
board — does the daemon's userspace curve take over.

The curve runs at `min_pwm` up to `min_temp`, rises linearly to 100% at
`max_temp`, and is pinned to 100% at or above `overtemp`.

### `min_pwm` is the floor for both modes

A manual value below `min_pwm` is raised to it. A fan driven too slowly stalls,
and some fans never restart from a stall, so the setting is overridden rather
than obeyed. The status document reports the value that was **actually written**,
which is how a raised setting becomes visible instead of silent.

### What this backend cannot do

Honestly:

* **No breathing, no rainbow, no factory alternation.** The kernel LED class
  does not fade; the `timer` trigger only produces a square wave. Real breathing
  means writing duty cycles frame by frame in software, which is not a job for
  shell.
* **It does not touch the raw PWM channels.** The reference board's RGB LED is
  not a kernel LED; it is the vendor daemon writing
  `/sys/class/pwm/pwmchip0/pwm{0,1,2}` directly. The generic backend does not
  claim those channels — that is precisely the "two backends fighting" case.
  **So on the reference board its lighting half does nothing at all**; its value
  is on other boards.
* **Usually no RPM.** Most hwmon fan devices expose no `fan1_input`, and the
  reference board's tachometer is a bare GPIO that the kernel's pwm-fan driver is
  not wired to. Duty cycle is what is reported.

## Dependencies

* `luci-base` — build-time dependency.
* **the vendor backend** (`/usr/bin/factory-pwm`) — optional, and not part of
  the official feeds. When installed it is preferred; when not, the generic
  backend is used.

Neither backend adds a dependency of its own: the rpcd plugin and the generic
daemon are POSIX shell using `jshn.sh` from `ubox` and `/lib/functions.sh`,
both part of the base system on every release. The package stays
`Architecture: all`.

## UCI configuration

The vendor backend reads `/etc/config/factory_pwm`:

```uci
config factory_led 'led'
	option led_mode 'auto'      # auto | manual | off
	option led_color 'blue'     # blue | red | green | yellow | purple | white
	option led_effect 'on'      # see the table below
	option brightness '100'     # 10..100 in steps of 10

config factory_fan 'fan'
	option fan_mode 'auto'      # auto | manual
	option min_rpm '1500'       # floor in automatic mode
	option manual_rpm '2500'    # target in manual mode
```

With `led_mode` set to `auto`, the LED follows the WAN link state, the boot
phases and the firmware upgrade phases, driven by the backend together with
`/etc/hotplug.d/iface/99-factory-pwm-led` and `/etc/diag.sh`. `led_color` is
only shown for the three effects that actually use a colour (solid on,
blinking, breathing).

The generic backend reads `/etc/config/ledfancontrol`:

```uci
config led 'led'
	option device ''            # a name under /sys/class/leds/, empty = leave it alone
	option mode 'off'           # off | manual
	option effect 'on'          # on | blink
	option color 'blue'         # only where the LED has multi_intensity
	option brightness '100'

config fan 'fan'
	option mode 'auto'          # auto | manual
	option hwmon 'pwmfan'       # the driver's name, not an hwmon index
	option min_pwm '30'         # the floor, applied in both modes
	option manual_pwm '60'      # the manual target
	option min_temp '40'        # where the curve starts
	option max_temp '90'        # where the curve reaches full speed
	option overtemp '100'       # emergency full speed
```

`device` defaults to empty: the daemon then touches nothing rather than guessing
which LED is meant. The page lists the names the kernel actually has, for the
user to choose from.

## LED effects (vendor backend)

| `led_effect` | Label | Behaviour |
| --- | --- | --- |
| `on` | Solid on | Steady light in the selected colour |
| `blink` | Blinking | Blinks in the selected colour |
| `breath` | Breathing | Breathes in the selected colour |
| `rainbow` | Rainbow fade | Cycles through the hue wheel |
| `alternate_blink` | Factory red/blue alternating blink | Factory red/blue alternating blink |
| `alternate_breath` | Factory red/blue alternating breathing | Factory red/blue alternating breathing |
| `red_white_blink` | Factory red/white alternating blink | Factory red/white alternating blink |
| `red_2_blue` | Factory red to blue, red held longer | Factory red-to-blue, red held longer |
| `red_1_blue` | Factory red to blue, equal timing | Factory red-to-blue, equal timing |
| `blue_dim` | Factory dim blue | Factory dim blue |

The generic backend offers only *solid on* and *blinking*.

## Fan

Vendor backend:

* **Automatic**: uses the factory multi-sensor thermal table, reading the
  Wi-Fi 0/1/2 and CPU temperatures to pick a speed, with the floor given by
  `min_rpm`.
* **Manual**: a fixed `manual_rpm`; the backend still keeps the forced
  full-speed protection above 108 °C.
* The speed range is 1500–4700 RPM, and the measured speed comes from the GPIO
  tachometer.

Generic backend:

* **Automatic**: a linear curve; where a cooling map is bound, `pwm1_enable=2`
  hands the fan to the kernel instead.
* **Manual**: a fixed duty cycle, raised to `min_pwm` if set below it.
* Reports a duty cycle percentage, not a speed.

The "108 °C", "1500–4700 RPM" and "40–90 °C" on the page come from the
descriptor rather than being constants written into the labels.

> **Note**: the vendor's `fan_mode` has no usable `off` — the backend parses it
> and then does nothing. It is therefore not offered in the interface.

## Live status

Both backends rewrite a status document every second or two
(`/tmp/factory-pwm-status.json` and `/tmp/ledfancontrol-status.json`), and the
rpcd plugin relays the active backend's copy verbatim:

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

The document is passed through byte for byte rather than parsed and rebuilt,
because jshn has no notion of a JSON number and would hand the daemon's readings
back as strings.

**Sensors are rendered dynamically.** The keys in `sensors` are chosen by the
backend and are all `omitempty` — a sensor that cannot be read is simply absent.
The page renders the keys that are actually present rather than enumerating
`wifi0_c/wifi1_c/wifi2_c`. The descriptor only supplies a human-readable name
for the keys it recognises; an unrecognised key is still shown, under its own
name. A backend that grows a sensor therefore needs no change here.

**The fan line is assembled from whichever fields the document carries.** The
vendor backend has a tachometer and reports RPM; the generic one has none and
reports the duty cycle it wrote. Rendering "0 RPM" for a backend that never
claimed to know the speed would be worse than not showing a speed.

## Installation

Prebuilt packages are on the
[Releases](https://github.com/Arthur97172/luci-app-ledfancontrol/releases) page.

OpenWrt 24.10:

```sh
opkg install luci-app-ledfancontrol_*.ipk
# the Chinese interface needs the translation package as well
opkg install luci-i18n-ledfancontrol-zh-cn_*.ipk
```

OpenWrt 25.12:

```sh
apk add --allow-untrusted luci-app-ledfancontrol-*.apk
# the Chinese interface needs the translation package as well
apk add --allow-untrusted luci-i18n-ledfancontrol-zh-cn-*.apk
```

## Building

Drop the directory into the `package/` tree of an OpenWrt source tree or SDK
(for example `package/luci-app-ledfancontrol`), then:

```sh
make package/luci-app-ledfancontrol/compile V=s
```

This produces both `luci-app-ledfancontrol` and
`luci-i18n-ledfancontrol-zh-cn`. Both `.ipk` (opkg) and `.apk`
(apk-openssl, OpenWrt 25.12+) are supported.

## Provenance

The interface was extracted from the `luci-app-factory-pwm` package preinstalled
on a Qualcomm ipq95xx router (QSDK 13) and rewritten in LuCI 2 client-side
JavaScript. The original used LuCI 1's Lua CBI
(`controller/factory_pwm.lua` + `model/cbi/factory_pwm.lua` +
`view/factory_pwm/status.htm`); its fields, values and dependencies have been
mapped one to one onto this view. The `factory-pwm` backend is a closed-source
binary and is not part of this repository.

The backend's behaviour — the UCI values and their clamping, the three PWM duty
cycles of each colour, the ten effects, the blink and breath periods, the
11-state thermal machine with its up/down thresholds, `fan_mode=off` being a
no-op, the sensor key names — was recovered by disassembling it and is written
up in
**[`docs/reverse-engineering/factory-pwm.md`](docs/reverse-engineering/factory-pwm.md)**.
That document is the source of every default the vendor descriptor ships, and it
also corrects an early conclusion that was wrong (`led_mode=manual` **is**
honoured; it is not treated as `auto`).

The generic backend comes from no disassembly at all: it drives interfaces the
kernel publishes, and its implementation is in
`root/usr/libexec/ledfancontrol-daemon`, GPL-3.0-only.

## License

GPL-3.0-only, see [LICENSE](LICENSE).
