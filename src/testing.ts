// A stand-in for `createDecisionApi`'s client in tests: no network, typed as
// the real one, and as strict about answers as the real one.

import { DecisionError, type DecisionUsage } from './create-decision-api.ts'
import { DECISION_MODELS, type DecisionModel } from './models.ts'
import {
	type DecisionAnswer,
	type DecisionQuestion,
	matchesQuestion
} from './questions.ts'

/** One call the code under test made: its input (context included) and model. */
export type FakeDecisionCall = {
	state: unknown
	questions: Record<string, DecisionQuestion>
	model: DecisionModel | undefined
	[field: string]: unknown
}

/**
 * Answers by question key: a number is a noul's probability or a score, a
 * string is the choice, or give the full answer.
 */
export type FakeAnswers = Record<string, number | string | DecisionAnswer>

type Respond = (
	call: FakeDecisionCall
) =>
	| FakeAnswers
	| DecisionError
	| null
	| Promise<FakeAnswers | DecisionError | null>

/**
 * A fake `decide`, typed as the real one: `fakeDecide<typeof decide>(...)`.
 * `respond` answers each call; `null` fails it as `request-failed`, and a
 * `DecisionError` fails it with that error. An answer that does not fit its
 * question, or a missing one, throws in the test, since the real client would
 * never return it. `calls` records every call.
 */
export function fakeDecide<Api>(
	respond: Respond
): Api & { calls: FakeDecisionCall[] } {
	const calls: FakeDecisionCall[] = []

	const result = async (input: object, model?: DecisionModel) => {
		const call = { ...input, model } as FakeDecisionCall
		calls.push(call)
		const used = model ?? 'jev'
		const response = await respond(call)
		if (response === null || response instanceof DecisionError) {
			const error =
				response ?? new DecisionError('request-failed', used, 'fakeDecide')
			return { ok: false as const, error }
		}
		const usage: DecisionUsage = {
			model: used,
			provider: DECISION_MODELS[used].provider,
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			latencyMs: 0,
			attempts: 1
		}
		return {
			ok: true as const,
			answers: expand(call.questions, response),
			usage
		}
	}

	const decide = async (input: object, model?: DecisionModel) => {
		const outcome = await result(input, model)
		return outcome.ok ? outcome.answers : null
	}
	return Object.assign(decide, { result, calls }) as unknown as Api & {
		calls: FakeDecisionCall[]
	}
}

function expand(
	questions: Record<string, DecisionQuestion>,
	given: FakeAnswers
): Record<string, DecisionAnswer> {
	return Object.fromEntries(
		Object.entries(questions).map(([key, question]) => {
			const answer = toAnswer(question, given[key])
			if (!matchesQuestion(question, answer)) {
				throw new Error(
					`fakeDecide: the answer to "${key}" (${JSON.stringify(given[key])}) does not fit its ${question.type} question`
				)
			}
			return [key, answer as DecisionAnswer]
		})
	)
}

/** Shorthand to a full answer: all the probability on the given value. */
function toAnswer(
	question: DecisionQuestion,
	value: FakeAnswers[string] | undefined
): DecisionAnswer | undefined {
	if (value === undefined || typeof value === 'object') return value
	if (question.type === 'noul') {
		return typeof value === 'number' ? { type: 'noul', noul: value } : undefined
	}
	const options =
		question.type === 'choice'
			? Object.keys(question.criteria)
			: question.criteria.map((_, index) => String(index))
	const picked = String(
		question.type === 'score' ? Math.round(Number(value)) : value
	)
	const probabilities = Object.fromEntries(
		options.map((option) => [option, option === picked ? 1 : 0])
	)
	if (question.type === 'choice') {
		return typeof value === 'string'
			? { type: 'choice', choice: value, confidence: 1, probabilities }
			: undefined
	}
	return typeof value === 'number'
		? { type: 'score', score: value, confidence: 1, probabilities }
		: undefined
}
