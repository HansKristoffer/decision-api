import { expect, test } from 'bun:test'
import { type DecisionCase, grade, report, runCases } from './eval.ts'
import type { createDecisionApi, DecisionQuestion } from './index.ts'
import { fakeDecide } from './testing.ts'

test('grades each answer kind against the expected answer', () => {
	expect(grade({ type: 'noul', noul: 0.8 }, true)).toEqual({
		expected: true,
		value: '0.80',
		correct: true,
		pCorrect: 0.8,
		noul: 0.8
	})
	expect(grade({ type: 'noul', noul: 0.8 }, false).correct).toBe(false)

	const choice = grade(
		{
			type: 'choice',
			choice: 'billing',
			confidence: 0.7,
			probabilities: { billing: 0.7, other: 0.3 }
		},
		'other'
	)
	expect(choice).toMatchObject({
		value: 'billing',
		correct: false,
		pCorrect: 0.3
	})

	// A score is right when it rounds to the expected level.
	const score = grade(
		{
			type: 'score',
			score: 2.6,
			confidence: 0.6,
			probabilities: { '2': 0.4, '3': 0.6 }
		},
		3
	)
	expect(score).toMatchObject({ value: '2.60', correct: true, pCorrect: 0.6 })
})

const PRIVATE = {
	type: 'noul',
	instructions: 'Is this private?'
} satisfies DecisionQuestion

const cases: DecisionCase[] = [
	{
		name: 'salary',
		state: 'a',
		questions: { private: PRIVATE },
		expected: { private: true }
	},
	{
		name: 'address',
		state: 'b',
		questions: { private: PRIVATE },
		expected: { private: true }
	},
	{
		name: 'menu',
		state: 'c',
		questions: { private: PRIVATE },
		expected: { private: false }
	}
]
const NOUL_BY_STATE: Record<string, number> = { a: 0.9, b: 0.4, c: 0.2 }

test('reports each question at the threshold the app ships', async () => {
	const decide = fakeDecide<
		ReturnType<typeof createDecisionApi<{ typesafe: string }, 'jev'>>
	>(({ state }) => ({ private: NOUL_BY_STATE[String(state)] ?? 0 }))

	const logs = await runCases({ decide, cases, runs: 2 })
	expect(logs).toHaveLength(6)

	// At 0.5 the 0.4 address is a miss; at the shipped 0.35 nothing is.
	const atDefault = report(logs)
	expect(atDefault.ok).toBe(false)
	expect(atDefault.models[0]?.questions[0]?.noul).toMatchObject({
		misses: 2,
		falsePositives: 0
	})

	const shipped = report(logs, { thresholds: { private: 0.35 } })
	expect(shipped.ok).toBe(true)
	const question = shipped.models[0]?.questions[0]
	expect(question).toMatchObject({ threshold: 0.35, wrong: 0, accuracy: 1 })
	// Lowest positive 0.4, highest negative 0.2.
	expect(question?.noul?.margin).toBeCloseTo(0.2, 10)
	expect(question?.noul?.brier).toBeCloseTo((0.01 + 0.36 + 0.04) / 3, 10)
	expect(question?.noul?.sweep.find((row) => row.threshold === 0.25)).toEqual({
		threshold: 0.25,
		misses: 0,
		falsePositives: 0
	})
	expect(question?.noul?.reliability.map((row) => row.from)).toEqual([
		0.2, 0.4, 0.9
	])
})

test('a failed call fails the report', async () => {
	const decide = fakeDecide<
		ReturnType<typeof createDecisionApi<{ typesafe: string }, 'jev'>>
	>(() => null)

	const logs = await runCases({ decide, cases })
	const summary = report(logs)

	expect(logs[0]?.error).toBe('request-failed: fakeDecide')
	expect(summary.ok).toBe(false)
	expect(summary.models[0]).toMatchObject({ calls: 3, failed: 3 })
})
