'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require ui';
'require ledfancontrol.backend as backend';

/*
 * LuCI 2 view for "LED & Fan Control" - the RGB status LED and the cooling fan.
 *
 * Almost nothing happens here. The hardware is driven by a backend: either the
 * vendor's factory-pwm daemon, or the generic one that drives the kernel's own
 * LED, hwmon and thermal classes. This view only does three things:
 *
 *   - edit the UCI configuration that backend reads,
 *   - reload its init script, so a change takes effect without a reboot,
 *   - render the status document the backend publishes, as a live status box.
 *
 * Which backend, which config, which options exist at all, which effect
 * vocabulary and which speed range apply are all decided in
 * ledfancontrol/backend.js. This file must not name any of them, so that a
 * third backend can be added without touching the view.
 *
 * That is why every option list below is built by iterating the descriptor
 * rather than by writing values out: a board with a multicolour LED gets a
 * colour list and a board without one does not, without a single conditional
 * here that mentions LEDs.
 */

var STATUS_INTERVAL = 3;

/*
 * Reload the backend's init script through ubus, so that the daemon picks up
 * the committed configuration immediately.
 *
 * The matching ACL grant is  write > ubus > rc > [ "init" ], in
 * root/usr/share/rpcd/acl.d/luci-app-ledfancontrol.json. The backend probe and
 * the status document need no file grant of their own: both arrive through the
 * ledfancontrol ubus object, which is granted next to this one.
 */
var callRcInit = rpc.declare({
	object: 'rc',
	method: 'init',
	params: [ 'name', 'action' ]
});

/*
 * Escape a string for interpolation into innerHTML.
 *
 * The status box is built as one HTML string, and most of what goes into it
 * comes from the device: the backend's own mode names, and the kernel's names
 * for its sensors. None of it is attacker-controlled in any realistic threat
 * model - it is all written by root-owned daemons and by kernel drivers - but
 * the page has no business interpreting it as markup either, and a thermal
 * zone whose type happened to contain a `<` would otherwise break the box.
 */
function esc(s) {
	return String(s === null || s === undefined ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function fmt(sensor) {
	return esc(sensor.label) + ': ' + esc(sensor.value) +
		(sensor.unit ? ' ' + esc(sensor.unit) : '');
}

function renderStatus(desc, st) {
	var e = document.getElementById('ledfancontrol_status');

	if (!e)
		return;

	/*
	 * An empty document means the backend has not published anything yet. The
	 * test is emptiness rather than a null check because the plugin answers
	 * with an empty object, not with null, when the status file is missing or
	 * was caught mid-write - and it is deliberately not a check for any one key
	 * such as `updated`, so that a backend which reports a different set of
	 * fields still renders.
	 */
	if (!st || Object.keys(st).length === 0) {
		e.innerHTML = '<em>' + _('The backend has not reported a status yet.') + '</em>';
		return;
	}

	var sensors = backend.sensors(desc, st);
	var temps = sensors.length
		? sensors.map(fmt).join(' · ')
		: '<em>' + _('No readable sensors.') + '</em>';

	var line = function(label, value) {
		return '<strong>' + esc(label) + ':</strong> ' + value + '<br />';
	};

	/*
	 * The fan line is assembled from whichever fields the document actually
	 * carries, because the two backends measure different things: the vendor
	 * daemon reads a tachometer and reports RPM, the generic one reports the
	 * duty cycle it wrote, because most hwmon fan devices have no tachometer at
	 * all. Rendering "0 RPM" for a backend that never claimed to know the speed
	 * would be worse than not showing a speed.
	 */
	var fan = [];

	if (st.fan_mode != null)
		fan.push(esc(st.fan_mode));

	if (st.thermal_state != null)
		fan.push(_('thermal state') + ' ' + esc(st.thermal_state));

	if (st.target_rpm != null || st.measured_rpm != null) {
		fan.push(_('target') + ' ' + (st.target_rpm || 0) + ' RPM' +
			', ' + _('measured') + ' ' + (st.measured_rpm || 0) + ' RPM');
		fan.push('PWM ' + (st.fan_pwm_0_255 || 0) + '/255');
	}
	else if (st.target_pwm != null) {
		fan.push(_('target') + ' ' + esc(st.target_pwm) + '%');
	}

	e.innerHTML =
		line(_('Lighting'),
			esc(st.led || '--') + ' (' + esc(st.led_mode || '--') + ', ' + _('brightness') + ' ' +
			(st.brightness_percent == null ? '--' : esc(st.brightness_percent)) + '%)') +
		line(_('Fan'), fan.length ? fan.join(', ') : '--') +
		line(_('Temperature'), temps);
}

/*
 * Whether the descriptor offers a given half at all.
 *
 * A backend that drives the kernel's classes may find LEDs and no fan, or a fan
 * and no LEDs, and the descriptor says so by leaving the corresponding list
 * empty. Rendering the section anyway would put an empty dropdown on the page
 * and invite the user to save a setting that nothing will read.
 */
function hasLed(desc) {
	if (!desc.ledModes || !desc.ledModes.length)
		return false;

	if (desc.ledDeviceKey)
		return !!(desc.ledDevices && desc.ledDevices.length);

	return true;
}

function hasFan(desc) {
	return !!desc.fan;
}

/*
 * The page shown when there is no backend this view can drive.
 *
 * It is deliberately not an empty form: a form that saves settings nothing
 * reads is worse than no form, because it looks like it worked. Saying so
 * plainly is the honest outcome.
 *
 * Two different situations land here and they need different words, because
 * only one of them is the user's to fix. An empty list means no backend is
 * usable - either none is installed, or the kernel exposes nothing this page
 * can drive. A non-empty list means the device has a backend this page has no
 * descriptor for, which is a page older than the hardware, and the answer to
 * that is to update the app.
 */
function renderUnsupported(available) {
	var found = (available && available.length) ? available.join('", "') : null;

	return E('div', { 'class': 'cbi-map' }, [
		E('h2', {}, _('LED & Fan Control')),
		E('div', { 'class': 'cbi-section' }, [
			E('p', {}, found
				? _('This device has a "%s" backend, but this version of the page has no support for it.').format(found)
				: _('No supported LED and fan backend was found on this device.')),
			E('p', {}, found
				? _('The backend is installed and running; it is only this configuration page that is out of date.')
				: _('This page drives the lighting and the fan either through a vendor daemon or through the kernel\'s own LED, hwmon and thermal interfaces. Neither was found here.'))
		])
	]);
}

return view.extend({
	load: function() {
		var self = this;

		return backend.detect().then(function(det) {
			self.det = det;

			if (!det.descriptor.config)
				return;

			return uci.load(det.descriptor.config);
		});
	},

	render: function() {
		var det = this.det || { descriptor: backend.NONE, available: [] };
		var desc = det.descriptor;
		var m, s, o, v;

		if (!desc.config)
			return renderUnsupported(det.available);

		m = new form.Map(desc.config, _('LED & Fan Control'),
			_('Unified control of the RGB PWM lighting and of the fan thermal control. A change takes effect as soon as it is saved and applied.'));

		/*
		 * The live status box is not a CBI section: it renders data the daemon
		 * writes, not a configuration value, so it is built as plain DOM and
		 * prepended to the rendered map below.
		 */
		var status = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Live status')),
			E('div', { 'id': 'ledfancontrol_status' }, E('em', {}, _('Reading…')))
		]);

		/* ---------------------------------------------------------------- */
		/* RGB LED                                                           */
		/* ---------------------------------------------------------------- */
		if (hasLed(desc)) {
			s = m.section(form.NamedSection, 'led', desc.sections.led, _('System RGB LED'));
			s.addremove = false;

			/*
			 * Which LED to drive is only a question on a board where the page
			 * has a choice; the vendor daemon owns its channels outright and
			 * leaves the list empty, so this option does not appear for it.
			 */
			if (desc.ledDeviceKey && desc.ledDevices.length) {
				o = s.option(form.ListValue, desc.ledDeviceKey, _('LED'));

				desc.ledDevices.forEach(function(l) {
					o.value(l.name, l.multicolor
						? l.name + ' — ' + _('multicolour')
						: l.name);
				});

				o.default = '';
				o.rmempty = false;
			}

			o = s.option(form.ListValue, 'led_mode', _('Control mode'));
			desc.ledModes.forEach(function(mode) {
				o.value(mode.value, mode.label);
			});
			o.default = desc.ledModes[0].value;
			o.rmempty = false;

			/*
			 * A colour only means something for the effects that actually use
			 * one. depends() entries are OR-ed by CBI - each entry is an AND of
			 * its own keys, and the entries are alternatives - so one entry per
			 * colour-taking effect shows the list for exactly those effects.
			 *
			 * Which effects those are, and whether the board can mix a colour
			 * at all, are properties of the backend: the descriptor's colour
			 * list is empty where no LED can, and the option is then left out
			 * entirely rather than offered and ignored.
			 */
			if (desc.colours.length) {
				o = s.option(form.ListValue, 'led_color', _('Manual colour'));
				desc.colours.forEach(function(c) {
					o.value(c.value, c.label);
				});
				o.default = desc.colours[0].value;
				desc.effects.forEach(function(e) {
					if (e.colour)
						o.depends({ led_mode: 'manual', led_effect: e.value });
				});
			}

			o = s.option(form.ListValue, 'led_effect', _('Manual effect'));
			desc.effects.forEach(function(e) {
				o.value(e.value, e.label);
			});
			o.default = desc.effects.length ? desc.effects[0].value : null;
			o.depends('led_mode', 'manual');

			o = s.option(form.ListValue, 'brightness', _('Brightness'));
			for (v = desc.brightness.min; v <= desc.brightness.max; v += desc.brightness.step)
				o.value(String(v), v + '%');
			o.default = String(desc.brightness.default);
			o.rmempty = false;
		}

		/* ---------------------------------------------------------------- */
		/* Cooling fan                                                       */
		/* ---------------------------------------------------------------- */
		if (hasFan(desc)) {
			s = m.section(form.NamedSection, 'fan', desc.sections.fan, _('Cooling fan'));
			s.addremove = false;

			/*
			 * Which hwmon device is the fan, on a board that has more than one
			 * candidate. The daemon matches on the name the driver reports, so
			 * what is stored here is that name - never the hwmon index, which
			 * moves between boots.
			 */
			if (desc.hwmonKey && desc.fanDevices.length) {
				o = s.option(form.ListValue, desc.hwmonKey, _('Fan device'));

				desc.fanDevices.forEach(function(h) {
					o.value(h.name, h.tach
						? h.name + ' — ' + _('with tachometer')
						: h.name);
				});

				o.default = desc.fanDevices[0].name;
				o.rmempty = false;
			}

			/*
			 * The trip point in this description is the backend's, so it is
			 * read from the descriptor rather than written into the string, and
			 * the sentence is only used by a backend that has one.
			 */
			o = s.option(form.ListValue, 'fan_mode', _('Control mode'),
				desc.fan.overtempC != null
					? _('Manual mode still keeps the forced full speed protection above %d °C.')
						.format(desc.fan.overtempC)
					: null);
			desc.fanModes.forEach(function(mode) {
				o.value(mode.value, mode.label);
			});
			o.default = desc.fanModes[0].value;
			o.rmempty = false;

			/*
			 * The two speed options are built from `steps` when the backend's
			 * table is an irregular list - the vendor daemon's RPM values are -
			 * and from min/max/step when it is a plain range, which is what a
			 * duty cycle is. Either way the unit comes from the descriptor.
			 */
			var speeds = function(which) {
				if (desc.fan.steps && desc.fan.steps[which])
					return desc.fan.steps[which].map(String);

				var out = [];
				for (var n = desc.fan.min; n <= desc.fan.max; n += desc.fan.step)
					out.push(String(n));

				return out;
			};

			o = s.option(form.ListValue, desc.fan.minKey,
				_('Minimum speed in automatic mode'));
			speeds('min').forEach(function(val, i) {
				o.value(val, val + ' ' + desc.fan.unit +
					(i === 0 ? ' (' + _('recommended') + ')' : ''));
			});
			o.default = String(desc.fan.defaultMin != null
				? desc.fan.defaultMin
				: desc.fan.steps.min[0]);
			o.depends('fan_mode', 'auto');

			o = s.option(form.ListValue, desc.fan.manualKey, _('Manual target speed'));
			speeds('manual').forEach(function(val) {
				o.value(val, val + ' ' + desc.fan.unit);
			});
			o.default = String(desc.fan.defaultManual != null
				? desc.fan.defaultManual
				: desc.fan.steps.manual[2]);
			o.depends('fan_mode', 'manual');

			/*
			 * The remaining numeric knobs, whatever they are. The descriptor
			 * supplies the label, the explanation and the range; the view only
			 * knows they are whole numbers. That keeps a backend which grows a
			 * setting - a second curve point, a spin-up delay - from needing a
			 * line here.
			 */
			(desc.extraFields || []).forEach(function(f) {
				o = s.option(form.Value, f.key,
					f.unit ? f.label + ' (' + f.unit + ')' : f.label,
					f.description);

				o.datatype = 'range(%d,%d)'.format(f.min, f.max);
				o.default = String(f.default);
				o.rmempty = false;
				o.depends('fan_mode', 'auto');
			});
		}

		return m.render().then(function(node) {
			node.insertBefore(status, node.firstChild);

			L.Poll.add(function() {
				return backend.status().then(function(st) {
					renderStatus(desc, st);
				});
			}, STATUS_INTERVAL);

			return node;
		});
	},

	handleSaveApply: function(ev, mode) {
		var det = this.det || { descriptor: backend.NONE, available: [] };
		var desc = det.descriptor;

		return this.handleSave(ev).then(function() {
			/*
			 * Commit the staged UCI change first, so that the init script
			 * reloaded below already reads the new values.
			 *
			 * uci.apply() is the raw ubus RPC rather than the HTTP endpoint
			 * the stock footer posts to, and it answers UBUS_STATUS_NO_DATA
			 * when there is nothing staged to commit - which is exactly the
			 * case when Save & Apply is pressed without changing anything.
			 * The call is declared reject: true, so that status arrives as a
			 * rejected promise and would be reported below as a bogus failure
			 * of an operation that was really a no-op. Ask uci.changes() for
			 * the staged changeset and commit only when it is non-empty.
			 */
			return uci.changes();
		}).then(function(changes) {
			var pending = 0;

			for (var config in changes)
				pending += changes[config].length;

			return pending ? uci.apply() : null;
		}).then(function() {
			return callRcInit(desc.service, 'reload');
		}).then(function() {
			/*
			 * Reload so the form shows the committed state. Deliberately no
			 * success notification: the reload replaces the page a moment
			 * later, so a toast would only flash past. The error branch below
			 * keeps its notification, because on failure nothing reloads and
			 * the user would otherwise see no sign that anything went wrong.
			 */
			window.location.reload();
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Failed to apply the settings: %s').format(err)), 'error');
		});
	}
});
