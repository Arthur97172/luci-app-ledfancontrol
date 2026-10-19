'use strict';
'require view';
'require form';
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
 *   - commit it, which restarts the backend through its procd reload trigger,
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
 *
 * One thing here is more than rendering: the four LED settings are stored per
 * LED, so that configuring one indicator does not overwrite another's settings,
 * and the fields have to follow the LED chosen in the dropdown. CBI has no
 * built-in way to do that - an option's name is fixed - so the four options get
 * their load/write/remove replaced with ones that resolve the name from the
 * selected LED. See ledBind() and ledSwitch().
 */

var STATUS_INTERVAL = 3;

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

/* ------------------------------------------------------------------------ */
/* Per-LED settings                                                          */
/* ------------------------------------------------------------------------ */

/*
 * The LED whose settings the fields currently show, and the options bound to
 * it.
 *
 * Module state rather than a property of the view because the option hooks
 * below are closures created while the form is built, and they have to agree
 * with the dropdown about which LED is being edited. load() resets it, so a
 * reload starts from what is actually in the configuration.
 */
var ledState = {
	device: '',
	deviceOpt: null,
	options: []
};

/*
 * Transliterate a kernel LED name into something libuci accepts as an option
 * name.
 *
 * libuci's name grammar is [A-Za-z0-9_] and nothing else. It answers
 * `blue:status_mode` with "Parse error (invalid character in name field)", and
 * hyphens and dots are refused the same way - only *values* may contain them.
 * Every LED name the kernel publishes on the reference board has a colon or a
 * hyphen in it (blue:status, green:lan-3, mt76-phy0), so the name has to be
 * rewritten before it can be part of an option name.
 *
 * The daemon applies exactly the same rule with tr(1) when it reads these
 * settings back, and the two must not drift: a name spelled differently here
 * would leave the daemon reading an option the page never wrote, which looks
 * exactly like the setting being ignored.
 */
function san(name) {
	return String(name === null || name === undefined ? '' : name)
		.replace(/[^A-Za-z0-9_]/g, '_');
}

/*
 * The UCI option one LED setting is stored under, for the LED currently chosen
 * in the dropdown.
 *
 * With no LED chosen the plain name is used. That is what the configuration
 * meant before the settings became per-LED, and it is what the daemon falls
 * back to, so a board whose LED has not been picked yet behaves as it always
 * did.
 */
function ledKey(desc, base) {
	if (!desc.ledKeyTemplate || !ledState.device)
		return base;

	return desc.ledKeyTemplate.format(san(ledState.device), base);
}

/*
 * Read one LED setting for the LED currently chosen, walking the same chain the
 * daemon walks: this LED's own value, then the plain one the setting used to
 * live under, then nothing - in which case the option's default fills the
 * widget.
 *
 * The middle step is what keeps the page honest. Without it an LED that has no
 * settings of its own yet would display the built-in default while the daemon
 * applied the older global setting, so the page would be showing a value that
 * is not in force.
 */
function ledRead(desc, sid, base) {
	var v = uci.get(desc.config, sid, ledKey(desc, base));

	if (v === null || v === undefined || v === '')
		v = uci.get(desc.config, sid, base);

	return (v === null || v === undefined || v === '') ? null : v;
}

/*
 * Put one LED setting into its widget.
 *
 * CBI offers no way to re-read a single option from the configuration:
 * render() draws the value cached at load time, and Map.reset() only re-renders
 * - it does not re-read either. So the dropdown has to set the widgets itself.
 * getUIElement() is the supported way in, and it is the same widget formvalue()
 * reads, so a save afterwards sees the new value.
 */
function ledShow(desc, sid, entry) {
	var elem = entry.opt.getUIElement(sid);
	var v;

	if (!elem)
		return;

	v = ledRead(desc, sid, entry.base);

	/*
	 * An LED with neither a value of its own nor a global one to inherit gets
	 * the option's default - and that has to be applied here rather than left
	 * to CBI. CBI fills a widget from the default only while rendering, and
	 * this widget was rendered for a different LED; leaving it alone would put
	 * the previous LED's value on screen under the new LED's name.
	 */
	if (v === null)
		v = entry.fallback;

	if (v !== null && v !== undefined)
		elem.setValue(v);

	/*
	 * A stored value the option does not offer - a colour this board can no
	 * longer mix, or a leftover from another backend - leaves the list empty,
	 * because assigning a value with no matching entry clears it. An empty
	 * value is not a setting this page accepts and would make the next save
	 * fail with "must not be empty", so the default stands in instead.
	 */
	if (!elem.getValue() && entry.fallback !== null && entry.fallback !== undefined)
		elem.setValue(entry.fallback);

	entry.shown = elem.getValue();
}

/*
 * Move the four settings fields from one LED to another.
 *
 * Anything edited but not yet saved is first written into the changeset under
 * the LED it was edited on. Choosing a different LED is not a save, so without
 * this the edit would simply vanish - which is the same class of bug as the one
 * where saving one LED clobbered another's settings.
 *
 * It goes into the changeset rather than to the configuration file, so it is
 * committed or discarded along with the rest of the page. And because uci.get()
 * merges the changeset over the stored values, choosing that LED again brings
 * the unsaved edit back with it.
 */
function ledSwitch(desc, sid, device) {
	var prev = ledState.device;

	if (prev && prev !== device) {
		ledState.options.forEach(function(entry) {
			var elem = entry.opt.getUIElement(sid);
			var v = elem ? elem.getValue() : null;

			if (v === null || v === '' || v === entry.shown)
				return;

			uci.set(desc.config, sid,
				desc.ledKeyTemplate.format(san(prev), entry.base), v);
		});
	}

	ledState.device = device || '';

	ledState.options.forEach(function(entry) {
		ledShow(desc, sid, entry);
	});
}

/*
 * Bind one of the four LED settings to the LED chosen in the dropdown instead
 * of to a fixed option name.
 *
 * CBI resolves an option's name at load, write and remove time and nowhere
 * else, so replacing those three methods is all it takes to move an option
 * between keys. Its widget, its DOM id and its depends() wiring stay where they
 * are, which is what keeps this a single short section rather than a block of
 * fields for every LED on the board.
 *
 * There is no per-option `save` hook in CBI - `save` exists only on the map -
 * which is what an earlier attempt at this got wrong, and why the fields used
 * to come back as the default after a save.
 *
 * A descriptor that stores its settings once for the whole board - the vendor
 * daemon, which owns its channels outright and has no LED list - names no
 * template, and is left exactly as it was.
 */
function ledBind(desc, o, base) {
	if (!desc.ledKeyTemplate)
		return;

	/*
	 * CBI treats "the widget holds the option's default" as "nothing was
	 * chosen": parse() sends an option whose value equals its default straight
	 * to remove(), for any option that is rmempty - and rmempty is true by
	 * default, which the colour and effect options are. Removing the value is
	 * the right answer for a setting that has one home, but not here: it would
	 * make choosing the default for an LED delete that LED's setting, so the
	 * LED would fall back to the global one and quietly apply a different
	 * value than the one on screen.
	 *
	 * With rmempty off, a value the user chose is stored even when it happens
	 * to equal the default, and the LED stops inheriting. The value can never
	 * be empty for these options - ledShow() puts the default in rather than
	 * leaving the list blank - so the "must not be empty" rejection that
	 * rmempty also guards against cannot fire.
	 */
	o.rmempty = false;

	o.load = function(sid) {
		return ledRead(desc, sid, base);
	};

	o.write = function(sid, val) {
		return this.map.data.set(desc.config, sid, ledKey(desc, base), val);
	};

	o.remove = function(sid) {
		this.map.data.unset(desc.config, sid, ledKey(desc, base));
	};

	ledState.options.push({
		base: base,
		opt: o,
		fallback: o.default,
		shown: null
	});
}

return view.extend({
	load: function() {
		var self = this;

		ledState.device = '';
		ledState.deviceOpt = null;
		ledState.options = [];

		return backend.detect().then(function(det) {
			self.det = det;

			if (!det.descriptor.config)
				return;

			return uci.load(det.descriptor.config).then(function() {
				/*
				 * Which LED the settings belong to has to be known before the
				 * form loads, because that is what the options read their value
				 * from - see ledBind().
				 */
				if (det.descriptor.ledDeviceKey)
					ledState.device = uci.get(det.descriptor.config, 'led',
						det.descriptor.ledDeviceKey) || '';
			});
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
		 *
		 * The inner div carries cbi-map-descr, the class form.Map puts on the map
		 * description - the sentence under the page title. That class is what
		 * indents that sentence, and a bare div inside a cbi-section inherits
		 * none of it: the theme pads the section's heading and its content
		 * separately, and only the heading is padded, so the status lines used to
		 * sit hard against the left edge while the description above them was
		 * inset.
		 *
		 * cbi-section-descr is the native class for a description *inside* a
		 * section and looks like the more obvious choice, but themes do not give
		 * it the same inset as the map description - in Argon it is 1rem against
		 * the description's 1.25rem - so the lines would stay visibly out of line
		 * with the sentence they are compared against. Borrowing the map
		 * description's class aligns the two by construction, in any theme,
		 * rather than by a number that would have to be kept in step with each
		 * theme's stylesheet.
		 */
		var status = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Live status')),
			E('div', { 'class': 'cbi-map-descr', 'id': 'ledfancontrol_status' },
				E('em', {}, _('Reading…')))
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

				/*
				 * Choosing an LED chooses whose settings the three fields below
				 * show, so the choice has to be acted on rather than just
				 * stored. CBI hands onchange the section id and the new value;
				 * see ledSwitch() for what it does with them.
				 */
				if (desc.ledKeyTemplate) {
					o.onchange = function(ev, sid, value) {
						ledSwitch(desc, sid, value);
					};

					/* Kept so that render() can ask the rendered dropdown which
					 * LED it ended up showing; see the note there. */
					ledState.deviceOpt = o;
				}
			}

			o = s.option(form.ListValue, desc.ledModeKey, _('Control mode'));
			desc.ledModes.forEach(function(mode) {
				o.value(mode.value, mode.label);
			});
			o.default = desc.ledModes[0].value;
			o.rmempty = false;
			ledBind(desc, o, desc.ledModeKey);

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
				o = s.option(form.ListValue, desc.ledColorKey, _('Manual colour'));
				desc.colours.forEach(function(c) {
					o.value(c.value, c.label);
				});
				o.default = desc.colours[0].value;
				desc.effects.forEach(function(e) {
					if (!e.colour)
						return;

					/*
					 * Built rather than written as a literal, because both keys
					 * belong to the backend rather than to this file.
					 */
					var dep = {};

					dep[desc.ledModeKey] = 'manual';
					dep[desc.ledEffectKey] = e.value;
					o.depends(dep);
				});

				/*
				 * Retain the stored colour while the option is hidden.
				 *
				 * CBI deletes the value of every option whose depends() is
				 * unsatisfied unless `retain` is set - form.js sends an
				 * inactive option straight to remove(). That is the wrong
				 * answer for a colour twice over: the user's choice would be
				 * silently dropped the moment they picked an effect that takes
				 * no colour, and the save after that would ask rpcd to delete
				 * an option that is no longer in the configuration, which it
				 * answers with UBUS_STATUS_NOT_FOUND - the "未找到资源" this
				 * page used to report.
				 */
				o.retain = true;
				ledBind(desc, o, desc.ledColorKey);
			}

			o = s.option(form.ListValue, desc.ledEffectKey, _('Manual effect'));
			desc.effects.forEach(function(e) {
				o.value(e.value, e.label);
			});
			o.default = desc.effects.length ? desc.effects[0].value : null;
			o.depends(desc.ledModeKey, 'manual');

			/* Retained while the LED is not in manual mode - see above. */
			o.retain = true;
			ledBind(desc, o, desc.ledEffectKey);

			o = s.option(form.ListValue, desc.brightnessKey, _('Brightness'));
			for (v = desc.brightness.min; v <= desc.brightness.max; v += desc.brightness.step)
				o.value(String(v), v + '%');
			o.default = String(desc.brightness.default);
			o.rmempty = false;
			ledBind(desc, o, desc.brightnessKey);
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
			o = s.option(form.ListValue, desc.fanModeKey, _('Control mode'),
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

			var mins = speeds('min');

			/*
			 * The "(recommended)" marker follows the value the descriptor names
			 * rather than the head of the list. The vendor daemon's list now
			 * opens at 1000 RPM, which the daemon itself raises to 1500, so
			 * marking the first entry would recommend a speed that cannot be
			 * set. A backend that names no recommended value keeps the older
			 * behaviour and marks its first entry.
			 */
			var recommended = desc.fan.recommendedMin != null
				? String(desc.fan.recommendedMin)
				: mins[0];

			o = s.option(form.ListValue, desc.fan.minKey,
				_('Minimum speed in automatic mode'));
			mins.forEach(function(val) {
				o.value(val, val + ' ' + desc.fan.unit +
					(val === recommended ? ' (' + _('recommended') + ')' : ''));
			});
			o.default = String(desc.fan.defaultMin != null
				? desc.fan.defaultMin
				: desc.fan.steps.min[0]);
			o.depends(desc.fanModeKey, 'auto');

			/* Retained while the fan is not in automatic mode - see above. */
			o.retain = true;

			o = s.option(form.ListValue, desc.fan.manualKey, _('Manual target speed'));
			speeds('manual').forEach(function(val) {
				o.value(val, val + ' ' + desc.fan.unit);
			});
			o.default = String(desc.fan.defaultManual != null
				? desc.fan.defaultManual
				: desc.fan.steps.manual[2]);
			o.depends(desc.fanModeKey, 'manual');

			/* Retained while the fan is not in manual mode - see above. */
			o.retain = true;

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
				o.depends(desc.fanModeKey, 'auto');

				/* Retained while the fan is not in automatic mode - see above. */
				o.retain = true;
			});
		}

		return m.render().then(function(node) {
			node.insertBefore(status, node.firstChild);

			/*
			 * A <select> with no entry marked selected shows its first one, so
			 * the LED on screen is not always the LED the configuration names:
			 * a configuration whose `device` is still empty - a fresh install -
			 * draws the first LED of the list. Take the device from the dropdown
			 * rather than from the configuration, so that the settings shown are
			 * always the ones belonging to the LED shown.
			 */
			var devElem = ledState.deviceOpt && ledState.deviceOpt.getUIElement('led');

			if (devElem && devElem.getValue())
				ledState.device = devElem.getValue();

			/*
			 * Then settle each field on what it should display: the stored value
			 * for this LED, or the option default where there is none. Drawing
			 * already did this from the values load() read, but load() ran
			 * against the device named in the configuration, which is the value
			 * just replaced - and drawing leaves a field blank when the stored
			 * value is not one the option offers. Both are corrected here.
			 *
			 * It also records what each field settled on; ledSwitch() compares
			 * against that to tell an edit from an untouched field.
			 */
			ledState.options.forEach(function(entry) {
				ledShow(desc, 'led', entry);
			});

			L.Poll.add(function() {
				return backend.status().then(function(st) {
					renderStatus(desc, st);
				});
			}, STATUS_INTERVAL);

			return node;
		});
	},

	/*
	 * Save the form, then hand the commit to ui.changes.apply() - the stock
	 * path, and the same one line the base view in luci.js runs.
	 *
	 * This override is deliberately the base implementation written out. It is
	 * spelled out rather than inherited only so that the reasoning below sits
	 * next to the code it protects: the page was changed into a hand-rolled
	 * ubus call once already, and the argument against doing that again is
	 * worth more here than in a commit message.
	 *
	 * Committing through uci.apply() over ubus instead - the obvious-looking
	 * thing, and what this page used to do - fails here for two independent
	 * reasons, and both of them are properties of the RPC rather than of
	 * anything this page gets wrong.
	 *
	 * It commits the whole session changeset, not this page's share of it.
	 * rpcd stages every config any open page has touched in one per-session
	 * delta directory, and uci apply walks that directory and refuses the
	 * call unless the session holds *write* ACL on every config in it
	 * (rpc_uci_apply_access() in rpcd's uci.c). A config the session may read
	 * but not write - wireless, left behind by another page in the same
	 * browser session - is enough to turn the call into
	 * UBUS_STATUS_PERMISSION_DENIED, which is the "没有权限" the button used
	 * to report. ui.changes.apply() posts to the admin/uci endpoint instead,
	 * which the LuCI dispatcher handles as root and where no per-config ubus
	 * ACL applies.
	 *
	 * It is also the rollback flavour of the call. LuCI's uci.apply() sends
	 * uci apply { rollback: true }, so rpcd snapshots the configuration and
	 * arms a timer, and it refuses a second rollback apply while one is
	 * pending (rpc_uci_apply()). Confirming is the caller's job, and the
	 * confirm loop LuCI wraps around it never ran here because this page
	 * reloaded itself as soon as the apply returned - so a second press
	 * inside the rollback window was denied, and an unconfirmed first press
	 * quietly reverted the configuration.
	 *
	 * ui.changes.apply() also reports "There are no changes to apply" rather
	 * than failing when the changeset is empty, which is what pressing the
	 * button without having edited anything produces, and it drives the
	 * confirm step and the reload itself.
	 *
	 * Nothing reloads the backend here on purpose. Committing the
	 * configuration runs reload_config, which fires the procd reload trigger
	 * both init scripts declare - service_triggers() in
	 * root/etc/init.d/ledfancontrol and in the vendor's factory-pwm - so the
	 * daemon is restarted by the commit itself. A separate rc.init call would
	 * only race the page reload the apply flow has already started.
	 */
	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function() {
			ui.changes.apply(mode == '0');
		});
	}
});
