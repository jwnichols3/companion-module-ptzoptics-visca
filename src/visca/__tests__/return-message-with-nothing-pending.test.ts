import { InstanceStatus } from '@companion-module/base'
import { describe, test } from 'vitest'
import { ExposureModeInquiry } from '../../camera/exposure.js'
import { FocusLock, FocusModeInquiry } from '../../camera/focus.js'
import {
	ACK,
	ACKCompletion,
	CommandBufferFullBytes,
	CommandNotExecutable,
	Completion,
	ExposureModeInquiryBytes,
	FocusLockBytes,
	FocusModeInquiryBytes,
	SyntaxErrorBytes,
} from './camera-interactions/bytes.js'
import {
	CameraExpectIncomingBytes,
	CameraReplyBytes,
	CameraReplyNetworkChange,
	CommandFailedFatally,
	CommandSucceeded,
	InquiryFailed,
	InquiryFailedFatally,
	InquirySucceeded,
	InstanceStatusIs,
	SendCommand,
	SendInquiry,
	WaitForLogMessage,
	WaitUntilConnectedToCamera,
} from './camera-interactions/interactions.js'
import {
	CompletionInEmptySocketMatcher,
	InquiryNotExecutableMatcher,
	MatchVISCABytes,
	NotExecutableWithNoCommandsMatcher,
} from './camera-interactions/matchers.js'
import { RunCameraInteractionTest } from './camera-interactions/run-test.js'

// A camera may send, on a new connection, its replies to messages it was sent
// on the connection before.  Seen 2026-11-27: cameras that close the
// connection every twelve hours, to the minute, then deliver on the next one
// the answers, or the Command Not Executable refusals of a camera in standby,
// to inquiries unanswered when they closed it.
//
// A return message that arrives while nothing at all awaits a response can't
// be the response to anything, so it's ignored, whatever kind it is.  With
// anything awaiting a response the rules are as they were.  (An inquiry
// response is covered in `unexpected-inquiry-response.test.ts`.)

const IgnoringUnsolicitedACKMatcher = /^Ignoring unsolicited ACK /
const IgnoringUnsolicitedCompletionMatcher = /^Ignoring unsolicited Completion /
const IgnoringUnsolicitedErrorMatcher = /^Ignoring unsolicited error response /

describe('return message with nothing pending', () => {
	test('ACK with nothing pending', async () => {
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				CameraReplyBytes(ACK(1)),
				WaitForLogMessage(IgnoringUnsolicitedACKMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				// Were the ACK kept for the command sent after it, the
				// command would be taken to execute in socket 1, not 2.
				SendCommand(FocusLock, 'focus-lock'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraReplyBytes(ACKCompletion(2)), // focus-lock
				CommandSucceeded('focus-lock'),
			],
			InstanceStatus.Ok,
		)
	})

	test('Completion with nothing pending', async () => {
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				CameraReplyNetworkChange([0xa0, 0x38, 0xff]), // not essential to this test: randomly added to tests
				CameraReplyBytes(Completion(1)),
				WaitForLogMessage(IgnoringUnsolicitedCompletionMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendCommand(FocusLock, 'focus-lock'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraReplyBytes(ACKCompletion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
			],
			InstanceStatus.Ok,
		)
	})

	test('Command Not Executable with nothing pending', async () => {
		// Were the refusal kept for the inquiry sent after it, that inquiry
		// would fail.
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				CameraReplyBytes(CommandNotExecutable(1)),
				WaitForLogMessage(IgnoringUnsolicitedErrorMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('Command Not Executable with nothing pending, past command and inquiry', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusLock, 'focus-lock'),
				SendInquiry(ExposureModeInquiry, 'exposure-mode'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraExpectIncomingBytes(ExposureModeInquiryBytes), // exposure-mode
				CameraReplyBytes(ACK(1)), // focus-lock
				CameraReplyBytes(CommandNotExecutable(1)), // exposure-mode
				InquiryFailed([InquiryNotExecutableMatcher, MatchVISCABytes(ExposureModeInquiryBytes)], 'exposure-mode'),
				CameraReplyBytes(Completion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
				CameraReplyBytes(CommandNotExecutable(1)),
				WaitForLogMessage(IgnoringUnsolicitedErrorMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendCommand(FocusLock, 'focus-lock-again'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock-again
				CameraReplyBytes(ACKCompletion(1)), // focus-lock-again
				CommandSucceeded('focus-lock-again'),
			],
			InstanceStatus.Ok,
		)
	})

	test.each([
		['Syntax Error', SyntaxErrorBytes],
		['Command Buffer Full', CommandBufferFullBytes],
		['unrecognized error', [0x90, 0x60, 0x17, 0xff]], // 17 not 41/03/02 as 60 requires
	])('%s with nothing pending', async (_name, error) => {
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				CameraReplyBytes(error),
				WaitForLogMessage(IgnoringUnsolicitedErrorMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendCommand(FocusLock, 'focus-lock'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraReplyBytes(ACKCompletion(1)), // focus-lock
				CommandSucceeded('focus-lock'),
			],
			InstanceStatus.Ok,
		)
	})

	test('leftover replies of every kind, one after another, with nothing pending', async () => {
		return RunCameraInteractionTest(
			[
				WaitUntilConnectedToCamera(),
				CameraReplyBytes([0x90, 0x50, 0x03, 0xff]),
				CameraReplyBytes(CommandNotExecutable(1)),
				CameraReplyBytes(ACK(1)),
				CameraReplyBytes(Completion(1)),
				WaitForLogMessage(IgnoringUnsolicitedCompletionMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes([0x90, 0x50, 0x02, 0xff]), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})
})

describe('return message that responds to nothing, with something pending', () => {
	// (An ACK with only an inquiry pending is covered in
	// `ack-without-pending-command.test.ts`, and an error other than Command
	// Not Executable with only a command waiting for completion in
	// `error-with-no-unacknowledged-commands.test.ts`.)

	test('Completion with only inquiry pending', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(Completion(1)),
				InquiryFailedFatally([CompletionInEmptySocketMatcher(1), MatchVISCABytes(Completion(1))], 'focus-mode'),
			],
			InstanceStatus.ConnectionFailure,
		)
	})

	test('Command Not Executable with only command waiting for completion', async () => {
		return RunCameraInteractionTest(
			[
				SendCommand(FocusLock, 'focus-lock'),
				CameraExpectIncomingBytes(FocusLockBytes), // focus-lock
				CameraReplyBytes(ACK(1)), // focus-lock
				CameraReplyBytes(CommandNotExecutable(1)),
				CommandFailedFatally(
					[NotExecutableWithNoCommandsMatcher, MatchVISCABytes(CommandNotExecutable(1))],
					'focus-lock',
				),
			],
			InstanceStatus.ConnectionFailure,
		)
	})
})
