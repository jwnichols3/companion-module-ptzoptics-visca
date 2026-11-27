/**
 * What the module believes of how one camera model answers the status
 * inquiries the module can poll.
 *
 * A definition covers polling only: it never changes how commands are sent.
 * It is separate from the captures that back it, which record what a camera
 * of this model did.
 */
export type CameraDefinition = {
	/** Stored in the connection config to name this definition, so never changed. */
	readonly id: string

	/** Names the camera model in the connection settings. */
	readonly label: string

	/**
	 * The polled inquiries, by id, that the camera may answer while on.  An
	 * inquiry not listed is never sent.  One that is listed is still dropped
	 * if the camera turns out not to answer it.
	 */
	readonly supported: readonly string[]

	/**
	 * The polled inquiries, by id, that the camera still answers in standby:
	 * the only ones sent once it reports standby.
	 */
	readonly standby: readonly string[]

	/** Value ranges that vary by camera. */
	readonly ranges: {
		/** The zoom position of the telephoto end. */
		readonly zoomMax: number
	}

	/**
	 * How many milliseconds the camera may take, after it acknowledges being
	 * told to power on, to answer anything again.  A camera may answer nothing
	 * as it wakes, and may refuse connections.
	 */
	readonly wakeWindowMs: number

	/** Known oddities in how the camera answers, each with the capture that shows it. */
	readonly quirks: readonly {
		readonly name: string
		readonly capture: string
	}[]

	/**
	 * The captures that back this definition, as paths under `captures/`
	 * without the extension (`ptzoptics/on`).
	 */
	readonly captures: readonly string[]
}
