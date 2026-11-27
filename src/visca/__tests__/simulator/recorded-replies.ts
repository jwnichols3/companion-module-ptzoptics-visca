import { CommandNotExecutable, SyntaxErrorBytes } from '../camera-interactions/bytes.js'
import type { CameraReplies } from './simulated-camera.js'

export const PowerInquiryBytes = [0x81, 0x09, 0x04, 0x00, 0xff]
const PanTiltPositionInquiryBytes = [0x81, 0x09, 0x06, 0x12, 0xff]
const ZoomPositionInquiryBytes = [0x81, 0x09, 0x04, 0x47, 0xff]
const FocusPositionInquiryBytes = [0x81, 0x09, 0x04, 0x48, 0xff]
const FocusModeInquiryBytes = [0x81, 0x09, 0x04, 0x38, 0xff]

/**
 * Replies observed from PTZOptics cameras: powered on (2026-11-22) and in
 * standby (2026-11-25).
 */
export const RecordedReplies: CameraReplies = {
	on: {
		replies: [
			{ inquiry: PowerInquiryBytes, reply: [0x90, 0x50, 0x02, 0xff] },
			{
				inquiry: PanTiltPositionInquiryBytes,
				reply: [0x90, 0x50, 0x0f, 0x0d, 0x0d, 0x0f, 0x0f, 0x0f, 0x0b, 0x0c, 0xff],
			},
			{ inquiry: ZoomPositionInquiryBytes, reply: [0x90, 0x50, 0x02, 0x08, 0x0f, 0x07, 0xff] },
			{ inquiry: FocusPositionInquiryBytes, reply: [0x90, 0x50, 0x00, 0x07, 0x07, 0x02, 0xff] },
			{ inquiry: FocusModeInquiryBytes, reply: [0x90, 0x50, 0x02, 0xff] },
		],
		otherwise: SyntaxErrorBytes,
	},
	standby: {
		replies: [
			{ inquiry: PowerInquiryBytes, reply: [0x90, 0x50, 0x03, 0xff] },
			{ inquiry: PanTiltPositionInquiryBytes, reply: CommandNotExecutable(1) },
			{ inquiry: ZoomPositionInquiryBytes, reply: CommandNotExecutable(1) },
		],
		// Only the inquiries above were recorded in standby.  Assume the camera
		// refuses every other inquiry the same way.
		otherwise: CommandNotExecutable(1),
	},
}
