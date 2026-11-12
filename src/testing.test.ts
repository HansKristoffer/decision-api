import { expect, test } from 'bun:test'
import {
	createDecisionApi,
	DecisionError,
	type DecisionQuestion,
	perItem
} from './index.ts'
import { fakeDecide } from './testing.ts'

const real = createDecisionApi({
	keys: { typesafe: 'key' },
	defaultModel: 'jev',
	registerUsage: (_usage, _context: { organizationId: string }) => {}
})

const QUESTIONS = {
	agreed: { type: 'noul', instructions: 'Did they agree?' },
	team: {
		type: 'choice',
		instructions: 'Which team?',
		criteria: { billing: 'Payments', other: 'Anything else' }
	},
	urgency: {
		type: 'score',
		instructions: 'How urgent?',
		criteria: ['Low', 'High']
	}
} satisfies Record<string, DecisionQuestion>

test('a fake answers in the real shape and records each call', async () => {
	const decide = fakeDecide<typeof real>(() => ({
		agreed: 0.9,
		team: 'billing',
		urgency: 1
	}))

	const answers = await decide({
		state: 'yes',
		questions: QUESTIONS,
		organizationId: 'org_1'
	})

	expect(answers?.agreed.noul).toBe(0.9)
	expect(answers?.team).toEqual({
		type: 'choice',
		choice: 'billing',
		confidence: 1,
		probabilities: { billing: 1, other: 0 }
	})
	expect(answers?.urgency.score).toBe(1)
	expect(decide.calls[0]).toMatchObject({
		state: 'yes',
		organizationId: 'org_1'
	})
})

test('a fake refuses an answer the real client never returns', async () => {
	const missing = fakeDecide<typeof real>(() => ({
		agreed: 0.9,
		team: 'billing'
	}))
	const wrongOption = fakeDecide<typeof real>(() => ({
		agreed: 0.9,
		team: 'sales',
		urgency: 0
	}))

	const ask = { state: '', questions: QUESTIONS, organizationId: 'org_1' }
	await expect(missing(ask)).rejects.toThrow('"urgency"')
	await expect(wrongOption(ask)).rejects.toThrow('"team"')
})

test('a fake fails a call with null or with a given error', async () => {
	const down = fakeDecide<typeof real>(() => null)
	const limited = fakeDecide<typeof real>(
		() => new DecisionError('rate-limited', 'jev', 'slow down', 429)
	)
	const ask = { state: '', questions: QUESTIONS, organizationId: 'org_1' }

	expect(await down(ask)).toBeNull()
	const outcome = await limited.result(ask)
	expect(outcome.ok ? null : outcome.error.kind).toBe('rate-limited')
})

test('perItem asks one question per item and pairs each with its answer', async () => {
	const blocks = [{ id: 'b1' }, { id: 'b2' }]
	const perBlock = perItem(blocks, 'block', (_block, index) => ({
		type: 'noul',
		instructions: `Is \`blocks[${index}]\` private?`
	}))
	const decide = fakeDecide<typeof real>(() => ({
		block_0: 0.1,
		block_1: 0.8,
		rules: 0.5
	}))

	const answers = await decide({
		state: { blocks },
		questions: {
			...perBlock.questions,
			rules: { type: 'noul', instructions: 'Any rules?' }
		},
		organizationId: 'org_1'
	})
	if (!answers) throw new Error('expected answers')

	const flagged = perBlock
		.read(answers)
		// Typed as a noul answer, never undefined.
		.filter(({ answer }) => answer.noul >= 0.35)
		.map(({ item }) => item.id)
	expect(flagged).toEqual(['b2'])
	expect(Object.keys(perBlock.questions)).toEqual(['block_0', 'block_1'])
})
