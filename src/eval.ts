// Labelled cases against a live client: run them, then read accuracy at the
// thresholds the app ships, a threshold sweep and calibration per question.
// The app brings the cases; nothing here knows its domain.

import type { DecisionResult } from './create-decision-api.ts'
import type { DecisionModel } from './models.ts'
import type { DecisionAnswer, DecisionQuestion } from './questions.ts'

/** One call and the answers a careful human would give to its questions. */
export type DecisionCase = {
	name: string
	state: unknown
	questions: Record<string, DecisionQuestion>
	/** By question key: a noul's truth, a choice's option, a score's level. */
	expected: Record<string, boolean | string | number>
}

export type GradedAnswer = {
	expected: boolean | string | number
	value: string
	/** At 0.5 for a noul; `report` regrades nouls at your thresholds. */
	correct: boolean
	/** The probability the model put on the expected answer. */
	pCorrect: number
	/** A noul's probability, kept for the threshold sweep and calibration. */
	noul?: number
}

export type CaseLog = {
	model: DecisionModel
	caseName: string
	run: number
	latencyMs: number
	inputTokens?: number
	costUsd?: number
	/** `kind: message` of a failed call. */
	error?: string
	answers?: Record<string, GradedAnswer>
}

/** Right or wrong, plus the probability the model put on the right answer. */
export function grade(
	answer: DecisionAnswer,
	expected: boolean | string | number
): GradedAnswer {
	if (answer.type === 'noul') {
		const pCorrect = expected ? answer.noul : 1 - answer.noul
		return {
			expected,
			value: answer.noul.toFixed(2),
			correct: pCorrect >= 0.5,
			pCorrect,
			noul: answer.noul
		}
	}
	const pCorrect = answer.probabilities[String(expected)] ?? 0
	if (answer.type === 'choice') {
		return {
			expected,
			value: answer.choice,
			correct: answer.choice === expected,
			pCorrect
		}
	}
	return {
		expected,
		value: answer.score.toFixed(2),
		correct: Math.round(answer.score) === expected,
		pCorrect
	}
}

/** What `runCases` needs of a client: `decide` from `createDecisionApi` fits. */
type CaseClient = {
	result(
		input: { state: unknown; questions: Record<string, DecisionQuestion> },
		model?: DecisionModel
	): Promise<DecisionResult<Record<string, DecisionQuestion>>>
}

/**
 * Asks every case `runs` times on each of `models` (the client's default
 * model when left out). Models run side by side; each model's calls run one
 * at a time, so they never queue behind each other. `context` is the usage
 * context the client requires, if it requires one.
 */
export async function runCases(input: {
	decide: CaseClient
	cases: DecisionCase[]
	runs?: number
	models?: DecisionModel[]
	context?: object
	onCall?: (log: CaseLog) => void
}): Promise<CaseLog[]> {
	const runs = input.runs ?? 1
	const perModel = await Promise.all(
		(input.models ?? [undefined]).map(async (model) => {
			const logs: CaseLog[] = []
			for (let run = 1; run <= runs; run++) {
				for (const decisionCase of input.cases) {
					const outcome = await input.decide.result(
						{
							...input.context,
							state: decisionCase.state,
							questions: decisionCase.questions
						},
						model
					)
					const log: CaseLog = outcome.ok
						? {
								model: outcome.usage?.model ?? model ?? 'jev',
								caseName: decisionCase.name,
								run,
								latencyMs: outcome.usage?.latencyMs ?? 0,
								inputTokens: outcome.usage?.inputTokens,
								costUsd: outcome.usage?.costUsd,
								answers: Object.fromEntries(
									Object.entries(decisionCase.expected).map(
										([key, expected]) => [
											key,
											grade(outcome.answers[key] as DecisionAnswer, expected)
										]
									)
								)
							}
						: {
								model: outcome.error.model,
								caseName: decisionCase.name,
								run,
								latencyMs: outcome.error.latencyMs,
								error: `${outcome.error.kind}: ${outcome.error.message}`
							}
					input.onCall?.(log)
					logs.push(log)
				}
			}
			return logs
		})
	)
	return perModel.flat()
}

export function percentile(values: number[], p: number) {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
}

export const mean = (values: number[]) =>
	values.length === 0
		? Number.NaN
		: values.reduce((sum, value) => sum + value, 0) / values.length

const SWEEP = Array.from({ length: 19 }, (_, index) => (index + 1) / 20)

/**
 * Per model and question: accuracy at its threshold (`thresholds[key]`, 0.5
 * when unset; a noul is positive at or above it), and for nouls the misses
 * and false positives there and at every threshold from 0.05 to 0.95, the
 * margin between the lowest positive and the highest negative (below zero
 * means no threshold separates them), the Brier score and a 10-bin
 * reliability table. `ok` is false when any call failed or any answer was
 * wrong: `if (!summary.ok) process.exitCode = 1`.
 */
export function report(
	logs: CaseLog[],
	options: { thresholds?: Record<string, number> } = {}
) {
	const models = [...new Set(logs.map((log) => log.model))]
	const perModel = models.map((model) => {
		const own = logs.filter((log) => log.model === model)
		const answered = own.filter((log) => log.answers)
		const keys = [
			...new Set(answered.flatMap((log) => Object.keys(log.answers ?? {})))
		]
		const questions = keys.map((key) =>
			summarizeQuestion(
				key,
				answered.flatMap((log) => log.answers?.[key] ?? []),
				options.thresholds?.[key] ?? 0.5
			)
		)
		const nouls = answered.flatMap((log) =>
			Object.values(log.answers ?? {}).filter((a) => a.noul !== undefined)
		)
		const latencies = answered.map((log) => log.latencyMs)
		return {
			model,
			calls: own.length,
			failed: own.length - answered.length,
			wrong: questions.reduce((sum, question) => sum + question.wrong, 0),
			brier: brier(nouls),
			latencyP50: percentile(latencies, 0.5),
			latencyP90: percentile(latencies, 0.9),
			inputTokens: sum(answered.map((log) => log.inputTokens ?? 0)),
			costUsd: sum(answered.map((log) => log.costUsd ?? 0)),
			questions
		}
	})
	return {
		ok: perModel.every((row) => row.failed === 0 && row.wrong === 0),
		models: perModel
	}
}

function summarizeQuestion(
	key: string,
	graded: GradedAnswer[],
	threshold: number
) {
	const nouls = graded.filter(
		(answer): answer is GradedAnswer & { noul: number } =>
			answer.noul !== undefined
	)
	if (nouls.length === 0 || nouls.length !== graded.length) {
		const wrong = graded.filter((answer) => !answer.correct).length
		return {
			key,
			answers: graded.length,
			threshold: undefined,
			wrong,
			accuracy: 1 - wrong / graded.length,
			noul: undefined
		}
	}

	const errorsAt = (at: number) => ({
		threshold: at,
		misses: nouls.filter((a) => a.expected && a.noul < at).length,
		falsePositives: nouls.filter((a) => !a.expected && a.noul >= at).length
	})
	const at = errorsAt(threshold)
	const positives = nouls.filter((a) => a.expected).map((a) => a.noul)
	const negatives = nouls.filter((a) => !a.expected).map((a) => a.noul)
	const wrong = at.misses + at.falsePositives
	return {
		key,
		answers: graded.length,
		threshold,
		wrong,
		accuracy: 1 - wrong / graded.length,
		noul: {
			misses: at.misses,
			falsePositives: at.falsePositives,
			margin:
				positives.length && negatives.length
					? Math.min(...positives) - Math.max(...negatives)
					: Number.NaN,
			brier: brier(nouls),
			sweep: SWEEP.map(errorsAt),
			reliability: reliability(nouls)
		}
	}
}

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0)

/** Mean squared distance from the truth: 0 is perfect, 0.25 is a coin. */
function brier(nouls: GradedAnswer[]) {
	return mean(nouls.map((a) => ((a.noul ?? 0) - (a.expected ? 1 : 0)) ** 2))
}

/** Answers binned by probability: a calibrated model's `observed` tracks `meanP`. */
function reliability(nouls: (GradedAnswer & { noul: number })[]) {
	return Array.from({ length: 10 }, (_, bin) => {
		const inBin = nouls.filter(
			(a) => Math.min(9, Math.floor(a.noul * 10)) === bin
		)
		return {
			from: bin / 10,
			to: (bin + 1) / 10,
			answers: inBin.length,
			meanP: mean(inBin.map((a) => a.noul)),
			observed: mean(inBin.map((a) => (a.expected ? 1 : 0)))
		}
	}).filter((row) => row.answers > 0)
}
