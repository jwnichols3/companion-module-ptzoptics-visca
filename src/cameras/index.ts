import type { CameraDefinition } from './definition.js'
import { GenericVisca } from './generic-visca.js'
import { PtzOptics20xF64Hi } from './ptzoptics-20x-f64hi.js'

export type { CameraDefinition }
export { GenericVisca }

/** Every camera definition built into the module, in the order the connection settings list them. */
export const CameraDefinitions: readonly CameraDefinition[] = [GenericVisca, PtzOptics20xF64Hi]
