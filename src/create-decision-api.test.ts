import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import {
	createDecisionApi,
	DECISION_MAX_REQUEST_CHARS,
	type DecisionError,
	type DecisionQuestion,
	type DecisionUsage
} from './index.ts'

const KEYS = {
	typesafe: 'typesafe-key',
	cloudflare: { apiToken: 'cloudflare-token', accountId: 'account-1' },
	openai: 'openai-key',
	openrouter: 'openrouter-key',
	google: 'google-key'
}

const decide = createDecisionApi({ keys: KEYS, defaultModel: 'jev' })

const ASK = { state: { message: 'Kan jeg få pengene tilbage?' } }

const QUESTIONS = {
	refund: { type: 'noul', instructions: 'Is this about a refund?' }
} satisfies Record<string, DecisionQuestion>

function mockFetch(
	handler: (init: RequestInit | undefined, attempt: number) => Response
) {
	let attempt = 0
	return spyOn(globalThis, 'fetch').mockImplementation((async (
		_url: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => handler(init as RequestInit | undefined, attempt++)) as typeof fetch)
}

const answered = (answers: unknown) =>
	Response.json({ answers, usage: { input_tokens: 100, output_tokens: 3 } })

function decideReporting(options: {
	defaultSignal?: () => AbortSignal
	attemptTimeoutMs?: number
}) {
	const onError = mock((_error: DecisionError, _context: object) => {})
	const decideWith = createDecisionApi({
		keys: { typesafe: 'key', cloudflare: KEYS.cloudflare },
		defaultModel: 'jev',
		onError,
		...options
	})
	return { decideWith, onError }
}

afterEach(() => {
	spyOn(globalThis, 'fetch').mockRestore()
})

test('sends every question in ONE call and returns the typed answers', async () => {
	let calls = 0
	let body: Record<string, unknown> = {}
	mockFetch((init) => {
		calls += 1
		body = JSON.parse(String(init?.body))
		return answered({
			refund: { type: 'noul', noul: 0.94 },
			urgent: { type: 'noul', noul: 0.12 },
			intent: {
				type: 'choice',
				choice: 'returns',
				confidence: 0.9,
				probabilities: { returns: 0.9, delivery: 0.1 }
			}
		})
	})

	const answers = await decide({
		...ASK,
		questions: {
			refund: { type: 'noul', instructions: 'About a refund?' },
			urgent: { type: 'noul', instructions: 'Urgent?' },
			intent: {
				type: 'choice',
				instructions: 'Which topic?',
				criteria: { returns: 'a return', delivery: 'a delivery' }
			}
		}
	})

	// The measured shape: independent judgments share one request, because ten
	// questions in one call beat ten calls (probe G2).
	expect(calls).toBe(1)
	expect(body.model).toBe('jev-latest')
	expect(Object.keys(body.questions as object)).toHaveLength(3)
	expect(answers?.refund.noul).toBe(0.94)
	// The choice answer is narrowed to its own criteria keys.
	const intent: 'returns' | 'delivery' | undefined = answers?.intent.choice
	expect(intent).toBe('returns')
})

test('a Clef call goes to Workers AI and reads the answers out of its envelope', async () => {
	let url = ''
	let body: Record<string, unknown> = {}
	spyOn(globalThis, 'fetch').mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => {
		url = String(input)
		body = JSON.parse(String(init?.body))
		return Response.json({
			result: {
				model: 'clef-flash',
				answers: { refund: { type: 'noul', noul: 0.88 } },
				usage: { input_tokens: 90, output_tokens: 0 }
			},
			success: true,
			errors: [],
			messages: []
		})
	}) as typeof fetch)

	const answers = await decide(
		{
			...ASK,
			questions: QUESTIONS
		},
		'clef-flash'
	)

	expect(url).toEndWith('/ai/run/@cf/cloudflare/clef-flash')
	expect(body.model).toBe('clef-flash')
	expect(answers?.refund.noul).toBe(0.88)
})

test('an OpenRouter model goes to its Decisions API under its own slug', async () => {
	let url = ''
	let init: RequestInit | undefined
	spyOn(globalThis, 'fetch').mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		requestInit?: Parameters<typeof fetch>[1]
	) => {
		url = String(input)
		init = requestInit as RequestInit | undefined
		return Response.json({
			id: 'gen-dec-1',
			model: 'microsoft/microsoft-decision-1-20261009',
			provider: 'Azure',
			answers: { refund: { type: 'noul', noul: 0.91 } },
			usage: { input_tokens: 80, output_tokens: 0, cost: 0.0000034 }
		})
	}) as typeof fetch)

	const answers = await decide(
		{ ...ASK, questions: QUESTIONS },
		'microsoft/microsoft-decision-1'
	)

	expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
	expect(new Headers(init?.headers).get('authorization')).toBe(
		'Bearer openrouter-key'
	)
	expect(JSON.parse(String(init?.body)).model).toBe(
		'microsoft/microsoft-decision-1'
	)
	expect(answers?.refund.noul).toBe(0.91)
})

const LUNA_QUESTIONS = {
	refund: {
		type: 'noul',
		instructions: 'About a refund?',
		criteria: { true: 'Wants money back', false: 'Anything else' }
	},
	team: {
		type: 'choice',
		instructions: 'Which team?',
		criteria: { billing: 'Payments', shipping: 'Deliveries' }
	},
	severity: {
		type: 'score',
		instructions: 'How severe?',
		criteria: ['Minor', 'Major']
	}
} satisfies Record<string, DecisionQuestion>

test('a gpt-6-luna call speaks OpenAI Decisions and answers in the shared shape', async () => {
	let url = ''
	let body: Record<string, unknown> = {}
	spyOn(globalThis, 'fetch').mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	) => {
		url = String(input)
		body = JSON.parse(String(init?.body))
		return Response.json({
			model: 'gpt-6-luna',
			answers: [
				{ type: 'predicate', name: 'refund', probability: 0.91 },
				{
					type: 'choice',
					name: 'team',
					choice: 'billing',
					probabilities: [
						{ value: 'billing', probability: 0.8 },
						{ value: 'shipping', probability: 0.2 }
					],
					confidence: 0.6
				},
				{
					type: 'score',
					name: 'severity',
					score: 0.7,
					probabilities: [
						{ value: 0, label: '0', probability: 0.3 },
						{ value: 1, label: '1', probability: 0.7 }
					],
					confidence: 0.4
				}
			],
			usage: { input_tokens: 120, output_tokens: 0 }
		})
	}) as typeof fetch)

	const answers = await decide(
		{
			...ASK,
			questions: LUNA_QUESTIONS
		},
		'gpt-6-luna'
	)

	expect(url).toBe('https://api.openai.com/v1/decisions')
	// Object state travels as text, and a noul's gloss rides in its instructions.
	expect(body).toEqual({
		model: 'gpt-6-luna',
		input: JSON.stringify(ASK.state),
		questions: [
			{
				type: 'predicate',
				name: 'refund',
				instructions:
					'About a refund?\nTrue means: Wants money back\nFalse means: Anything else'
			},
			{
				type: 'choice',
				name: 'team',
				instructions: 'Which team?',
				choices: [
					{ value: 'billing', description: 'Payments' },
					{ value: 'shipping', description: 'Deliveries' }
				]
			},
			{
				type: 'score',
				name: 'severity',
				instructions: 'How severe?',
				levels: [
					{ label: '0', description: 'Minor' },
					{ label: '1', description: 'Major' }
				]
			}
		]
	})
	expect(answers?.refund.noul).toBe(0.91)
	expect(answers?.team).toEqual({
		type: 'choice',
		choice: 'billing',
		confidence: 0.6,
		probabilities: { billing: 0.8, shipping: 0.2 }
	})
	expect(answers?.severity.probabilities).toEqual({ '0': 0.3, '1': 0.7 })
})

test('a gpt-6-luna answer outside its question is rejected like any other', async () => {
	mockFetch(() =>
		Response.json({
			answers: [
				{
					type: 'choice',
					name: 'team',
					choice: 'sales',
					probabilities: [{ value: 'sales', probability: 1 }],
					confidence: 1
				}
			],
			usage: { input_tokens: 50, output_tokens: 0 }
		})
	)

	expect(
		await decide(
			{
				...ASK,
				questions: { team: LUNA_QUESTIONS.team }
			},
			'gpt-6-luna'
		)
	).toBeNull()
})

test('a gemini-decision-1 call speaks Gemini Decisions and answers in the shared shape', async () => {
	let url = ''
	let init: RequestInit | undefined
	spyOn(globalThis, 'fetch').mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		requestInit?: Parameters<typeof fetch>[1]
	) => {
		url = String(input)
		init = requestInit as RequestInit | undefined
		return Response.json({
			answers: {
				refund: { type: 'noul', noul: 0.91, confidence: 0.91 },
				team: {
					type: 'choice',
					choice: 'billing',
					probabilities: { billing: 0.8, shipping: 0.2 },
					confidence: 0.8
				},
				severity: {
					type: 'score',
					score: 0.7,
					legend: { '0': 'Minor', '1': 'Major' },
					probabilities: { '0': 0.3, '1': 0.7 },
					confidence: 0.7
				}
			},
			usage: {
				total_input_tokens: 120,
				input_tokens_by_modality: [{ modality: 'text', tokens: 120 }],
				total_output_tokens: 0,
				total_tokens: 120
			}
		})
	}) as typeof fetch)

	const outcome = await decide.result(
		{ ...ASK, questions: LUNA_QUESTIONS },
		'gemini-decision-1'
	)

	expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions')
	const headers = new Headers(init?.headers)
	expect(headers.get('x-goog-api-key')).toBe('google-key')
	expect(headers.has('authorization')).toBe(false)
	// Object state travels as text; a noul's gloss is renamed, the rest is as sent.
	expect(JSON.parse(String(init?.body))).toEqual({
		model: 'gemini-decision-1',
		input: JSON.stringify(ASK.state),
		questions: {
			refund: {
				type: 'noul',
				instructions: 'About a refund?',
				criteria: {
					true_description: 'Wants money back',
					false_description: 'Anything else'
				}
			},
			team: LUNA_QUESTIONS.team,
			severity: LUNA_QUESTIONS.severity
		}
	})
	if (!outcome.ok) throw outcome.error
	expect(outcome.answers.refund).toEqual({ type: 'noul', noul: 0.91 })
	expect(outcome.answers.team.choice).toBe('billing')
	expect(outcome.answers.severity).toEqual({
		type: 'score',
		score: 0.7,
		confidence: 0.7,
		probabilities: { '0': 0.3, '1': 0.7 }
	})
	expect(outcome.usage).toMatchObject({
		provider: 'google',
		inputTokens: 120,
		outputTokens: 0,
		costUsd: (120 * 0.1) / 1_000_000
	})
})

test('a Gemini 400 for a bad key is unauthorized', async () => {
	const spy = mockFetch(() =>
		Response.json(
			{
				error: {
					code: 400,
					message: 'API key not valid. Please pass a valid API key.',
					status: 'INVALID_ARGUMENT'
				}
			},
			{ status: 400 }
		)
	)

	const outcome = await decide.result(
		{ ...ASK, questions: QUESTIONS },
		'gemini-decision-1'
	)

	expect(outcome.ok ? undefined : outcome.error.kind).toBe('unauthorized')
	expect(spy).toHaveBeenCalledTimes(1)
})

test('retries once on a retryable status, then succeeds', async () => {
	const spy = mockFetch((_init, attempt) =>
		attempt === 0
			? new Response('slow down', { status: 429 })
			: answered({ refund: { type: 'noul', noul: 0.5 } })
	)

	const answers = await decide({ ...ASK, questions: QUESTIONS })

	expect(spy).toHaveBeenCalledTimes(2)
	expect(answers?.refund.noul).toBe(0.5)
})

test('drops the unread body of a retried response', async () => {
	let cancelled = false
	mockFetch((_init, attempt) =>
		attempt === 0
			? new Response(
					new ReadableStream({
						cancel: () => {
							cancelled = true
						}
					}),
					{ status: 503 }
				)
			: answered({ refund: { type: 'noul', noul: 0.5 } })
	)

	await decide({ ...ASK, questions: QUESTIONS })

	expect(cancelled).toBe(true)
})

test.each([
	{ retryAfter: '0', calls: 2 },
	// Not ready within this call's budget: retrying would only be billed.
	{ retryAfter: '60', calls: 1 },
	{ retryAfter: new Date(Date.now() + 60_000).toUTCString(), calls: 1 }
])('honours Retry-After $retryAfter', async ({ retryAfter, calls }) => {
	const spy = mockFetch((_init, attempt) =>
		attempt === 0
			? new Response('slow down', {
					status: 429,
					headers: { 'retry-after': retryAfter }
				})
			: answered({ refund: { type: 'noul', noul: 0.5 } })
	)

	await decide({ ...ASK, questions: QUESTIONS })

	expect(spy).toHaveBeenCalledTimes(calls)
})

test('a rejected request is not retried and answers null', async () => {
	const spy = mockFetch(() => new Response('bad question', { status: 422 }))

	expect(await decide({ ...ASK, questions: QUESTIONS })).toBeNull()
	// 422 is our bug, not the vendor's load: retrying it only doubles the cost.
	expect(spy).toHaveBeenCalledTimes(1)
})

test('a missing answer fails the whole call rather than returning a hole', async () => {
	mockFetch(() => answered({ refund: { type: 'noul', noul: 0.9 } }))

	// `urgent` was asked and did not come back: indexing it would read undefined
	// at a call site whose types promise otherwise.
	expect(
		await decide({
			...ASK,
			questions: {
				refund: { type: 'noul', instructions: 'About a refund?' },
				urgent: { type: 'noul', instructions: 'Urgent?' }
			}
		})
	).toBeNull()
})

test('a malformed answer answers null instead of throwing', async () => {
	mockFetch(() => answered({ refund: { type: 'noul', noul: 'very likely' } }))

	expect(await decide({ ...ASK, questions: QUESTIONS })).toBeNull()
})

test('rejects an answer kind that does not match its question', async () => {
	mockFetch(() =>
		answered({
			refund: {
				type: 'choice',
				choice: 'private',
				confidence: 1,
				probabilities: { private: 1 }
			}
		})
	)

	expect(await decide({ ...ASK, questions: QUESTIONS })).toBeNull()
})

test.each([-0.01, 1.01])('rejects an invalid probability %s', async (noul) => {
	mockFetch(() => answered({ refund: { type: 'noul', noul } }))

	expect(await decide({ ...ASK, questions: QUESTIONS })).toBeNull()
})

const CHOICE_QUESTION = {
	intent: {
		type: 'choice',
		instructions: 'Which topic?',
		criteria: { returns: 'a return', delivery: 'a delivery' }
	}
} satisfies Record<string, DecisionQuestion>

test.each([
	{
		choice: 'other',
		confidence: 1,
		probabilities: { returns: 1, delivery: 0 }
	},
	{ choice: 'returns', confidence: 1, probabilities: { returns: 1 } },
	{
		choice: 'returns',
		confidence: 1,
		probabilities: { returns: 1, delivery: 0, other: 0 }
	},
	{
		choice: 'returns',
		confidence: 1.1,
		probabilities: { returns: 1, delivery: 0 }
	},
	{
		choice: 'returns',
		confidence: 1,
		probabilities: { returns: 1.1, delivery: -0.1 }
	}
])('rejects a choice outside its declared contract: %j', async (answer) => {
	mockFetch(() => answered({ intent: { type: 'choice', ...answer } }))

	expect(await decide({ ...ASK, questions: CHOICE_QUESTION })).toBeNull()
})

const SCORE_QUESTION = {
	quality: {
		type: 'score',
		instructions: 'How complete is the answer?',
		criteria: ['Missing', 'Partial', 'Complete']
	}
} satisfies Record<string, DecisionQuestion>

test('accepts a fractional score within the requested rubric', async () => {
	mockFetch(() =>
		answered({
			quality: {
				type: 'score',
				score: 1.5,
				confidence: 0.3,
				probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 }
			}
		})
	)

	const answers = await decide({ ...ASK, questions: SCORE_QUESTION })

	expect(answers?.quality.score).toBe(1.5)
})

test.each([
	{ score: -1, probabilities: { '0': 1, '1': 0, '2': 0 } },
	{ score: 3, probabilities: { '0': 0, '1': 0, '2': 1 } },
	{ score: 1, probabilities: { '1': 1 } },
	{ score: 1, probabilities: { '0': 0, '1': 1, '2': 0, '3': 0 } }
])('rejects a score outside its rubric: %j', async (answer) => {
	mockFetch(() =>
		answered({ quality: { type: 'score', confidence: 1, ...answer } })
	)

	expect(await decide({ ...ASK, questions: SCORE_QUESTION })).toBeNull()
})

test('a request past the measured wall never leaves the process', async () => {
	const spy = mockFetch(() => answered({ refund: { type: 'noul', noul: 1 } }))
	const { decideWith, onError } = decideReporting({})

	// The API answers 400 past ~32.5k tokens (probe G4); paying for that round
	// trip to learn it buys nothing.
	expect(
		await decideWith({
			...ASK,
			state: 'x'.repeat(DECISION_MAX_REQUEST_CHARS + 1),
			questions: QUESTIONS
		})
	).toBeNull()
	// Questions are billed input too: a small state with many long ones is over as well.
	const questions = Object.fromEntries(
		Array.from({ length: 100 }, (_, index) => [
			`q${index}`,
			{ type: 'noul' as const, instructions: 'x'.repeat(1_000) }
		])
	)
	expect(await decideWith({ ...ASK, questions })).toBeNull()

	expect(spy).not.toHaveBeenCalled()
	expect(onError.mock.calls.map(([error]) => error.kind)).toEqual([
		'request-too-large',
		'request-too-large'
	])
})

test('a call over its model limits never leaves the process', async () => {
	const spy = mockFetch(() => answered({}))
	const { decideWith, onError } = decideReporting({})
	const many = Object.fromEntries(
		Array.from({ length: 65 }, (_, index) => [
			`q${index}`,
			{ type: 'noul' as const, instructions: 'Refund?' }
		])
	)
	const options = Object.fromEntries(
		Array.from({ length: 256 }, (_, index) => [`o${index}`, 'An option'])
	)

	await decideWith({ ...ASK, questions: many }, 'clef')
	await decideWith({
		...ASK,
		questions: {
			team: { type: 'choice', instructions: 'Which?', criteria: options }
		}
	})

	expect(spy).not.toHaveBeenCalled()
	expect(onError.mock.calls.map(([error]) => error.message)).toEqual([
		"65 questions, over clef's 64",
		`"team" has 256 options, over jev's 255`
	])
})

test('a provider refusing the token count is request-too-large', async () => {
	mockFetch(
		() => new Response('{"detail":"max_tokens_exceeded"}', { status: 400 })
	)
	const { decideWith, onError } = decideReporting({})

	await decideWith({ ...ASK, questions: QUESTIONS })
	expect(onError.mock.calls[0]?.[0]).toMatchObject({
		kind: 'request-too-large',
		status: 400
	})
})

test('no questions is not a request, and answers nothing', async () => {
	const spy = mockFetch(() => answered({}))

	expect(await decide({ ...ASK, questions: {} })).toEqual({})
	expect(spy).not.toHaveBeenCalled()
})

test('reports usage with its cost and the call context', async () => {
	mockFetch(() => answered({ refund: { type: 'noul', noul: 0.7 } }))
	const registerUsage = mock(
		(_usage: DecisionUsage, _context: { organizationId: string }) => {}
	)
	const decideWithUsage = createDecisionApi({
		keys: { typesafe: 'key' },
		defaultModel: 'jev',
		registerUsage
	})

	await decideWithUsage({
		...ASK,
		questions: QUESTIONS,
		organizationId: 'org_1'
	})

	const [usage, context] = registerUsage.mock.calls[0] ?? []
	expect(usage).toMatchObject({
		model: 'jev',
		provider: 'typesafe',
		inputTokens: 100,
		outputTokens: 3
	})
	// 100 tokens at Jev's $0.042 per million.
	expect(usage?.costUsd).toBeCloseTo(0.0000042, 12)
	// The call's own fields stay out of the context.
	expect(context).toEqual({ organizationId: 'org_1' })
})

test('says why a call answered null', async () => {
	mockFetch(() => new Response('bad question', { status: 422 }))
	const onError = mock(() => {})
	const decideWithErrors = createDecisionApi({
		keys: { typesafe: 'key' },
		defaultModel: 'jev',
		onError
	})

	expect(await decideWithErrors({ ...ASK, questions: QUESTIONS })).toBeNull()
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ kind: 'request-failed', model: 'jev' }),
		{}
	)
})

test('a custom fetch sends every request, told which provider and attempt it is', async () => {
	const send = mock(async () =>
		Response.json({
			answers: { refund: { type: 'noul', noul: 0.5 } },
			usage: { input_tokens: 1, output_tokens: 0 }
		})
	)
	const decideThroughProxy = createDecisionApi({
		keys: { typesafe: 'key' },
		defaultModel: 'jev',
		fetch: send
	})

	await decideThroughProxy({ ...ASK, questions: QUESTIONS })

	expect(send).toHaveBeenCalledWith(
		expect.objectContaining({ url: 'https://api.typesafe.ai/v1/systemone' }),
		expect.objectContaining({ model: 'jev', provider: 'typesafe', attempt: 0 })
	)
})

test('a call without a signal uses the default signal', async () => {
	const controller = new AbortController()
	controller.abort()
	const decideInOperation = createDecisionApi({
		keys: { typesafe: 'key' },
		defaultModel: 'jev',
		defaultSignal: () => controller.signal
	})
	mockFetch((init) => {
		if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
		return answered({ refund: { type: 'noul', noul: 0.5 } })
	})

	expect(await decideInOperation({ ...ASK, questions: QUESTIONS })).toBeNull()
})

test.each([
	[402, 'out-of-credits'],
	[401, 'unauthorized'],
	[500, 'request-failed']
])('a %i refusal reports kind %s with its status', async (status, kind) => {
	mockFetch(
		() =>
			new Response('refused', {
				status,
				// No retry wait for the 500.
				headers: { 'retry-after': '0' }
			})
	)
	const { decideWith, onError } = decideReporting({})

	expect(await decideWith({ ...ASK, questions: QUESTIONS })).toBeNull()
	expect(onError.mock.calls[0]?.[0]).toMatchObject({
		kind,
		status,
		model: 'jev',
		provider: 'typesafe',
		message: `jev ${status}: refused`
	})
})

test('a 429 that outlasts the retry is rate-limited', async () => {
	mockFetch(
		() =>
			new Response('slow down', {
				status: 429,
				headers: { 'retry-after': '0' }
			})
	)
	const { decideWith, onError } = decideReporting({})

	await decideWith({ ...ASK, questions: QUESTIONS })
	expect(onError.mock.calls[0]?.[0]).toMatchObject({
		kind: 'rate-limited',
		status: 429
	})
})

test('a transport error is retried once, and has no status', async () => {
	const spy = mockFetch(() => {
		throw new TypeError('fetch failed')
	})
	const { decideWith, onError } = decideReporting({})

	await decideWith({ ...ASK, questions: QUESTIONS })
	const error = onError.mock.calls[0]?.[0]
	expect(spy).toHaveBeenCalledTimes(2)
	expect(error?.kind).toBe('request-failed')
	expect(error?.status).toBeUndefined()
	expect(error?.attempts).toBe(2)
})

test('a transport error then an answer succeeds', async () => {
	mockFetch((_init, attempt) => {
		if (attempt === 0) throw new TypeError('fetch failed')
		return answered({ refund: { type: 'noul', noul: 0.5 } })
	})

	const outcome = await decide.result({ ...ASK, questions: QUESTIONS })
	expect(outcome.ok && outcome.usage?.attempts).toBe(2)
})

test('a 504 is retried', async () => {
	const spy = mockFetch((_init, attempt) =>
		attempt === 0
			? new Response('gateway', { status: 504 })
			: answered({ refund: { type: 'noul', noul: 0.5 } })
	)

	expect(await decide({ ...ASK, questions: QUESTIONS })).not.toBeNull()
	expect(spy).toHaveBeenCalledTimes(2)
})

test('a body that is not JSON is unreadable, not a failed request', async () => {
	mockFetch(() => new Response('<html>gateway</html>'))
	const { decideWith, onError } = decideReporting({})

	expect(await decideWith({ ...ASK, questions: QUESTIONS })).toBeNull()
	expect(onError.mock.calls[0]?.[0].kind).toBe('unreadable-response')
})

test('tells a timeout apart from an abort', async () => {
	// Answers only once its signal gives up, like a provider that hangs.
	mockFetch(
		(init) =>
			new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError'))
				)
			) as unknown as Response
	)
	const { decideWith, onError } = decideReporting({})

	await decideWith({ ...ASK, questions: QUESTIONS, timeoutMs: 5 })
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 5)
	await decideWith({ ...ASK, questions: QUESTIONS, signal: controller.signal })

	expect(onError.mock.calls.map(([error]) => error.kind)).toEqual([
		'timeout',
		'aborted'
	])
})

test('a call leaves no listener on a long-lived signal', async () => {
	mockFetch(() => answered({ refund: { type: 'noul', noul: 0.5 } }))
	const app = new AbortController()
	let listeners = 0
	const add = app.signal.addEventListener.bind(app.signal)
	const remove = app.signal.removeEventListener.bind(app.signal)
	app.signal.addEventListener = (...args: Parameters<typeof add>) => {
		listeners += 1
		add(...args)
	}
	app.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
		listeners -= 1
		remove(...args)
	}
	const { decideWith } = decideReporting({ defaultSignal: () => app.signal })

	for (let call = 0; call < 5; call++) {
		await decideWith({ ...ASK, questions: QUESTIONS })
	}

	expect(listeners).toBe(0)
})

/** A provider that never answers: it rejects only once its signal gives up. */
const hang = (init: RequestInit | undefined) =>
	new Promise<Response>((_resolve, reject) =>
		init?.signal?.addEventListener('abort', () =>
			reject(new DOMException('aborted', 'AbortError'))
		)
	) as unknown as Response

test('timeoutMs bounds the whole call, the retry included', async () => {
	mockFetch((init, attempt) =>
		attempt === 0
			? new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
			: hang(init)
	)
	const startedAt = Date.now()

	const outcome = await decide.result({
		...ASK,
		questions: QUESTIONS,
		timeoutMs: 50
	})

	expect(outcome.ok ? null : outcome.error.kind).toBe('timeout')
	// One deadline, not a fresh 50 ms per attempt.
	expect(Date.now() - startedAt).toBeLessThan(90)
	expect(outcome.ok ? null : outcome.error.attempts).toBe(2)
})

test('an attempt past attemptTimeoutMs is abandoned and sent again', async () => {
	const spy = mockFetch((init, attempt) =>
		attempt === 0
			? hang(init)
			: answered({ refund: { type: 'noul', noul: 0.5 } })
	)
	const { decideWith } = decideReporting({ attemptTimeoutMs: 20 })

	const outcome = await decideWith.result({ ...ASK, questions: QUESTIONS })

	expect(spy).toHaveBeenCalledTimes(2)
	expect(outcome.ok && outcome.usage?.attempts).toBe(2)
})

test('a Retry-After past the time left fails at once', async () => {
	const spy = mockFetch(
		() =>
			new Response('slow down', {
				status: 429,
				headers: { 'retry-after': '1' }
			})
	)
	const startedAt = Date.now()

	const outcome = await decide.result({
		...ASK,
		questions: QUESTIONS,
		timeoutMs: 500
	})

	expect(spy).toHaveBeenCalledTimes(1)
	expect(outcome.ok ? null : outcome.error.kind).toBe('rate-limited')
	expect(Date.now() - startedAt).toBeLessThan(100)
})

test('the pause before a retry ends with the caller signal', async () => {
	mockFetch(
		() =>
			new Response('slow down', {
				status: 503,
				headers: { 'retry-after': '2' }
			})
	)
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 20)
	const startedAt = Date.now()

	const outcome = await decide.result({
		...ASK,
		questions: QUESTIONS,
		signal: controller.signal,
		timeoutMs: 5_000
	})

	expect(outcome.ok ? null : outcome.error.kind).toBe('aborted')
	expect(Date.now() - startedAt).toBeLessThan(500)
})

test('result() answers the usage with the answers', async () => {
	mockFetch(() =>
		Response.json({
			model: 'jev-1.14',
			answers: { refund: { type: 'noul', noul: 0.7 } },
			usage: { input_tokens: 100, output_tokens: 3 }
		})
	)

	const outcome = await decide.result({ ...ASK, questions: QUESTIONS })

	if (!outcome.ok) throw outcome.error
	expect(outcome.answers.refund.noul).toBe(0.7)
	expect(outcome.usage).toMatchObject({
		model: 'jev',
		resolvedModel: 'jev-1.14',
		provider: 'typesafe',
		inputTokens: 100,
		attempts: 1
	})
})

test('result() answers the error instead of null', async () => {
	mockFetch(() => new Response('bad question', { status: 422 }))
	const { decideWith, onError } = decideReporting({})

	const outcome = await decideWith.result({ ...ASK, questions: QUESTIONS })

	if (outcome.ok) throw new Error('expected a failure')
	expect(outcome.error).toMatchObject({
		kind: 'request-failed',
		status: 422,
		attempts: 1
	})
	expect(outcome.error.latencyMs).toBeGreaterThanOrEqual(0)
	// onError still hears about it.
	expect(onError.mock.calls[0]?.[0]).toBe(outcome.error)
})

test('result() with no questions answers no usage', async () => {
	expect(await decide.result({ ...ASK, questions: {} })).toEqual({
		ok: true,
		answers: {},
		usage: null
	})
})

// Compile-time only: the keys decide which models exist, a default makes the
// model optional, and a typed usage context becomes required on every call.
function typeChecks() {
	const typesafeOnly = createDecisionApi({ keys: { typesafe: 'key' } })
	typesafeOnly({ ...ASK, questions: QUESTIONS }, 'jev')
	// @ts-expect-error no default model, so the call must name one
	typesafeOnly({ ...ASK, questions: QUESTIONS })
	// @ts-expect-error clef needs a Cloudflare key
	typesafeOnly({ ...ASK, questions: QUESTIONS }, 'clef')
	typesafeOnly(
		{ ...ASK, questions: QUESTIONS },
		// @ts-expect-error OpenRouter models need an OpenRouter key
		'microsoft/microsoft-decision-1'
	)

	createDecisionApi({
		keys: { typesafe: 'key' },
		// @ts-expect-error a default model needs its provider's key
		defaultModel: 'gpt-6-luna'
	})

	const withContext = createDecisionApi({
		keys: { openai: 'key' },
		defaultModel: 'gpt-6-luna',
		registerUsage: (_usage, _context: { organizationId: string }) => {}
	})
	withContext({ ...ASK, questions: QUESTIONS, organizationId: 'org_1' })
	// @ts-expect-error the usage context is required
	withContext({ ...ASK, questions: QUESTIONS })
	// @ts-expect-error result() takes the same arguments
	withContext.result({ ...ASK, questions: QUESTIONS })
	// @ts-expect-error result() is typed by the same keys
	typesafeOnly.result({ ...ASK, questions: QUESTIONS }, 'clef')
}
void typeChecks
