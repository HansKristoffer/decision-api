# Releasing decision-api

Use a pull request with a conventional title. `fix:` and `perf:` release a patch, `feat:` a minor, and `feat!:` or a `BREAKING CHANGE:` footer a major. `chore:`, `ci:`, `docs:`, `refactor:` and `test:` do not release. Squash merging uses the PR title; do not manually edit versions or changelogs.

CI checks the PR title, lint/types, tests, build and the installed npm artifact: it packs the package, installs the tarball into an empty project, imports it under Node and type-checks a strict `nodenext` consumer. Release Please uses the built-in repository token. GitHub requires a maintainer to select **Approve workflows to run** on each bot-created or updated release PR before its PR checks start. Wait for those checks before merging; manual CI dispatches do not satisfy PR protection. No personal access token is needed.

## Publish

1. Merge a passing development PR. Release Please opens or updates a release PR containing the next version and changelog.
2. Review its release notes and any breaking-change migration instructions.
3. Merge the passing release PR when ready. The workflow creates the version tag and GitHub release, checks out that tag, validates the package, and publishes the exact verified tarball with provenance.

Publication uses npm trusted publishing. Its package configuration is GitHub Actions, owner `HansKristoffer`, repository `decision-api`, workflow `release.yml`, no environment, and permission to publish. Node 24 supplies a compatible npm CLI. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to this workflow.

## First release (once)

npm attaches a trusted publisher only to a package that already exists, so the very first version is published by hand:

1. Publish the `0.0.0` placeholder from a clean checkout of `main`: `bun install && bun run build && bun run verify:package`, then `npm publish .artifacts/package.tgz --access public --auth-type=web`.
2. Attach the trusted publisher on npmjs.com (Settings → Trusted Publisher → GitHub Actions, with the values above) or with `npx npm@latest trust github decision-api --repo HansKristoffer/decision-api --file release.yml --allow-publish`. The first workflow publish must follow within 2 days.
3. Merge a PR whose squash commit carries the footer `Release-As: 1.0.0`. Merging the release PR it produces publishes `1.0.0` through the workflow.
4. Deprecate the placeholder: `npm deprecate decision-api@0.0.0 "Use 1.0.0 or later"`.

## Recover a failed publication

Fix the failure, then run the Release workflow manually with the existing tag:

```sh
gh workflow run release.yml --repo HansKristoffer/decision-api -f tag=vX.Y.Z
```

The workflow checks that the tag exists as a GitHub release and agrees with the package version. Existing npm versions are skipped; registry errors fail rather than being mistaken for an unpublished version. npm versions are immutable: a broken published package needs a new fix PR and release. A source change cannot repair an old tag's build; cut a new release for that.

GitHub documents this token behavior in [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
