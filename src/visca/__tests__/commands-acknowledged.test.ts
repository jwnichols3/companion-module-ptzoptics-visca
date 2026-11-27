import { InstanceStatus, TCPHelper } from '@companion-module/base'
import { afterEach, describe, test, vi } from 'vitest'
import { FocusFarStandard, FocusModeInquiry, FocusNearStandard } from '../../camera/focus.js'
import {
	ACK,
	CommandNotExecutable,
	Completion,
	FocusFarStandardBytes,
	FocusModeInquiryBytes,
	FocusNearStandardBytes,
} from './camera-interactions/bytes.js'
import {
	CameraExpectIncomingBytes,
	CameraReplyBytes,
	CloseVISCAPortEarly,
	CommandFailed,
	CommandFailedFatally,
	CommandsAcknowledged,
	CommandsNotAcknowledged,
	CommandSucceeded,
	InquirySucceeded,
	SendCommand,
	SendInquiry,
	WaitUntilConnectedToCamera,
} from './camera-interactions/interactions.js'
import {
	CantBeExecutedNowMatcher,
	CloseVISCAPortEarlyMatcher,
	MatchVISCABytes,
} from './camera-interactions/matchers.js'
import { RunCameraInteractionTest } from './camera-interactions/run-test.js'

describe('commands acknowledged', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	test('no command sent', async () => {
		return RunCameraInteractionTest([WaitUntilConnectedToCamera(), CommandsAcknowledged()], InstanceStatus.Ok)
	})

	test('only an inquiry pending', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CommandsAcknowledged(),
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('command passed in before the connection is established', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusNearStandard, 'focus-near'),
				CommandsNotAcknowledged(),
				CameraExpectIncomingBytes(FocusNearStandardBytes), // focus-near
				CameraReplyBytes(ACK(1)), // focus-near
				CommandsAcknowledged(),
				CameraReplyBytes(Completion(1)), // focus-near
				CommandSucceeded('focus-near'),
			],
			InstanceStatus.Ok,
		)
	})

	test('acknowledged by ACK, before Completion', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusNearStandard, 'focus-near'),
				CameraExpectIncomingBytes(FocusNearStandardBytes), // focus-near
				CommandsNotAcknowledged(),
				CameraReplyBytes(ACK(1)), // focus-near
				CommandsAcknowledged(),
				CameraReplyBytes(Completion(1)), // focus-near
				CommandSucceeded('focus-near'),
				CommandsAcknowledged(),
			],
			InstanceStatus.Ok,
		)
	})

	test('acknowledged by an error', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusNearStandard, 'focus-near'),
				CameraExpectIncomingBytes(FocusNearStandardBytes), // focus-near
				CommandsNotAcknowledged(),
				CameraReplyBytes(CommandNotExecutable(1)), // focus-near
				CommandFailed([CantBeExecutedNowMatcher, MatchVISCABytes(FocusNearStandardBytes)], 'focus-near'),
				CommandsAcknowledged(),
			],
			InstanceStatus.Ok,
		)
	})

	test('two commands: not until both are acknowledged', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusNearStandard, 'focus-near'),
				SendCommand(FocusFarStandard, 'focus-far'),
				CameraExpectIncomingBytes(FocusNearStandardBytes), // focus-near
				CameraExpectIncomingBytes(FocusFarStandardBytes), // focus-far
				CameraReplyBytes(ACK(1)), // focus-near
				CameraReplyBytes(Completion(1)), // focus-near
				CommandSucceeded('focus-near'),
				CommandsNotAcknowledged(),
				CameraReplyBytes(ACK(2)), // focus-far
				CommandsAcknowledged(),
				CameraReplyBytes(Completion(2)), // focus-far
				CommandSucceeded('focus-far'),
			],
			InstanceStatus.Ok,
		)
	})

	test('command pending behind an inquiry', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				SendCommand(FocusNearStandard, 'focus-near'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraExpectIncomingBytes(FocusNearStandardBytes), // focus-near
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
				CommandsNotAcknowledged(),
				CameraReplyBytes(ACK(1)), // focus-near
				CommandsAcknowledged(),
				CameraReplyBytes(Completion(1)), // focus-near
				CommandSucceeded('focus-near'),
			],
			InstanceStatus.Ok,
		)
	})

	test('port closed with a command unacknowledged', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusNearStandard, 'focus-near'),
				SendCommand(FocusFarStandard, 'focus-far'),
				CameraExpectIncomingBytes(FocusNearStandardBytes), // focus-near
				CameraExpectIncomingBytes(FocusFarStandardBytes), // focus-far
				CommandsNotAcknowledged(),
				CameraReplyBytes(ACK(2)), // focus-near
				CloseVISCAPortEarly(),
				CommandFailedFatally(CloseVISCAPortEarlyMatcher, 'focus-near'),
				CommandFailedFatally(CloseVISCAPortEarlyMatcher, 'focus-far'),
				CommandsAcknowledged(),
			],
			InstanceStatus.Disconnected,
		)
	})

	test("command whose bytes couldn't be written", async () => {
		// Writing to the socket can fail without the connection having been
		// seen to close yet.
		vi.spyOn(TCPHelper.prototype, 'send').mockRejectedValueOnce(new Error('write EPIPE'))
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				SendCommand(FocusNearStandard, 'focus-near'),
				CommandFailedFatally('write EPIPE', 'focus-near'),
				CommandsAcknowledged(),
				SendCommand(FocusFarStandard, 'focus-far'),
				CameraExpectIncomingBytes(FocusFarStandardBytes), // focus-far
				CommandsNotAcknowledged(),
				CameraReplyBytes(ACK(1)), // focus-far
				CommandsAcknowledged(),
				CameraReplyBytes(Completion(1)), // focus-far
				CommandSucceeded('focus-far'),
			],
			InstanceStatus.Ok,
		)
	})
})
