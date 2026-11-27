# companion-module-ptzoptics-visca

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Getting started

Executing a `yarn` command should perform all necessary steps to develop the module. If it doesn't, follow the steps below.

First, download and install module dependencies using `yarn install`. You can then build the module using `yarn build`. The module can be loaded by Companion by adding a symlink to the module folder to the [`companion-module-dev`](https://github.com/bitfocus/companion-module-base/wiki) you specify in your Companion installation's settings. (Or you can simply clone the module into a folder inside `companion-module-dev`.)

Use `yarn lint` to check code style and `yarn lint --fix` to fix mechanically-fixable formatting errors. Use `yarn test` to run module tests. Use `yarn test:stress` to run the stress tests: hours of polling and of injected faults, in compressed time, which take a minute or two. The module includes a Github workflow that lints module code and runs tests when you push to Github or create a PR, so you can check lint/testing results for your pushes in the "Actions" tab of your Github repository.

Run `yarn dev` to compile module code, then watch for changes to automatically recompile it. This is a useful way to quickly test code changes as you work on them.

## Supported cameras

This module exists to support PTZOptics cameras, first and foremost. G3 series cameras are probably most supported, because that's what the module maintainer uses himself. G2 series cameras are expected to work reasonably well, too, but they're less well-tested and so we rely on user testing to ensure support.

This module uses VISCA over TCP/IP to control cameras. This protocol, initially developed by Sony, is implemented by many manufacturers for many different cameras. But cameras often implement it in subtly different form. This module attempts to enable support for non-PTZOptics cameras. But when such support would be incompatible with PTZOptics cameras -- for example, if a camera uses a different byte sequence for a command than PTZOptics cameras do -- the module will only support the PTZOptics mechanism. Users who use non-PTZOptics cameras are expected to use the "Custom command" action to work around this.

## Adding a camera model

The **Camera model** setting chooses a camera definition: which status inquiries the camera answers when on and in standby, its zoom range, and how long it takes to wake. A new definition is accepted only with:

- a capture of the camera **on** and a capture of it in **standby**, recorded by `tools/capture-camera.mjs` and saved unedited as `src/cameras/captures/<camera>/on.json` and `standby.json`;
- the camera's **model** and **firmware** in each capture (`--model` and `--firmware`).

A capture of the camera waking (`--state waking --allow-power`, saved as `waking.json`) is welcome too: the wake window comes from it.

Then add the definition in `src/cameras/` and list it in `src/cameras/index.ts`. `yarn test` checks every definition against its captures and says where they disagree, and runs the whole-module scenarios against every camera that has captures.

Captures are welcome before a definition can be written: of a camera in only one power state, or with its model or firmware not yet known. Save them the same way. The scenarios then run against that camera in the state it was recorded in, and list as skipped the ones that need the other state. An inquiry the camera left unanswered is played back as it was: the simulated camera sends nothing in reply.

One behaviour is known that no capture shows. Some cameras close the connection on a schedule (the ones seen do it every 12 hours, to the minute) and then send, on the next connection, their replies to inquiries left unanswered on the old one. The module makes the new connection at once and ignores a reply that arrives while nothing awaits one; `src/__tests__/leftover-replies.test.ts` plays this against every camera.
