# decision-api

One client for decision models: models that answer typed questions with calibrated probabilities instead of text. It speaks TypeSafe's Jev, Cloudflare's Clef and Clef-flash (Workers AI), OpenAI's gpt-6-luna and the decision models on OpenRouter (such as `microsoft/microsoft-decision-1` and `typesafe/jev-1.13`), and returns the same answer shape from all of them. Jev also reads images. It depends only on `zod`.

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
		// usage: model, resolvedModel, provider, inputTokens, outputTokens,
		// costUsd, latencyMs, attempts
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

A call answers `null` instead of throwing, and `onError` says why: `timeout`, `aborted` (the call's own signal: your own doing, so a logging `onError` may skip it), `unauthorized` (401/403, a bad key), `out-of-credits` (402), `rate-limited` (429 after the retry), `request-failed` (any other status, or a transport error), `request-too-large` (see below), `images-unsupported`, `image-detached` (see [Images](#images)), `unreadable-response` or `answer-mismatch`. Every error carries its `model` and `provider`, `status` when the provider answered, `latencyMs` and `attempts`; a throwing `registerUsage` reports `usage-failed` without failing the call. `fetch` replaces the transport, for example to route calls through your own rate limits, and `defaultSignal` supplies the signal for calls that pass none. A call with no questions answers `{}` without a request. The one throw is a call with no model and no `defaultModel`, which TypeScript already rejects.

**Timeouts and retries.** `timeoutMs` (default 4 s, per client or per call) bounds the whole call: every attempt, the pause between them and the body read. A status of 429, 500, 502, 503, 504 or 529 and a transport error are retried once, after the provider's `Retry-After` when it asks for 2 s or less and the deadline leaves time for it; otherwise the call fails at once. `attemptTimeoutMs` (off by default) abandons a request that has not answered by then and sends one more while time remains, so a voice turn can set `timeoutMs: 1_200, attemptTimeoutMs: 500` and still get a second try. An abandoned request may still be billed.

**Size.** The state and questions together are measured before sending: past `maxRequestChars` (default `DECISION_MAX_REQUEST_CHARS`, 90k characters, under Jev's ~32.5k-token wall) the call fails with `request-too-large` and nothing is sent. So does a call over its model's `maxQuestions`, `maxChoices` (options in one choice) or `maxLevels` (levels in one score) in `DECISION_MODELS`, and a provider's own token-limit refusal maps to the same kind. Extra questions add next to nothing to latency, but every question's instructions and criteria are billed as input tokens.

## Usage and errors per call

`decide.result()` takes the same arguments as `decide()` and answers what happened, so a caller can store the model, tokens and latency next to its own record, or the reason there is no answer, without a side channel through the usage context:

```ts
const outcome = await decide.result({ state, questions, customerId: 'c_1' })
if (outcome.ok) {
	outcome.answers // as decide() answers them
	outcome.usage // DecisionUsage; null for a call with no questions
} else {
	outcome.error // DecisionError: kind, status, latencyMs, attempts
}
```

`registerUsage` and `onError` still run. `usage.resolvedModel` is the model the provider says answered, when it says: TypeSafe resolves `jev` (sent as `jev-latest`) to a release there, so a new Jev release shows up in your rows.

## One question per item

`perItem` asks the same question about each item of a list under keys `prefix_0`, `prefix_1`… and reads the answers back typed, with no key helpers and no `undefined` to default:

```ts
import { perItem } from 'decision-api'

const perBlock = perItem(blocks, 'block', (block, index) => ({
	type: 'noul',
	instructions: `Does \`blocks[${index}]\` hold private material?`
}))
const answers = await decide({
	state: { blocks },
	questions: { ...perBlock.questions, rules },
	customerId: 'c_1'
})
for (const { item, answer } of answers ? perBlock.read(answers) : []) {
	if (answer.noul >= 0.35) flagged.push(item.id)
}
```

The single answer types are exported too: `DecisionNoulAnswer`, `DecisionChoiceAnswer`, `DecisionScoreAnswer` and their union `DecisionAnswer`.

## Images

`jev` and `typesafe/jev-1.13` read images (`images: true` in `DECISION_MODELS`). Make one with `image()` from PNG or JPEG bytes or base64, and put it anywhere text can go: in the state, as a question's instructions or as a criterion. Inside a sentence, write it into a `withImages` template:

```ts
import { image, withImages } from 'decision-api'
import { readFile } from 'node:fs/promises'

const door = image(await readFile('door-camera.jpg'))
const badge = image(await readFile('badge.jpg'))
const thumbsUp = image(await readFile('thumbs-up.png'))

const answers = await decide({
	state: { door },
	questions: {
		same: {
			type: 'noul',
			instructions: withImages`Is the person in \`door\` the one on this badge: ${badge}?`
		},
		gesture: {
			type: 'choice',
			instructions: 'Which gesture does the hand in `door` make?',
			criteria: { thumbs_up: thumbsUp, none: 'No hand, or another gesture' }
		}
	},
	customerId: 'c_1'
})
```

Each image is sent once, base64-encoded under a unique reference, however often it is used; every use still counts as input tokens. TypeSafe's image preview header is added for you. Put an image several questions use in the state, not in each question's instructions.

- **TypeScript rejects an image on a model that reads none**, when the image's type is visible in the call. Questions typed as `Record<string, DecisionQuestion>` don't show it, so the call checks as well and answers `null` with `images-unsupported`.
- **A plain template loses the image.** `` `Same as ${badge}?` `` writes only the reference; the call answers `null` with `image-detached` instead of asking about a bare string.
- **Prepare images first.** `image()` throws for anything but PNG or JPEG. Jev rejects images, and never resizes them, outside 280 to 1568 px a side or over 16 MiB, and ignores EXIF orientation, so scale and rotate before sending ([limits](https://docs.typesafe.ai/images#limits)). TypeSafe calls images a preview: the format and accuracy may change between Jev releases.

## Testing

`decision-api/testing` has a fake client typed as the real one, so a test needs no cast. A number answers a noul or a score, a string a choice, or give the full answer. An answer that does not fit its question, or a missing one, throws in the test, since the real client would never return it:

```ts
import { fakeDecide } from 'decision-api/testing'

const ask = fakeDecide<typeof decide>(() => ({ agreed: 0.9, team: 'billing' }))
const down = fakeDecide<typeof decide>(() => null) // fails as request-failed
ask.calls[0]?.questions // what the code under test sent
```

## Evaluating thresholds

`decision-api/eval` runs labelled cases against a real client and reports each question at the threshold your code ships. The app brings the cases; a case is a call plus the answers a careful human would give:

```ts
import { report, runCases } from 'decision-api/eval'

const logs = await runCases({
	decide,
	cases: [{ name: 'salary slip', state, questions, expected: { private: true } }],
	runs: 3,
	models: ['jev'], // the client's default when left out
	context: { customerId: 'eval' } // when registerUsage types a context
})
const summary = report(logs, { thresholds: { private: 0.35 } })
if (!summary.ok) process.exitCode = 1
```

Per model it reports failed calls, latency p50/p90, input tokens and cost, and per question its accuracy at the threshold (0.5 when unset; a noul is positive at or above it). For nouls it adds misses and false positives there and at every threshold from 0.05 to 0.95, the margin between the lowest positive and the highest negative (below zero, no threshold separates them), the Brier score and a 10-bin reliability table. `summary.ok` is false when any call failed or any answer was wrong.

## Benchmark

`bun run bench` asks every model with a key the fixed questions in [`bench/cases.ts`](bench/cases.ts) and writes `.artifacts/bench/report.html`: accuracy against the expected answers, probability on the right answer, latency p50/p90 and cost per model, every answer side by side, and a closing leaderboard; the console also prints each model's Brier score on the nouls that scores each model out of 100 (one point per right answer, a failed call scores zero). Keys come from the environment or `.env`: copy [`.env.example`](.env.example) to `.env` and fill in the providers you have; `--runs=5` and `--models=jev,clef` narrow or widen a run.

Results from 2026-10-10 (12 cases, 21 questions, 3 runs per case; `typesafe/jev-1.13` was added after this run):

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
