# decision-api

decision-api is one typed client, published to npm, for decision models (TypeSafe Jev, Cloudflare Clef, OpenAI gpt-6-luna, Google gemini-decision-1, OpenRouter models) that answer questions with calibrated probabilities. The [README](README.md) is the user guide.

## Consumers

Only our own apps install decision-api. A breaking change is allowed when it is released as one: title the PR `feat!:` and say in the body what an app must change. The apps are upgraded after the release.

## Before a PR

```sh
bun run lint && bun test && bun run build && bun run verify:package
```

This is what CI runs. The tests replace `fetch`, so they pass without reaching a provider.

## A new model option

A new model or provider in `DECISION_MODELS` ships only after `bun run bench` has run it against the real API:

1. Ask the owner for the provider's key (in T3 Code, the `request_secret` tool) and put it in the git-ignored `.env`; [`.env.example`](.env.example) names each variable.
2. Run `bun run bench --models=<model>` and paste the model's leaderboard row into the PR body. The bench cases are text only: name in the body each file input (image, video, audio, PDF) that is still untried.

Without the key the PR stays open and says so; it is merged and released once the bench has run. Why: 2.1.0 went to npm with Gemini support and "None of it has been tried against the real Gemini API, because there's no key here".

## Releasing

The PR title decides the release, and CI rejects a title that is not a conventional commit. Release Please writes the version in `package.json` and `CHANGELOG.md` in its release PR: leave both to it. See [docs/releasing.md](docs/releasing.md).
