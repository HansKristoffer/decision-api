// The question and answer shapes every call speaks. They are System One's own
// (TypeSafe's Jev, Cloudflare's Clef); a provider with another wire format
// translates to and from them in `models.ts`. Instructions and criteria take
// images (`DecisionText`) on the models that read them.

import { z } from 'zod'
import type { DecisionText } from './media.ts'

/** Probability that the condition holds. No separate confidence: this IS it. */
export type DecisionNoul = {
	type: 'noul'
	instructions: DecisionText
	/** Optional, but a `true`/`false` gloss is what keeps a noul from drifting. */
	criteria?: { true: DecisionText; false: DecisionText }
}

/** One option from a defined set, with the distribution across all of them. */
export type DecisionChoice<Option extends string = string> = {
	type: 'choice'
	instructions: DecisionText
	/** Option -> what that option means. Include a no-match option when one may fit nothing. */
	criteria: Record<Option, DecisionText>
}

/** A position on ordered, concretely described levels. */
export type DecisionScore = {
	type: 'score'
	instructions: DecisionText
	/** Two or more levels, lowest first; each must stand on its own. */
	criteria: DecisionText[]
}

export type DecisionQuestion = DecisionNoul | DecisionChoice | DecisionScore

export type DecisionNoulAnswer = { type: 'noul'; noul: number }
export type DecisionChoiceAnswer<Option extends string = string> = {
	type: 'choice'
	choice: Option
	confidence: number
	probabilities: Record<Option, number>
}
export type DecisionScoreAnswer = {
	type: 'score'
	score: number
	confidence: number
	probabilities: Record<string, number>
}

export type DecisionAnswer =
	| DecisionNoulAnswer
	| DecisionChoiceAnswer
	| DecisionScoreAnswer

/** The answer a given question shape produces, so call sites need no casts. */
export type AnswerFor<Q> = Q extends { type: 'noul' }
	? DecisionNoulAnswer
	: Q extends {
				type: 'choice'
				criteria: Record<infer Option extends string, DecisionText>
			}
		? DecisionChoiceAnswer<Option>
		: Q extends { type: 'score' }
			? DecisionScoreAnswer
			: never

export type DecisionAnswers<Q extends Record<string, DecisionQuestion>> = {
	[K in keyof Q]: AnswerFor<Q[K]>
}

const ProbabilitySchema = z.number().min(0).max(1)

const AnswerSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('noul'), noul: ProbabilitySchema }),
	z.object({
		type: z.literal('choice'),
		choice: z.string(),
		confidence: ProbabilitySchema,
		probabilities: z.record(z.string(), ProbabilitySchema)
	}),
	z.object({
		type: z.literal('score'),
		score: z.number(),
		confidence: ProbabilitySchema,
		probabilities: z.record(z.string(), ProbabilitySchema)
	})
])

/** What every vendor's response is read into. */
export const DecisionResponseSchema = z.object({
	/** The model that answered, when the provider says (it may resolve an alias). */
	model: z.string().optional(),
	answers: z.record(z.string(), AnswerSchema),
	usage: z.object({
		input_tokens: z.number().int().nonnegative(),
		output_tokens: z.number().int().nonnegative()
	})
})

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>

/** The contract depends on the question, not just the answer's own tag. */
export function matchesQuestion(
	question: DecisionQuestion,
	answer: DecisionAnswer | undefined
) {
	if (!answer || answer.type !== question.type) return false
	if (question.type === 'noul') return true

	if (question.type === 'choice' && answer.type === 'choice') {
		return (
			Object.hasOwn(question.criteria, answer.choice) &&
			matchesOptions(Object.keys(question.criteria), answer.probabilities)
		)
	}

	// Scores are fractional positions on zero-based rubric levels:
	// https://docs.typesafe.ai/api#score-answer
	if (question.type === 'score' && answer.type === 'score') {
		return (
			answer.score >= 0 &&
			answer.score <= question.criteria.length - 1 &&
			matchesOptions(
				question.criteria.map((_, index) => String(index)),
				answer.probabilities
			)
		)
	}

	return false
}

function matchesOptions(
	options: string[],
	probabilities: Record<string, number>
) {
	return (
		Object.keys(probabilities).length === options.length &&
		options.every((option) => Object.hasOwn(probabilities, option))
	)
}

/**
 * The same question about each item of a list, under keys `${prefix}_${index}`.
 * Spread `questions` into a call (next to other questions if you like) and
 * pass its answers to `read`, which pairs each item with its typed answer.
 */
export function perItem<
	Item,
	const Q extends DecisionQuestion,
	const Prefix extends string
>(
	items: readonly Item[],
	prefix: Prefix,
	ask: (item: Item, index: number) => Q
) {
	type Key = `${Prefix}_${number}`
	const questions = Object.fromEntries(
		items.map((item, index) => [`${prefix}_${index}`, ask(item, index)])
	) as Record<Key, Q>
	return {
		questions,
		/** Every key is there: a call answers all its questions or `null`. */
		read: (answers: { readonly [K in Key]: AnswerFor<Q> }) =>
			items.map((item, index) => ({
				item,
				index,
				answer: answers[`${prefix}_${index}`] as AnswerFor<Q>
			}))
	}
}
