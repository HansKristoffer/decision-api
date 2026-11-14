# Changelog

## [2.1.1](https://github.com/HansKristoffer/decision-api/compare/v2.1.0...v2.1.1) (2026-11-14)


### Bug Fixes

* ship CHANGELOG.md in the npm package ([6cf300e](https://github.com/HansKristoffer/decision-api/commit/6cf300e660fbbb335088e89155b9e58fbd0e0553))
* ship CHANGELOG.md in the npm package ([57a58e3](https://github.com/HansKristoffer/decision-api/commit/57a58e39952fa8b5eaed6bd8b24f6c33e52dec5c))

## [2.1.0](https://github.com/HansKristoffer/decision-api/compare/v2.0.0...v2.1.0) (2026-11-12)


### Features

* add Gemini Decision 1, with video, audio and PDF input ([#11](https://github.com/HansKristoffer/decision-api/issues/11)) ([a187761](https://github.com/HansKristoffer/decision-api/commit/a187761763a17ffba08b74935f6d14f8a88847d2))

## [2.0.0](https://github.com/HansKristoffer/decision-api/compare/v1.3.0...v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* the error kind state-too-large is now request-too-large and counts the questions as well as the state; the maxStateChars option is now maxRequestChars and DECISION_MAX_STATE_CHARS is now DECISION_MAX_REQUEST_CHARS. timeoutMs now bounds the whole call, retries included, instead of each attempt.

### Features

* attemptTimeoutMs, and a single retry for transport errors and 504 ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))
* check calls against per-model maxQuestions, maxChoices and maxLevels ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))
* decide.result() answers usage (with attempts and resolvedModel) or the error (with latencyMs and attempts) ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))
* decision-api/eval with runCases and a threshold and calibration report ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))
* decision-api/testing with fakeDecide ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))
* perItem, and export the single answer types ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))
* request-too-large replaces state-too-large and counts questions; maxRequestChars and DECISION_MAX_REQUEST_CHARS replace the state names; timeoutMs bounds the whole call ([a5059dd](https://github.com/HansKristoffer/decision-api/commit/a5059dd52f08f67bd15d9994e679ab8b64486caa))

## [1.3.0](https://github.com/HansKristoffer/decision-api/compare/v1.2.0...v1.3.0) (2026-11-04)


### Features

* add image inputs for Jev decision models ([a61827c](https://github.com/HansKristoffer/decision-api/commit/a61827c9f1a4ae8733bd81ca8e988dbf6cf492a3))
* add image inputs for Jev decision models ([87c1d93](https://github.com/HansKristoffer/decision-api/commit/87c1d93179f6c6296d7d26ba559d56ee4065d948))

## [1.2.0](https://github.com/HansKristoffer/decision-api/compare/v1.1.0...v1.2.0) (2026-10-19)


### Features

* add typesafe/jev-1.13 as an OpenRouter model ([#5](https://github.com/HansKristoffer/decision-api/issues/5)) ([8a14a92](https://github.com/HansKristoffer/decision-api/commit/8a14a92b5e276a653391682c4ccb84f5aefbb80f))

## [1.1.0](https://github.com/HansKristoffer/decision-api/compare/v1.0.0...v1.1.0) (2026-10-10)


### Features

* report provider status and refusal kinds on DecisionError ([#3](https://github.com/HansKristoffer/decision-api/issues/3)) ([42d6450](https://github.com/HansKristoffer/decision-api/commit/42d6450b86713ad1666c6e2e6fd3bc19736fc47f))

## 1.0.0 (2026-10-10)


### Features

* add OpenRouter models and a model benchmark ([#1](https://github.com/HansKristoffer/decision-api/issues/1)) ([771d8b5](https://github.com/HansKristoffer/decision-api/commit/771d8b50034bff46a3f4dc657c9c28cdeee60c68))
