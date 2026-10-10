// The benchmark's fixed questions. Each case is one call; `expected` holds the
// answer a careful human would give, so every model is graded the same way:
// a noul by whether it lands on the right side of 0.5, a choice by its pick,
// a score by its nearest level.

import type { DecisionQuestion } from '../src/index.ts'

export type BenchCase = {
	name: string
	state: unknown
	questions: Record<string, DecisionQuestion>
	expected: Record<string, boolean | string | number>
}

const TEAM = {
	type: 'choice',
	instructions: 'Which support team should handle this message?',
	criteria: {
		billing: 'Charges, invoices, refunds and payment methods',
		shipping: 'Delivery status, addresses and lost or damaged parcels',
		technical: 'Bugs, outages, logins and anything not working',
		other: 'Anything that fits none of the above'
	}
} satisfies DecisionQuestion

const URGENCY = {
	type: 'score',
	instructions: 'How urgently does this need a response?',
	criteria: [
		'Can wait a week: a question or idea with no impact',
		'Within a few days: a nuisance with a workaround',
		'Today: the customer is blocked or losing money',
		'Right now: an outage or harm happening as we speak'
	]
} satisfies DecisionQuestion

export const BENCH_CASES: BenchCase[] = [
	{
		name: 'Double charge',
		state: {
			message: 'I was charged twice for order #4411. Please fix this!'
		},
		questions: {
			refund: {
				type: 'noul',
				instructions: 'Does the customer want money back?',
				criteria: {
					true: 'They ask for a refund, reversal or credit',
					false: 'They want something other than money back'
				}
			},
			team: TEAM,
			urgency: URGENCY
		},
		expected: { refund: true, team: 'billing', urgency: 2 }
	},
	{
		name: 'Missing parcel',
		state: {
			message:
				'Tracking says my parcel was delivered yesterday but there is nothing at my door.'
		},
		questions: { team: TEAM, urgency: URGENCY },
		expected: { team: 'shipping', urgency: 2 }
	},
	{
		name: 'Production outage',
		state: {
			message:
				'Your API has returned 500 for every request for 20 minutes. Our checkout is down and we are losing orders.'
		},
		questions: { team: TEAM, urgency: URGENCY },
		expected: { team: 'technical', urgency: 3 }
	},
	{
		name: 'Feature idea',
		state: {
			message: 'Would be nice if the dashboard had a dark mode some day :)'
		},
		questions: { team: TEAM, urgency: URGENCY },
		expected: { team: 'other', urgency: 0 }
	},
	{
		name: 'Danish address change',
		state: {
			message: 'Hej, kan jeg nå at ændre leveringsadressen på min ordre?'
		},
		questions: {
			team: TEAM,
			language: {
				type: 'choice',
				instructions: 'Which language is the message written in?',
				criteria: {
					en: 'English',
					da: 'Danish',
					de: 'German',
					other: 'Another language'
				}
			}
		},
		expected: { team: 'shipping', language: 'da' }
	},
	{
		name: 'Gift card spam',
		state:
			'CONGRATULATIONS!!! You won a $1000 gift card. Click bit.ly/claim-now within 24h to claim.',
		questions: {
			spam: {
				type: 'noul',
				instructions: 'Is this unsolicited spam or a scam?'
			}
		},
		expected: { spam: true }
	},
	{
		name: 'Friendly reminder',
		state:
			'Hi Anna, just a reminder that our call moved to 3 pm tomorrow. See you then!',
		questions: {
			spam: {
				type: 'noul',
				instructions: 'Is this unsolicited spam or a scam?'
			},
			toxic: {
				type: 'noul',
				instructions: 'Is the message insulting, hateful or threatening?'
			}
		},
		expected: { spam: false, toxic: false }
	},
	{
		name: 'Product review',
		state:
			'Absolutely love this kettle. Boils in a minute, looks great, would buy again.',
		questions: {
			sentiment: {
				type: 'score',
				instructions: 'How satisfied is the reviewer?',
				criteria: [
					'Very unhappy: wants a refund or warns others away',
					'Disappointed: more bad than good',
					'Mixed or neutral',
					'Happy: mostly positive',
					'Delighted: enthusiastic, would recommend'
				]
			}
		},
		expected: { sentiment: 4 }
	},
	{
		name: 'Personal data',
		state:
			'My social security number is 123-45-6789, can you update my account?',
		questions: {
			pii: {
				type: 'noul',
				instructions:
					'Does the text contain a government ID, card number or similar sensitive personal data?'
			}
		},
		expected: { pii: true }
	},
	{
		name: 'SQL injection',
		state: {
			language: 'typescript',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the code under review
			code: 'const user = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`)'
		},
		questions: {
			vulnerable: {
				type: 'noul',
				instructions: 'Does this code contain a security vulnerability?'
			},
			severity: {
				type: 'score',
				instructions: 'How severe is the worst issue in the code?',
				criteria: [
					'No issue',
					'Style or minor bug',
					'Real bug that can break behaviour',
					'Exploitable security hole'
				]
			}
		},
		expected: { vulnerable: true, severity: 3 }
	},
	{
		name: 'False claim',
		state: 'The Eiffel Tower is located in Berlin.',
		questions: {
			true: {
				type: 'noul',
				instructions: 'Is the statement factually correct?'
			}
		},
		expected: { true: false }
	},
	{
		name: 'Sales lead',
		state: {
			message:
				'We are a 500-person company and want to buy 300 seats this quarter. Can we get a quote?',
			source: 'contact form'
		},
		questions: {
			intent: {
				type: 'score',
				instructions: 'How strong is the buying intent?',
				criteria: [
					'None: not interested in buying',
					'Curious: exploring, no plan',
					'Evaluating: comparing options',
					'Ready: asks for price, contract or seats now'
				]
			},
			enterprise: {
				type: 'noul',
				instructions: 'Is this a large organisation (200+ people)?'
			}
		},
		expected: { intent: 3, enterprise: true }
	}
]
