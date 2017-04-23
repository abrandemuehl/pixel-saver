const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Util = imports.misc.util;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const UtilMe = Me.imports.util;
const Utils = Me.imports.utils;

function LOG(message) {
	// log("[pixel-saver]: " + message);
}

function WARN(message) {
	log("[pixel-saver]: " + message);
}

/**
 * Guesses the X ID of a window.
 *
 * It is often in the window's title, being `"0x%x %10s".format(XID, window.title)`.
 * (See `mutter/src/core/window-props.c`).
 *
 * If we couldn't find it there, we use `win`'s actor, `win.get_compositor_private()`.
 * The actor's `x-window` property is the X ID of the window *actor*'s frame
 * (as opposed to the window itself).
 *
 * However, the child window of the window actor is the window itself, so by
 * using `xwininfo -children -id [actor's XID]` we can attempt to deduce the
 * window's X ID.
 *
 * It is not always foolproof, but works good enough for now.
 *
 * @param {Meta.Window} win - the window to guess the XID of. You wil get better
 * success if the window's actor (`win.get_compositor_private()`) exists.
 */
function guessWindowXID(win) {
	// We cache the result so we don't need to redetect.
	if (win._pixelSaverWindowID) {
		return win._pixelSaverWindowID;
	}
	
	/**
	 * If window title has non-utf8 characters, get_description() complains
	 * "Failed to convert UTF-8 string to JS string: Invalid byte sequence in conversion input",
	 * event though get_title() works.
	 */
	try {
		let m = win.get_description().match(/0x[0-9a-f]+/);
		if (m && m[0]) {
			return win._pixelSaverWindowID = m[0];
		}
	} catch (err) { }
	
	// use xwininfo, take first child.
	let act = win.get_compositor_private();
	let xwindow = act && act['x-window'];
	if (xwindow) {
		let xwininfo = GLib.spawn_command_line_sync('xwininfo -children -id 0x%x'.format(xwindow));
		if (xwininfo[0]) {
			let str = xwininfo[1].toString();
			
			/**
			 * The X ID of the window is the one preceding the target window's title.
			 * This is to handle cases where the window has no frame and so
			 * act['x-window'] is actually the X ID we want, not the child.
			 */
			let regexp = new RegExp('(0x[0-9a-f]+) +"%s"'.format(win.title));
			let m = str.match(regexp);
			if (m && m[1]) {
				return win._pixelSaverWindowID = m[1];
			}
			
			// Otherwise, just grab the child and hope for the best
			m = str.split(/child(?:ren)?:/)[1].match(/0x[0-9a-f]+/);
			if (m && m[0]) {
				return win._pixelSaverWindowID = m[0];
			}
		}
	}
	
	// Try enumerating all available windows and match the title. Note that this
	// may be necessary if the title contains special characters and `x-window`
	// is not available.
	let result = GLib.spawn_command_line_sync('xprop -root _NET_CLIENT_LIST');
	LOG('xprop -root _NET_CLIENT_LIST')
	if (result[0]) {
		let str = result[1].toString();
		
		// Get the list of window IDs.
		let windowList = str.match(/0x[0-9a-f]+/g);
		
		// For each window ID, check if the title matches the desired title.
		for (var i = 0; i < windowList.length; ++i) {
			let cmd = 'xprop -id "' + windowList[i] + '" _NET_WM_NAME _PIXEL_SAVER_ORIGINAL_STATE';
			let result = GLib.spawn_command_line_sync(cmd);
			LOG(cmd);
			
			if (result[0]) {
				let output = result[1].toString();
				let isManaged = output.indexOf("_PIXEL_SAVER_ORIGINAL_STATE(CARDINAL)") > -1;
				if (isManaged) {
					continue;
				}

				let title = output.match(/_NET_WM_NAME(\(\w+\))? = "(([^\\"]|\\"|\\\\)*)"/);
				LOG("Title of XID %s is \"%s\".".format(windowList[i], title[2]));

				// Is this our guy?
				if (title && title[2] == win.title) {
					return windowList[i];
				}
			}
		}
	}

	// debugging for when people find bugs..
	WARN("Could not find XID for window with title %s".format(win.title));
	return null;
}

const WindowState = {
	DEFAULT: 'default',
	UNDECORATED: 'undecorated',
	UNKNOWN: 'unknown'
}

/**
 * Get the value of _GTK_HIDE_TITLEBAR_WHEN_MAXIMIZED before
 * pixel saver did its magic.
 * 
 * @param {Meta.Window} win - the window to check the property
 */
function getOriginalState(win) {
	if (win._pixelSaverOriginalState !== undefined) {
		return win._pixelSaverOriginalState;
	}

	let id = guessWindowXID(win);
	let cmd = 'xprop -id ' + id;
	LOG(cmd);
	
	let xprops = GLib.spawn_command_line_sync(cmd);
	if (!xprops[0]) {
		WARN("xprop failed for " + win.title + " with id " + id);
		return win._pixelSaverOriginalState = State.UNKNOWN;
	}
	
	let str = xprops[1].toString();
	let m = str.match(/^_PIXEL_SAVER_ORIGINAL_STATE\(CARDINAL\) = ([0-9]+)$/m);
	if (m) {
		return win._pixelSaverOriginalState = !!m[1]
			? WindowState.UNDECORATED
			: WindowState.DEFAULT;
	}
	
	m = str.match(/^_MOTIF_WM_HINTS(\(CARDINAL\))? = ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+)$/m);
	if (m) {
		let state = !!m[3];
		cmd = ['xprop', '-id', id,
		      '-f', '_PIXEL_SAVER_ORIGINAL_STATE', '32c',
		      '-set', '_PIXEL_SAVER_ORIGINAL_STATE',
		      (state ? '0x1' : '0x0')];
		LOG(cmd.join(' '));
		Util.spawn(cmd);
		return win._pixelSaverOriginalState = state
			? WindowState.HIDE_TITLEBAR
			: WindowState.DEFAULT;
	}

    if(!win.decorated) {
        return win._pixelSaverOriginalState = WindowState.UNDECORATED;
    }
	
	WARN("Can't find original state for " + win.title + " with id " + id);
	
	// GTK uses the _GTK_HIDE_TITLEBAR_WHEN_MAXIMIZED atom to indicate that the
	// title bar should be hidden when maximized. If we can't find this atom, the
	// window uses the default behavior
	return win._pixelSaverOriginalState = WindowState.DEFAULT;
}

function updateHideTitlebar() {
    Mainloop.idle_add(function () {
        // If we have a window to control, then we undecorate
        let hide = false;
        let win = UtilMe.getWindow();

		if (settings.get_boolean('only-main-monitor'))
			hide = win.is_on_primary_monitor();
        if (win) {
            let state = getOriginalState(win);
            if(state === WindowState.DEFAULT) {
                hide = (win.get_maximized() === Meta.MaximizeFlags.BOTH);
                setHideTitlebar(win, hide);
            }
        }
        return false;
    });
}


function setHideTitlebar(win, hide) {
    // Make sure we save the original state before changing it
    getOriginalState(win);

    let cmd = ['xprop', '-id', guessWindowXID(win),
	        '-f', '_MOTIF_WM_HINTS', '32c',
	        '-set', '_MOTIF_WM_HINTS',
	        (hide ? '0x2, 0x0, 0x0, 0x0, 0x0' : '0x2, 0x0, 0x1, 0x0, 0x0')];



	LOG(cmd.join(' '));
	
	// Run xprop
	[success, pid] = GLib.spawn_async(
		null,
		cmd,
		null,
		GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
		null);

    // Remove the _MOTIF_WM_HINTS xprop so that we don't confuse ourselves if
    // the shell restarts
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, function () {
        let cmd = ['xprop', '-id', guessWindowXID(win),
        '-remove', '_MOTIF_WM_HINTS'];

        LOG(cmd.join(' '));

        // Run xprop
        [success, pid] = GLib.spawn_async(
                null,
                cmd,
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null);


        // After xprop completes, activate the focused window. For some reason
        // applying the change causes the window to not be focused when it
        // maximizes
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, function () {
            Main.activateWindow(win);
        });
    });
}


/**** Callbacks ****/
/**
 * Callback when a window is added in any of the workspaces.
 * This includes a window switching to another workspace.
 *
 * If it is a window we already know about, we do nothing.
 *
 * Otherwise, we activate the hide title on maximize feature.
 *
 * @param {Meta.Window} win - the window that was added.
 *
 * @see undecorate
 */
function onWindowAdded(ws, win, retry) {
	if (win.window_type === Meta.WindowType.DESKTOP) {
		return false;
	}
	
	// If the window is simply switching workspaces, it will trigger a
	// window-added signal. We don't want to reprocess it then because we already
	// have.
	if (win._pixelSaverOriginalState !== undefined) {
		return false;
	}
	
	/**
	 * Newly-created windows are added to the workspace before
	 * the compositor knows about them: get_compositor_private() is null.
	 * Additionally things like .get_maximized() aren't properly done yet.
	 * (see workspace.js _doAddWindow)
	 */
	if (!win.get_compositor_private()) {
		retry = (retry !== undefined) ? retry : 0;
		if (retry > 3) {
			return false;
		}
		
		Mainloop.idle_add(function () {
			onWindowAdded(ws, win, retry + 1);
			return false;
		});
		return false;
	}
	
	retry = 3;
	Mainloop.idle_add(function () {
		let id = guessWindowXID(win);
		if (!id) {
			if (--retry) {
				return true;
			}
			
			WARN("Finding XID for window %s failed".format(win.title));
			return false;
		}
		
		LOG('onWindowAdded: ' + win.get_title());
		updateHideTitlebar();
		return false;
	});
	
	return false;
}

let workspaces = [];

/**
 * Callback whenever the number of workspaces changes.
 *
 * We ensure that we are listening to the 'window-added' signal on each of
 * the workspaces.
 *
 * @see onWindowAdded
 */
function onChangeNWorkspaces() {
	cleanWorkspaces();
	
	let i = global.screen.n_workspaces;
	while (i--) {
		let ws = global.screen.get_workspace_by_index(i);
		workspaces.push(ws);
		// we need to add a Mainloop.idle_add, or else in onWindowAdded the
		// window's maximized state is not correct yet.
		ws._pixelSaverWindowAddedId = ws.connect('window-added', function (ws, win) {
			Mainloop.idle_add(function () { return onWindowAdded(ws, win); });
		});
	}
	
	return false;
}

/**
 * Utilities
 */
function cleanWorkspaces() {
	// disconnect window-added from workspaces
	workspaces.forEach(function(ws) {
		ws.disconnect(ws._pixelSaverWindowAddedId);
		delete ws._pixelSaverWindowAddedId;
	});
	
	workspaces = [];
}

function forEachWindow(callback) {
	global.get_window_actors()
		.map(function (w) { return w.meta_window; })
		.filter(function(w) { return w.window_type !== Meta.WindowType.DESKTOP; })
		.forEach(callback);
}

function windowEnteredMonitor(metaScreen, monitorIndex, metaWin) {
	let hide = true;
	if (settings.get_boolean('only-main-monitor'))
		hide = monitorIndex == Main.layoutManager.primaryIndex;
	setHideTitlebar(metaWin, hide);
}

/**
 * Subextension hooks
 */
function init() {}

let wmCallbackIDs = [];

let changeWorkspaceID = 0;
let windowEnteredID = 0;
function enable() {
	// Load settings
	settings = Utils.getSettings();

	// Connect events
	changeWorkspaceID = global.screen.connect('notify::n-workspaces', onChangeNWorkspaces);
	windowEnteredID   = global.screen.connect('window-entered-monitor', windowEnteredMonitor);

	let wm = global.window_manager;
	wmCallbackIDs.push(wm.connect('switch-workspace', updateHideTitlebar));
	wmCallbackIDs.push(wm.connect('minimize', updateHideTitlebar));
	wmCallbackIDs.push(wm.connect('unminimize', updateHideTitlebar));
    wmCallbackIDs = wmCallbackIDs.concat(UtilMe.onSizeChange(updateHideTitlebar));

    let i = global.screen.n_workspaces;
    while (i--) {
        let ws = global.screen.get_workspace_by_index(i);
        wmCallbackIDs.push(ws.connect('window-added', function () {
            Mainloop.idle_add(function () { return updateHideTitlebar(); });
        }));
    }
	
	/**
	 * Go through already-maximised windows & undecorate.
	 * This needs a delay as the window list is not yet loaded
	 * when the extension is loaded.
	 * Also, connect up the 'window-added' event.
	 * Note that we do not connect this before the onMaximise loop
	 * because when one restarts the gnome-shell, window-added gets
	 * fired for every currently-existing window, and then
	 * these windows will have onMaximise called twice on them.
	 */
	Mainloop.idle_add(function () {
		forEachWindow(function(win) {
			onWindowAdded(null, win);
		});
		
		onChangeNWorkspaces();
		return false;
	});
}

function disable() {
	if (changeWorkspaceID) {
		global.screen.disconnect(changeWorkspaceID);
		changeWorkspaceID = 0;
	}

	if (windowEnteredID) {
		global.screen.disconnect(windowEnteredID);
		windowEnteredID = 0;
	}
	wmCallbackIDs.forEach(function(id) {
		global.window_manager.disconnect(id);
	});
	
	cleanWorkspaces();
	
	forEachWindow(function(win) {
		let state = getOriginalState(win);
		LOG('stopUndecorating: ' + win.title + ' original=' + state);
		if (state == WindowState.DEFAULT) {
			setHideTitlebar(win, false);
		}
		
		delete win._pixelSaverOriginalState;
	});

	settings.run_dispose();
	settings = null;
}

