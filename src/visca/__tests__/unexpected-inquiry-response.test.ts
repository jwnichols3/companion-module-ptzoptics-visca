import { InstanceStatus } from '@companion-module/base'
import { describe, test } from 'vitest'
import { FocusLock, FocusModeInquiry } from '../../camera/focus.js'
import { ACK, Completion, FocusLockBytes, FocusModeInquiryBytes } from './camera-interactions/bytes.js'
import {
	CameraExpectIncomingBytes,
	CameraReplyBytes,
	CameraReplyNetworkChange,
	CommandSucceeded,
	InquirySucceeded,
	InstanceStatusIs,
	SendCommand,
	SendInquiry,
	WaitForLogMessage,
	WaitUntilConnectedToCamera,
} from './camera-interactions/interactions.js'
import { RunCameraInteractionTest } from './camera-interactions/run-test.js'

const IgnoringUnsolicitedMatcher = /^Ignoring unsolicited inquiry response /

describe('no pending inquiry', () => {
	test('inquiry response with nothing pending', async () => {
		// A camera that has just powered on may answer an inquiry it was
		// sent while powering on.  The response reads as focus mode manual:
		// were it kept for the inquiry sent after it, that inquiry would
		// resolve manual, not auto.
		const InquiryResponse = [0x90, 0x50, 0x03, 0xff]
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				CameraReplyBytes(InquiryResponse),
				WaitForLogMessage(IgnoringUnsolicitedMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('inquiry response with nothing pending, past command and inquiry', async () => {
		const InquiryResponse = [0x90, 0x50, 0x03, 0xff]
		return RunCameraInteractionTest(
			[
				SendCommand(FocusLock, 'focus-lock'),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(ACK(1)), // focus-lock
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
				CameraReplyBytes(Completion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
				CameraReplyBytes(InquiryResponse),
				WaitForLogMessage(IgnoringUnsolicitedMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendInquiry(FocusModeInquiry, 'focus-mode-again'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode-again
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode-again
				InquirySucceeded({ mode: 'auto' }, 'focus-mode-again'),
			],
			InstanceStatus.Ok,
		)
	})

	// An inquiry response is never the response to a command.  So while no
	// inquiry is pending it's the response to nothing, whatever commands are
	// pending, and they go on to be acknowledged and completed.

	test('inquiry response with command waiting initial response', async () => {
		const InquiryResponse = [0x90, 0x50, 0x37 /* makes it an inquiry response */, 0xff]
		return RunCameraInteractionTest(
			[
				SendCommand(FocusLock, 'focus-lock'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraReplyBytes(InquiryResponse),
				WaitForLogMessage(IgnoringUnsolicitedMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				CameraReplyBytes(ACK(1)), // focus-lock
				CameraReplyBytes(Completion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
			],
			InstanceStatus.Ok,
		)
	})

	test('inquiry response with command waiting initial response, past inquiry', async () => {
		const InquiryResponse = [0x90, 0x50, 0x42 /* makes it an inquiry response */, 0xff]
		return RunCameraInteractionTest(
			[
				SendCommand(FocusLock, 'focus-lock'),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
				CameraReplyBytes(InquiryResponse),
				WaitForLogMessage(IgnoringUnsolicitedMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				CameraReplyBytes(ACK(1)), // focus-lock
				CameraReplyBytes(Completion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
			],
			InstanceStatus.Ok,
		)
	})

	test('inquiry response with only command waiting for completion', async () => {
		const InquiryResponse = [0x90, 0x50, 0x17 /* makes it an inquiry response */, 0xff]
		return RunCameraInteractionTest(
			[
				SendCommand(FocusLock, 'focus-lock'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraReplyBytes(ACK(1)), // focus-lock
				CameraReplyNetworkChange([0x90, 0x38, 0xff]), // not essential to this test: randomly added to tests
				CameraReplyBytes(InquiryResponse),
				WaitForLogMessage(IgnoringUnsolicitedMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				CameraReplyBytes(Completion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
			],
			InstanceStatus.Ok,
		)
	})
})
