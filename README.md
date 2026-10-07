# decision-api

One client for decision models: models that answer typed questions with calibrated probabilities instead of text. It speaks TypeSafe's Jev, Cloudflare's Clef and Clef-flash (Workers AI) and OpenAI's gpt-6-luna, and returns the same answer shape from all of them. It depends only on `zod`.

```sh
npm install decision-api
```

```ts
import { createDecisionApi } from 'decision-api'

const decide = createDecisionApi({
	keys: {
		typesafe: '…',
		cloudflare: { apiToken: '…', accountId: '…' },
		openai: '…'
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

- **Keys select models.** Only models whose provider key you passed can be named, as `defaultModel` or per call. A key typed `string | undefined` (a raw `process.env` read) does not count; narrow it first.
- **The model is optional only with a default.** Without `defaultModel`, every call must name one.
- **Usage context is required when typed.** The type of `registerUsage`'s second parameter is required on every call and passed back to `registerUsage` and `onError`.

A call answers `null` instead of throwing, and `onError` says why: `timeout`, `aborted` (the call's own signal), `request-failed`, `state-too-large`, `unreadable-response` or `answer-mismatch`; a throwing `registerUsage` reports `usage-failed` without failing the call. Retryable statuses (429 and 5xx) are retried once, after the provider's `Retry-After` when it asks for 2 s or less, and not at all when it asks for more. `fetch` replaces the transport, for example to route calls through your own rate limits, and `defaultSignal` supplies the signal for calls that pass none. A call with no questions answers `{}` without a request. The one throw is a call with no model and no `defaultModel`, which TypeScript already rejects.

## Releasing

Squash PRs with conventional titles (`fix:`, `feat:`, or `feat!:`). Release Please keeps the version and changelog in a release PR; merge that PR to publish with release notes and npm provenance. See [release and recovery instructions](docs/releasing.md).

## License

[MIT](LICENSE).
