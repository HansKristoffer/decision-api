import { expect, test } from 'bun:test'
import { leaderboard } from './run.ts'

test('a failed call scores zero points', () => {
	const benchCase = {
		name: 'One',
		state: 'x',
		questions: { a: { type: 'noul' as const, instructions: 'a?' } },
		expected: { a: true }
	}
	const right = {
		a: { expected: true, value: '0.90', correct: true, pCorrect: 0.9 }
	}
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
