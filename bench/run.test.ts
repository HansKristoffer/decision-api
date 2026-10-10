import { expect, test } from 'bun:test'
import { grade, leaderboard } from './run.ts'

test('grades each answer kind against the expected answer', () => {
	expect(grade({ type: 'noul', noul: 0.8 }, true)).toEqual({
		value: '0.80',
		correct: true,
		pCorrect: 0.8
	})
	expect(grade({ type: 'noul', noul: 0.8 }, false).correct).toBe(false)

	const choice = grade(
		{
			type: 'choice',
			choice: 'billing',
			probabilities: { billing: 0.7, other: 0.3 }
		},
		'other'
	)
	expect(choice).toEqual({ value: 'billing', correct: false, pCorrect: 0.3 })

	// A score is right when it rounds to the expected level.
	const score = grade(
		{ type: 'score', score: 2.6, probabilities: { '2': 0.4, '3': 0.6 } },
		3
	)
	expect(score).toEqual({ value: '2.60', correct: true, pCorrect: 0.6 })
})

test('a failed call scores zero points', () => {
	const benchCase = {
		name: 'One',
		state: 'x',
		questions: { a: { type: 'noul' as const, instructions: 'a?' } },
		expected: { a: true }
	}
	const right = { a: { value: '0.90', correct: true, pCorrect: 0.9 } }
	const [first, second] = leaderboard({
		models: ['jev', 'clef'],
		runs: 2,
		cases: [benchCase],
		logs: [
			{ model: 'clef', caseName: 'One', run: 1, latencyMs: 1, answers: right },
			{
				model: 'clef',
				caseName: 'One',
				run: 2,
				latencyMs: 1,
				error: 'timeout'
			},
			{ model: 'jev', caseName: 'One', run: 1, latencyMs: 1, answers: right },
			{ model: 'jev', caseName: 'One', run: 2, latencyMs: 1, answers: right }
		]
	})
	expect(first).toMatchObject({ model: 'jev', points: 1, score: 100 })
	expect(second).toMatchObject({ model: 'clef', points: 0.5, score: 50 })
})
