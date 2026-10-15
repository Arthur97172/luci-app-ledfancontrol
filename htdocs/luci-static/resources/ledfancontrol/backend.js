'use strict';
'require baseclass';
'require rpc';

/*
 * Backend descriptors for "Led&fan Control".
 *
 * The view is not allowed to know anything about the hardware. Everything it
 * needs - which UCI config to edit, which init script to reload, which options
 * exist, what the effect vocabulary is, what the speed range and the
 * over-temperature trip point are - lives in a descriptor here, and the view
 * renders whatever the descriptor describes.
 *
 * There are three descriptors:
 *
 *   factory-pwm   the closed-source vendor daemon. It is what this package was
 *                 originally written against. See
 *                 docs/reverse-engineering/factory-pwm.md.
 *   sysfs         the kernel's own LED, hwmon and thermal classes, driven by
 *                 /usr/libexec/ledfancontrol-daemon. Unlike the other two this
 *                 one cannot be a constant: which LEDs exist, whether they are
 *                 multicolour, which hwmon device is the fan and which thermal
 *                 zones are readable are all properties of the board, so it is
 *                 *built* from what the rpcd plugin reports. See buildSysfs().
 *   none          nothing this page can drive was found. The view still
 *                 renders, but only to say so - better than a form that writes
 *                 settings nothing will ever read.
 *
 * Note what is *not* here: the paths of the daemons and of their status files.
 * Finding the hardware and reading its state are the device's business and live
 * in /usr/libexec/rpcd/ledfancontrol; this file only describes how to present
 * what that plugin reports.
 *
 * A descriptor's shape, for the view's benefit:
 *
 *   id, title                 identity, for the "found X" wording
 *   config, service           the UCI config to edit and the init script to reload
 *   sections.led / .fan       the section type each half lives in
 *   ledModes, fanModes        [{ value, label }] - the vocabularies, per backend
 *   ledDeviceKey, ledDevices  which /sys/class/leds entry to drive (sysfs only)
 *   hwmonKey, fanDevices      which hwmon device is the fan (sysfs only)
 *   colours, effects          [{ value, label, colour? }]
 *   brightness                { min, max, step, default }
 *   fan                       { minKey, manualKey, unit, ... } or null
 *   extraFields               [{ key, label, ... }] rendered as plain numbers
 *   sensors                   [{ key, label, unit }] for the status box
 */

/*
 * The vendor daemon's sensor keys, in the order they should be shown.
 *
 * These names are a hardcoded property of the closed-source binary - it emits
 * exactly wifi0_c / wifi1_c / wifi2_c / cpu_max_c / iot_c, and on hardware that
 * is not this router the first three simply come back missing. The view must
 * therefore render the keys that are actually present rather than this list;
 * the list only supplies the human label and the display order for the keys we
 * recognise, and anything unrecognised is shown under its raw name.
 */
var FACTORY_PWM_SENSORS = [
	{ key: 'wifi0_c',   label: _('Wi-Fi 0'), unit: '°C' },
	{ key: 'wifi1_c',   label: _('Wi-Fi 1'), unit: '°C' },
	{ key: 'wifi2_c',   label: _('Wi-Fi 2'), unit: '°C' },
	{ key: 'cpu_max_c', label: _('CPU max'), unit: '°C' },
	{ key: 'iot_c',     label: _('IoT'),     unit: '°C' }
];

var FACTORY_PWM = {
	id: 'factory-pwm',
	title: 'Factory PWM daemon',

	config: 'factory_pwm',
	service: 'factory-pwm',

	sensors: FACTORY_PWM_SENSORS,

	/* The two UCI sections the daemon reads, and the type each must carry. */
	sections: {
		led: 'factory_led',
		fan: 'factory_fan'
	},

	/*
	 * The daemon has three LED modes, and its `auto` follows the WAN link
	 * state, the boot phases and the firmware upgrade phases.
	 */
	ledModes: [
		{ value: 'auto',   label: _('Automatic (follow WAN, boot and upgrade state)') },
		{ value: 'manual', label: _('Manual') },
		{ value: 'off',    label: _('Off') }
	],

	fanModes: [
		{ value: 'auto',   label: _('Automatic (multi-sensor thermal table)') },
		{ value: 'manual', label: _('Manual fixed speed') }
	],

	/* The vendor daemon drives the hardware itself; there is nothing to pick. */
	ledDeviceKey: null,
	ledDevices: [],
	hwmonKey: null,
	fanDevices: [],

	/*
	 * Colour vocabulary. Only the first three effects below actually use a
	 * colour; the rest ignore it, which is why the view hides the colour list
	 * unless one of those three is selected.
	 *
	 * blue_dim is deliberately absent: the daemon accepts it as an effect, not
	 * as a colour, so offering it in both lists would be two ways to say the
	 * same thing.
	 */
	colours: [
		{ value: 'blue',   label: _('Blue') },
		{ value: 'red',    label: _('Red') },
		{ value: 'green',  label: _('Green') },
		{ value: 'yellow', label: _('Yellow') },
		{ value: 'purple', label: _('Purple') },
		{ value: 'white',  label: _('White') }
	],

	/*
	 * Effects. `colour: true` marks the ones that are composed as
	 * "<colour>_<effect>"; the others stand alone and ignore the colour.
	 */
	effects: [
		{ value: 'on',               label: _('Solid on'),                                colour: true },
		{ value: 'blink',            label: _('Blinking'),                                colour: true },
		{ value: 'breath',           label: _('Breathing'),                               colour: true },
		{ value: 'rainbow',          label: _('Rainbow fade') },
		{ value: 'alternate_blink',  label: _('Factory red/blue alternating blink') },
		{ value: 'alternate_breath', label: _('Factory red/blue alternating breathing') },
		{ value: 'red_white_blink',  label: _('Factory red/white alternating blink') },
		{ value: 'red_2_blue',       label: _('Factory red to blue, red held longer') },
		{ value: 'red_1_blue',       label: _('Factory red to blue, equal timing') },
		{ value: 'blue_dim',         label: _('Factory dim blue') }
	],

	brightness: { min: 10, max: 100, step: 10, default: 100 },

	/*
	 * Fan limits. minRpm/maxRpm are the ends of the daemon's interpolation
	 * table; overtempC is the temperature at which it stops honouring
	 * manual_rpm and forces full speed. Both are properties of the vendor's
	 * thermal table, not universal constants, so the view reads them from here
	 * instead of spelling them out in its labels.
	 *
	 * `steps` is the set of values the daemon's table actually contains, which
	 * is not a uniform range - hence the explicit lists rather than a
	 * min/max/step triple.
	 */
	fan: {
		minKey: 'min_rpm',
		manualKey: 'manual_rpm',
		unit: 'RPM',
		min: 1500,
		max: 4700,
		steps: {
			min: [ 1500, 2000, 2500, 3000 ],
			manual: [ 1500, 2000, 2500, 3000, 3500, 4000, 4500, 4700 ]
		},
		overtempC: 108,
		overtempHysteresisC: 4
	},

	extraFields: []
};

var NONE = {
	id: 'none',
	title: 'No supported backend',

	config: null,
	service: null,

	sections: { led: 'led', fan: 'fan' },

	ledModes: [],
	fanModes: [],
	ledDeviceKey: null,
	ledDevices: [],
	hwmonKey: null,
	fanDevices: [],

	sensors: [],
	colours: [],
	effects: [],
	brightness: { min: 10, max: 100, step: 10, default: 100 },
	fan: null,
	extraFields: []
};

/* The six colours the sysfs backend knows how to mix, as channel intensities. */
var SYSFS_COLOURS = [
	{ value: 'blue',   label: _('Blue') },
	{ value: 'red',    label: _('Red') },
	{ value: 'green',  label: _('Green') },
	{ value: 'yellow', label: _('Yellow') },
	{ value: 'purple', label: _('Purple') },
	{ value: 'white',  label: _('White') }
];

/* thermal_zoneN -> N, so the zones list in board order rather than as text. */
function zoneIndex(name) {
	var m = /(\d+)\s*$/.exec(name || '');

	return m ? +m[1] : 0;
}

/*
 * Build the sysfs descriptor from what the device reported.
 *
 * Everything board-specific arrives in `caps` - the LED names, whether a LED
 * can mix colours, which hwmon device carries the fan, which thermal zones are
 * readable - and this function only decides how to present it. That split is
 * the whole point: on a board with a multicolour LED the colour list appears,
 * on one without it does not, and neither case needed a line of board-specific
 * code here.
 *
 * Returns null when there is nothing to drive, so that a capabilities reply
 * which is empty - or one the ACL refused - falls through to the unsupported
 * page instead of rendering a form with no fields in it.
 */
function buildSysfs(caps) {
	var leds = (caps && caps.leds) || [];
	var hwmon = (caps && caps.hwmon) || [];
	var thermal = (caps && caps.thermal) || [];

	var fans = hwmon.filter(function(h) { return h.pwm; });
	var anyMulticolour = leds.some(function(l) { return l.multicolor; });
	var anyTimer = leds.some(function(l) {
		return (l.triggers || []).indexOf('timer') >= 0;
	});

	if (!leds.length && !fans.length)
		return null;

	var effects = [ { value: 'on', label: _('Solid on'), colour: true } ];

	/*
	 * Blinking is the kernel's `timer` trigger, which not every LED implements.
	 * The test is whether *any* LED has it rather than the selected one,
	 * because which LED is selected is not known until the form is filled in;
	 * a LED without it falls back to a steady light, and the status box reports
	 * what was actually applied.
	 */
	if (anyTimer)
		effects.push({ value: 'blink', label: _('Blinking'), colour: true });

	var sensors = thermal.slice().sort(function(a, b) {
		return zoneIndex(a.zone) - zoneIndex(b.zone);
	}).map(function(z) {
		/* The kernel's own name for the zone, e.g. tsens_tz_sensor3. */
		return { key: z.zone, label: z.type || z.zone, unit: '°C' };
	});

	sensors.unshift({ key: 'hottest_c', label: _('Hottest sensor'), unit: '°C' });

	return {
		id: 'sysfs',
		title: 'Kernel sysfs (LED, hwmon, thermal)',

		config: 'ledfancontrol',
		service: 'ledfancontrol',

		sections: { led: 'led', fan: 'fan' },

		/*
		 * There is no `auto` here. Following the WAN link state is the vendor
		 * daemon's behaviour, built on its own hotplug scripts; the kernel's
		 * equivalent is a netdev trigger, which is a different feature with
		 * different settings, and pretending the two are the same mode would
		 * be a lie in the interface.
		 */
		ledModes: [
			{ value: 'off',    label: _('Off') },
			{ value: 'manual', label: _('Manual') }
		],

		fanModes: [
			{ value: 'auto',   label: _('Automatic (thermal curve)') },
			{ value: 'manual', label: _('Manual fixed speed') }
		],

		ledDeviceKey: 'device',
		ledDevices: leds,

		hwmonKey: fans.length ? 'hwmon' : null,
		fanDevices: fans,

		/* A colour only exists where a LED can actually mix one. */
		colours: anyMulticolour ? SYSFS_COLOURS : [],

		effects: effects,

		brightness: { min: 10, max: 100, step: 10, default: 100 },

		/*
		 * No RPM anywhere: this backend reports duty cycle. It reads a
		 * tachometer only when the hwmon device happens to expose one, and
		 * most do not - the reference board's tach is a bare GPIO that the
		 * kernel's fan driver is not wired to. Percent is what is actually
		 * controllable, so percent is what is offered.
		 *
		 * min doubles as the floor: the daemon clamps both modes to it, so a
		 * curve can never stop the fan, and neither can a manual setting.
		 */
		fan: fans.length ? {
			minKey: 'min_pwm',
			manualKey: 'manual_pwm',
			unit: '%',
			min: 20,
			max: 100,
			step: 10,
			defaultMin: 30,
			defaultManual: 60,
			overtempC: 100
		} : null,

		/*
		 * The curve, exposed because it is the one thing here that is a real
		 * choice rather than a property of the board. Only shown for this
		 * backend: the vendor daemon's table is fixed in its binary.
		 */
		extraFields: fans.length ? [
			{
				key: 'min_temp',
				label: _('Curve start temperature'),
				description: _('At or below this temperature the fan runs at the minimum speed.'),
				min: 20, max: 90, step: 1, default: 40, unit: '°C'
			},
			{
				key: 'max_temp',
				label: _('Curve full-speed temperature'),
				description: _('At this temperature the fan reaches full speed, and stays there above it.'),
				min: 30, max: 110, step: 1, default: 90, unit: '°C'
			},
			{
				key: 'overtemp',
				label: _('Emergency temperature'),
				description: _('At or above this temperature the fan is forced to full speed regardless of the curve.'),
				min: 60, max: 120, step: 1, default: 100, unit: '°C'
			}
		] : [],

		sensors: sensors
	};
}

/*
 * Which constant descriptor serves which backend id.
 *
 * The ids are the ones the rpcd plugin reports; that plugin knows which
 * hardware is present, this table knows which hardware this page can drive. A
 * backend that is present but missing here is reported as unsupported rather
 * than silently ignored - see detect(). `sysfs` is absent because it is built
 * per device rather than declared.
 */
var DESCRIPTORS = {
	'factory-pwm': FACTORY_PWM
};

/*
 * Ask the device which backends it has.
 *
 * The probe lives in the rpcd plugin rather than here because deciding what
 * hardware is present is a question about the device, and because a backend
 * driving the kernel's own LED/PWM/hwmon/thermal classes has to enumerate them
 * - and rpcd's file ACL cannot express "whatever thermal zones this board
 * happens to have". One ubus object covers all of it.
 *
 * Neither call sets reject: true, so a failing ubus call resolves with null
 * instead of rejecting. That is deliberate: a device with no backend at all is
 * the ordinary case this page has to render, not an error worth a red
 * notification.
 */
var callBackends = rpc.declare({ object: 'ledfancontrol', method: 'backends' });
var callStatus = rpc.declare({ object: 'ledfancontrol', method: 'status' });
var callCapabilities = rpc.declare({ object: 'ledfancontrol', method: 'capabilities' });

function known(id) {
	return id === 'sysfs' || !!DESCRIPTORS[id];
}

/*
 * Decide which descriptor applies.
 *
 * Resolves to { descriptor, available }: the descriptor to render with (NONE
 * when there is nothing this page can drive) and the raw list of ids the
 * device reported, so the view can tell "no hardware" apart from "hardware
 * this version of the page does not know about".
 *
 * `active` is the device's own choice of which backend to use. With two
 * backends present, which one wins is hardware policy - the vendor daemon owns
 * the PWM channel, so a generic backend must not fight it - and policy belongs
 * on the device. If this page has no descriptor for the active id, fall back to
 * the first available id it does understand, and only then give up.
 *
 * The capabilities round trip is made only when the sysfs backend is the one
 * being used, so a board running the vendor daemon pays for one ubus call, not
 * two.
 */
function detect() {
	return callBackends().then(function(res) {
		var available = (res && res.available) || [];
		var wanted = (res && res.active) || '';

		if (!known(wanted)) {
			wanted = '';

			for (var i = 0; i < available.length; i++) {
				if (known(available[i])) {
					wanted = available[i];
					break;
				}
			}
		}

		if (!wanted)
			return { descriptor: NONE, available: available };

		if (wanted !== 'sysfs')
			return { descriptor: DESCRIPTORS[wanted], available: available };

		return callCapabilities().then(function(caps) {
			return {
				descriptor: buildSysfs(caps) || NONE,
				available: available,
				capabilities: caps
			};
		});
	}).catch(function() {
		return { descriptor: NONE, available: [] };
	});
}

/*
 * The active backend's status document, or null when it has not published one
 * yet. The plugin relays the document verbatim, so what arrives here is exactly
 * what the daemon wrote - numbers still numbers.
 */
function status() {
	return callStatus().then(function(res) {
		return res || null;
	}).catch(function() {
		return null;
	});
}

/*
 * Turn the status document's `sensors` object into an ordered list of
 * { label, value } for display.
 *
 * Only keys the descriptor knows get a friendly label; any other key is still
 * shown, under its own name, because a backend that grows a sensor should not
 * become invisible. Keys with a null or undefined value are dropped - the
 * daemon omits unreachable sensors, and "Wi-Fi 2: --" is noise, not
 * information.
 *
 * The labels in the descriptor are already translated: each one is wrapped in
 * a gettext call at the point of definition rather than translated here,
 * because that is the only spelling the translation template extractor
 * understands. The labels for the sysfs backend's zones are the exception -
 * they are the kernel's own names for the sensors, which are not translatable
 * and are shown as they are.
 */
function sensors(desc, st) {
	var raw = (st && st.sensors) || {};
	var out = [];
	var seen = {};

	(desc.sensors || []).forEach(function(s) {
		var v = raw[s.key];

		seen[s.key] = true;

		if (v !== null && v !== undefined)
			out.push({ label: s.label, value: v, unit: s.unit || '' });
	});

	Object.keys(raw).forEach(function(k) {
		var v = raw[k];

		if (seen[k] || v === null || v === undefined)
			return;

		/*
		 * `errors` is a list of per-sensor failure strings rather than a
		 * reading; showing it among the temperatures would be misleading, so
		 * it is left to the caller to render separately.
		 */
		if (k === 'errors')
			return;

		out.push({ label: k, value: v, unit: '' });
	});

	return out;
}

return baseclass.extend({
	detect: detect,
	status: status,
	sensors: sensors,

	FACTORY_PWM: FACTORY_PWM,
	NONE: NONE
});
