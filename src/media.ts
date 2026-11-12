// Images, video, audio and PDFs in a decision call. Each file stands in the
// state, an instruction or a criterion as its reference string and is sent
// once beside them: in TypeSafe's top-level `assets` map for images
// (https://docs.typesafe.ai/images), or as a content block in Gemini's `input`
// (https://aistudio.google.com/docs/decisions-api).

export type DecisionMediaKind = 'image' | 'video' | 'audio' | 'pdf'

export type DecisionImageFormat = 'png' | 'jpg'

/** Gemini's detail levels: more detail costs more input tokens. */
export type DecisionVideoResolution = 'low' | 'medium' | 'high'
export type DecisionImageResolution = DecisionVideoResolution | 'ultra_high'

/** A file's bytes, its standard base64, or a `data:` URL. */
export type DecisionMediaData = ArrayBuffer | ArrayBufferView | string

/** A file the provider fetches itself: an HTTPS URL or a Gemini Files API URI. */
export type DecisionMediaUri = { uri: string; mimeType: string }

/** Every reference starts with this, so a reference without its file can be caught. */
const REFERENCE_PREFIX = 'decision-api-'
const REFERENCE_PATTERN = new RegExp(
	`${REFERENCE_PREFIX}(?:image|video|audio|pdf)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
	'g'
)

type Source =
	| { bytes: Uint8Array }
	| { base64: string }
	| { uri: string; mimeType: string }

/**
 * A file in a call, created by `image()`, `video()`, `audio()` or `pdf()`.
 * Put it wherever text can go: as (part of) the state, a question's
 * instructions or a criterion. Inside a sentence, write it into a `withMedia`
 * template.
 */
export class DecisionMedia<Kind extends DecisionMediaKind = DecisionMediaKind> {
	/** The text the file is sent under; what `String(media)` and `JSON.stringify` write. */
	readonly reference: string
	readonly mimeType: string
	/** Set when the provider fetches the file itself instead of receiving its bytes. */
	readonly uri: string | undefined
	private bytes: Uint8Array | undefined
	private encoded: string | undefined

	constructor(
		readonly kind: Kind,
		source: Source,
		mimeType: string,
		readonly resolution?: DecisionImageResolution
	) {
		this.reference = `${REFERENCE_PREFIX}${kind}-${uuid()}`
		this.mimeType = mimeType
		this.uri = 'uri' in source ? source.uri : undefined
		this.bytes = 'bytes' in source ? source.bytes : undefined
		this.encoded = 'base64' in source ? source.base64 : undefined
	}

	/** The file in standard base64, encoded once on first use; empty for a URI. */
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

/** A PNG or JPEG image, created by `image()`. */
export class DecisionImage extends DecisionMedia<'image'> {
	readonly type = 'image'
	readonly format: DecisionImageFormat

	constructor(
		data: DecisionMediaData,
		options: { resolution?: DecisionImageResolution } = {}
	) {
		const source = sourceOf(data)
		const format = formatOf(headOf(source))
		super(
			'image',
			source,
			format === 'png' ? 'image/png' : 'image/jpeg',
			options.resolution
		)
		this.format = format
	}
}

export type DecisionVideo = DecisionMedia<'video'>
export type DecisionAudio = DecisionMedia<'audio'>
export type DecisionPdf = DecisionMedia<'pdf'>

/** Text from a `withMedia` template: the files in it travel with the request. */
export class DecisionMediaText<
	Kind extends DecisionMediaKind = DecisionMediaKind
> {
	constructor(
		readonly text: string,
		readonly media: readonly DecisionMedia<Kind>[]
	) {}

	/** @deprecated The same list as `media`, under its name from before video, audio and PDFs. */
	get images() {
		return this.media
	}

	toString() {
		return this.text
	}

	toJSON() {
		return this.text
	}
}

export type DecisionImageText = DecisionMediaText<'image'>

/** Text, a file on its own, or text with files in it: whatever a model may read. */
export type DecisionText = string | DecisionMedia | DecisionMediaText

/**
 * A PNG or JPEG image to put in a call, from its file bytes or base64 (a
 * `data:` URL works too). Only models with `images: true` in
 * `DECISION_MODELS` read images. `resolution` is Gemini's detail level;
 * TypeSafe ignores it.
 *
 * Throws when the data is not a PNG or JPEG file. The provider rejects, never
 * resizes, an image outside its limits: for Jev, 280 to 1568 px a side and at
 * most 16 MiB, with EXIF orientation ignored, so rotate and scale first.
 */
export function image(
	data: DecisionMediaData,
	options?: { resolution?: DecisionImageResolution }
) {
	return new DecisionImage(data, options)
}

/**
 * A video, from its bytes, base64 or `{ uri, mimeType }`. MP4, MOV, 3GP,
 * WebM, AVI, FLV, WMV and MPEG are recognised from their bytes; pass
 * `mimeType` for anything else. Only models with `video: true` in
 * `DECISION_MODELS` read video (`gemini-decision-1`), and frames count as
 * image tokens. A long video takes longer than the default 4 s `timeoutMs`.
 */
export function video(
	data: DecisionMediaData | DecisionMediaUri,
	options: { mimeType?: string; resolution?: DecisionVideoResolution } = {}
): DecisionVideo {
	const [source, mimeType] = mediaSource(
		'video',
		data,
		options.mimeType,
		videoType
	)
	return new DecisionMedia('video', source, mimeType, options.resolution)
}

/**
 * Audio, from its bytes, base64 or `{ uri, mimeType }`. WAV, MP3, AAC, Ogg,
 * FLAC, AIFF and WebM are recognised from their bytes; pass `mimeType` for
 * anything else (such as `audio/m4a` or raw `audio/l16`). Only models with
 * `audio: true` in `DECISION_MODELS` read audio (`gemini-decision-1`).
 */
export function audio(
	data: DecisionMediaData | DecisionMediaUri,
	options: { mimeType?: string } = {}
): DecisionAudio {
	const [source, mimeType] = mediaSource(
		'audio',
		data,
		options.mimeType,
		audioType
	)
	return new DecisionMedia('audio', source, mimeType)
}

/**
 * A PDF, from its bytes, base64 or `{ uri }`. Only models with `pdf: true` in
 * `DECISION_MODELS` read PDFs (`gemini-decision-1`), and pages count as image
 * tokens.
 */
export function pdf(
	data: DecisionMediaData | { uri: string; mimeType?: string }
): DecisionPdf {
	const [source, mimeType] = mediaSource(
		'pdf',
		typeof data === 'object' && 'uri' in data
			? { uri: data.uri, mimeType: data.mimeType ?? PDF_TYPE }
			: data,
		undefined,
		(head) => (ascii(head, 0, 5) === '%PDF-' ? PDF_TYPE : undefined)
	)
	return new DecisionMedia('pdf', source, mimeType)
}

type KindOf<Value> =
	Value extends DecisionMedia<infer Kind>
		? Kind
		: Value extends DecisionMediaText<infer Kind>
			? Kind
			: never

/**
 * Tag a template whose text names files, so they are sent with it:
 * withMedia`Is the person in \`door\` the one on this badge: ${badge}?`
 * A plain template would carry the reference without the file, and the call
 * answers `null` (`image-detached`) rather than ask about a bare string.
 */
export function withMedia<const Values extends unknown[]>(
	strings: TemplateStringsArray,
	...values: Values
): DecisionMediaText<KindOf<Values[number]>> {
	const media: DecisionMedia[] = []
	let text = strings[0] ?? ''
	values.forEach((value, index) => {
		if (value instanceof DecisionMedia) media.push(value)
		if (value instanceof DecisionMediaText) media.push(...value.media)
		text += String(value) + (strings[index + 1] ?? '')
	})
	return new DecisionMediaText(
		text,
		media as DecisionMedia<KindOf<Values[number]>>[]
	)
}

/** The same tag as `withMedia`, under the name it had when only images existed. */
export const withImages = withMedia

/** Every file in a value, once each, keyed by its reference. Object keys stay text. */
export function collectMedia(
	value: unknown,
	into = new Map<string, DecisionMedia>()
) {
	if (value instanceof DecisionMedia) {
		into.set(value.reference, value)
	} else if (value instanceof DecisionMediaText) {
		for (const item of value.media) into.set(item.reference, item)
	} else if (Array.isArray(value)) {
		for (const item of value) collectMedia(item, into)
	} else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectMedia(item, into)
	}
	return into
}

/** A reference written into the text whose file was not sent with it, if any. */
export function detachedReference(
	text: string,
	media: ReadonlyMap<string, DecisionMedia>
) {
	if (!text.includes(REFERENCE_PREFIX)) return undefined
	return text.match(REFERENCE_PATTERN)?.find((found) => !media.has(found))
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

const PDF_TYPE = 'application/pdf'

function mediaSource(
	kind: Exclude<DecisionMediaKind, 'image'>,
	data: DecisionMediaData | DecisionMediaUri,
	mimeType: string | undefined,
	recognise: (head: Uint8Array) => string | undefined
): [Source, string] {
	const name = `${kind}()`
	let source: Source
	if (typeof data === 'object' && 'uri' in data) {
		if (!/^https:\/\//.test(data.uri)) {
			throw new TypeError(`${name} takes an HTTPS URL or a Files API URI`)
		}
		source = data
		mimeType ??= data.mimeType
	} else {
		source = sourceOf(data)
	}
	const type = mimeType ?? recognise(headOf(source))
	if (!type) {
		throw new TypeError(`${name} does not recognise this file; pass mimeType`)
	}
	const expected = kind === 'pdf' ? PDF_TYPE : `${kind}/`
	if (kind === 'pdf' ? type !== PDF_TYPE : !type.startsWith(expected)) {
		throw new TypeError(`${name} needs a ${expected} type, not ${type}`)
	}
	return [source, type]
}

function sourceOf(data: DecisionMediaData): Source {
	if (typeof data !== 'string') {
		return {
			bytes: ArrayBuffer.isView(data)
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data)
		}
	}
	// A data URL's prefix is dropped; the APIs want the bare base64.
	const base64 = data.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/, '')
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
		throw new TypeError('Media needs padded standard base64')
	}
	return { base64 }
}

/** The first bytes of a file, where its format's magic numbers are. */
function headOf(source: Source): Uint8Array {
	if ('bytes' in source) return source.bytes.subarray(0, 16)
	if ('base64' in source) {
		const binary = atob(source.base64.slice(0, 24))
		return Uint8Array.from(binary, (char) => char.charCodeAt(0))
	}
	return new Uint8Array()
}

function ascii(head: Uint8Array, from: number, to: number) {
	return String.fromCharCode(...head.subarray(from, to))
}

function formatOf(head: Uint8Array): DecisionImageFormat {
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (png.every((byte, index) => head[index] === byte)) return 'png'
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
	throw new TypeError('image() takes PNG or JPEG files only')
}

const EBML = [0x1a, 0x45, 0xdf, 0xa3]
const startsWith = (head: Uint8Array, bytes: number[]) =>
	bytes.every((byte, index) => head[index] === byte)

/** Video types as Gemini names them (`video/mov`, `video/avi`, `video/wmv`). */
function videoType(head: Uint8Array) {
	if (ascii(head, 4, 8) === 'ftyp') {
		const brand = ascii(head, 8, 12)
		if (brand === 'qt  ') return 'video/mov'
		if (brand.startsWith('3g')) return 'video/3gpp'
		return 'video/mp4'
	}
	if (startsWith(head, EBML)) return 'video/webm'
	if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'AVI ') {
		return 'video/avi'
	}
	if (ascii(head, 0, 3) === 'FLV') return 'video/x-flv'
	if (startsWith(head, [0x30, 0x26, 0xb2, 0x75])) return 'video/wmv'
	if (startsWith(head, [0, 0, 1]) && (head[3] === 0xba || head[3] === 0xb3)) {
		return 'video/mpeg'
	}
	return undefined
}

function audioType(head: Uint8Array) {
	const tag = ascii(head, 0, 4)
	if (tag === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return 'audio/wav'
	if (tag === 'FORM' && /^AIF[FC]$/.test(ascii(head, 8, 12))) {
		return 'audio/aiff'
	}
	if (tag === 'OggS') return 'audio/ogg'
	if (tag === 'fLaC') return 'audio/flac'
	if (startsWith(head, EBML)) return 'audio/webm'
	if (ascii(head, 0, 3) === 'ID3') return 'audio/mp3'
	const second = head[1] ?? 0
	// ADTS (AAC) and MPEG audio frames share the 0xFFF sync; AAC's layer is 0.
	if (head[0] === 0xff && (second & 0xf6) === 0xf0) return 'audio/aac'
	if (head[0] === 0xff && (second & 0xe0) === 0xe0) return 'audio/mp3'
	return undefined
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
