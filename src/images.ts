// Images in a decision call. Each image is sent once, base64-encoded in the
// request's top-level `assets` map, and stands in the state, an instruction or
// a criterion as its reference string:
// https://docs.typesafe.ai/images

export type DecisionImageFormat = 'png' | 'jpg'

/** Every reference starts with this, so a reference without its image can be caught. */
const REFERENCE_PREFIX = 'decision-api-image-'
const REFERENCE_PATTERN = new RegExp(
	`${REFERENCE_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
	'g'
)

/**
 * A PNG or JPEG image, created by `image()`. Put it wherever text can go: as
 * (part of) the state, a question's instructions or a criterion. Inside a
 * sentence, write it into a `withImages` template.
 */
export class DecisionImage {
	readonly type = 'image'
	/** The text the image is sent under; what `String(image)` and `JSON.stringify` write. */
	readonly reference = `${REFERENCE_PREFIX}${uuid()}`
	readonly format: DecisionImageFormat
	private bytes: Uint8Array | undefined
	private encoded: string | undefined

	constructor(data: ArrayBuffer | ArrayBufferView | string) {
		if (typeof data === 'string') {
			// A data URL's prefix is dropped; the API wants the bare base64.
			const base64 = data.replace(/^data:image\/[a-z]+;base64,/, '')
			if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
				throw new TypeError('image() needs padded standard base64')
			}
			this.encoded = base64
			this.format = formatOfBase64(base64)
		} else {
			this.bytes = ArrayBuffer.isView(data)
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data)
			this.format = formatOfBytes(this.bytes)
		}
	}

	/** The file in standard base64, encoded once on first use. */
	get base64(): string {
		if (this.encoded === undefined && this.bytes) {
			this.encoded = toBase64(this.bytes)
			this.bytes = undefined
		}
		return this.encoded ?? ''
	}

	toString() {
		return this.reference
	}

	toJSON() {
		return this.reference
	}
}

/** Text from a `withImages` template: the images in it travel with the request. */
export class DecisionImageText {
	constructor(
		readonly text: string,
		readonly images: readonly DecisionImage[]
	) {}

	toString() {
		return this.text
	}

	toJSON() {
		return this.text
	}
}

/** Text, an image on its own, or text with images in it: whatever a model may read. */
export type DecisionText = string | DecisionImage | DecisionImageText

/**
 * A PNG or JPEG image to put in a call, from its file bytes or base64 (a
 * `data:` URL works too). Only models with `images: true` in
 * `DECISION_MODELS` read images.
 *
 * Throws when the data is not a PNG or JPEG file. The provider rejects, never
 * resizes, an image outside its limits: for Jev, 280 to 1568 px a side and at
 * most 16 MiB, with EXIF orientation ignored, so rotate and scale first.
 */
export function image(data: ArrayBuffer | ArrayBufferView | string) {
	return new DecisionImage(data)
}

/**
 * Tag a template whose text names images, so they are sent with it:
 * withImages`Is the person in \`door\` the one on this badge: ${badge}?`
 * A plain template would carry the reference without the image, and the call
 * answers `null` (`image-detached`) rather than ask about a bare string.
 */
export function withImages(
	strings: TemplateStringsArray,
	...values: unknown[]
): DecisionImageText {
	const images: DecisionImage[] = []
	let text = strings[0] ?? ''
	values.forEach((value, index) => {
		if (value instanceof DecisionImage) images.push(value)
		if (value instanceof DecisionImageText) images.push(...value.images)
		text += String(value) + (strings[index + 1] ?? '')
	})
	return new DecisionImageText(text, images)
}

/** Every image in a value, once each, keyed by its reference. Object keys stay text. */
export function collectImages(
	value: unknown,
	into = new Map<string, DecisionImage>()
) {
	if (value instanceof DecisionImage) {
		into.set(value.reference, value)
	} else if (value instanceof DecisionImageText) {
		for (const item of value.images) into.set(item.reference, item)
	} else if (Array.isArray(value)) {
		for (const item of value) collectImages(item, into)
	} else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectImages(item, into)
	}
	return into
}

/** A reference written into the text whose image was not sent with it, if any. */
export function detachedReference(
	text: string,
	images: ReadonlyMap<string, DecisionImage>
) {
	if (!text.includes(REFERENCE_PREFIX)) return undefined
	return text.match(REFERENCE_PATTERN)?.find((found) => !images.has(found))
}

/** The `assets` map TypeSafe's API (and OpenRouter's, for Jev) reads. */
export function toAssets(images: Iterable<DecisionImage>) {
	return Object.fromEntries(
		Array.from(images, (item) => [
			item.reference,
			{ type: 'image', format: item.format, data_base64: item.base64 }
		])
	)
}

function formatOfBytes(bytes: Uint8Array): DecisionImageFormat {
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (png.every((byte, index) => bytes[index] === byte)) return 'png'
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
	throw new TypeError('image() takes PNG or JPEG files only')
}

/** The same magic numbers, as they start a base64 string. */
function formatOfBase64(base64: string): DecisionImageFormat {
	if (base64.startsWith('iVBORw0KGgo')) return 'png'
	if (base64.startsWith('/9j/')) return 'jpg'
	throw new TypeError('image() takes PNG or JPEG files only')
}

function toBase64(bytes: Uint8Array) {
	// In slices, because spreading megabytes into one call overflows the stack.
	let binary = ''
	for (let start = 0; start < bytes.length; start += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
	}
	return btoa(binary)
}

/** `crypto.randomUUID` where the runtime has it (Node 18 and React Native may not). */
function uuid() {
	const random = globalThis.crypto as Partial<Crypto> | undefined
	if (random?.randomUUID) return random.randomUUID()
	const hex = Array.from({ length: 32 }, () =>
		Math.floor(Math.random() * 16).toString(16)
	).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}
