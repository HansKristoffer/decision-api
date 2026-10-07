import {
	buildDecisionRequest,
	DECISION_MODELS,
	type DecisionModel,
	type DecisionProvider,
	type DecisionProviderKeys,
	type ModelsFor,
	readDecisionResponse
} from './models.ts'
import {
	type DecisionAnswers,
	type DecisionQuestion,
	matchesQuestion
} from './questions.ts'

/**
 * Jev answers `400 max_tokens_exceeded` past roughly 32.5k input tokens (96k
 * chars passed, 128k did not). A state over this is refused before it leaves
 * the process; keep well under the wall, since tokenization varies. Clef takes
 * 64k tokens but silently truncates long state, so the same guard keeps it
 * from judging half a corpus.
 */
export const DECISION_MAX_STATE_CHARS = 90_000

/**
 * A generous ceiling rather than a target (Jev's p90 is ~280 ms for ten
 * questions): past it the caller is better served by its own fallback.
 */
const DEFAULT_TIMEOUT_MS = 4_000

/** Retried once: the providers' own guidance for these is to back off and retry. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const RETRY_DELAY_MS = 250
/**
 * A provider asking for a longer pause (`Retry-After`) will not be ready within
 * this call's budget: failing now beats paying for a doomed retry.
 */
const MAX_RETRY_DELAY_MS = 2_000

/** What one answered call cost; `costUsd` is priced from `DECISION_MODELS`. */
export type DecisionUsage<Model extends DecisionModel = DecisionModel> = {
	model: Model
	provider: DecisionProvider
	inputTokens: number
	outputTokens: number
	costUsd: number
	latencyMs: number
}

export type DecisionErrorKind =
	| 'state-too-large'
	/** No answer within `timeoutMs`. */
	| 'timeout'
	/** The call's own signal (or `defaultSignal`) aborted it. */
	| 'aborted'
	| 'request-failed'
	| 'unreadable-response'
	| 'answer-mismatch'
	| 'usage-failed'

export class DecisionError extends Error {
	constructor(
		readonly kind: DecisionErrorKind,
		readonly model: DecisionModel,
		message: string
	) {
		super(message)
		this.name = 'DecisionError'
	}
}

/** Sends one request. Replace it to route calls through your own budget or proxy. */
export type DecisionFetch = (
	request: { url: string; init: RequestInit },
	info: {
		model: DecisionModel
		provider: DecisionProvider
		attempt: number
		/** The same signal `init` carries: the call's own, plus its timeout. */
		signal: AbortSignal
	}
) => Promise<Response>

type DecisionCall<Q extends Record<string, DecisionQuestion>> = {
	/** A string, or named fields - name them when the state has several parts. */
	state: unknown
	questions: Q
	signal?: AbortSignal
	timeoutMs?: number
}

type DecisionApiOptions<Keys extends DecisionProviderKeys, Default, Context> = {
	keys: Keys
	/** Lets a call leave out its model. */
	defaultModel?: Default
	/**
	 * Called after every answered call. Whatever its second parameter is typed
	 * as becomes required on every call, so usage can be attributed.
	 */
	registerUsage?: (
		usage: DecisionUsage<ModelsFor<Keys>>,
		context: Context
	) => unknown
	/** Every reason a call answered `null`. */
	onError?: (error: DecisionError, context: Context) => void
	/** The signal of a call that passes none. */
	defaultSignal?: () => AbortSignal | undefined
	fetch?: DecisionFetch
	timeoutMs?: number
	maxStateChars?: number
}

/**
 * Ask one or more independent judgments about the same state.
 *
 * **Send every independent question in ONE call**: questions are evaluated
 * together, so extra ones are close to free, and latency tracks the size of
 * `state`, not the number of questions.
 *
 * **Answers `null` rather than throwing** - on a timeout, an abort, a
 * transport error, a rejected request or an answer that does not match its
 * question; `onError` says which. The right fallback belongs to the caller: a
 * tagging job treats `null` as "no tags this time", a policy guard as "refuse".
 * It throws only when there is no model at all - a setup bug TypeScript
 * already rejects, which a silent `null` would hide.
 */
export type DecisionApi<Model extends DecisionModel, Default, Context> = <
	Q extends Record<string, DecisionQuestion>
>(
	input: DecisionCall<Q> & Context,
	...model: [Default] extends [Model] ? [model?: Model] : [model: Model]
) => Promise<DecisionAnswers<Q> | null>

export function createDecisionApi<
	const Keys extends DecisionProviderKeys,
	Default extends ModelsFor<Keys> | undefined = undefined,
	Context extends object = Record<never, never>
>(
	options: DecisionApiOptions<Keys, Default, Context>
): DecisionApi<ModelsFor<Keys>, Default, Context> {
	const send: DecisionFetch =
		options.fetch ?? ((request) => fetch(request.url, request.init))
	const maxStateChars = options.maxStateChars ?? DECISION_MAX_STATE_CHARS

	return async (input, ...[requestedModel]) => {
		const { state, questions, signal, timeoutMs, ...rest } = input
		const context = rest as Context
		const model = requestedModel ?? options.defaultModel
		if (!model) throw new Error('No model given and no defaultModel set')

		const fail = (kind: DecisionErrorKind, message: string) => {
			options.onError?.(new DecisionError(kind, model, message), context)
			return null
		}

		if (Object.keys(questions).length === 0) {
			return {} as DecisionAnswers<typeof questions>
		}

		const stateText = typeof state === 'string' ? state : JSON.stringify(state)
		const stateChars = stateText.length
		if (stateChars > maxStateChars) {
			return fail(
				'state-too-large',
				`State is ${stateChars} chars, over ${maxStateChars}`
			)
		}

		const startedAt = Date.now()
		let text: string
		try {
			text = await postWithRetry({
				send,
				model,
				request: buildDecisionRequest(
					model,
					{ state, questions },
					options.keys
				),
				signal: signal ?? options.defaultSignal?.(),
				timeoutMs: timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
			})
		} catch (error) {
			if (error instanceof DecisionError) return fail(error.kind, error.message)
			return fail('request-failed', messageOf(error))
		}

		let json: unknown
		try {
			json = JSON.parse(text)
		} catch (error) {
			return fail('unreadable-response', messageOf(error))
		}

		const parsed = readDecisionResponse(model, json)
		if (!parsed.success) {
			return fail(
				'unreadable-response',
				parsed.error.issues[0]?.message ?? 'unknown'
			)
		}

		const { usage, answers } = parsed.data
		reportUsage(
			{
				model,
				provider: DECISION_MODELS[model].provider,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				costUsd:
					(usage.input_tokens * DECISION_MODELS[model].inputUsdPerMTok) /
					1_000_000,
				latencyMs: Date.now() - startedAt
			},
			context
		)

		for (const [key, question] of Object.entries(questions)) {
			if (!matchesQuestion(question, answers[key])) {
				return fail('answer-mismatch', `Answer to "${key}" does not fit it`)
			}
		}
		// Every requested key, kind and option set was validated above.
		return answers as DecisionAnswers<typeof questions>
	}

	/**
	 * Only a call that reached the provider is reported - a state over the
	 * wall, a timeout or an unreadable body reports nothing, so a 0 ms row can
	 * never flatter a latency percentile. A failing hook never fails the call.
	 */
	function reportUsage(
		usage: DecisionUsage<ModelsFor<Keys>>,
		context: Context
	) {
		const { registerUsage } = options
		if (!registerUsage) return
		if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return

		// One path for a hook that throws and one that rejects.
		Promise.resolve()
			.then(() => registerUsage(usage, context))
			.catch((error: unknown) => {
				const failure = new DecisionError(
					'usage-failed',
					usage.model,
					messageOf(error)
				)
				options.onError?.(failure, context)
			})
	}
}

/** The body of the first OK response, read under the same timeout as the request. */
async function postWithRetry(input: {
	send: DecisionFetch
	model: DecisionModel
	request: ReturnType<typeof buildDecisionRequest>
	signal: AbortSignal | undefined
	timeoutMs: number
}): Promise<string> {
	const provider = DECISION_MODELS[input.model].provider
	const failure = (kind: DecisionErrorKind, message: string) =>
		new DecisionError(kind, input.model, message)

	for (let attempt = 0; ; attempt++) {
		if (input.signal?.aborted) throw failure('aborted', 'Aborted by the caller')

		// A fresh timeout per attempt, so a retry gets its own budget.
		const timeout = AbortSignal.timeout(input.timeoutMs)
		const { signal, release } = linkSignals(timeout, input.signal)
		try {
			const response = await input.send(
				{
					url: input.request.url,
					init: {
						method: 'POST',
						headers: input.request.headers,
						body: input.request.body,
						// React Native's fetch types declare an AbortSignal of their own.
						signal: signal as unknown as NonNullable<RequestInit['signal']>
					}
				},
				{ model: input.model, provider, attempt, signal }
			)
			if (response.ok) return await response.text()

			const delayMs = retryDelayMs(response)
			if (
				attempt > 0 ||
				!RETRYABLE_STATUSES.has(response.status) ||
				delayMs > MAX_RETRY_DELAY_MS
			) {
				const body = (await response.text()).slice(0, 200)
				throw failure(
					'request-failed',
					`${input.model} ${response.status}: ${body}`
				)
			}
			// An unread body holds its connection until garbage collection.
			await response.body?.cancel().catch(() => {})
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		} catch (error) {
			if (error instanceof DecisionError) throw error
			if (input.signal?.aborted) throw failure('aborted', messageOf(error))
			if (timeout.aborted) {
				throw failure('timeout', `No answer within ${input.timeoutMs} ms`)
			}
			throw error
		} finally {
			release()
		}
	}
}

/** The pause a response asks for, in seconds or as a date; our own without one. */
function retryDelayMs(response: Response) {
	const header = response.headers.get('retry-after')?.trim()
	if (!header) return RETRY_DELAY_MS
	const seconds = Number(header)
	const ms = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(header) - Date.now()
	return Number.isNaN(ms) ? RETRY_DELAY_MS : Math.max(0, ms)
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * The timeout plus the caller's signal, whichever fires first. Combined by hand
 * rather than with `AbortSignal.any`, which older DOM libs (React Native's
 * among them) do not declare. `release` unhooks the caller's signal, which may
 * outlive every call made with it.
 */
function linkSignals(timeout: AbortSignal, signal: AbortSignal | undefined) {
	if (!signal) return { signal: timeout, release: () => {} }

	const controller = new AbortController()
	const abort = () => controller.abort()
	if (timeout.aborted || signal.aborted) abort()
	timeout.addEventListener('abort', abort, { once: true })
	signal.addEventListener('abort', abort, { once: true })
	return {
		signal: controller.signal,
		release: () => {
			timeout.removeEventListener('abort', abort)
			signal.removeEventListener('abort', abort)
		}
	}
}
