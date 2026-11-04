import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import {
	createDecisionApi,
	type DecisionError,
	type DecisionQuestion,
	image,
	withImages
} from './index.ts'

// The magic numbers are all `image()` reads; the rest stands in for pixels.
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02
])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

const KEYS = {
	typesafe: 'typesafe-key',
	cloudflare: { apiToken: 'cloudflare-token', accountId: 'account-1' },
	openrouter: 'openrouter-key'
}

type Sent = {
	url: string
	headers: Headers
	body: {
		state: unknown
		questions: Record<string, { instructions: unknown; criteria?: unknown }>
		assets?: Record<string, unknown>
	}
}

function capture(answers: unknown) {
	const sent: Sent[] = []
	spyOn(globalThis, 'fetch').mockImplementation((async (
		url: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => {
		sent.push({
			url: String(url),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body))
		})
		return Response.json({
			answers,
			usage: { input_tokens: 1500, output_tokens: 0 }
		})
	}) as typeof fetch)
	return sent
}

function decideReporting() {
	const onError = mock((_error: DecisionError, _context: object) => {})
	const decide = createDecisionApi({ keys: KEYS, defaultModel: 'jev', onError })
	return { decide, onError }
}

afterEach(() => {
	spyOn(globalThis, 'fetch').mockRestore()
})

test('Jev gets each image once in assets, referenced from state, instructions and criteria', async () => {
	const sent = capture({
		same: { type: 'noul', noul: 0.8 },
		gesture: {
			type: 'choice',
			choice: 'thumbs_up',
			confidence: 0.9,
			probabilities: { thumbs_up: 0.9, none: 0.1 }
		}
	})
	const door = image(PNG)
	const badge = image(JPEG)
	const thumb = image(PNG)
	const { decide } = decideReporting()

	const answers = await decide({
		state: { door, note: 'front door camera' },
		questions: {
			same: {
				type: 'noul',
				instructions: withImages`Is the person in \`door\` the one on this badge: ${badge}?`
			},
			gesture: {
				type: 'choice',
				instructions: 'Which gesture does the hand in `door` make?',
				// The same image twice is still one asset.
				criteria: { thumbs_up: thumb, none: withImages`Not ${thumb}` }
			}
		}
	})

	expect(answers?.gesture.choice).toBe('thumbs_up')
	const [request] = sent
	expect(request?.headers.get('typesafe-danger-zone-images')).toBe('true')
	expect(request?.body.state).toEqual({
		door: door.reference,
		note: 'front door camera'
	})
	expect(request?.body.questions.same?.instructions).toBe(
		`Is the person in \`door\` the one on this badge: ${badge.reference}?`
	)
	expect(request?.body.questions.gesture?.criteria).toEqual({
		thumbs_up: thumb.reference,
		none: `Not ${thumb.reference}`
	})
	expect(request?.body.assets).toEqual({
		[door.reference]: {
			type: 'image',
			format: 'png',
			data_base64: Buffer.from(PNG).toString('base64')
		},
		[badge.reference]: {
			type: 'image',
			format: 'jpg',
			data_base64: Buffer.from(JPEG).toString('base64')
		},
		[thumb.reference]: {
			type: 'image',
			format: 'png',
			data_base64: Buffer.from(PNG).toString('base64')
		}
	})
})

test('a text-only call carries no assets and no image header', async () => {
	const sent = capture({ refund: { type: 'noul', noul: 0.5 } })
	const { decide } = decideReporting()

	await decide({
		state: 'I was charged twice',
		questions: { refund: { type: 'noul', instructions: 'Refund?' } }
	})

	expect(sent[0]?.body).not.toHaveProperty('assets')
	expect(sent[0]?.headers.has('typesafe-danger-zone-images')).toBe(false)
})

test('Jev on OpenRouter gets the same assets, without TypeSafe header', async () => {
	const sent = capture({ damaged: { type: 'noul', noul: 0.2 } })
	const photo = image(Buffer.from(PNG).toString('base64'))
	const { decide } = decideReporting()

	await decide(
		{
			state: photo,
			questions: { damaged: { type: 'noul', instructions: 'Is it damaged?' } }
		},
		'typesafe/jev-1.13'
	)

	expect(sent[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
	expect(sent[0]?.headers.has('typesafe-danger-zone-images')).toBe(false)
	expect(sent[0]?.body.state).toBe(photo.reference)
	expect(Object.keys(sent[0]?.body.assets ?? {})).toEqual([photo.reference])
})

test('a model that reads no images is never sent one', async () => {
	const sent = capture({})
	const { decide, onError } = decideReporting()
	// Typed as any question, so only the call can tell an image is in it.
	const questions: Record<string, DecisionQuestion> = {
		damaged: { type: 'noul', instructions: image(PNG) }
	}

	expect(await decide({ state: 'listing', questions }, 'clef')).toBeNull()
	expect(sent).toHaveLength(0)
	expect(onError.mock.calls[0]?.[0]).toMatchObject({
		kind: 'images-unsupported',
		model: 'clef'
	})
})

test('a reference written without withImages fails instead of sending a bare string', async () => {
	const sent = capture({})
	const { decide, onError } = decideReporting()
	const badge = image(JPEG)

	const answers = await decide({
		state: 'door camera',
		questions: {
			same: { type: 'noul', instructions: `Same person as ${badge}?` }
		}
	})

	expect(answers).toBeNull()
	expect(sent).toHaveLength(0)
	expect(onError.mock.calls[0]?.[0].kind).toBe('image-detached')
})

test('image() reads PNG and JPEG from bytes, base64 or a data URL, and nothing else', () => {
	const base64 = Buffer.from(JPEG).toString('base64')
	expect(image(PNG.buffer).format).toBe('png')
	expect(image(new DataView(JPEG.buffer)).format).toBe('jpg')
	expect(image(`data:image/jpeg;base64,${base64}`).base64).toBe(base64)
	expect(() => image(new TextEncoder().encode('GIF89a'))).toThrow('PNG or JPEG')
	expect(() => image('not base64!')).toThrow('base64')
})

test('a large image encodes to the same base64 as Buffer', () => {
	const bytes = new Uint8Array(200_003)
	bytes.set(PNG)
	for (let index = PNG.length; index < bytes.length; index++) {
		bytes[index] = (index * 31) % 256
	}
	expect(image(bytes).base64).toBe(Buffer.from(bytes).toString('base64'))
})

// Compile-time only: an image the types can see needs a model that reads images.
function typeChecks() {
	const decide = createDecisionApi({ keys: KEYS })
	const photo = image(PNG)
	const noul = { type: 'noul', instructions: 'Damaged?' } as const

	decide({ state: { photo }, questions: { noul } }, 'jev')
	// @ts-expect-error Clef reads no images
	decide({ state: { photo }, questions: { noul } }, 'clef')
	decide(
		{
			state: 'listing',
			questions: {
				same: { type: 'noul', instructions: withImages`Same as ${photo}?` }
			}
		},
		// @ts-expect-error an image in the instructions counts too
		'microsoft/microsoft-decision-1'
	)
	decide({ state: ['Listing photo:', photo], questions: { noul } }, 'jev')

	// Broad types say nothing either way, so these stay open to every model.
	const questions: Record<string, DecisionQuestion> = { noul }
	decide({ state: 'listing', questions }, 'clef')
	type Json = string | number | Json[] | { [key: string]: Json }
	const state: Json = { nested: [{ deeper: ['x'] }] }
	decide({ state, questions: { noul } }, 'clef')

	// A default that reads images keeps the model optional.
	const withDefault = createDecisionApi({ keys: KEYS, defaultModel: 'jev' })
	withDefault({ state: photo, questions: { noul } })
	const clefDefault = createDecisionApi({ keys: KEYS, defaultModel: 'clef' })
	// @ts-expect-error the default reads no images, so name one that does
	clefDefault({ state: photo, questions: { noul } })
}
void typeChecks
