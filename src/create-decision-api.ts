import {
	collectMedia,
	type DecisionMedia,
	type DecisionMediaKind,
	type DecisionMediaText,
	type DecisionText,
	detachedReference
} from './media.ts'
import {
	buildDecisionRequest,
	DECISION_MODELS,
	type DecisionMediaModel,
	type DecisionModel,
	type DecisionProvider,
	type DecisionProviderKeys,
	type ModelsFor,
	overModelLimit,
	readDecisionResponse,
	readsMedia
} from './models.ts'
import {
	type DecisionAnswers,
	type DecisionQuestion,
	matchesQuestion
} from './questions.ts'

/**
 * Jev answers `400 max_tokens_exceeded` past roughly 32.5k input tokens (96k
 * chars of state passed, 128k did not). Every question's instructions and
 * criteria count too, so a request whose state and questions together are over
 * this is refused before it leaves the process; keep well under the wall,
 * since tokenization varies. Clef takes 64k tokens but silently truncates long
 * state, so the same guard keeps it from judging half a corpus.
 */
export const DECISION_MAX_REQUEST_CHARS = 90_000

/**
 * A generous ceiling rather than a target (Jev's p90 is ~280 ms for ten
 * questions): past it the caller is better served by its own fallback.
 */
const DEFAULT_TIMEOUT_MS = 4_000

/** Retried once: the providers' own guidance for these is to back off and retry. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])
const RETRY_DELAY_MS = 250
/**
 * A provider asking for a longer pause (`Retry-After`) will not be ready within
 * this call's budget: failing now beats paying for a doomed retry.
 */
const MAX_RETRY_DELAY_MS = 2_000

/** What one answered call cost; `costUsd` is priced from `DECISION_MODELS`. */
export type DecisionUsage<Model extends DecisionModel = DecisionModel> = {
	model: Model
	/**
	 * The model the provider says answered, when it says: an alias such as
	 * `jev` (sent as `jev-latest`) resolves to a release here.
	 */
	resolvedModel?: string
	provider: DecisionProvider
	inputTokens: number
	outputTokens: number
	costUsd: number
	/** From the first request to the answer, retries included. */
	latencyMs: number
	/** Requests sent: 2 when the first was retried. */
	attempts: number
}

export type DecisionErrorKind =
	/**
	 * The state and questions together are over `maxRequestChars`, the call is
	 * over the model's question, option or level limit (`DECISION_MODELS`), or
	 * the provider refused it as too many tokens.
	 */
	| 'request-too-large'
	/** The call holds an image and the model reads none (`images: false`). */
	| 'images-unsupported'
	/** The call holds a video, audio or a PDF and the model does not read that kind. */
	| 'media-unsupported'
	/** A file's reference is in the text without the file: build that text with `withMedia`. */
	| 'image-detached'
	/** No answer within `timeoutMs`, retries included. */
	| 'timeout'
	/**
	 * The call's own signal (or `defaultSignal`) aborted it: the caller's own
	 * doing, which an `onError` that logs failures may want to skip.
	 */
	| 'aborted'
	/**
	 * 401 or 403, or Gemini's 400 for a key that is not valid: the provider
	 * rejected the key. Retrying will not help.
	 */
	| 'unauthorized'
	/** 402: the provider's account is out of credits. Retrying will not help. */
	| 'out-of-credits'
	/** 429 that outlasted the retry, or asked to wait longer than a call can. */
	| 'rate-limited'
	/** Any other refused request (see `status`), or a transport error (no `status`). */
	| 'request-failed'
	| 'unreadable-response'
	| 'answer-mismatch'
	| 'usage-failed'

export class DecisionError extends Error {
	readonly provider: DecisionProvider
	/** From the start of the call to this failure. Set by the client. */
	latencyMs = 0
	/** Requests sent before this failure: 0 when it failed before sending. */
	attempts = 0

	constructor(
		readonly kind: DecisionErrorKind,
		readonly model: DecisionModel,
		message: string,
		/** The HTTP status, when the provider answered. */
		readonly status?: number
	) {
		super(message)
		this.name = 'DecisionError'
		this.provider = DECISION_MODELS[model].provider
	}
}

const KIND_BY_STATUS: Partial<Record<number, DecisionErrorKind>> = {
	401: 'unauthorized',
	402: 'out-of-credits',
	403: 'unauthorized',
	429: 'rate-limited'
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

type DecisionCall<Q extends Record<string, DecisionQuestion>, State> = {
	/**
	 * A string, or named fields - name them when the state has several parts.
	 * Images, video, audio and PDFs go in as values, on models that read them.
	 */
	state: State
	questions: Q
	signal?: AbortSignal
	/** The whole call, retries and pauses included. */
	timeoutMs?: number
	/** One request; see `attemptTimeoutMs` on `createDecisionApi`. */
	attemptTimeoutMs?: number
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
	/** The whole call, retries and pauses included. Defaults to 4 s. */
	timeoutMs?: number
	/**
	 * Abandon a request that has not answered by then and send one more, while
	 * `timeoutMs` leaves time. Off by default; the abandoned request may still
	 * be billed.
	 */
	attemptTimeoutMs?: number
	/** State plus questions, in characters. Defaults to `DECISION_MAX_REQUEST_CHARS`. */
	maxRequestChars?: number
}

/** What `decide.result()` answers: the answers and their usage, or why there are none. */
export type DecisionResult<
	Q extends Record<string, DecisionQuestion>,
	Model extends DecisionModel = DecisionModel
> =
	| {
			ok: true
			answers: DecisionAnswers<Q>
			/** `null` only for a call with no questions, which sends nothing. */
			usage: DecisionUsage<Model> | null
	  }
	| { ok: false; error: DecisionError }

/**
 * Ask one or more independent judgments about the same state.
 *
 * **Send every independent question in ONE call**: questions are evaluated
 * together, so extra ones add next to nothing to latency, which tracks the
 * size of `state`. They are not free: every question's instructions and
 * criteria are billed as input tokens.
 *
 * **Answers `null` rather than throwing** - on a timeout, an abort, a
 * transport error, a rejected request or an answer that does not match its
 * question; `onError` says which. The right fallback belongs to the caller: a
 * tagging job treats `null` as "no tags this time", a policy guard as "refuse".
 * It throws only when there is no model at all - a setup bug TypeScript
 * already rejects, which a silent `null` would hide.
 *
 * `decide.result()` takes the same arguments and answers the usage with the
 * answers, or the error instead of `null`.
 */
export type DecisionApi<Model extends DecisionModel, Default, Context> = {
	<Q extends Record<string, DecisionQuestion>, State = unknown>(
		input: DecisionCall<Q, State> & Context,
		...model: DecisionModelArgument<Model, Default, Q, State>
	): Promise<DecisionAnswers<Q> | null>
	result<Q extends Record<string, DecisionQuestion>, State = unknown>(
		input: DecisionCall<Q, State> & Context,
		...model: DecisionModelArgument<Model, Default, Q, State>
	): Promise<DecisionResult<Q, Model>>
}

type DecisionModelArgument<
	Model extends DecisionModel,
	Default,
	Q,
	State
> = ModelArgument<ModelsReading<Model, MediaIn<State> | MediaIn<Q>>, Default>

/** The models that read every kind of file a call holds; all of them for none. */
type ModelsReading<Model, Kinds extends DecisionMediaKind> = [Kinds] extends [
	never
]
	? Model
	: Extract<Model, DecisionMediaModel<Kinds>>

type ModelArgument<Model, Default> = [Default] extends [Model]
	? [model?: Model]
	: [model: Model]

/**
 * The kinds of file a call's state or questions hold, as far as their types
 * tell: a value typed as any text (`DecisionText`, `unknown`, `any`) does not
 * say, and the call checks it instead. Stops at a few levels deep, so a
 * recursive JSON type cannot recurse forever.
 */
type MediaIn<T, Depth extends unknown[] = []> = 0 extends 1 & T
	? never
	: [DecisionText] extends [T]
		? never
		: Depth['length'] extends 6
			? never
			: MediaOf<T, [...Depth, unknown]>

type MediaOf<T, Depth extends unknown[]> =
	T extends DecisionMedia<infer Kind>
		? Kind
		: T extends DecisionMediaText<infer Kind>
			? Kind
			: T extends readonly (infer Item)[]
				? MediaIn<Item, Depth>
				: T extends object
					? { [K in keyof T]-?: MediaIn<T[K], Depth> }[keyof T]
					: never

export function createDecisionApi<
	const Keys extends DecisionProviderKeys,
	Default extends ModelsFor<Keys> | undefined = undefined,
	Context extends object = Record<never, never>
>(
	options: DecisionApiOptions<Keys, Default, Context>
): DecisionApi<ModelsFor<Keys>, Default, Context> {
	const send: DecisionFetch =
		options.fetch ?? ((request) => fetch(request.url, request.init))
	const maxRequestChars = options.maxRequestChars ?? DECISION_MAX_REQUEST_CHARS
	type Model = ModelsFor<Keys>
	type Result = DecisionResult<Record<string, DecisionQuestion>, Model>

	const result = async (
		input: DecisionCall<Record<string, DecisionQuestion>, unknown> & Context,
		requestedModel?: Model
	): Promise<Result> => {
		const calledAt = Date.now()
		const { state, questions, signal, timeoutMs, attemptTimeoutMs, ...rest } =
			input
		const context = rest as Context
		const model = requestedModel ?? options.defaultModel
		if (!model) throw new Error('No model given and no defaultModel set')

		const report = (error: DecisionError): Result => {
			error.latencyMs = Date.now() - calledAt
			options.onError?.(error, context)
			return { ok: false, error }
		}
		const fail = (kind: DecisionErrorKind, message: string) =>
			report(new DecisionError(kind, model, message))

		if (Object.keys(questions).length === 0) {
			return { ok: true, answers: {}, usage: null }
		}

		// An image counts as its reference here: its tokens are the provider's to count.
		const stateText = typeof state === 'string' ? state : JSON.stringify(state)
		const questionsText = JSON.stringify(questions)
		const requestChars = stateText.length + questionsText.length
		if (requestChars > maxRequestChars) {
			return fail(
				'request-too-large',
				`State and questions are ${requestChars} chars, over ${maxRequestChars}`
			)
		}
		const overLimit = overModelLimit(model, questions)
		if (overLimit) return fail('request-too-large', overLimit)

		const media = collectMedia(questions, collectMedia(state))
		const detached = detachedReference(stateText + questionsText, media)
		if (detached) {
			return fail(
				'image-detached',
				`${detached} is in the text without its file; write that text with withMedia`
			)
		}
		const unread = [...media.values()].find(
			(item) => !readsMedia(model, item.kind)
		)
		if (unread?.kind === 'image') {
			return fail('images-unsupported', `${model} does not read images`)
		}
		if (unread) {
			return fail('media-unsupported', `${model} does not read ${unread.kind}`)
		}

		const startedAt = Date.now()
		let sent: { text: string; attempts: number }
		try {
			sent = await postWithRetry({
				send,
				model,
				request: buildDecisionRequest(
					model,
					{ state, questions, media: [...media.values()] },
					options.keys
				),
				signal: signal ?? options.defaultSignal?.(),
				timeoutMs: timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				attemptTimeoutMs: attemptTimeoutMs ?? options.attemptTimeoutMs
			})
		} catch (error) {
			if (error instanceof DecisionError) return report(error)
			return fail('request-failed', messageOf(error))
		}
		const failAfterSend = (kind: DecisionErrorKind, message: string) => {
			const error = new DecisionError(kind, model, message)
			error.attempts = sent.attempts
			return report(error)
		}

		let json: unknown
		try {
			json = JSON.parse(sent.text)
		} catch (error) {
			return failAfterSend('unreadable-response', messageOf(error))
		}

		const parsed = readDecisionResponse(model, json)
		if (!parsed.success) {
			return failAfterSend(
				'unreadable-response',
				parsed.error.issues[0]?.message ?? 'unknown'
			)
		}

		const { usage: tokens, answers, model: resolvedModel } = parsed.data
		const usage: DecisionUsage<Model> = {
			model,
			...(resolvedModel !== undefined && { resolvedModel }),
			provider: DECISION_MODELS[model].provider,
			inputTokens: tokens.input_tokens,
			outputTokens: tokens.output_tokens,
			costUsd:
				(tokens.input_tokens * DECISION_MODELS[model].inputUsdPerMTok) /
				1_000_000,
			latencyMs: Date.now() - startedAt,
			attempts: sent.attempts
		}
		reportUsage(usage, context)

		for (const [key, question] of Object.entries(questions)) {
			if (!matchesQuestion(question, answers[key])) {
				return failAfterSend(
					'answer-mismatch',
					`Answer to "${key}" does not fit it`
				)
			}
		}
		// Every requested key, kind and option set was validated above.
		return {
			ok: true,
			answers: answers as DecisionAnswers<Record<string, DecisionQuestion>>,
			usage
		}
	}

	const decide = async (input: Parameters<typeof result>[0], model?: Model) => {
		const outcome = await result(input, model)
		return outcome.ok ? outcome.answers : null
	}

	// The call signatures above are checked per call; one implementation serves them all.
	return Object.assign(decide, { result }) as unknown as DecisionApi<
		Model,
		Default,
		Context
	>

	/**
	 * Only a call that reached the provider is reported - a request over the
	 * wall, a timeout or an unreadable body reports nothing, so a 0 ms row can
	 * never flatter a latency percentile (`onError` carries `latencyMs` for
	 * those). A failing hook never fails the call.
	 */
	function reportUsage(usage: DecisionUsage<Model>, context: Context) {
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

/**
 * The body of the first OK response and how many requests it took. One
 * deadline (`timeoutMs`) bounds every attempt, the pause between them and the
 * body read. A retryable status, a transport error or an abandoned attempt
 * (`attemptTimeoutMs`) is retried once, when the deadline leaves time for it.
 */
async function postWithRetry(input: {
	send: DecisionFetch
	model: DecisionModel
	request: ReturnType<typeof buildDecisionRequest>
	signal: AbortSignal | undefined
	timeoutMs: number
	attemptTimeoutMs: number | undefined
}): Promise<{ text: string; attempts: number }> {
	const provider = DECISION_MODELS[input.model].provider
	const endsAt = Date.now() + input.timeoutMs
	let attempts = 0
	const failure = (
		kind: DecisionErrorKind,
		message: string,
		status?: number
	) => {
		const error = new DecisionError(kind, input.model, message, status)
		error.attempts = attempts
		return error
	}
	const timedOut = () =>
		failure('timeout', `No answer within ${input.timeoutMs} ms`)

	for (let attempt = 0; ; attempt++) {
		if (input.signal?.aborted) throw failure('aborted', 'Aborted by the caller')
		const remainingMs = endsAt - Date.now()
		if (remainingMs <= 0) throw timedOut()
		const canRetry = attempt === 0

		const attemptMs = Math.min(
			input.attemptTimeoutMs ?? remainingMs,
			remainingMs
		)
		const timeout = AbortSignal.timeout(attemptMs)
		const { signal, release } = linkSignals(timeout, input.signal)
		attempts += 1
		let delayMs = RETRY_DELAY_MS
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
			if (response.ok) return { text: await response.text(), attempts }

			delayMs = retryDelayMs(response)
			if (
				!canRetry ||
				!RETRYABLE_STATUSES.has(response.status) ||
				delayMs > MAX_RETRY_DELAY_MS ||
				delayMs >= endsAt - Date.now()
			) {
				const body = (await response.text()).slice(0, 200)
				throw failure(
					kindOf(response.status, body),
					`${input.model} ${response.status}: ${body}`,
					response.status
				)
			}
			// An unread body holds its connection until garbage collection.
			await response.body?.cancel().catch(() => {})
		} catch (error) {
			if (error instanceof DecisionError) throw error
			if (input.signal?.aborted) throw failure('aborted', messageOf(error))
			if (timeout.aborted) {
				// The deadline itself, or the last attempt: nothing left to try.
				if (attemptMs >= remainingMs || !canRetry) throw timedOut()
				continue
			}
			if (!canRetry || RETRY_DELAY_MS >= endsAt - Date.now()) {
				throw failure('request-failed', messageOf(error))
			}
		} finally {
			release()
		}
		await pause(delayMs, input.signal).catch(() => {
			throw failure('aborted', 'Aborted by the caller')
		})
	}
}

/** The kind a refused response maps to; anything unlisted is `request-failed`. */
function kindOf(status: number, body: string): DecisionErrorKind {
	if (status === 413 || (status === 400 && /max_tokens_exceeded/.test(body))) {
		return 'request-too-large'
	}
	// Gemini answers a bad key with 400 rather than 401.
	if (status === 400 && /API key not valid|API_KEY_INVALID/.test(body)) {
		return 'unauthorized'
	}
	return KIND_BY_STATUS[status] ?? 'request-failed'
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason)
		const timer = setTimeout(done, ms)
		signal?.addEventListener('abort', done, { once: true })
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			if (signal?.aborted) reject(signal.reason)
			else resolve()
		}
	})
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
