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
