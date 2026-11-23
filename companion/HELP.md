# companion-module-ptzoptics-visca

This module can be used to control PTZOptics cameras using the PTZOptics flavor of the Sony VISCA protocol communicating over TCP.

It _may_ work with other manufacturers' cameras, but it isn't guaranteed to do so. (We attempt to maintain support for other cameras as long as it doesn't interfere with supporting PTZOptics cameras.) If you find that some commands work with your camera but others don't, you may be able to replace the nonfunctional commands with a "Custom command" that sends the byte sequence your camera requires.

## Commands

- Custom Command
  Custom commands allow you to send any valid VISCA byte sequence to the camera. The camera must respond with an `ACK` message followed at some later time (either immediately or after a delay) by a `Completion` message: that is,`90 4y FF` and `90 5y FF` where the nibble indicated by `y` is consistent in both replies. Specify the VISCA bytes using this format, beginning with `81` and ending with `FF` and with one or more non-`FF` bytes between: `81 01 02 03 04 FF`

## Status variables

Turn on **Poll camera status** in the connection settings to have the module ask the camera for its status and show the answers as variables. Choose which status to poll; fewer groups make each poll faster (each answer takes about 20 ms). The module polls every 200 ms for 2 seconds after any command it sends, then goes back to the configured interval.

| Group                 | Variables                                                |
| --------------------- | -------------------------------------------------------- |
| Power                 | `power`                                                  |
| Pan/tilt position     | `pan`, `tilt`                                            |
| Zoom and focus        | `zoom`, `zoom_pct`, `focus`, `focus_mode`                |
| Exposure              | `exposure_mode`, `iris`, `shutter`, `gain`, `brightness` |
| White balance         | `wb_mode`, `wb_red`, `wb_blue`                           |
| Image flip and mirror | `flip`, `mirror`                                         |

`pt_speed` (the pan/tilt speed movement actions use) is always available. The camera can't report it, so the module publishes its own setting.

If the camera doesn't answer one of these inquiries, the module logs it once and stops asking for that value.

## Status from the camera web interface (optional)

PTZOptics cameras also report status over their web interface, which needs the camera's web login. Turn on **Read status from the camera web interface** and enter a username and password. The password is kept in Companion's secret store. Use a low-privilege account such as `guest`. The module only sends read-only requests and never reads network settings (they contain stream keys).

Variables: `http_status` (ok, login rejected, unreachable), `device_name`, `model`, `firmware`, `moving`, `pt_moving`, `zoom_moving`, `focus_moving`, `autotrack`, `camera_preset`, `video_format`, `ndi_mode`.

`camera_preset` is whatever the camera reports; its meaning varies by firmware (-2 means none).

## Feedbacks

Feedbacks read the status above, so turn on the matching polling first.

- **Camera: power is on**, **Lens: focus mode is**, **Exposure: mode is**, **White balance: mode is**, **Image: flip or mirror is on**
- **Lens: zoom position (%)** above / below / equal to a value
- **Pan/tilt: speed is** equal to / above / below a value
- **Camera: is moving** and **Camera: auto-tracking is on** (need the web login)
- **Presets: preset is the one last recalled**: on after this module recalls that preset, off once the camera is moved away from it (needs pan/tilt and zoom polling to notice) or another preset is recalled. The camera itself can't report its preset. Also as the variable `last_preset`.
- **Camera: status is not updating**: polling is on but the camera stopped answering.

## Knob actions

- **Zoom step (for knobs)**: zoom in or out by a percentage of the range. Fast turns add up. Needs "Zoom and focus" polling.
- **Zoom to position (%)**: 0% wide, 100% full telephoto.
