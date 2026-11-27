import { InstanceStatus } from '@companion-module/base'
import { describe, test } from 'vitest'
import { ExposureModeInquiry } from '../../camera/exposure.js'
import { FocusModeInquiry } from '../../camera/focus.js'
import { PanTiltPositionInquiry } from '../../camera/pan-tilt.js'
import {
	CommandNotExecutable,
	ExposureModeInquiryBytes,
	FocusModeInquiryBytes,
	PanTiltPositionInquiryBytes,
} from './camera-interactions/bytes.js'
import {
	AbandonInquiry,
	CameraExpectIncomingBytes,
	CameraReplyBytes,
	CameraReplyNetworkChange,
	CloseVISCAPortEarly,
	InquiryFailed,
	InquiryFailedFatally,
	InquirySucceeded,
	InstanceStatusIs,
	SendInquiry,
	WaitForLogMessage,
} from './camera-interactions/interactions.js'
import {
	AbandonedInquiryAmbiguousMatcher,
	AbandonedInquiryIgnoredMatcher,
	CloseVISCAPortEarlyMatcher,
	InquiryNotExecutableMatcher,
	InquiryResponseIncompatibleMatcher,
	MatchVISCABytes,
} from './camera-interactions/matchers.js'
import { RunCameraInteractionTest } from './camera-interactions/run-test.js'

// Some cameras send nothing at all in reply to an inquiry they don't have.
// Answers are matched to pending inquiries in order, so an inquiry the camera
// ignored would take the answer to the next inquiry sent.  A caller that has
// waited long enough on an inquiry can abandon it, then send another whose
// answer can't be mistaken for an answer to the abandoned one: the camera
// answers in order, so whichever answer comes first tells whether the
// abandoned inquiry was ignored or only answered late.

const PanTiltPositionAnswer = [0x90, 0x50, 0x0f, 0x0d, 0x0d, 0x0f, 0x0f, 0x0f, 0x0b, 0x0c, 0xff]
const FocusModeAuto = [0x90, 0x50, 0x02, 0xff]
const FocusModeManual = [0x90, 0x50, 0x03, 0xff]

const IgnoringUnsolicitedMatcher = /^Ignoring unsolicited inquiry response /

describe('abandoned inquiry', () => {
	test('ignored by the camera: the answer to the next inquiry is not taken for its answer', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				AbandonInquiry(PanTiltPositionInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquiryFailed([AbandonedInquiryIgnoredMatcher, MatchVISCABytes(PanTiltPositionInquiryBytes)], 'pan-tilt'),
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('answered late, before the next inquiry is answered: each inquiry is given its own answer', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				AbandonInquiry(PanTiltPositionInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(PanTiltPositionAnswer), // pan-tilt
				CameraReplyNetworkChange([0xb0, 0x38, 0xff]), // not essential to this test: randomly added to tests
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquirySucceeded({ panPosition: 0xfddf, tiltPosition: 0xffbc }, 'pan-tilt'),
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('answered late, with no inquiry sent after it: the answer is its answer', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				AbandonInquiry(FocusModeInquiry),
				CameraReplyBytes(FocusModeManual), // focus-mode
				InquirySucceeded({ mode: 'manual' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	// An answer that fits both the abandoned inquiry and the next one can't
	// be told for either's.  It's credited to neither.

	test('answer that could be its answer or the answer to the next inquiry: neither inquiry is given it', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(ExposureModeInquiry, 'exposure-mode'),
				CameraExpectIncomingBytes(ExposureModeInquiryBytes), // exposure-mode
				AbandonInquiry(ExposureModeInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				// Read as an exposure mode this is manual, and as a focus
				// mode manual too.
				CameraReplyBytes(FocusModeManual),
				InquiryFailed(
					[
						AbandonedInquiryAmbiguousMatcher,
						MatchVISCABytes(ExposureModeInquiryBytes),
						MatchVISCABytes(FocusModeManual),
					],
					'exposure-mode',
				),
				// Had that been the late answer to the abandoned inquiry,
				// the next inquiry's answer follows it.
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('answer that fits neither it nor the next inquiry: it fails, and the next inquiry is still answered', async () => {
		const ZoomPositionAnswer = [0x90, 0x50, 0x02, 0x08, 0x0f, 0x07, 0xff]
		return RunCameraInteractionTest(
			[
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				AbandonInquiry(PanTiltPositionInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(ZoomPositionAnswer), // pan-tilt
				InquiryFailed([InquiryResponseIncompatibleMatcher, MatchVISCABytes(ZoomPositionAnswer)], 'pan-tilt'),
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('refused late, before the next inquiry is answered: the refusal is its refusal', async () => {
		// A Command Not Executable doesn't say which inquiry it refuses, so
		// it's the oldest pending inquiry's, abandoned or not.
		return RunCameraInteractionTest(
			[
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				AbandonInquiry(PanTiltPositionInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(CommandNotExecutable(1)), // pan-tilt
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquiryFailed([InquiryNotExecutableMatcher, MatchVISCABytes(PanTiltPositionInquiryBytes)], 'pan-tilt'),
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('two abandoned and both ignored: the answer to the inquiry after them is not taken for the answer to either', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				AbandonInquiry(PanTiltPositionInquiry),
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt-again'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt-again
				AbandonInquiry(PanTiltPositionInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquiryFailed(AbandonedInquiryIgnoredMatcher, 'pan-tilt'),
				InquiryFailed(AbandonedInquiryIgnoredMatcher, 'pan-tilt-again'),
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	// Once the next inquiry has been answered, the abandoned one is settled
	// and no longer pending.  A camera that answers in order has no answer
	// left to send it.  Were one to come anyway, it's handled as any reply
	// that nothing asked for is.

	test('answered after the next inquiry was, with nothing pending: the answer is ignored', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(ExposureModeInquiry, 'exposure-mode'),
				CameraExpectIncomingBytes(ExposureModeInquiryBytes), // exposure-mode
				AbandonInquiry(ExposureModeInquiry),
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				CameraReplyBytes(PanTiltPositionAnswer), // pan-tilt
				InquiryFailed(AbandonedInquiryIgnoredMatcher, 'exposure-mode'),
				InquirySucceeded({ panPosition: 0xfddf, tiltPosition: 0xffbc }, 'pan-tilt'),
				// Read as a focus mode, the late answer is manual: were it
				// kept for the inquiry sent after it, that inquiry would
				// resolve manual, not auto.
				CameraReplyBytes([0x90, 0x50, 0x03, 0xff]), // exposure-mode
				WaitForLogMessage(IgnoringUnsolicitedMatcher),
				InstanceStatusIs(InstanceStatus.Ok),
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
			],
			InstanceStatus.Ok,
		)
	})

	test('answered after the next inquiry was, with an inquiry of another kind pending: the answer is not taken for the answer to that inquiry', async () => {
		const ExposureModeManual = [0x90, 0x50, 0x03, 0xff]
		return RunCameraInteractionTest(
			[
				SendInquiry(ExposureModeInquiry, 'exposure-mode'),
				CameraExpectIncomingBytes(ExposureModeInquiryBytes), // exposure-mode
				AbandonInquiry(ExposureModeInquiry),
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				CameraReplyBytes(PanTiltPositionAnswer), // pan-tilt
				InquiryFailed(AbandonedInquiryIgnoredMatcher, 'exposure-mode'),
				InquirySucceeded({ panPosition: 0xfddf, tiltPosition: 0xffbc }, 'pan-tilt'),
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt-again'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt-again
				CameraReplyBytes(ExposureModeManual), // exposure-mode
				InquiryFailed([InquiryResponseIncompatibleMatcher, MatchVISCABytes(ExposureModeManual)], 'pan-tilt-again'),
			],
			InstanceStatus.Ok,
		)
	})

	test('not pending: abandoning it does nothing', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(FocusModeInquiry, 'focus-mode'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode
				AbandonInquiry(ExposureModeInquiry),
				CameraReplyBytes(FocusModeAuto), // focus-mode
				InquirySucceeded({ mode: 'auto' }, 'focus-mode'),
				AbandonInquiry(FocusModeInquiry),
				SendInquiry(FocusModeInquiry, 'focus-mode-again'),
				CameraExpectIncomingBytes(FocusModeInquiryBytes), // focus-mode-again
				CameraReplyBytes(FocusModeManual), // focus-mode-again
				InquirySucceeded({ mode: 'manual' }, 'focus-mode-again'),
			],
			InstanceStatus.Ok,
		)
	})

	test('port closed while it is pending: it fails as any pending inquiry does', async () => {
		return RunCameraInteractionTest(
			[
				SendInquiry(PanTiltPositionInquiry, 'pan-tilt'),
				CameraExpectIncomingBytes(PanTiltPositionInquiryBytes), // pan-tilt
				AbandonInquiry(PanTiltPositionInquiry),
				CameraReplyNetworkChange([0xd0, 0x38, 0xff]), // not essential to this test: randomly added to tests
				CloseVISCAPortEarly(),
				InstanceStatusIs(InstanceStatus.Disconnected),
				InquiryFailedFatally(CloseVISCAPortEarlyMatcher, 'pan-tilt'),
			],
			InstanceStatus.Disconnected,
		)
	})
})
