// Every decision model, the provider that serves it, what it costs, and how
// that provider's wire format maps onto the shared question shapes
// (`questions.ts`).

import { z } from 'zod'
import {
	DecisionImage,
	type DecisionMedia,
	type DecisionMediaKind,
	toAssets
} from './media.ts'
import {
	type DecisionQuestion,
	type DecisionResponse,
	DecisionResponseSchema
} from './questions.ts'

/** The credentials each provider needs; pass only the providers you use. */
export type DecisionProviderKeys = {
	typesafe?: string
	cloudflare?: { apiToken: string; accountId: string }
	openai?: string
	/** One key for every model OpenRouter hosts (the `vendor/model` names). */
	openrouter?: string
	/** A Gemini API key: https://aistudio.google.com/api-keys */
	google?: string
}

export type DecisionProvider = keyof DecisionProviderKeys

/**
 * `inputUsdPerMTok` is USD per million input tokens; output is free on every
 * provider, because an answer is a few tokens of enum rather than generated
 * prose. Jev's rate is from TypeSafe's launch material (the docs publish no
 * price sheet); the rest are the providers' list prices (2026-10). Images are
 * billed as input tokens at the same rate.
 *
 * `images` marks the models this client sends images to, and `video`,
 * `audio` and `pdf` the models it sends those files to. Jev reads images
 * anywhere in the state, instructions and criteria (1.13 and later:
 * https://docs.typesafe.ai/images); Gemini reads every kind, in its input
 * only, so the client sends files there and the text names them. Clef and
 * gpt-6-luna read images too, but in wire formats this client does not speak
 * yet.
 *
 * `maxQuestions`, `maxChoices` (options in one choice) and `maxLevels` (levels
 * in one score) are the limits a call is checked against before it is sent,
 * where a provider documents or was measured to enforce one. Jev's come from
 * its API schema (https://docs.typesafe.ai/api); Clef's question limit was
 * measured (it refuses more than 64). Gemini's are from its API reference
 * (https://aistudio.google.com/docs/decisions-api).
 */
export const DECISION_MODELS = {
	jev: {
		provider: 'typesafe',
		inputUsdPerMTok: 0.042,
		images: true,
		maxChoices: 255,
		maxLevels: 10
	},
	clef: {
		provider: 'cloudflare',
		inputUsdPerMTok: 0.24,
		images: false,
		maxQuestions: 64
	},
	'clef-flash': {
		provider: 'cloudflare',
		inputUsdPerMTok: 0.09,
		images: false
	},
	'gpt-6-luna': { provider: 'openai', inputUsdPerMTok: 0.1, images: false },
	// OpenRouter models are named by their OpenRouter slug, so adding one is
	// one line here: https://openrouter.ai/rankings/decisions
	'microsoft/microsoft-decision-1': {
		provider: 'openrouter',
		inputUsdPerMTok: 0.042,
		images: false
	},
	// TypeSafe's Jev 1.13 on OpenRouter, served on OpenRouter's
	// zero-data-retention list. OpenRouter forwards `assets` to Jev as written:
	// https://openrouter.ai/docs/guides/community/multimodal-decisions
	'typesafe/jev-1.13': {
		provider: 'openrouter',
		inputUsdPerMTok: 0.042,
		images: true,
		maxChoices: 255,
		maxLevels: 10
	},
	// Google's Gemini Decision 1 on the Gemini Developer API (v1beta), list
	// price from the launch post (2026-11-11).
	'gemini-decision-1': {
		provider: 'google',
		inputUsdPerMTok: 0.1,
		images: true,
		video: true,
		audio: true,
		pdf: true,
		maxQuestions: 1000,
		maxChoices: 255,
		maxLevels: 255
	}
} as const satisfies Record<string, DecisionModelInfo>

type DecisionModelInfo = {
	provider: DecisionProvider
	inputUsdPerMTok: number
	images: boolean
	video?: boolean
	audio?: boolean
	pdf?: boolean
	maxQuestions?: number
	maxChoices?: number
	maxLevels?: number
}

export type DecisionModel = keyof typeof DECISION_MODELS

/** The flag in `DECISION_MODELS` that says a model reads each kind of file. */
const MEDIA_FLAGS = {
	image: 'images',
	video: 'video',
	audio: 'audio',
	pdf: 'pdf'
} as const satisfies Record<DecisionMediaKind, keyof DecisionModelInfo>

/** The models that read every kind of file in `Kind`. */
export type DecisionMediaModel<Kind extends DecisionMediaKind> = {
	[Model in DecisionModel]: (typeof DECISION_MODELS)[Model] extends {
		[Flag in (typeof MEDIA_FLAGS)[Kind]]: true
	}
		? Model
		: never
}[DecisionModel]

/** The models that read images. */
export type DecisionImageModel = DecisionMediaModel<'image'>

export function readsMedia(model: DecisionModel, kind: DecisionMediaKind) {
	const info: DecisionModelInfo = DECISION_MODELS[model]
	return info[MEDIA_FLAGS[kind]] === true
}

type ModelsOf<Provider> = {
	[Model in DecisionModel]: (typeof DECISION_MODELS)[Model]['provider'] extends Provider
		? Model
		: never
}[DecisionModel]

/** The models a set of keys can call: a provider counts only when its key is surely there. */
export type ModelsFor<Keys extends DecisionProviderKeys> = ModelsOf<
	{
		[Provider in keyof Keys]-?: undefined extends Keys[Provider]
			? never
			: Provider
	}[keyof Keys]
>

/** Why a model would refuse these questions, or undefined when it takes them. */
export function overModelLimit(
	model: DecisionModel,
	questions: Record<string, DecisionQuestion>
): string | undefined {
	const limits: DecisionModelInfo = DECISION_MODELS[model]
	const count = Object.keys(questions).length
	if (limits.maxQuestions !== undefined && count > limits.maxQuestions) {
		return `${count} questions, over ${model}'s ${limits.maxQuestions}`
	}
	for (const [key, question] of Object.entries(questions)) {
		if (question.type === 'noul') continue
		const [size, limit, what] =
			question.type === 'choice'
				? [Object.keys(question.criteria).length, limits.maxChoices, 'options']
				: [question.criteria.length, limits.maxLevels, 'levels']
		if (limit !== undefined && size > limit) {
			return `"${key}" has ${size} ${what}, over ${model}'s ${limit}`
		}
	}
	return undefined
}

type RequestInput = {
	state: unknown
	questions: Record<string, DecisionQuestion>
	/** Sent only to models that read their kinds (`readsMedia`); the caller checks. */
	media: DecisionMedia[]
}

/** One POST: where it goes, and the headers and body it carries. */
export function buildDecisionRequest(
	model: DecisionModel,
	input: RequestInput,
	keys: DecisionProviderKeys
) {
	const provider = DECISION_MODELS[model].provider
	const required = (token: string | undefined) => {
		if (!token) throw new Error(`No ${provider} key for ${model}`)
		return token
	}
	const headers = (token: string | undefined) => ({
		authorization: `Bearer ${required(token)}`,
		'content-type': 'application/json'
	})
	const { state, questions } = input
	const images = input.media.filter((item) => item instanceof DecisionImage)
	// A text-only request goes out exactly as it did before images existed.
	const assets = images.length > 0 ? { assets: toAssets(images) } : {}

	if (provider === 'typesafe') {
		return {
			url: 'https://api.typesafe.ai/v1/systemone',
			headers: {
				...headers(keys.typesafe),
				// Images are opt-in per request while TypeSafe calls them a preview.
				...(images.length > 0 && { 'typesafe-danger-zone-images': 'true' })
			},
			body: JSON.stringify({
				state,
				questions,
				...assets,
				model: 'jev-latest'
			})
		}
	}

	if (provider === 'cloudflare') {
		return {
			url: `https://api.cloudflare.com/client/v4/accounts/${keys.cloudflare?.accountId}/ai/run/@cf/cloudflare/${model}`,
			headers: headers(keys.cloudflare?.apiToken),
			body: JSON.stringify({ state, questions, model })
		}
	}

	if (provider === 'openrouter') {
		// https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
		return {
			url: 'https://openrouter.ai/api/alpha/decisions',
			headers: headers(keys.openrouter),
			body: JSON.stringify({ state, questions, ...assets, model })
		}
	}

	if (provider === 'google') {
		return {
			url: 'https://generativelanguage.googleapis.com/v1beta/decisions',
			headers: {
				'x-goog-api-key': required(keys.google),
				'content-type': 'application/json'
			},
			body: JSON.stringify(toGeminiRequest(model, input))
		}
	}

	return {
		url: 'https://api.openai.com/v1/decisions',
		headers: headers(keys.openai),
		body: JSON.stringify(toOpenAiRequest(model, { state, questions }))
	}
}

/** The provider's response read into the shared shape, unvalidated against the questions. */
export function readDecisionResponse(model: DecisionModel, json: unknown) {
	return responseSchemas[DECISION_MODELS[model].provider].safeParse(json)
}

// ───────────────────────────── OpenAI Decisions ─────────────────────────────
// https://developers.openai.com/api/docs/guides/decisions - the same three
// question kinds under other names: `predicate` for noul, choices and levels as
// arrays of objects, answers as an array keyed by `name`.

function toOpenAiQuestion(name: string, question: DecisionQuestion) {
	if (question.type === 'noul') {
		// No criteria field on a predicate: the gloss rides in the instructions.
		const gloss = question.criteria
			? `\nTrue means: ${question.criteria.true}\nFalse means: ${question.criteria.false}`
			: ''
		return {
			type: 'predicate',
			name,
			instructions: `${question.instructions}${gloss}`
		}
	}

	if (question.type === 'choice') {
		return {
			type: 'choice',
			name,
			instructions: question.instructions,
			choices: Object.entries(question.criteria).map(
				([value, description]) => ({ value, description })
			)
		}
	}

	return {
		type: 'score',
		name,
		instructions: question.instructions,
		levels: question.criteria.map((description, index) => ({
			label: String(index),
			description
		}))
	}
}

function toOpenAiRequest(
	model: DecisionModel,
	input: Omit<RequestInput, 'media'>
) {
	return {
		model,
		input:
			typeof input.state === 'string'
				? input.state
				: JSON.stringify(input.state),
		questions: Object.entries(input.questions).map(([name, question]) =>
			toOpenAiQuestion(name, question)
		)
	}
}

const OpenAiProbabilitiesSchema = z.array(
	z.object({
		value: z.union([z.string(), z.number()]),
		probability: z.number()
	})
)

const OpenAiResponseSchema = z.object({
	model: z.string().optional(),
	answers: z.array(
		z.discriminatedUnion('type', [
			z.object({
				type: z.literal('predicate'),
				name: z.string(),
				probability: z.number()
			}),
			z.object({
				type: z.literal(['choice', 'score']),
				name: z.string(),
				choice: z.string().optional(),
				score: z.number().optional(),
				confidence: z.number(),
				probabilities: OpenAiProbabilitiesSchema
			})
		])
	),
	usage: z.object({ input_tokens: z.number(), output_tokens: z.number() })
})

function fromOpenAiResponse(
	response: z.infer<typeof OpenAiResponseSchema>
): unknown {
	const answers = response.answers.map((answer) => {
		if (answer.type === 'predicate') {
			return [answer.name, { type: 'noul', noul: answer.probability }]
		}
		// Score levels come back as numeric indices; the shared shape keys them as strings.
		const probabilities = Object.fromEntries(
			answer.probabilities.map((option) => [
				String(option.value),
				option.probability
			])
		)
		return [
			answer.name,
			answer.type === 'choice'
				? {
						type: 'choice',
						choice: answer.choice,
						confidence: answer.confidence,
						probabilities
					}
				: {
						type: 'score',
						score: answer.score,
						confidence: answer.confidence,
						probabilities
					}
		]
	})

	return {
		model: response.model,
		answers: Object.fromEntries(answers),
		usage: {
			input_tokens: response.usage.input_tokens,
			output_tokens: response.usage.output_tokens
		}
	}
}

// ───────────────────────────── Gemini Decisions ─────────────────────────────
// https://aistudio.google.com/docs/decisions-api - System One's question and
// answer shapes, except that a noul's criteria are named `true_description` and
// `false_description`, the state is `input` (text or content blocks) and usage
// counts `total_input_tokens`. Instructions and criteria take text only, so
// every file goes into `input` after the state, each under a line naming its
// reference, which is what the state, instructions and criteria write.

const GEMINI_BLOCK_TYPES = {
	image: 'image',
	video: 'video',
	audio: 'audio',
	pdf: 'document'
} as const satisfies Record<DecisionMediaKind, string>

function toGeminiBlock(item: DecisionMedia) {
	return {
		type: GEMINI_BLOCK_TYPES[item.kind],
		...(item.uri === undefined ? { data: item.base64 } : { uri: item.uri }),
		mime_type: item.mimeType,
		...(item.resolution !== undefined && { resolution: item.resolution })
	}
}

function toGeminiQuestion(question: DecisionQuestion) {
	if (question.type !== 'noul' || !question.criteria) return question
	return {
		...question,
		criteria: {
			true_description: question.criteria.true,
			false_description: question.criteria.false
		}
	}
}

function toGeminiRequest(model: DecisionModel, input: RequestInput) {
	const text =
		typeof input.state === 'string' ? input.state : JSON.stringify(input.state)
	return {
		model,
		input:
			input.media.length === 0
				? text
				: [
						{ type: 'text', text },
						// Gemini joins adjacent text blocks with no separator.
						...input.media.flatMap((item) => [
							{ type: 'text', text: `\n\n${item.reference}:\n` },
							toGeminiBlock(item)
						])
					],
		questions: Object.fromEntries(
			Object.entries(input.questions).map(([key, question]) => [
				key,
				toGeminiQuestion(question)
			])
		)
	}
}

// Answers pass through as they are: the extra `confidence` on a noul and
// `legend` on a score are dropped by the shared schema.
const GeminiResponseSchema = z
	.object({
		answers: z.record(z.string(), z.unknown()),
		usage: z.object({
			total_input_tokens: z.number(),
			total_output_tokens: z.number()
		})
	})
	.transform(({ answers, usage }) => ({
		answers,
		usage: {
			input_tokens: usage.total_input_tokens,
			output_tokens: usage.total_output_tokens
		}
	}))

const responseSchemas: Record<DecisionProvider, z.ZodType<DecisionResponse>> = {
	typesafe: DecisionResponseSchema,
	// OpenRouter's Decisions API speaks System One's shape for every model.
	openrouter: DecisionResponseSchema,
	// Workers AI wraps every model's output in its own envelope.
	cloudflare: z
		.object({ result: DecisionResponseSchema })
		.transform((response) => response.result),
	openai: OpenAiResponseSchema.transform(fromOpenAiResponse).pipe(
		DecisionResponseSchema
	),
	google: GeminiResponseSchema.pipe(DecisionResponseSchema)
}
