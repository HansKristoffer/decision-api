// Runs every case in `cases.ts` against every model with a key, and writes a
// side-by-side report of speed, cost and correctness.
//
//   bun run bench                         # every model with a key, 3 runs
//   bun run bench --runs=5 --models=jev,microsoft/microsoft-decision-1
//
// Keys come from the environment; copy `.env.example` to `.env` (Bun reads it):
// TYPESAFE_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, OPENAI_API_KEY,
// OPENROUTER_API_KEY (every OpenRouter model in DECISION_MODELS).

import { mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
	createDecisionApi,
	DECISION_MODELS,
	type DecisionModel,
	type DecisionProviderKeys
} from '../src/index.ts'
import { BENCH_CASES, type BenchCase } from './cases.ts'

const OUT_DIR = '.artifacts/bench'

type Answer =
	| { type: 'noul'; noul: number }
	| { type: 'choice'; choice: string; probabilities: Record<string, number> }
	| { type: 'score'; score: number; probabilities: Record<string, number> }

type Graded = { value: string; correct: boolean; pCorrect: number }

export type CallLog = {
	model: DecisionModel
	caseName: string
	run: number
	latencyMs: number
	costUsd?: number
	error?: string
	answers?: Record<string, Graded>
}

/** Right or wrong, plus the probability the model put on the right answer. */
export function grade(
	answer: Answer,
	expected: boolean | string | number
): Graded {
	if (answer.type === 'noul') {
		const pCorrect = expected ? answer.noul : 1 - answer.noul
		return {
			value: answer.noul.toFixed(2),
			correct: pCorrect >= 0.5,
			pCorrect
		}
	}
	const pCorrect = answer.probabilities[String(expected)] ?? 0
	if (answer.type === 'choice') {
		return {
			value: answer.choice,
			correct: answer.choice === expected,
			pCorrect
		}
	}
	return {
		value: answer.score.toFixed(2),
		correct: Math.round(answer.score) === expected,
		pCorrect
	}
}

function keysFromEnv(): DecisionProviderKeys {
	const env = process.env
	return {
		typesafe: env.TYPESAFE_API_KEY,
		openai: env.OPENAI_API_KEY,
		openrouter: env.OPENROUTER_API_KEY,
		cloudflare:
			env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID
				? {
						apiToken: env.CLOUDFLARE_API_TOKEN,
						accountId: env.CLOUDFLARE_ACCOUNT_ID
					}
				: undefined
	}
}

export async function runBench(input: {
	keys: DecisionProviderKeys
	models: DecisionModel[]
	runs: number
	cases?: BenchCase[]
	onCall?: (log: CallLog) => void
}) {
	const decide = createDecisionApi({
		// Only models whose key is present are passed in `models`.
		keys: input.keys as Required<DecisionProviderKeys>,
		timeoutMs: 15_000,
		registerUsage: (usage, context: { log: CallLog }) => {
			context.log.costUsd = usage.costUsd
		},
		onError: (error, context) => {
			context.log.error = `${error.kind}: ${error.message}`
		}
	})
	const cases = input.cases ?? BENCH_CASES

	// Models run side by side (separate providers); each model's own calls run
	// one at a time so they never queue behind each other.
	const perModel = await Promise.all(
		input.models.map(async (model) => {
			const logs: CallLog[] = []
			for (let run = 1; run <= input.runs; run++) {
				for (const benchCase of cases) {
					const log: CallLog = {
						model,
						caseName: benchCase.name,
						run,
						latencyMs: 0
					}
					const startedAt = performance.now()
					const answers = await decide(
						{ state: benchCase.state, questions: benchCase.questions, log },
						model
					)
					log.latencyMs = Math.round(performance.now() - startedAt)
					if (answers) {
						log.answers = Object.fromEntries(
							Object.entries(benchCase.expected).map(([key, expected]) => [
								key,
								grade(answers[key] as Answer, expected)
							])
						)
					}
					input.onCall?.(log)
					logs.push(log)
				}
			}
			return logs
		})
	)
	return perModel.flat()
}

// ───────────────────────────────── Report ──────────────────────────────────

function percentile(values: number[], p: number) {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
}

const mean = (values: number[]) =>
	values.length === 0
		? Number.NaN
		: values.reduce((sum, value) => sum + value, 0) / values.length

function summarize(model: DecisionModel, logs: CallLog[]) {
	const own = logs.filter((log) => log.model === model)
	const answered = own.filter((log) => log.answers)
	const graded = answered.flatMap((log) => Object.values(log.answers ?? {}))
	const latencies = answered.map((log) => log.latencyMs)
	return {
		model,
		calls: own.length,
		failures: own.length - answered.length,
		accuracy: mean(graded.map((g) => (g.correct ? 1 : 0))),
		pCorrect: mean(graded.map((g) => g.pCorrect)),
		p50: percentile(latencies, 0.5),
		p90: percentile(latencies, 0.9),
		costPerCall: mean(answered.map((log) => log.costUsd ?? 0)),
		totalCost: answered.reduce((sum, log) => sum + (log.costUsd ?? 0), 0)
	}
}

/**
 * One point per question answered right, averaged over runs. A failed call
 * scores zero, so an unreliable model cannot climb by skipping questions.
 * Ties go to the model that put more probability on the right answers.
 */
export function leaderboard(input: {
	logs: CallLog[]
	models: DecisionModel[]
	runs: number
	cases?: BenchCase[]
}) {
	const maxPoints = (input.cases ?? BENCH_CASES).reduce(
		(sum, benchCase) => sum + Object.keys(benchCase.expected).length,
		0
	)
	return input.models
		.map((model) => {
			const correct = input.logs
				.filter((log) => log.model === model)
				.flatMap((log) => Object.values(log.answers ?? {}))
				.filter((g) => g.correct).length
			const points = correct / input.runs
			return {
				...summarize(model, input.logs),
				points,
				maxPoints,
				score: (points / maxPoints) * 100
			}
		})
		.sort((a, b) => b.points - a.points || b.pCorrect - a.pCorrect)
}

const esc = (text: string) =>
	text.replace(
		/[&<>"]/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char
	)

const pct = (value: number) =>
	Number.isNaN(value) ? '–' : `${(value * 100).toFixed(0)}%`
const ms = (value: number) => (Number.isNaN(value) ? '–' : `${value} ms`)

/** A cell with a bar behind its value; `share` is 0..1 of the column's best. */
function barCell(text: string, share: number, good: boolean) {
	const width = Number.isFinite(share) ? Math.round(share * 100) : 0
	return `<td class="bar ${good ? 'best' : ''}"><span style="width:${width}%"></span><b>${text}</b></td>`
}

export function renderReport(input: {
	logs: CallLog[]
	models: DecisionModel[]
	runs: number
	cases?: BenchCase[]
	startedAt: Date
}) {
	const cases = input.cases ?? BENCH_CASES
	const rows = input.models.map((model) => summarize(model, input.logs))
	const ranking = leaderboard(input)
	const podium = ranking
		.map(
			(row, index) => `<tr class="${index === 0 ? 'winner' : ''}">
	<td class="rank">${index + 1}</td>
	<th>${row.model}<small>${DECISION_MODELS[row.model].provider}</small></th>
	${barCell(`${row.score.toFixed(1)}`, row.score / 100, index === 0)}
	<td class="num">${row.points.toFixed(1)} / ${row.maxPoints}</td>
	<td class="num">${pct(row.pCorrect)}</td>
	<td class="num">${ms(row.p50)}</td>
	<td class="num">$${(row.costPerCall * 1000).toFixed(4)}</td>
</tr>`
		)
		.join('')
	const maxOf = (pick: (row: (typeof rows)[number]) => number) =>
		Math.max(...rows.map(pick).filter(Number.isFinite))
	const minOf = (pick: (row: (typeof rows)[number]) => number) =>
		Math.min(...rows.map(pick).filter(Number.isFinite))

	const summary = rows
		.map(
			(row) => `<tr>
	<th>${row.model}<small>${DECISION_MODELS[row.model].provider}</small></th>
	${barCell(pct(row.accuracy), row.accuracy, row.accuracy === maxOf((r) => r.accuracy))}
	${barCell(pct(row.pCorrect), row.pCorrect, row.pCorrect === maxOf((r) => r.pCorrect))}
	${barCell(ms(row.p50), row.p50 / maxOf((r) => r.p90), row.p50 === minOf((r) => r.p50))}
	${barCell(ms(row.p90), row.p90 / maxOf((r) => r.p90), row.p90 === minOf((r) => r.p90))}
	<td class="num">$${(row.costPerCall * 1000).toFixed(4)}</td>
	<td class="num">$${row.totalCost.toFixed(5)}</td>
	<td class="num ${row.failures ? 'bad' : ''}">${row.failures}/${row.calls}</td>
</tr>`
		)
		.join('')

	const detail = cases
		.flatMap((benchCase) =>
			Object.entries(benchCase.expected).map(([key, expected], index) => {
				const cells = input.models.map((model) => {
					const runs = input.logs.filter(
						(log) => log.model === model && log.caseName === benchCase.name
					)
					const graded = runs
						.map((log) => log.answers?.[key])
						.filter((g): g is Graded => g !== undefined)
					const first = graded[0]
					if (!first) {
						const error = runs.find((log) => log.error)?.error ?? 'no answer'
						return `<td class="cell bad" title="${esc(error)}">failed</td>`
					}
					const right = graded.filter((g) => g.correct).length
					const latency = mean(runs.map((log) => log.latencyMs))
					const tone =
						right === graded.length ? 'ok' : right === 0 ? 'bad' : 'mixed'
					return `<td class="cell ${tone}">
	<b>${esc(first.value)}</b>
	<small>${right}/${graded.length} right · p ${first.pCorrect.toFixed(2)}${index === 0 ? ` · ${Math.round(latency)} ms` : ''}</small>
</td>`
				})
				const caseCell =
					index === 0
						? `<th rowspan="${Object.keys(benchCase.expected).length}" class="case">${esc(benchCase.name)}<small>${esc(preview(benchCase.state))}</small></th>`
						: ''
				return `<tr>${caseCell}<td class="q">${esc(key)}<small>${benchCase.questions[key]?.type}</small></td><td class="expected">${esc(String(expected))}</td>${cells.join('')}</tr>`
			})
		)
		.join('')

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>decision-api benchmark</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	:root { color-scheme: light dark; --fg: #1b1b1f; --muted: #6b6b76; --line: #e4e4ea; --bg: #fff; --card: #f7f7f9; --ok: #1f9d55; --bad: #d64545; --mixed: #c98a12; --bar: #dbe7ff; --best: #b9e8c9; }
	@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #9a9aa6; --line: #2c2c33; --bg: #141417; --card: #1c1c21; --bar: #23324d; --best: #1d4630; } }
	* { box-sizing: border-box; }
	body { margin: 0; padding: 40px 24px 80px; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--fg); background: var(--bg); }
	main { max-width: 1200px; margin: 0 auto; }
	h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
	h2 { font-size: 16px; margin: 40px 0 12px; }
	p.meta { color: var(--muted); margin: 0; }
	table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 10px; overflow: hidden; }
	th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
	thead th { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
	tbody tr:last-child > * { border-bottom: 0; }
	small { display: block; color: var(--muted); font-size: 12px; font-weight: 400; }
	.num { font-variant-numeric: tabular-nums; text-align: right; }
	.bar { position: relative; min-width: 110px; font-variant-numeric: tabular-nums; }
	.bar span { position: absolute; inset: 6px auto 6px 6px; max-width: calc(100% - 12px); background: var(--bar); border-radius: 4px; }
	.bar.best span { background: var(--best); }
	.bar b { position: relative; font-weight: 600; }
	.case { max-width: 240px; }
	.case small { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
	.expected { font-family: ui-monospace, monospace; }
	.cell { border-left: 3px solid transparent; }
	.cell b { font-family: ui-monospace, monospace; font-weight: 600; }
	.cell.ok { border-left-color: var(--ok); }
	.cell.mixed { border-left-color: var(--mixed); }
	.cell.bad, td.bad { border-left-color: var(--bad); color: var(--bad); }
	.rank { width: 40px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; }
	.leaderboard .bar b { font-size: 16px; }
	.winner .rank { color: var(--ok); }
	ul.notes { color: var(--muted); padding-left: 18px; }
</style>
</head>
<body>
<main>
	<h1>decision-api benchmark</h1>
	<p class="meta">${input.startedAt.toISOString()} · ${cases.length} cases · ${input.runs} run${input.runs === 1 ? '' : 's'} per case</p>

	<h2>Summary</h2>
	<table>
		<thead><tr><th>Model</th><th>Accuracy</th><th>p(correct)</th><th>Latency p50</th><th>Latency p90</th><th class="num">Cost / 1k calls</th><th class="num">Total cost</th><th class="num">Failed</th></tr></thead>
		<tbody>${summary}</tbody>
	</table>
	<ul class="notes">
		<li><b>Accuracy</b>: share of questions answered right (noul on the right side of 0.5, choice picked, score rounded to the expected level).</li>
		<li><b>p(correct)</b>: mean probability the model put on the expected answer, so a confident right answer beats a hesitant one.</li>
		<li>Latency is wall time per call, answered calls only. Cost is priced from <code>DECISION_MODELS</code>.</li>
	</ul>

	<h2>Answers</h2>
	<table>
		<thead><tr><th>Case</th><th>Question</th><th>Expected</th>${input.models.map((model) => `<th>${model}</th>`).join('')}</tr></thead>
		<tbody>${detail}</tbody>
	</table>
	<p class="meta">Cells show the first run's answer, how many runs were right, the probability on the expected answer, and mean latency for the case.</p>

	<h2>Leaderboard</h2>
	<table class="leaderboard">
		<thead><tr><th>#</th><th>Model</th><th>Score</th><th class="num">Points</th><th class="num">p(correct)</th><th class="num">Latency p50</th><th class="num">Cost / 1k calls</th></tr></thead>
		<tbody>${podium}</tbody>
	</table>
	<p class="meta">One point per question answered right, averaged over runs; a failed call scores zero. Score is points out of 100. Ties go to the higher p(correct).</p>
</main>
</body>
</html>
`
}

function preview(state: unknown) {
	const text = typeof state === 'string' ? state : JSON.stringify(state)
	return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

// ─────────────────────────────────── CLI ───────────────────────────────────

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			runs: { type: 'string', default: '3' },
			models: { type: 'string' }
		}
	})
	const keys = keysFromEnv()
	const runs = Number(values.runs)
	const available = (Object.keys(DECISION_MODELS) as DecisionModel[]).filter(
		(model) => keys[DECISION_MODELS[model].provider]
	)
	const models = values.models
		? (values.models.split(',') as DecisionModel[])
		: available

	const missing = models.filter((model) => !available.includes(model))
	if (missing.length > 0 || models.length === 0 || !(runs >= 1)) {
		console.error(
			missing.length > 0
				? `No key (or unknown model) for: ${missing.join(', ')}`
				: models.length === 0
					? 'No provider keys set: copy .env.example to .env and fill it in.'
					: '--runs must be 1 or more'
		)
		process.exit(1)
	}

	const startedAt = new Date()
	const total = models.length * runs * BENCH_CASES.length
	let done = 0
	console.log(`Benchmarking ${models.join(', ')}: ${total} calls`)
	const logs = await runBench({
		keys,
		models,
		runs,
		onCall: (log) => {
			done += 1
			const status = log.error ? `✗ ${log.error}` : `${log.latencyMs} ms`
			console.log(
				`[${done}/${total}] ${log.model} · ${log.caseName} · ${status}`
			)
		}
	})

	await mkdir(OUT_DIR, { recursive: true })
	await Bun.write(
		`${OUT_DIR}/results.json`,
		JSON.stringify({ startedAt, runs, models, logs }, null, '\t')
	)
	await Bun.write(
		`${OUT_DIR}/report.html`,
		renderReport({ logs, models, runs, startedAt })
	)
	console.log('\nLeaderboard')
	console.table(
		leaderboard({ logs, models, runs }).map((row, index) => ({
			rank: index + 1,
			model: row.model,
			score: Number(row.score.toFixed(1)),
			points: `${row.points.toFixed(1)} / ${row.maxPoints}`,
			'p(correct)': pct(row.pCorrect),
			'latency p50': ms(row.p50)
		}))
	)
	console.log(`\nReport: ${OUT_DIR}/report.html`)
}
