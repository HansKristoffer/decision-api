// Every decision model, the provider that serves it, what it costs, and how
// that provider's wire format maps onto the shared question shapes
// (`questions.ts`).

import { z } from 'zod'
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
}

export type DecisionProvider = keyof DecisionProviderKeys

/**
 * USD per million input tokens; output is free on every provider, because an
 * answer is a few tokens of enum rather than generated prose. Jev's rate is
 * from TypeSafe's launch material (the docs publish no price sheet); the rest
 * are the providers' list prices (2026-10).
 */
export const DECISION_MODELS = {
	jev: { provider: 'typesafe', inputUsdPerMTok: 0.042 },
	clef: { provider: 'cloudflare', inputUsdPerMTok: 0.24 },
	'clef-flash': { provider: 'cloudflare', inputUsdPerMTok: 0.09 },
	'gpt-6-luna': { provider: 'openai', inputUsdPerMTok: 0.1 },
	// OpenRouter models are named by their OpenRouter slug, so adding one is
	// one line here: https://openrouter.ai/rankings/decisions
	'microsoft/microsoft-decision-1': {
		provider: 'openrouter',
		inputUsdPerMTok: 0.042
	},
	// TypeSafe's Jev 1.13 on OpenRouter, served on OpenRouter's zero-data-retention list
	'typesafe/jev-1.13': { provider: 'openrouter', inputUsdPerMTok: 0.042 }
} as const satisfies Record<
	string,
	{ provider: DecisionProvider; inputUsdPerMTok: number }
>

export type DecisionModel = keyof typeof DECISION_MODELS

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

type RequestInput = {
	state: unknown
	questions: Record<string, DecisionQuestion>
}

/** One POST: where it goes, and the headers and body it carries. */
export function buildDecisionRequest(
	model: DecisionModel,
	input: RequestInput,
	keys: DecisionProviderKeys
) {
	const provider = DECISION_MODELS[model].provider
	const headers = (token: string | undefined) => {
		if (!token) throw new Error(`No ${provider} key for ${model}`)
		return {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json'
		}
	}

	if (provider === 'typesafe') {
		return {
			url: 'https://api.typesafe.ai/v1/systemone',
			headers: headers(keys.typesafe),
			body: JSON.stringify({ ...input, model: 'jev-latest' })
		}
	}

	if (provider === 'cloudflare') {
		return {
			url: `https://api.cloudflare.com/client/v4/accounts/${keys.cloudflare?.accountId}/ai/run/@cf/cloudflare/${model}`,
			headers: headers(keys.cloudflare?.apiToken),
			body: JSON.stringify({ ...input, model })
		}
	}

	if (provider === 'openrouter') {
		// https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
		return {
			url: 'https://openrouter.ai/api/alpha/decisions',
			headers: headers(keys.openrouter),
			body: JSON.stringify({ ...input, model })
		}
	}

	return {
		url: 'https://api.openai.com/v1/decisions',
		headers: headers(keys.openai),
		body: JSON.stringify(toOpenAiRequest(model, input))
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

function toOpenAiRequest(model: DecisionModel, input: RequestInput) {
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
		answers: Object.fromEntries(answers),
		usage: {
			input_tokens: response.usage.input_tokens,
			output_tokens: response.usage.output_tokens
		}
	}
}

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
	)
}
