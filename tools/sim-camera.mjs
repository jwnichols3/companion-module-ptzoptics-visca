#!/usr/bin/env node
// Run the simulated camera the tests use as a network service, playing one
// camera's captures, so that a real Companion (or anything else that speaks
// VISCA over TCP) can connect to it.  This is how to check the module against
// a camera brand you do not own: all it takes is that camera's captures.
//
//   yarn sim-camera <camera> [--state on|standby] [--port <port>] \
//        [--host <address>] [--wake-up-speed <times>]
//   yarn sim-camera --list
//
// (`yarn sim-camera` is `node tools/sim-camera.mjs`.)
//
// <camera> is a directory of captures under src/cameras/captures/, as recorded
// by `tools/capture-camera.mjs`, or a camera written by hand for the tests.
// `--list` prints them all, as does naming a camera that isn't one of them.
//
//   --state          the power state the camera starts in: on if omitted
//   --port           the TCP port to listen on: 5678 if omitted, and 0 for a
//                    port the OS chooses
//   --host           the address to listen on: 127.0.0.1 if omitted, so that
//                    only this computer can connect.  A Companion on another
//                    computer can connect only if this is an address of this
//                    computer that it can reach (or 0.0.0.0 for all of them),
//                    which opens the port to that network.
//   --wake-up-speed  how many times faster than recorded to play the camera's
//                    wake-up: 1, the true pace, if omitted
//
// Then add a connection in Companion with this computer's address and the
// port.  The camera answers inquiries as its captures say it does in its
// state, and acknowledges and completes every command.  Power Off puts it in
// standby; Power On wakes it the way the capture of it waking says, at the
// pace it was recorded, or at once if it has no such capture.  Each message
// received and each change of state is printed.  Ctrl-C stops it.
//
// The camera itself is src/visca/__tests__/simulator/, in TypeScript, so this
// compiles it with `tsc` into tools/.sim-camera/ and runs the result: run
// `yarn install` first.
import { execFileSync } from 'node:child_process'
import { cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const Root = new URL('../', import.meta.url)
const Built = new URL('.sim-camera/', import.meta.url)

try {
	execFileSync(
		process.execPath,
		[fileURLToPath(new URL('node_modules/typescript/bin/tsc', Root)), '-p', 'tools/sim-camera.tsconfig.json'],
		{ cwd: Root, stdio: 'inherit' },
	)
} catch {
	// tsc has said what's wrong.
	process.exit(1)
}

// The camera looks for captures beside itself.
cpSync(new URL('src/cameras/captures/', Root), new URL('cameras/captures/', Built), { recursive: true })

const { main } = await import(new URL('visca/__tests__/simulator/service.js', Built).href)
await main(process.argv.slice(2))
