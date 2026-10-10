# decision-api

One client for decision models: models that answer typed questions with calibrated probabilities instead of text. It speaks TypeSafe's Jev, Cloudflare's Clef and Clef-flash (Workers AI), OpenAI's gpt-6-luna and the decision models on OpenRouter (such as `microsoft/microsoft-decision-1`), and returns the same answer shape from all of them. It depends only on `zod`.

```sh
npm install decision-api
```

```ts
import { createDecisionApi } from 'decision-api'

const decide = createDecisionApi({
	keys: {
		typesafe: '…',
		cloudflare: { apiToken: '…', accountId: '…' },
		openai: '…',
		openrouter: '…' // every OpenRouter model, named by its slug
	},
	defaultModel: 'jev',
	registerUsage: (usage, context: { customerId: string }) => {
		// usage: model, provider, inputTokens, outputTokens, costUsd, latencyMs
	},
	onError: (error, context) => console.warn(error.kind, error.message)
})

const answers = await decide(
	{
		state: { message: 'I was charged twice' },
		questions: {
			refund: { type: 'noul', instructions: 'Does the customer want money back?' },
			team: {
				type: 'choice',
				instructions: 'Which team handles this?',
				criteria: { billing: 'Payments and refunds', other: 'Anything else' }
			}
		},
		customerId: 'c_1'
	},
	'gpt-6-luna' // optional when defaultModel is set
)

answers?.refund.noul // number
answers?.team.choice // 'billing' | 'other'
```

TypeScript enforces the setup:

- **Keys select models.** Only models whose provider key you passed can be named, as `defaultModel` or per call. A key typed `string | undefined` (a raw `process.env` read) does not count; narrow it first. One `openrouter` key opens every OpenRouter model at once; a new one is added as its slug and price in `DECISION_MODELS`.
- **The model is optional only with a default.** Without `defaultModel`, every call must name one.
- **Usage context is required when typed.** The type of `registerUsage`'s second parameter is required on every call and passed back to `registerUsage` and `onError`.

A call answers `null` instead of throwing, and `onError` says why: `timeout`, `aborted` (the call's own signal), `unauthorized` (401/403, a bad key), `out-of-credits` (402), `rate-limited` (429 after the retry), `request-failed` (any other status, or a transport error), `state-too-large`, `unreadable-response` or `answer-mismatch`. Every error carries its `model` and `provider`, and `status` when the provider answered; a throwing `registerUsage` reports `usage-failed` without failing the call. Retryable statuses (429 and 5xx) are retried once, after the provider's `Retry-After` when it asks for 2 s or less, and not at all when it asks for more. `fetch` replaces the transport, for example to route calls through your own rate limits, and `defaultSignal` supplies the signal for calls that pass none. A call with no questions answers `{}` without a request. The one throw is a call with no model and no `defaultModel`, which TypeScript already rejects.

## Benchmark

`bun run bench` asks every model with a key the fixed questions in [`bench/cases.ts`](bench/cases.ts) and writes `.artifacts/bench/report.html`: accuracy against the expected answers, probability on the right answer, latency p50/p90 and cost per model, every answer side by side, and a closing leaderboard that scores each model out of 100 (one point per right answer, a failed call scores zero). Keys come from the environment or `.env`: copy [`.env.example`](.env.example) to `.env` and fill in the providers you have; `--runs=5` and `--models=jev,clef` narrow or widen a run.

Results from 2026-10-10 (12 cases, 21 questions, 3 runs per case):

| # | Model | Score | Points | p(correct) | Latency p50 / p90 | Cost / 1k calls |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `jev` | 100 | 21 / 21 | 96% | 262 / 292 ms | $0.017 |
| 2 | `clef` | 100 | 21 / 21 | 94% | 292 / 550 ms | $0.067 |
| 3 | `microsoft/microsoft-decision-1` | 95.2 | 20 / 21 | 95% | 354 / 819 ms | $0.005 |
| 4 | `gpt-6-luna` | 95.2 | 20 / 21 | 94% | 149 / 264 ms | $0.029 |
| 5 | `clef-flash` | 95.2 | 20 / 21 | 85% | 227 / 662 ms | $0.025 |

## Releasing

Squash PRs with conventional titles (`fix:`, `feat:`, or `feat!:`). Release Please keeps the version and changelog in a release PR; merge that PR to publish with release notes and npm provenance. See [release and recovery instructions](docs/releasing.md).

## License

[MIT](LICENSE).
